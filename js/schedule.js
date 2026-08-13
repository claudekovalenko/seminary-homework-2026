// Turns the raw syllabus JSON into dated, measurable work:
// page counts, effort estimates, deadlines, and a day-by-day reading plan.

import { settings, overrideFor, isDone, progressFor, sessionDates } from './store.js';

/* ---------- dates ---------- */

export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export const addDays = (date, n) => {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
};

export const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);

function parseDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function withTime(date, hhmm) {
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

export function formatDate(date, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return parseDay(date).toLocaleDateString(undefined, opts);
}

export function relativeDay(date) {
  const n = daysBetween(startOfToday(), date);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}

/* ---------- page ranges ---------- */

export const rangePages = (ranges) => (ranges || []).reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);

// Join ranges that touch or overlap, so "1–3" plus "4–6" prints as "1–6".
export function mergeRanges(ranges) {
  const out = [];
  for (const [lo, hi] of [...(ranges || [])].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

export function formatRanges(ranges) {
  return mergeRanges(ranges)
    .map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`))
    .join('; ');
}

// Take the first `count` pages out of a list of ranges.
// Returns [taken, rest] so a long chunk can be spread across days as real page numbers.
export function sliceRanges(ranges, count) {
  const taken = [];
  const rest = [];
  let left = count;
  for (const [lo, hi] of ranges) {
    const size = hi - lo + 1;
    if (left <= 0) {
      rest.push([lo, hi]);
    } else if (size <= left) {
      taken.push([lo, hi]);
      left -= size;
    } else {
      taken.push([lo, lo + left - 1]);
      rest.push([lo + left, hi]);
      left = 0;
    }
  }
  return [taken, rest];
}

/* ---------- measuring one reading ---------- */

export function pagesOf(item, key) {
  const override = overrideFor(key);
  if (typeof override === 'number') return override;
  if (item.ranges && item.ranges.length) return rangePages(item.ranges);
  if (typeof item.pages === 'number') return item.pages;
  if (typeof item.estPages === 'number') return item.estPages;
  if (typeof item.chapters === 'number') return item.chapters * settings().defaultChapterPages;
  return 0;
}

export function minutesOf(item, key) {
  const s = settings();
  if (item.unit === 'verses') return (item.verses || 0) * s.minsPerGreekVerse;
  if (item.unit === 'chapters') return (item.chapters || 0) * s.minsPerBibleChapter;
  return pagesOf(item, key) * s.minsPerPage;
}

export function amountLabel(item, key) {
  if (item.unit === 'verses') return `${item.verses} verses`;
  if (item.unit === 'chapters') return `${item.chapters} ch.`;
  const p = pagesOf(item, key);
  const approx = isEstimated(item, key) ? '~' : '';
  return `${approx}${p} pp.`;
}

export function isEstimated(item, key) {
  if (typeof overrideFor(key) === 'number') return false;
  if (item.ranges && item.ranges.length) return false;
  return Boolean(item.estimated) || typeof item.chapters === 'number';
}

export const formatMinutes = (mins) => {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
};

/* ---------- class times ---------- */

// Fallback used when a course's meeting time has not been confirmed yet.
export const ASSUMED_CLASS_TIME = '18:00';

/** The time a course meets: your setting first, then the syllabus, then a guess. */
export function classTimeFor(course) {
  return settings().classTimes?.[course.id] || course.classTime || ASSUMED_CLASS_TIME;
}

/** True when the meeting time is still an assumption rather than a known fact. */
export function classTimeIsAssumed(course) {
  return !settings().classTimes?.[course.id] && !course.classTime;
}

/**
 * The last day you can still read for a class. An evening class leaves the
 * class day itself usable; a morning one does not.
 */
export function lastStudyDay(deadline, from) {
  const eveningClass = deadline.getHours() >= 17;
  if (eveningClass && daysBetween(from, deadline) >= 0) return parseDay(deadline);
  return daysBetween(from, deadline) >= 1 ? addDays(deadline, -1) : from;
}

/* ---------- Bible readings, passage by passage ---------- */

/**
 * Break a week's Bible reading into the passages it is actually made of.
 *
 *   "Ps 1; Ps 27; 1 Cor 13; Rev 22"  -> four passages
 *   "Isa 40–48"                      -> nine, one per chapter
 *   "Rom 1–2:15"                     -> "Rom 1" and "Rom 2:1–15"
 *   "Rom 5:12–21"                    -> one, since it is part of a chapter
 *
 * A syllabus writes a week's worth on one line; a day's reading is one chapter
 * of it. Anything unparseable is kept whole rather than mangled — better a
 * passage that does not split than one that comes out wrong.
 */
export function bibleUnits(ref) {
  const out = [];
  for (const piece of String(ref || '').split(/[;,]/)) {
    const segment = piece.trim();
    if (!segment) continue;

    const parts = segment.match(/^(.*[A-Za-z.])\s+([\d:–—-]+)$/);
    if (!parts) {
      out.push(segment);
      continue;
    }
    const book = parts[1].trim();
    const spec = parts[2];

    // Part of a single chapter: "5:12–21", "3:16".
    if (/^\d+:\d+([–—-]\d+)?$/.test(spec)) {
      out.push(`${book} ${spec}`);
      continue;
    }
    // Whole chapters, then part of the last: "1–2:15".
    const partial = spec.match(/^(\d+)[–—-](\d+):(\d+)$/);
    if (partial) {
      for (let n = Number(partial[1]); n < Number(partial[2]); n++) out.push(`${book} ${n}`);
      out.push(`${book} ${partial[2]}:1–${partial[3]}`);
      continue;
    }
    // A run of whole chapters: "40–48".
    const run = spec.match(/^(\d+)[–—-](\d+)$/);
    if (run && Number(run[2]) > Number(run[1])) {
      for (let n = Number(run[1]); n <= Number(run[2]); n++) out.push(`${book} ${n}`);
      continue;
    }
    out.push(segment);
  }
  return out;
}

/**
 * How many of `count` things to do on each of `days` days, heaviest first.
 * Six readings over five days is 2,1,1,1,1 — the extra goes at the front, where
 * there is still time to absorb it, rather than at the end against the deadline.
 */
export function spread(count, days) {
  if (days <= 0) return [];
  const each = Math.floor(count / days);
  const extra = count % days;
  return Array.from({ length: days }, (_, i) => each + (i < extra ? 1 : 0));
}

/* ---------- normalising the syllabus ---------- */

export const keyFor = (courseId, date, kind, idx) => `${courseId}|${date}|${kind}|${idx}`;

/**
 * When a session actually happens.
 *
 * Applied Theology is arranged between the student, the professor and a pastor,
 * so its meetings have no date in the syllabus at all. They keep a stable id
 * instead, and a date once you have set one in the app. Until then the work is
 * real and tickable but has no deadline, and nothing may pretend otherwise.
 */
export function sessionDate(course, session) {
  return session.date || sessionDates()[`${course.id}|${session.id}`] || null;
}

/** The part of a task's key that identifies its session, dated or not. */
const sessionKey = (session) => session.date || session.id;

// How much of a task is left once completion and part-way progress are applied.
function applyProgress(task) {
  const s = settings();
  if (isDone(task.key)) {
    return { ...task, read: task.pages, baseRanges: task.ranges, remainingPages: 0, remainingRanges: [], remaining: 0, complete: true };
  }
  // For a project, progress is logged in minutes; for a reading, in pages.
  if (task.unit === 'project') {
    const logged = Math.min(progressFor(task.key), task.minutes);
    return {
      ...task,
      read: logged,
      remainingPages: 0,
      remainingRanges: null,
      remaining: Math.max(0, task.minutes - logged),
      complete: false
    };
  }
  // Bible reading is counted in chapters, not pages, but it is tracked exactly
  // the same way: how many of them you have got through so far.
  const counted = task.unit === 'pages' || task.unit === 'chapters';
  const read = counted ? Math.min(progressFor(task.key), task.pages) : 0;

  // A reading given only as "ch. 4" still has a length, so give it a notional
  // 1..n range. That lets it be split across days as "pages 1–8 of 22" instead
  // of being dumped whole onto one evening.
  const hasRealRanges = Boolean(task.ranges?.length);
  const baseRanges = hasRealRanges ? task.ranges : counted && task.pages > 0 ? [[1, task.pages]] : null;

  const remainingRanges = baseRanges ? sliceRanges(baseRanges, read)[1] : null;
  const remainingPages = baseRanges ? rangePages(remainingRanges) : Math.max(0, task.pages - read);
  const perUnit = task.unit === 'chapters' ? s.minsPerBibleChapter : s.minsPerPage;
  const remaining = counted ? remainingPages * perUnit : task.minutes;
  return { ...task, read, baseRanges, synthetic: !hasRealRanges, remainingPages, remainingRanges, remaining, complete: false };
}

/**
 * Long-run work (papers, projects): what to do about it today, given that the
 * remaining effort is spread evenly over the study days still available.
 */
export function projectPace(task, from = startOfToday()) {
  const s = settings();
  const start = task.startPlanning ? parseDate(task.startPlanning) : from;
  if (parseDay(from) < parseDay(start)) return null;
  const deadline = dueAt(task);
  if (!deadline) return null;
  const days = studyDaysBetween(from, lastStudyDay(deadline, from), s.studyDays);
  const perDay = task.remaining / days.length;
  const todayIsStudyDay = days.some((d) => daysBetween(d, from) === 0);
  return { perDay, days: days.length, todayIsStudyDay, deadline };
}

// One flat list of everything with a date attached.
export function buildTasks(data) {
  const tasks = [];
  for (const course of data.courses) {
    for (const session of course.sessions) {
      // A session you arrange yourself has no date until you set one. Its work
      // still exists; it simply has nothing to be due by.
      const when = sessionDate(course, session);
      const slot = sessionKey(session);
      const ctx = {
        courseId: course.id,
        course: course.short || course.name,
        courseName: course.name,
        color: course.color,
        sessionDate: slot,
        sessionId: session.id || session.date,
        undated: !when,
        arrangeBy: session.when || null,
        topic: session.topic,
        classTime: classTimeFor(course),
        classTimeAssumed: classTimeIsAssumed(course)
      };

      (session.readings || []).forEach((item, i) => {
        const key = keyFor(course.id, slot, 'r', i);
        tasks.push({
          ...ctx,
          key,
          kind: 'reading',
          order: item.order ?? i + 1,
          title: item.source,
          // The physical book/PDF this reading lives in — attachments key off it.
          material: item.material || item.source,
          detail: item.ref,
          format: item.format,
          driver: Boolean(item.driver),
          flag: item.flag,
          unit: item.unit || 'pages',
          ranges: item.ranges || null,
          verses: item.verses,
          raw: item,
          due: when,
          dueTime: classTimeFor(course),
          pages: pagesOf(item, key),
          minutes: minutesOf(item, key),
          estimated: isEstimated(item, key)
        });
      });

      if (session.bible) {
        const key = keyFor(course.id, slot, 'b', 0);
        // The passages themselves, so a day can be given one chapter rather
        // than "the Bible reading" whole. The syllabus's own count is a
        // fallback for anything the parser cannot make sense of.
        const units = bibleUnits(session.bible.ref);
        const chapters = units.length || session.bible.chapters || 0;
        const item = { unit: 'chapters', chapters };
        tasks.push({
          ...ctx,
          key,
          kind: 'bible',
          order: 99,
          title: 'Bible reading',
          detail: session.bible.ref,
          unit: 'chapters',
          chapters,
          units,
          raw: item,
          due: when,
          dueTime: classTimeFor(course),
          pages: chapters,
          minutes: minutesOf(item, key),
          estimated: false
        });
      }

      (session.assignments || []).forEach((a, i) => {
        const key = keyFor(course.id, slot, 'a', i);
        // Papers and projects are long-run work: they get their own planning
        // window rather than being crammed into the week they are due.
        const isProject = typeof a.effortMinutes === 'number';
        const sitting = a.type === 'quiz' || a.type === 'exam' ? 0 : 30;
        tasks.push({
          ...ctx,
          key,
          kind: 'assignment',
          type: a.type,
          unit: isProject ? 'project' : 'task',
          order: 100 + i,
          title: a.title,
          detail: a.note || (a.atClass ? 'At the beginning of class' : 'Due before class'),
          atClass: Boolean(a.atClass),
          startPlanning: a.startPlanning || null,
          raw: a,
          due: a.due || when,
          dueTime: a.dueTime || classTimeFor(course),
          pages: 0,
          minutes: isProject ? a.effortMinutes : sitting,
          estimated: isProject,
          project: isProject
        });
      });
    }
  }
  // Dated work first, in date order; anything you have yet to arrange sorts to
  // the end, where it waits rather than pretending to be imminent.
  const when = (t) => (t.due ? parseDate(t.due).getTime() : Infinity);
  return tasks
    .map(applyProgress)
    .sort((a, b) => when(a) - when(b) || a.courseId.localeCompare(b.courseId) || a.order - b.order);
}

/** When a task is due, or null for work you have not put a date on yet. */
export const dueAt = (task) => (task.due ? withTime(parseDate(task.due), task.dueTime) : null);

/* ---------- the week you are currently working toward ---------- */

// Every session whose work is still ahead of you, grouped by course.
export function upcomingSessions(data, from = startOfToday()) {
  const out = [];
  for (const course of data.courses) {
    for (const session of course.sessions) {
      const when = sessionDate(course, session);
      // Nothing to plan toward until a date exists.
      if (!when) continue;
      const d = parseDate(when);
      if (d < from) continue;
      out.push({ course, session, date: d });
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

// The next class meeting for each course (what you're reading for right now).
export function nextSessionPerCourse(data, from = startOfToday()) {
  const map = new Map();
  for (const { course, session, date } of upcomingSessions(data, from)) {
    if (!map.has(course.id)) map.set(course.id, { course, session, date });
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

/* ---------- falling behind ---------- */

/**
 * When the reading for a class meeting became yours to do: the day after the
 * course last met. That is the window an even pace is measured against, and
 * without it "behind" has nothing to be behind of.
 */
export function windowStartFor(course, session) {
  const start = sessionDate(course, session);
  if (!start) return null;
  const here = parseDate(start);
  let prev = null;
  for (const other of course.sessions) {
    const when = sessionDate(course, other);
    if (!when) continue;
    const d = parseDate(when);
    if (d < here && (!prev || d > prev)) prev = d;
  }
  return prev ? addDays(prev, 1) : addDays(here, -7);
}

/**
 * Whether you are keeping up, and by how much you are not.
 *
 * The plan already re-spreads whatever is left over the days that remain, so
 * missing a day silently raises every day after it. This works out by how much:
 * compare what is actually left against what an even pace from the start of the
 * week would have left by now. The difference is the reading you owe yourself.
 */
export function pace(tasks, deadline, { from = startOfToday(), windowStart = null } = {}) {
  const s = settings();
  const total = tasks.reduce((sum, t) => sum + t.minutes, 0);
  const remaining = tasks.reduce((sum, t) => sum + t.remaining, 0);
  const start = windowStart && windowStart < from ? windowStart : from;
  const whole = studyDaysBetween(start, lastStudyDay(deadline, start), s.studyDays);
  const left = studyDaysBetween(from, lastStudyDay(deadline, from), s.studyDays);

  const evenPerDay = total / whole.length;
  const perDayNow = remaining / left.length;
  // Where an even pace would have left you standing today.
  const shouldRemain = Math.min(total, evenPerDay * left.length);
  const behind = Math.max(0, remaining - shouldRemain);

  return {
    total,
    remaining,
    evenPerDay,
    perDayNow,
    behind,
    daysMissed: evenPerDay > 0 ? Math.round(behind / evenPerDay) : 0,
    daysLeft: left.length,
    days: whole.length,
    // Half a day's slippage is rounding, not a problem worth a banner.
    onTrack: behind < evenPerDay * 0.5
  };
}

/**
 * Unfinished work whose class has already met.
 *
 * The schedule moves on the moment a class is over, so without this the reading
 * you never got to simply disappears — no reminder, no plan, nothing ever asks
 * for it again.
 */
export function overdue(tasks, { from = new Date() } = {}) {
  return tasks.filter((t) => !t.complete && t.due && dueAt(t) < from).sort((a, b) => dueAt(a) - dueAt(b));
}

/** Work that exists but has no date yet, because you arrange it yourself. */
export function unscheduled(tasks) {
  return tasks.filter((t) => t.undated && !t.complete);
}

/* ---------- the day-by-day plan ---------- */

function studyDaysBetween(from, to, studyDays) {
  const days = [];
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
    if (studyDays.includes(d.getDay())) days.push(new Date(d));
  }
  // If none of the remaining days are marked as study days, you still have to
  // read — fall back to every remaining day rather than showing an empty plan.
  if (!days.length) {
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) days.push(new Date(d));
  }
  if (!days.length) days.push(new Date(from));
  return days;
}

/**
 * Spread the outstanding work for one class meeting across the days you have
 * left. Long page ranges get split at real page boundaries, so a day says
 * "Bavinck pp. 530–547", not "a third of Bavinck".
 */
export function planFor(tasks, deadline, opts = {}) {
  const s = settings();
  const today = opts.from || startOfToday();
  // Projects are paced separately by projectPace(), so they stay out of here.
  const pending = tasks.filter((t) => !t.complete && t.remaining > 0 && t.unit !== 'project');

  // Work is due before class, so the last useful study day is normally the day
  // before — but an evening class leaves that day open too.
  const days = studyDaysBetween(today, lastStudyDay(deadline, today), s.studyDays);

  const totalMinutes = pending.reduce((sum, t) => sum + t.remaining, 0);
  const perDay = totalMinutes / days.length;

  const chunkLabel = (task, ranges) =>
    task.synthetic ? `pages ${formatRanges(ranges)} of ${task.pages}` : `pp. ${formatRanges(ranges)}`;

  // Bible reading is paced by the day rather than by the minute: a chapter a
  // day is the point of it, not an even division of effort. It is placed
  // directly onto days further down, so it stays out of the general packing.
  const scripture = pending.filter((t) => t.kind === 'bible' && t.units?.length);

  // Chop anything much bigger than one day's share into page-accurate chunks.
  const atoms = [];
  for (const task of pending) {
    if (scripture.includes(task)) continue;
    const splittable =
      task.unit === 'pages' && task.remainingRanges?.length && task.remaining > perDay * 1.2 && perDay > 0;

    if (!splittable) {
      const partial = task.read > 0 && task.remainingRanges?.length;
      atoms.push({
        task,
        minutes: task.remaining,
        ranges: task.remainingRanges,
        label: partial || !task.synthetic ? chunkLabel(task, task.remainingRanges || []) : task.detail,
        whole: true,
        from: task.read,
        through: task.pages
      });
      continue;
    }

    const chunks = Math.max(2, Math.ceil(task.remaining / perDay));
    const per = Math.ceil(task.remainingPages / chunks);
    let rest = task.remainingRanges;
    let cumulative = task.read;
    while (rest.length) {
      const [taken, remainder] = sliceRanges(rest, per);
      const from = cumulative;
      cumulative += rangePages(taken);
      atoms.push({
        task,
        minutes: rangePages(taken) * s.minsPerPage,
        ranges: taken,
        label: chunkLabel(task, taken),
        whole: false,
        from,
        through: cumulative
      });
      rest = remainder;
    }
  }

  const plan = days.map((date) => ({ date, items: [], minutes: 0 }));
  let i = 0;
  for (const atom of atoms) {
    // Move on once this chunk would push the day well past its share — but
    // never leave a day empty, or a single long reading would have nowhere to go.
    while (i < plan.length - 1 && plan[i].minutes > 0 && plan[i].minutes + atom.minutes > perDay * 1.35) i += 1;
    const last = plan[i].items[plan[i].items.length - 1];
    // Two chunks of the same book landing on the same day read as one stretch.
    if (last && last.task.key === atom.task.key) {
      last.ranges = [...(last.ranges || []), ...(atom.ranges || [])];
      last.minutes += atom.minutes;
      last.through = atom.through;
      last.label = chunkLabel(atom.task, last.ranges);
      last.whole = last.through >= atom.task.pages && last.from === 0;
    } else {
      plan[i].items.push({ ...atom });
    }
    plan[i].minutes += atom.minutes;
  }

  // A chapter a day, as far as it goes. With more chapters left than days the
  // extra are clumped onto the earliest days and named together — "Gen 1, Gen
  // 2" — rather than one day being handed the lot at the end.
  for (const task of scripture) {
    const left = task.units.slice(task.read);
    const share = spread(left.length, days.length);
    let taken = 0;
    share.forEach((count, i) => {
      if (!count) return;
      const passages = left.slice(taken, taken + count);
      plan[i].items.push({
        task,
        minutes: count * s.minsPerBibleChapter,
        ranges: null,
        label: passages.join(', '),
        passages,
        whole: task.read + taken + count >= task.pages && task.read + taken === 0,
        from: task.read + taken,
        through: task.read + taken + count
      });
      plan[i].minutes += count * s.minsPerBibleChapter;
      taken += count;
    });
  }

  return { plan, totalMinutes, perDay, days: days.length, pending, deadline };
}

/* ---------- deadlines & reminders ---------- */

/** How far into a single reading you are, 0–100. Pages-only; other units are all-or-nothing. */
export function itemPct(task) {
  if (task.complete) return 100;
  // Pages and chapters are both simply counted through.
  if ((task.unit !== 'pages' && task.unit !== 'chapters') || !task.pages) return 0;
  return Math.min(100, Math.round((task.read / task.pages) * 100));
}

/** How much of a group of tasks is done, in minutes and as a percentage. */
export function workload(tasks) {
  const total = tasks.reduce((sum, t) => sum + t.minutes, 0);
  const remaining = tasks.reduce((sum, t) => sum + t.remaining, 0);
  const done = Math.max(0, total - remaining);
  const pct = total ? Math.round((done / total) * 100) : tasks.length ? 100 : 0;
  const allDone = tasks.length > 0 && tasks.every((t) => t.complete);
  return { total, remaining, done, pct, allDone };
}

export function deadlines(tasks, { from = startOfToday(), withinDays = 21, includeDone = false } = {}) {
  const groups = new Map();
  for (const t of tasks) {
    if (!includeDone && t.complete) continue;
    const when = dueAt(t);
    if (!when) continue;
    const delta = daysBetween(from, when);
    if (delta < 0 || delta > withinDays) continue;
    const gkey = `${t.courseId}|${t.due}`;
    if (!groups.has(gkey)) {
      groups.set(gkey, {
        key: gkey,
        courseId: t.courseId,
        course: t.course,
        courseName: t.courseName,
        color: t.color,
        topic: t.topic,
        date: when,
        iso: t.due,
        time: t.dueTime,
        timeAssumed: Boolean(t.classTimeAssumed) && !t.raw?.dueTime,
        daysUntil: delta,
        tasks: []
      });
    }
    groups.get(gkey).tasks.push(t);
  }
  return [...groups.values()].sort((a, b) => a.date - b.date);
}
