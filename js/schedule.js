// Turns the raw syllabus JSON into dated, measurable work:
// page counts, effort estimates, deadlines, and a day-by-day reading plan.

import { settings, overrideFor, isDone, progressFor } from './store.js';

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

/* ---------- normalising the syllabus ---------- */

export const keyFor = (courseId, date, kind, idx) => `${courseId}|${date}|${kind}|${idx}`;

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
  const read = task.unit === 'pages' ? Math.min(progressFor(task.key), task.pages) : 0;

  // A reading given only as "ch. 4" still has a length, so give it a notional
  // 1..n range. That lets it be split across days as "pages 1–8 of 22" instead
  // of being dumped whole onto one evening.
  const hasRealRanges = Boolean(task.ranges?.length);
  const baseRanges = hasRealRanges ? task.ranges : task.unit === 'pages' && task.pages > 0 ? [[1, task.pages]] : null;

  const remainingRanges = baseRanges ? sliceRanges(baseRanges, read)[1] : null;
  const remainingPages = baseRanges ? rangePages(remainingRanges) : Math.max(0, task.pages - read);
  const remaining = task.unit === 'pages' ? remainingPages * s.minsPerPage : task.minutes;
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
      const ctx = {
        courseId: course.id,
        course: course.short || course.name,
        courseName: course.name,
        color: course.color,
        sessionDate: session.date,
        topic: session.topic,
        classTime: classTimeFor(course),
        classTimeAssumed: classTimeIsAssumed(course)
      };

      (session.readings || []).forEach((item, i) => {
        const key = keyFor(course.id, session.date, 'r', i);
        tasks.push({
          ...ctx,
          key,
          kind: 'reading',
          order: item.order ?? i + 1,
          title: item.source,
          detail: item.ref,
          format: item.format,
          driver: Boolean(item.driver),
          flag: item.flag,
          unit: item.unit || 'pages',
          ranges: item.ranges || null,
          verses: item.verses,
          raw: item,
          due: session.date,
          dueTime: classTimeFor(course),
          pages: pagesOf(item, key),
          minutes: minutesOf(item, key),
          estimated: isEstimated(item, key)
        });
      });

      if (session.bible) {
        const key = keyFor(course.id, session.date, 'b', 0);
        const item = { unit: 'chapters', chapters: session.bible.chapters };
        tasks.push({
          ...ctx,
          key,
          kind: 'bible',
          order: 99,
          title: 'Bible reading',
          detail: session.bible.ref,
          unit: 'chapters',
          chapters: session.bible.chapters,
          raw: item,
          due: session.date,
          dueTime: classTimeFor(course),
          pages: 0,
          minutes: minutesOf(item, key),
          estimated: false
        });
      }

      (session.assignments || []).forEach((a, i) => {
        const key = keyFor(course.id, session.date, 'a', i);
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
          due: a.due || session.date,
          dueTime: a.dueTime || classTimeFor(course),
          pages: 0,
          minutes: isProject ? a.effortMinutes : sitting,
          estimated: isProject,
          project: isProject
        });
      });
    }
  }
  return tasks
    .map(applyProgress)
    .sort((a, b) => parseDate(a.due) - parseDate(b.due) || a.courseId.localeCompare(b.courseId) || a.order - b.order);
}

export const dueAt = (task) => withTime(parseDate(task.due), task.dueTime);

/* ---------- the week you are currently working toward ---------- */

// Every session whose work is still ahead of you, grouped by course.
export function upcomingSessions(data, from = startOfToday()) {
  const out = [];
  for (const course of data.courses) {
    for (const session of course.sessions) {
      const d = parseDate(session.date);
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

  // Chop anything much bigger than one day's share into page-accurate chunks.
  const atoms = [];
  for (const task of pending) {
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

  return { plan, totalMinutes, perDay, days: days.length, pending, deadline };
}

/* ---------- deadlines & reminders ---------- */

export function deadlines(tasks, { from = startOfToday(), withinDays = 21, includeDone = false } = {}) {
  const groups = new Map();
  for (const t of tasks) {
    if (!includeDone && t.complete) continue;
    const when = dueAt(t);
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
