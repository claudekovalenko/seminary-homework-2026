import * as store from './store.js';
import * as S from './schedule.js';
import * as notify from './notify.js';
import * as lib from './library.js';
import { emphasisRuns, EM as EM_MARK, STRONG as STRONG_MARK } from './text.js';

// Shown in Settings so you can tell at a glance which version a device is
// actually running. Bump it alongside the service worker's CACHE.
const AHEAD = 3;

const BUILD = 'v36 · 2026-09-03';

let DATA = null;
let TASKS = [];
let view = location.hash.replace('#', '') || 'today';
// Set when you tap a paperclip in a reading list: the Files view scrolls to it.
let focusMaterial = null;
// The material an OCR run is working on, if any. Re-rendering mid-run would
// throw away the progress line it is writing into, so redraws wait for it.
let ocrRunning = null;
// Whether text struck out of a reading is shown in place, greyed and crossed
// through, so it can be judged and put back.
let showCut = false;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------------- data ---------------- */

async function loadData() {
  // The single-file build embeds the syllabus here so it works with no server.
  if (globalThis.__COURSES__) return globalThis.__COURSES__;
  const res = await fetch('./data/courses.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load the syllabus data (${res.status})`);
  return res.json();
}

function rebuild() {
  TASKS = S.buildTasks(DATA);
}

/** Refresh the set of materials that already have extracted text. */
async function loadExtractedIds() {
  try {
    extractedIds = new Set(await lib.listTextIds());
  } catch {
    extractedIds = new Set();
  }
}

/** The class meeting each course is currently working toward, with its plan. */
/** Reading whose class has already met and which was never ticked off. */
function lateWork(from = new Date()) {
  return S.overdue(
    TASKS.filter((t) => t.unit !== 'project'),
    { from }
  ).map((t) => ({ ...t, overdue: true }));
}

/** ...and the part of it the plan is currently being asked to carry. */
function carriedWork(from = new Date()) {
  return store.settings().carryOverdue ? lateWork(from) : [];
}

function currentPlans() {
  const late = carriedWork();
  return S.nextSessionPerCourse(DATA).map(({ course, session, date }) => {
    const slot = session.date || session.id;
    const tasks = TASKS.filter((t) => t.courseId === course.id && t.sessionDate === slot);
    const owed = late.filter((t) => t.courseId === course.id);
    // Pass the deadline with its hour attached: an evening class leaves the
    // class day itself available to read in.
    const deadline = S.withTime(date, S.classTimeFor(course));
    return {
      course,
      session,
      date,
      deadline,
      tasks,
      owed,
      // What you owe from last week is planned first, ahead of this week's
      // reading — otherwise it sits at the back of the queue for ever.
      plan: S.planFor([...owed, ...tasks], deadline),
      // Measured on this week's reading alone. What is owed from a class that
      // has already met is its own number, not a bigger version of this one.
      pace: S.pace(tasks, deadline, { windowStart: S.windowStartFor(course, session) })
    };
  });
}

function activeProjects(from = S.startOfToday()) {
  return TASKS.filter((t) => t.unit === 'project' && !t.complete)
    .map((t) => ({ task: t, pace: S.projectPace(t, from), overdue: Boolean(t.due) && S.dueAt(t) < new Date() }))
    .filter((p) => p.pace);
}

/** Everything the plan says to do today, flattened across courses. */
function todayBucket() {
  const today = S.startOfToday();
  const items = [];
  let minutes = 0;
  // How much of today is the reading you set out to do, and how much is making
  // up lost ground. Two things put you there — work from a class that has
  // already met, and days of this week's reading you did not get to — so both
  // are counted, and neither is counted twice.
  let catchUp = 0;
  for (const { course, plan, pace } of currentPlans()) {
    const day = plan.plan.find((d) => S.daysBetween(d.date, today) === 0);
    if (!day) continue;
    for (const atom of day.items) items.push({ ...atom, course });
    minutes += day.minutes;
    const owedToday = day.items.filter((a) => a.task.overdue).reduce((sum, a) => sum + a.minutes, 0);
    catchUp += owedToday + Math.max(0, day.minutes - owedToday - pace.evenPerDay);
  }
  const projects = activeProjects(today).filter((p) => p.pace.todayIsStudyDay);
  projects.forEach((p) => (minutes += p.pace.perDay));
  return { items, projects, minutes, catchUp, title: items.map((i) => i.task.title) };
}

/* ---------------- shared bits of markup ---------------- */

const dot = (color) => `<span class="dot" style="--dot:${esc(color)}"></span>`;

function pill(text, cls = '') {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

/** A labeled progress bar. Pass a workload() result, or a bare 0-100 number. */
function progressBar(w, { size = '', label = true } = {}) {
  const pct = typeof w === 'number' ? w : w.pct;
  const complete = typeof w === 'number' ? pct >= 100 : w.allDone || pct >= 100;
  return `
    <div class="progress ${size} ${complete ? 'is-complete' : ''}">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${label ? `<span class="progress-pct">${complete ? 'Done' : `${pct}%`}</span>` : ''}
    </div>`;
}

const MODE_LABELS = { 'in-person': 'in person', online: 'online', hybrid: 'hybrid' };

/** "6:00 PM", or "6:00 PM (assumed)" while the real time is unknown. */
function classTimeLabel(course, { short = false } = {}) {
  const time = S.classTimeFor(course);
  const shown = S.withTime(new Date(), time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!S.classTimeIsAssumed(course)) return shown;
  return short ? `${shown}?` : `${shown} (assumed)`;
}

function modePill(session) {
  const label = MODE_LABELS[session?.mode];
  return label ? pill(label, session.mode === 'online' ? 'accent' : '') : '';
}

const ICON_OPEN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;
const ICON_CLIP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.3-2.3l8.2-8.2"/></svg>`;

const ICON_READ = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5A9 9 0 0 1 12 7a9 9 0 0 1 9-1.5v12A9 9 0 0 0 12 19a9 9 0 0 0-9-1.5z"/><path d="M12 7v12"/></svg>`;

/**
 * The buttons on the right of a reading: read the text if we have it, and
 * open (or attach) the PDF itself.
 */
function materialButton(task) {
  if (task.kind !== 'reading') return '';
  const name = task.material || task.title;
  const id = lib.materialId(name);
  const entry = store.libraryEntry(id);

  // Carry the task along so the reader can remind you which pages are assigned.
  const read = extractedIds.has(id)
    ? `<button class="matbtn read" data-action="read-here" data-mat="${esc(id)}" data-key="${esc(task.key)}"
         title="Read ${esc(name)}" aria-label="Read ${esc(name)}">${ICON_READ}</button>`
    : '';

  const open = entry
    ? `<button class="matbtn has" data-action="open-material" data-mat="${esc(id)}"
         title="Open ${esc(entry.title)}" aria-label="Open ${esc(entry.title)}">${ICON_OPEN}</button>`
    : `<button class="matbtn" data-action="find-material" data-mat="${esc(id)}"
         title="Attach ${esc(name)}" aria-label="Attach ${esc(name)}">${ICON_CLIP}</button>`;

  return read + open;
}

/**
 * Start or stop the stopwatch on a piece of work.
 *
 * Only one thing runs at a time, and the elapsed figure is worked out from the
 * moment it started rather than counted up — so it keeps time while the app is
 * shut, backgrounded, or the phone is asleep, and comes back right.
 */
function timerButton(task) {
  const running = store.runningTimer();
  const mine = running && running.key === task.key;
  if (mine) {
    return `<button class="amount timer running" data-action="stop-timer" data-key="${esc(task.key)}">
              <span data-elapsed="${esc(running.startedAt)}">${esc(elapsedClock(running))}</span> ■
            </button>`;
  }
  return `<button class="amount timer" data-action="start-timer" data-key="${esc(task.key)}"
                  data-course="${esc(task.courseId)}" title="Start timing ${esc(task.title)}">▶ Start</button>`;
}

/**
 * Everything ever spent on one reading, kept beside the stopwatch.
 *
 * The stopwatch alone only ever answered "how long is this sitting" — the
 * moment you stopped it, the number was gone into the weekly total and the
 * reading itself had nothing to show for it. This is the other half: minutes
 * banked against this item since the first time you opened it, still counting
 * while the clock runs. Tap it to correct, for the evening you read on the bus
 * and forgot to start anything.
 */
function timeChip(task) {
  const running = store.runningTimer();
  const mine = running && running.key === task.key;
  const banked = store.totalOn(task.key);
  if (!banked && !mine) {
    return `<button class="amount clock ghost" data-action="edit-time" data-key="${esc(task.key)}"
                    title="Say how long you have spent on ${esc(task.title)}">+ time</button>`;
  }
  const shown = banked + (mine ? elapsedMinutes(running) : 0);
  return `<button class="amount clock ${mine ? 'running' : ''}" data-action="edit-time" data-key="${esc(task.key)}"
                  ${mine ? `data-total-base="${banked}" data-total-since="${esc(running.startedAt)}"` : ''}
                  title="Time spent on ${esc(task.title)} so far">${S.formatMinutes(shown)}</button>`;
}

/**
 * A finished sitting counts twice over: toward the week's measured total, which
 * the store has already recorded, and toward the item's own progress, so a paper
 * still shows how much of its estimate is behind you.
 */
function creditTime(banked) {
  // A burst you actually sat through is a burst done. Stopping the clock is the
  // only signal there is, so it ticks the box rather than asking for a second tap.
  if (store.isRhythmKey(banked.key)) {
    if (banked.minutes > 0) store.setRhythmDone(banked.key, true);
    return;
  }
  const task = TASKS.find((t) => t.key === banked.key);
  if (task?.unit === 'project') store.setProgress(banked.key, store.progressFor(banked.key) + banked.minutes);
}

/** What the stopwatch is on, in words — a reading's title, or which burst. */
function runningLabel(running, { withCourse = false } = {}) {
  if (store.isRhythmKey(running.key)) {
    const [, habitId, slot] = running.key.split('|');
    const habit = store.rhythm().find((h) => h.id === habitId);
    return `${habit?.title || 'memorisation'} · ${(store.SLOT_LABELS[slot] || slot).toLowerCase()}`;
  }
  const task = TASKS.find((t) => t.key === running.key);
  if (!task) return 'something';
  // Away from the row it was started on, "Bible reading" alone does not say
  // whose. The course is the one word that settles it.
  return withCourse && task.course ? `${task.title} · ${task.course}` : task.title;
}

/** Whole minutes on the clock for a running timer. */
function elapsedMinutes(running) {
  return Math.max(0, Math.round((Date.now() - new Date(running.startedAt).getTime()) / 60000));
}

/** The running figure, as a stopwatch reads: 4:07, or 1:04:07 past the hour. */
function elapsedClock(running) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(running.startedAt).getTime()) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(secs % 60)}` : `${m}:${pad(secs % 60)}`;
}

/**
 * The stopwatch, at the top of the screen, wherever you are.
 *
 * It used to live only on the row it was started from — so the moment you
 * scrolled past that row, changed tab, or opened the reader to actually do the
 * reading, there was nothing to tell you the clock was running or to stop it
 * with. Which is precisely when it matters: a stopwatch you cannot see is one
 * you leave running all night and one you forget to start again.
 *
 * The header is sticky already, so this rides along with it and is painted by
 * the same tick that moves every other elapsed figure.
 */
function paintRunningStrip() {
  const strip = $('#running-strip');
  if (!strip) return;
  const running = store.runningTimer();
  // No compensating for the header growing by the height of this strip: the
  // browser's own scroll anchoring already holds the content still and moves
  // the scroll offset to match, and adjusting it again on top of that moves the
  // page by exactly the amount it was supposed to be holding.
  if (!running) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.hidden = false;
  strip.innerHTML = `
    <span class="running-pulse" aria-hidden="true"></span>
    <span class="running-what">${esc(runningLabel(running, { withCourse: true }))}</span>
    <span class="running-clock" data-elapsed="${esc(running.startedAt)}">${esc(elapsedClock(running))}</span>
    <button class="btn small running-stop" data-action="stop-timer" data-key="${esc(running.key)}">Stop</button>`;
}

/**
 * Keep the running figure moving. Only the digits are repainted — redrawing the
 * whole view once a second is how you make a phone hot.
 */
let tick = null;
function watchTimer() {
  clearInterval(tick);
  tick = null;
  const running = store.runningTimer();
  if (!running) return;
  const paint = () => {
    const shown = elapsedClock(running);
    for (const el of document.querySelectorAll('[data-elapsed]')) el.textContent = shown;
    // The item's own total climbs with it, so the number you are watching is
    // the one that will still be there when you stop.
    const minutes = elapsedMinutes(running);
    for (const el of document.querySelectorAll('[data-total-base]')) {
      el.textContent = S.formatMinutes(Number(el.dataset.totalBase || 0) + minutes);
    }
  };
  paint();
  tick = setInterval(paint, 1000);
}

function taskLine(task, { showCourse = false, chunk = null, asPassage = false, withTimer = false, note = '', hideDriver = false } = {}) {
  const done = task.complete;
  // A part-way chunk is ticked once you have read past its last page. A whole
  // item is ticked only when it is marked done — page arithmetic cannot answer
  // it, because a Bible reading or a Greek passage has no page count at all,
  // and "0 pages read of 0" reads as finished. That is what made the Bible
  // reading permanently ticked, and impossible to untick.
  const ticked = chunk ? (chunk.whole ? done : task.read >= chunk.through) : done;
  const checked = ticked ? 'checked' : '';
  // Under a "Bible reading" heading the passage is the useful line, not the
  // words "Bible reading" repeated down the page.
  const title = asPassage && chunk?.label ? chunk.label : task.title;
  const detail = asPassage ? '' : chunk ? chunk.label : task.detail;
  const amount = chunk
    ? S.formatMinutes(chunk.minutes)
    : task.unit === 'project'
      ? S.formatMinutes(task.remaining || task.minutes)
      : S.amountLabel(task.raw, task.key);

  const attrs = chunk
    ? `data-action="chunk" data-key="${esc(task.key)}" data-from="${chunk.from}" data-through="${chunk.through}"
       data-total="${task.pages}" ${chunk.whole ? 'data-whole="1"' : ''}`
    : `data-action="toggle" data-key="${esc(task.key)}"`;

  const partial = !chunk && task.read > 0 && !done;
  const flags = [
    task.overdue ? pill('overdue', 'warn') : '',
    task.driver && !hideDriver ? pill('drives discussion', 'accent') : '',
    task.format === 'pdf' ? pill('PDF') : '',
    task.kind === 'assignment' && !task.project ? pill(task.type || 'assignment', 'warn') : '',
    task.project ? pill('project', 'warn') : '',
    task.estimated && task.unit === 'pages' ? pill('estimated', 'muted') : ''
  ]
    .filter(Boolean)
    .join('');

  return `
    <li class="task ${done ? 'is-done' : ''}">
      <label class="check">
        <input type="checkbox" ${checked} ${attrs}>
        <span class="box"></span>
      </label>
      <div class="task-body">
        <div class="task-title">
          ${showCourse ? dot(task.color) : ''}${esc(title)}
        </div>
        ${detail ? `<div class="task-detail">${esc(detail)}</div>` : ''}
        ${
          partial
            ? `<div class="task-detail muted">${task.read} of ${task.pages} ${task.unit === 'chapters' ? 'chapters' : 'pp.'} read</div>${progressBar(S.itemPct(task), { size: 'progress-sm' })}`
            : ''
        }
        ${note ? `<div class="task-detail muted">${esc(note)}</div>` : ''}
        ${task.flag ? `<div class="task-flag">⚠ ${esc(task.flag)}</div>` : ''}
        <div class="tags">${flags}</div>
      </div>
      ${materialButton(task)}
      <div class="task-actions">
        ${withTimer ? timeChip(task) : ''}
        ${withTimer ? timerButton(task) : ''}
        <button class="amount ${task.unit === 'pages' && !chunk ? 'editable' : ''}"
                ${task.unit === 'pages' && !chunk ? `data-action="edit-pages" data-key="${esc(task.key)}"` : 'disabled'}>
          ${esc(amount)}
        </button>
      </div>
    </li>`;
}

function dayRow(day, courseColor) {
  const isToday = S.daysBetween(day.date, S.startOfToday()) === 0;
  return `
    <div class="day ${isToday ? 'is-today' : ''} ${day.block === false ? 'is-off' : ''}">
      <div class="day-head">
        <span class="day-name">${isToday ? 'Today' : S.formatDate(day.date)}${
          day.block === false ? ' <span class="muted">· not a reading day</span>' : ''
        }</span>
        <span class="day-mins">${day.minutes ? S.formatMinutes(day.minutes) : '—'}</span>
      </div>
      <ul class="tasks">
        ${day.items.map((atom) => taskLine({ ...atom.task, color: courseColor }, { chunk: atom })).join('') || '<li class="empty">Nothing scheduled</li>'}
      </ul>
    </div>`;
}

/* ---------------- views ---------------- */

/**
 * How long you have actually worked this week.
 *
 * Everything else in the app is an estimate of how long something ought to
 * take. This is the only number that is measured, so it is kept separate and
 * plain: the total, where it went, and which days it happened on.
 */
function weekOfWorkCard() {
  const running = store.runningTimer();
  const week = S.weekOfWork(store.timeLog(), { running });
  if (!week.total && !running) {
    return `
      <section class="card">
        <h2>Time this week</h2>
        <p class="note">
          Nothing timed yet. Press <strong>▶ Start</strong> on a paper or project when you sit down
          to it, and the time lands here — the clock keeps running while the app is shut.
        </p>
      </section>`;
  }

  const named = new Map(DATA.courses.map((c) => [c.id, c]));
  const busiest = Math.max(1, ...week.byDay.map((d) => d.minutes));
  const today = S.startOfToday();

  return `
    <section class="card">
      <div class="card-head">
        <h2>Time this week</h2>
        <span class="card-when">since ${esc(S.formatDate(week.from))}</span>
      </div>
      <div class="week-total">${S.formatMinutes(week.total)}</div>
      ${
        running
          ? `<p class="note running-now">
               Running now on <strong>${esc(runningLabel(running))}</strong> —
               <span data-elapsed="${esc(running.startedAt)}">${esc(elapsedClock(running))}</span>.
               <button class="btn small" data-action="stop-timer" data-key="${esc(running.key)}">Stop</button>
             </p>`
          : ''
      }
      <div class="week-days">
        ${week.byDay
          .map((d) => {
            const isToday = S.daysBetween(d.date, today) === 0;
            return `
          <div class="week-day ${isToday ? 'is-today' : ''}" title="${esc(S.formatDate(d.date))}: ${esc(S.formatMinutes(d.minutes))}">
            <div class="week-bar"><div style="height:${Math.round((d.minutes / busiest) * 100)}%"></div></div>
            <small>${esc(S.formatDate(d.date, { weekday: 'narrow' }))}</small>
          </div>`;
          })
          .join('')}
      </div>
      ${
        week.byCourse.size
          ? `<ul class="week-courses">
               ${[...week.byCourse.entries()]
                 .sort((a, b) => b[1] - a[1])
                 .map(([id, minutes]) => {
                   const course = named.get(id);
                   return `<li>${course ? dot(course.color) : ''}${esc(course?.short || course?.name || 'Other')}
                           <span>${esc(S.formatMinutes(minutes))}</span></li>`;
                 })
                 .join('')}
             </ul>`
          : ''
      }
    </section>`;
}

const courseById = (id) => DATA?.courses.find((c) => c.id === id) || null;

/**
 * One burst: a box to tick and a clock to run.
 *
 * Both, rather than one or the other. The box is the honest minimum — you did
 * it, you say so — and the clock is for when you want to know whether "a few
 * minutes" was four or fourteen. Timing a burst ticks it when you stop, so the
 * two never disagree; ticking by hand leaves the clock alone.
 */
function slotRow(s, habit, burst) {
  const running = store.runningTimer();
  const mine = running && running.key === s.key;
  const label = store.SLOT_LABELS[s.slot] || s.slot;
  // Once you are past the goal the goal stops being news — "12 min of 10 min"
  // is a worse way of saying "12 min".
  const shown = !s.minutes
    ? ''
    : s.met || !burst
      ? S.formatMinutes(s.minutes)
      : `${S.formatMinutes(s.minutes)} of ${S.formatMinutes(burst)}`;

  return `
    <li class="slot ${s.done ? 'on' : ''} ${mine ? 'is-running' : ''}">
      <button class="slot-tick" data-action="tick-rhythm" data-rkey="${esc(s.key)}" aria-pressed="${s.done}">
        <span class="slot-box" aria-hidden="true">${s.done ? '✓' : ''}</span>
        <span>${esc(label)}</span>
      </button>
      <span class="slot-mins ${s.met ? 'met' : ''}">${esc(shown)}</span>
      ${
        mine
          ? `<button class="amount timer running" data-action="stop-timer" data-key="${esc(s.key)}">
               <span data-elapsed="${esc(running.startedAt)}">${esc(elapsedClock(running))}</span> ■
             </button>`
          : `<button class="amount timer" data-action="start-timer" data-key="${esc(s.key)}"
                     data-course="${esc(habit.courseId || '')}"
                     title="Time this ${esc(label.toLowerCase())} burst of ${esc(habit.title)}">▶ Start</button>`
      }
    </li>`;
}

/** How much reading a given day is carrying, across every class. */
function loadOn(date) {
  let minutes = 0;
  for (const { plan } of currentPlans()) {
    const day = plan.plan.find((d) => S.daysBetween(d.date, date) === 0);
    if (day) minutes += day.minutes;
  }
  return minutes;
}

/**
 * The two rhythms the term actually runs on.
 *
 * Greek is a language, so it goes in small daily doses — a few minutes in the
 * morning, a few in the afternoon, a few in the evening — and the only thing
 * asked of you is to tick the box. Reading is the opposite: it does not survive
 * being sliced into twenty minutes a night, so it is blocked into whole days
 * you sit down and get after it.
 *
 * Nothing in here is a deadline and nothing here goes red. A missed slot is a
 * missed slot; the streak picks up again tomorrow.
 */
function rhythmCard() {
  const habits = store.rhythm();
  const today = S.startOfToday();
  const r = S.rhythmProgress(store.rhythmLog(), habits, { from: today, timeLog: store.timeLog() });
  const blockDays = store.settings().studyDays;
  const next = S.nextBlockDay(today, blockDays);
  const isBlockToday = next && S.daysBetween(next, today) === 0;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const habitList = habits.length
    ? `<ul class="rhythm-habits">
         ${r.today
           .map(
             ({ habit, slots, done, total, burst, minutes, target }) => `
           <li class="rhythm-habit">
             <div class="rhythm-habit-head">
               <span class="rhythm-habit-title">${habit.courseId && courseById(habit.courseId) ? dot(courseById(habit.courseId).color) : ''}${esc(habit.title)}</span>
               <span class="muted">${done}/${total}${
                 minutes > 0 ? ` · ${S.formatMinutes(minutes)}${target ? ` of ${S.formatMinutes(target)}` : ''}` : ''
               }</span>
             </div>
             ${habit.detail ? `<div class="task-detail">${esc(habit.detail)}</div>` : ''}
             <ul class="slots">
               ${slots.map((s) => slotRow(s, habit, burst)).join('')}
             </ul>
           </li>`
           )
           .join('')}
       </ul>
       <div class="rhythm-week" role="img" aria-label="The last seven days">
         ${r.week
           .map((d) => {
             const state = !d.total ? 'none' : d.done === d.total ? 'full' : d.done ? 'some' : 'none';
             const isToday = S.daysBetween(d.date, today) === 0;
             return `<span class="rhythm-dot is-${state} ${isToday ? 'is-today' : ''}"
                           title="${esc(S.formatDate(d.date))}: ${d.done} of ${d.total}"></span>`;
           })
           .join('')}
         <small class="muted">${r.streak ? `${r.streak} day${r.streak === 1 ? '' : 's'} running` : 'start whenever'}</small>
       </div>`
    : `<p class="note">No daily habits set. Add one in Settings — a few minutes of vocabulary is plenty.</p>`;

  const load = next ? loadOn(next) : 0;
  const blockLine = !next
    ? 'No reading days set, so the books are spread over every day. Pick your days in Settings.'
    : isBlockToday
      ? `<strong>Today is a reading day.</strong> ${load ? `${S.formatMinutes(load)} of reading is blocked in — sit down and get after it.` : 'Nothing left on it.'}`
      : `Next reading block: <strong>${esc(S.formatDate(next, { weekday: 'long' }))}</strong>${
          load ? ` · ${S.formatMinutes(load)}` : ''
        }. The books wait for it; only the Bible reading carries on daily.`;

  // Blocking a week into one day is the point, but a block nobody could sit
  // through is worth saying out loud once, without turning it into a warning
  // you have to dismiss. It is stated, not flagged red.
  const TOO_LONG = 6 * 60;
  const overloaded = load > TOO_LONG && blockDays.length < 4;

  return `
    <section class="card rhythm">
      <div class="card-head">
        <h2>Rhythm</h2>
        <span class="card-when">${r.todayTotal ? `${r.todayDone}/${r.todayTotal} today` : ''}</span>
      </div>
      ${habitList}
      <div class="rhythm-block">
        <div class="rhythm-block-days">
          ${dayNames
            .map((n, i) => `<span class="rhythm-day ${blockDays.includes(i) ? 'on' : ''}">${n}</span>`)
            .join('')}
        </div>
        <p class="note">${blockLine}</p>
        ${
          overloaded
            ? `<p class="note">
                 ${S.formatMinutes(load)} is more than one sitting holds. Your call: take it as a long
                 haul, or tick another day in Settings and the app spreads it out.
               </p>`
            : ''
        }
      </div>
    </section>`;
}

/**
 * What to say when you are behind.
 *
 * The plan has already absorbed the missed reading — it re-spreads whatever is
 * left over the days that remain, every time it is drawn. What it never did was
 * say so, which made today's larger number look arbitrary. This is the card that
 * explains it, and the place unfinished work from a class that has already met
 * gets picked up rather than quietly dropped.
 */
/**
 * The week as one thing, aimed at a day rather than at the classes.
 *
 * Both classes meet on Tuesday, so left to itself the plan runs the reading
 * right up to Tuesday evening — which is how a week ends with Monday night
 * holding four hours of Bavinck. The finish line is the fix: everything for
 * both courses lands by Saturday, and Sunday and Monday are what is left over
 * if it does not. This card is that week in one place — how much is left,
 * how it falls across the days, and the whole list of it for both courses.
 */
function weekAimCard(allPlans) {
  // The courses that meet every week. What you arrange yourself has its own
  // checklist further down and is deliberately not part of this number.
  const plans = allPlans.filter((p) => !p.course.datesUnknown);
  if (!plans.length) return '';
  const today = S.startOfToday();
  const target = plans.map((p) => p.plan.target).sort((a, b) => a - b)[0];
  const aimed = plans.some((p) => p.plan.finishLine);
  const all = plans.flatMap((p) => [...p.owed, ...p.tasks]);
  const w = S.workload(all);
  const dayName = S.formatDate(target, { weekday: 'long' });
  const until = S.daysBetween(today, target);

  if (!w.remaining) {
    return `
      <section class="card week-aim done">
        <div class="card-head">
          <h2>Done by ${esc(dayName)}</h2>
          <span class="card-when">${esc(S.formatDate(target))}</span>
        </div>
        <p class="note">
          Everything for both classes is ticked off, ${until >= 0 ? `and ${esc(dayName)} has not even arrived` : 'ahead of the class'}.
          Nothing is owed until the next round of reading opens up.
        </p>
      </section>`;
  }

  // One row per day, both courses added together: the question this answers is
  // "what does Thursday look like", not "what does Thursday look like for Greek".
  const byDay = new Map();
  for (const p of plans) {
    for (const day of p.plan.plan) {
      const iso = S.toISO(day.date);
      const row = byDay.get(iso) || { date: day.date, minutes: 0, block: false };
      row.minutes += day.minutes;
      row.block = row.block || day.block;
      byDay.set(iso, row);
    }
  }
  const strip = [...byDay.values()].sort((a, b) => a.date - b.date);
  const blocks = strip.filter((d) => d.block).length || 1;

  const outstanding = all.filter((t) => !t.complete);
  const counts = [
    [outstanding.filter((t) => t.kind === 'reading').length, 'readings'],
    [outstanding.filter((t) => t.kind === 'bible').length, 'Bible readings'],
    [outstanding.filter((t) => t.kind === 'assignment').length, 'assignments']
  ].filter(([n]) => n > 0);

  return `
    <section class="card week-aim">
      <div class="card-head">
        <h2>Done by ${esc(dayName)}</h2>
        <span class="card-when">${esc(S.formatDate(target))} · ${esc(S.relativeDay(target).toLowerCase())}</span>
      </div>
      <p class="note">
        ${
          aimed
            ? `Everything for both classes, finished by ${esc(dayName)} rather than by the class itself —
               ${esc(S.formatDate(plans[0].deadline))} is the deadline, this is the plan.`
            : `${esc(dayName)} is as late as this week goes, so this is what is left of it.`
        }
        ${counts.length ? `Still to do: ${esc(counts.map(([n, label]) => `${n} ${label}`).join(', '))}.` : ''}
      </p>
      <div class="stats">
        <div><span class="stat">${S.formatMinutes(w.remaining)}</span><small>left this week</small></div>
        <div><span class="stat">${S.formatMinutes(w.remaining / blocks)}</span><small>a day to get there</small></div>
        <div><span class="stat">${blocks}</span><small>reading ${blocks === 1 ? 'day' : 'days'} left</small></div>
      </div>
      ${progressBar(w)}
      <div class="week-strip">
        ${strip
          .map((day) => {
            const isToday = S.daysBetween(day.date, today) === 0;
            const isTarget = S.daysBetween(day.date, target) === 0;
            return `
            <div class="week-day ${isToday ? 'is-today' : ''} ${day.block ? '' : 'is-off'} ${isTarget ? 'is-target' : ''}">
              <span class="week-day-name">${esc(S.formatDate(day.date, { weekday: 'short' }))}</span>
              <span class="week-day-mins">${day.minutes ? S.formatMinutes(day.minutes) : '—'}</span>
            </div>`;
          })
          .join('')}
      </div>
      <div class="week-courses">
        ${plans
          .map(({ course, session, date, owed, tasks }) => {
            const cw = S.workload([...owed, ...tasks]);
            return `
            <div class="course-progress">
              <div class="course-progress-head">
                <span>${dot(course.color)}${esc(course.short || course.name)}</span>
                <span class="muted">${cw.remaining ? `${S.formatMinutes(cw.remaining)} left` : 'done'} · ${esc(S.formatDate(date))}</span>
              </div>
              ${progressBar(cw, { size: 'progress-sm' })}
            </div>`;
          })
          .join('')}
      </div>
      <details class="all-readings">
        <summary>Everything to finish by ${esc(dayName)} (${outstanding.length})</summary>
        <ul class="tasks">${outstanding.map((t) => taskLine(t, { showCourse: true, withTimer: true })).join('')}</ul>
      </details>
    </section>`;
}

/**
 * The reading the class is actually built on.
 *
 * The syllabus underlines one reading a week — the one the seminar discusses,
 * the one you will be asked about. The plan, quite correctly, does not care: it
 * spreads the week's pages over the days you have, puts what you already owe
 * ahead of what you do not yet, and if that leaves the underlined reading on
 * Friday then Friday is where it goes. Which is fine as arithmetic and useless
 * on a Thursday evening, when the thing you want is not "what does the plan say
 * to do now" but "where is the Swain chapter, so I can start".
 *
 * So it gets a place of its own, whatever day it has been planned for, with the
 * stopwatch on it.
 */
function driverCard(plans) {
  const groups = plans
    .filter((p) => !p.course.datesUnknown)
    .map(({ course, session, date, tasks, plan }) => {
      const drivers = tasks.filter((t) => t.driver && !t.complete);
      // Which day the plan has put each one on, so the two do not contradict
      // each other: this is a shortcut to the reading, not a second schedule.
      const dayOf = (task) => {
        const day = plan.plan.find((d) => d.items.some((a) => a.task.key === task.key));
        if (!day) return null;
        return S.daysBetween(day.date, S.startOfToday()) === 0 ? 'today' : S.formatDate(day.date);
      };
      return { course, session, date, drivers, dayOf };
    })
    .filter((g) => g.drivers.length);
  if (!groups.length) return '';

  return `
    <section class="card driver">
      <div class="card-head">
        <h2>Drives the discussion</h2>
        <span class="card-when">underlined in the syllabus</span>
      </div>
      ${groups
        .map(
          ({ course, session, date, drivers, dayOf }) => `
        <div class="driver-group">
          <div class="course-progress-head">
            <span>${dot(course.color)}${esc(course.short || course.name)} — ${esc(session.topic)}</span>
            <span class="muted">${esc(S.relativeDay(date))}</span>
          </div>
          <ul class="tasks">
            ${drivers
              .map((t) => {
                const day = dayOf(t);
                // The pill would only repeat the heading it is sitting under.
                return taskLine(t, { withTimer: true, hideDriver: true, note: day ? `planned for ${day}` : '' });
              })
              .join('')}
          </ul>
        </div>`
        )
        .join('')}
    </section>`;
}

/**
 * What has been set aside, and how to get it back.
 *
 * Deciding not to catch up is a legitimate decision — a fortnight of reading
 * from classes that have already met will otherwise fill every day between here
 * and Tuesday and bury the chapter the seminar is actually on. But work that
 * has quietly stopped being mentioned is work you cannot trust the app about,
 * so nothing is deleted and nothing goes unsaid: it is counted here, listed
 * behind one tap, still tickable, and one button brings all of it back.
 */
function setAsideCard() {
  if (store.settings().carryOverdue) return '';
  const late = lateWork();
  if (!late.length) return '';
  const minutes = late.reduce((sum, t) => sum + t.remaining, 0);
  const id = 'set-aside';
  // Shut unless you have opened it before: out of the way is the point of it.
  const shut = store.settings().collapsed?.[id] !== false;

  return `
    <details class="card fold set-aside" ${shut ? '' : 'open'}>
      <summary data-collapse="${esc(id)}">
        <span class="fold-title">Set aside</span>
        <span class="card-when">${late.length} from classes already past · ${S.formatMinutes(minutes)}</span>
      </summary>
      <p class="note">
        Out of the plan and out of this week's total, but not gone: tick any of it off here, or
        bring the lot back into the plan.
      </p>
      <ul class="tasks">${late.map((t) => taskLine(t, { showCourse: true, withTimer: true })).join('')}</ul>
      <button class="btn ghost" data-action="toggle-carry">Bring these back into the plan</button>
    </details>`;
}

function catchUpCard(plans, projects) {
  const slipping = plans.filter((p) => !p.pace.onTrack && p.pace.behind > 0);
  const owed = plans.flatMap((p) => p.owed);
  const lateProjects = projects.filter((p) => p.overdue);
  if (!slipping.length && !owed.length && !lateProjects.length) return '';

  return `
    <section class="card catchup">
      <h2>Catching up</h2>
      ${slipping
        .map(
          (p) => `
        <p class="note">
          ${dot(p.course.color)}<strong>${esc(p.course.short || p.course.name)}</strong> —
          about ${S.formatMinutes(p.pace.behind)} behind${p.pace.daysMissed >= 1 ? `, roughly ${p.pace.daysMissed} study ${p.pace.daysMissed === 1 ? 'day' : 'days'}` : ''}.
          The missed pages are already spread across the ${p.pace.daysLeft}
          ${p.pace.daysLeft === 1 ? 'day' : 'days'} you have left, not piled onto today: that works out
          at <strong>${S.formatMinutes(p.pace.perDayNow)}</strong> a day against the
          ${S.formatMinutes(p.pace.evenPerDay)} you started at. The Plan tab has the day-by-day, which
          varies a little either side of that to break at real page boundaries.
        </p>`
        )
        .join('')}
      ${
        owed.length
          ? `<p class="note warn-note">
               ${owed.length} reading${owed.length === 1 ? '' : 's'} from a class that has already met
               ${owed.length === 1 ? 'is' : 'are'} still unticked, so ${owed.length === 1 ? 'it is' : 'they are'}
               planned ahead of this week's work — or tick ${owed.length === 1 ? 'it' : 'them'} off here if
               you are letting ${owed.length === 1 ? 'it' : 'them'} go.
             </p>
             <ul class="tasks">${owed.map((t) => taskLine(t, { showCourse: true })).join('')}</ul>
             <button class="btn ghost" data-action="toggle-carry">
               Set these aside and plan only what is ahead
             </button>`
          : ''
      }
      ${
        lateProjects.length
          ? `<p class="note warn-note">Past its due date:
               ${lateProjects.map((p) => esc(p.task.title)).join(', ')}.</p>`
          : ''
      }
    </section>`;
}

/**
 * Today's reading, split up the way an evening actually goes.
 *
 * One undifferentiated list meant scanning past Greek to find whether there was
 * theology, and the Bible reading sat somewhere in the middle of it. Each course
 * gets its own block, in the order the classes meet — Greek at five, theology at
 * seven — and the Bible reading stands on its own beneath the course that sets
 * it, one passage a day rather than a week's worth on one line.
 */
function todaySections(bucket) {
  if (!bucket.items.length) return '';

  const groups = new Map();
  for (const atom of bucket.items) {
    const scripture = atom.task.kind === 'bible';
    const key = `${atom.course.id}${scripture ? ':bible' : ''}`;
    if (!groups.has(key)) groups.set(key, { course: atom.course, scripture, items: [] });
    groups.get(key).items.push(atom);
  }

  // Earlier class first, and within a course its Bible reading comes after the
  // books it belongs with.
  const courses = [...new Set(bucket.items.map((a) => a.course))].sort((a, b) =>
    S.classTimeFor(a).localeCompare(S.classTimeFor(b))
  );
  const ordered = [];
  for (const course of courses) {
    for (const suffix of ['', ':bible']) {
      const group = groups.get(`${course.id}${suffix}`);
      if (group) ordered.push(group);
    }
  }

  return ordered
    .map(({ course, scripture, items }) => {
      const minutes = items.reduce((sum, a) => sum + a.minutes, 0);
      return `
      <section class="card today-group">
        <div class="card-head">
          <h2>${dot(course.color)}${scripture ? 'Bible reading' : esc(course.name)}</h2>
          <span class="card-when">${scripture ? esc(course.short || course.name) + ' · ' : ''}${S.formatMinutes(minutes)}</span>
        </div>
        <ul class="tasks">
          ${items.map((a) => taskLine({ ...a.task, color: course.color }, { chunk: a, asPassage: scripture, withTimer: true })).join('')}
        </ul>
      </section>`;
    })
    .join('');
}

function viewToday() {
  const bucket = todayBucket();
  const upcoming = S.deadlines(TASKS, { withinDays: store.settings().leadDays });
  const soon = S.deadlines(TASKS, { withinDays: 21 }).filter((g) => g.daysUntil > store.settings().leadDays);

  const plans = currentPlans();
  const overall = S.workload(plans.flatMap((p) => p.tasks));

  return `
    <section class="hero">
      <div class="hero-date">${esc(S.formatDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
      <div class="hero-mins">${bucket.minutes ? S.formatMinutes(bucket.minutes) : 'Nothing due'}</div>
      <div class="hero-sub">
        ${bucket.minutes ? "today's reading target" : 'enjoy the quiet'}
        ${bucket.catchUp >= 5 ? ` · ${S.formatMinutes(bucket.catchUp)} of it catching up` : ''}
      </div>
      <div class="bar"><div class="bar-fill" style="width:${overall.pct}%"></div></div>
      <div class="hero-sub">${overall.pct}% of this week's work done</div>
    </section>

    ${weekAimCard(plans)}

    ${driverCard(plans)}

    ${catchUpCard(plans, activeProjects())}

    ${rhythmCard()}
    ${todaySections(bucket)}
    ${weekOfWorkCard()}
    ${setAsideCard()}
    ${arrangedSection({ collapsible: true })}

    ${
      bucket.projects.length
        ? `<section class="card">
             <h2>Chip away at</h2>
             <ul class="tasks">
               ${bucket.projects
                 .map(
                   ({ task, pace }) => `
                 <li class="task">
                   <div class="task-body">
                     <div class="task-title">${dot(task.color)}${esc(task.title)}</div>
                     <div class="task-detail">${esc(task.courseName)} · due ${esc(S.formatDate(S.dueAt(task)))} · ${S.formatMinutes(task.remaining)} left over ${pace.days} study days</div>
                   </div>
                   <div class="task-actions">
                     ${timerButton(task)}
                     <button class="amount editable" data-action="log-project" data-key="${esc(task.key)}">+${S.formatMinutes(pace.perDay)}</button>
                   </div>
                 </li>`
                 )
                 .join('')}
             </ul>
           </section>`
        : ''
    }

    <section class="card">
      <h2>Due within ${store.settings().leadDays} days</h2>
      ${upcoming.length ? upcoming.map(deadlineRow).join('') : '<p class="empty">Nothing due in this window.</p>'}
    </section>

    ${
      soon.length
        ? `<section class="card">
             <h2>On the horizon</h2>
             ${soon.map(deadlineRow).join('')}
           </section>`
        : ''
    }`;
}

function deadlineRow(g) {
  const w = S.workload(g.tasks);
  const urgent = g.daysUntil <= 1 ? 'urgent' : g.daysUntil <= 3 ? 'soon' : '';
  const assignments = g.tasks.filter((t) => t.kind === 'assignment');
  return `
    <div class="deadline ${urgent}">
      <div class="deadline-when">
        <strong>${esc(S.relativeDay(g.date))}</strong>
        <span>${esc(S.formatDate(g.date))}</span>
        <span>${esc(g.date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}${g.timeAssumed ? '?' : ''}</span>
      </div>
      <div class="deadline-body">
        <div class="deadline-title">${dot(g.color)}${esc(g.courseName)} — ${esc(g.topic)}</div>
        <div class="deadline-detail">
          ${w.remaining ? `${S.formatMinutes(w.remaining)} of work left` : 'All done'}
          ${assignments.length ? ` · ${esc(assignments.map((a) => a.title).join(', '))}` : ''}
        </div>
        ${progressBar(w, { size: 'progress-sm' })}
      </div>
    </div>`;
}

function viewPlan() {
  const plans = currentPlans();
  const projects = activeProjects();

  return `
    ${plans
      .map(({ course, session, date, tasks, owed, plan, pace }) => {
        const all = [...owed, ...tasks];
        const w = S.workload(all);
        const pages = all.reduce((a, t) => a + (t.unit === 'pages' ? t.pages : 0), 0);
        const pagesLeft = all.reduce((a, t) => a + (t.unit === 'pages' ? t.remainingPages : 0), 0);
        return `
        <section class="card">
          <div class="card-head" style="--accent:${esc(course.color)}">
            <h2>${dot(course.color)}${esc(course.name)}</h2>
            <span class="card-when">${esc(S.relativeDay(date))} · ${esc(S.formatDate(date))}, ${esc(classTimeLabel(course))}</span>
          </div>
          <p class="topic">${esc(session.topic)}</p>
          <div class="tags">${modePill(session)}</div>
          ${progressBar(w)}
          <div class="stats">
            <div><span class="stat">${pagesLeft}</span><small>pages left of ${pages}</small></div>
            <div><span class="stat">${S.formatMinutes(w.remaining)}</span><small>of ${S.formatMinutes(w.total)}</small></div>
            <div><span class="stat">${plan.days}</span><small>reading days</small></div>
            <div><span class="stat">${S.formatMinutes(plan.perDay)}</span><small>per day</small></div>
          </div>
          ${
            plan.finishLine
              ? `<p class="note">
                   Aimed at <strong>${esc(S.formatDate(plan.target))}</strong>, not at the class.
                   ${esc(S.formatDate(date))} is when it is due; this is when it is meant to be done,
                   which leaves the days between as margin rather than as the plan.
                 </p>`
              : ''
          }
          <p class="note pace ${pace.onTrack && !owed.length ? 'ok' : 'behind'}">
            ${
              owed.length
                ? `${owed.length} reading${owed.length === 1 ? '' : 's'} still owed from a class already past,
                   planned before this week's. This week's own reading is
                   ${pace.onTrack ? 'on pace' : `${S.formatMinutes(pace.behind)} behind`}.`
                : pace.onTrack
                  ? `On pace — ${S.formatMinutes(pace.evenPerDay)} a day was the plan and it still is.`
                  : `${S.formatMinutes(pace.behind)} behind. Started at ${S.formatMinutes(pace.evenPerDay)} a day;
                     ${S.formatMinutes(pace.perDayNow)} a day now over the ${pace.daysLeft}
                     ${pace.daysLeft === 1 ? 'day' : 'days'} left.`
            }
          </p>
          <div class="days">${plan.plan.map((d) => dayRow(d, course.color)).join('')}</div>
          <details class="all-readings">
            <summary>Everything due for this class (${all.length})</summary>
            <ul class="tasks">${all.map((t) => taskLine(t)).join('')}</ul>
          </details>
        </section>`;
      })
      .join('')}

    ${
      projects.length
        ? `<section class="card">
            <h2>Long-run work</h2>
            <ul class="tasks">
              ${projects
                .map(
                  ({ task, pace }) => `
                <li class="task">
                  <label class="check">
                    <input type="checkbox" data-action="toggle" data-key="${esc(task.key)}" ${task.complete ? 'checked' : ''}>
                    <span class="box"></span>
                  </label>
                  <div class="task-body">
                    <div class="task-title">${dot(task.color)}${esc(task.title)}</div>
                    <div class="task-detail">${esc(task.courseName)} · due ${esc(S.formatDate(S.dueAt(task)))} (${esc(S.relativeDay(S.dueAt(task)))})</div>
                    <div class="task-detail muted">${S.formatMinutes(task.read)} logged · ${S.formatMinutes(task.remaining)} left · aim for ${S.formatMinutes(pace.perDay)}/day</div>
                  </div>
                  <div class="task-actions">
                    ${timerButton(task)}
                    <button class="amount editable" data-action="log-project" data-key="${esc(task.key)}">log</button>
                  </div>
                </li>`
                )
                .join('')}
            </ul>
          </section>`
        : ''
    }

    ${laterClassesCard()}`;
}

/**
 * The classes after the one being planned for.
 *
 * The plan deliberately looks exactly one class ahead per course: that is the
 * work that has a deadline you can be behind on, and pacing anything further
 * would be pretending to know how the week goes. But looking ahead and working
 * ahead are different things, and an evening when the week's reading is done —
 * or when you simply want it out of the way — had nowhere to go. Next week's
 * reading existed only in the Schedule, which lists it and lets you do nothing
 * with it: no tick, no stopwatch, no way in to the PDF.
 *
 * So here it is, foldable and out of the way, with everything a reading carries
 * anywhere else. It is not paced and does not count toward the week's target;
 * ticking something off here simply means it is done when its week arrives.
 */
function laterClassesCard() {
  const perCourse = new Map();
  for (const { course, session, date } of S.upcomingSessions(DATA)) {
    if (course.datesUnknown) continue;
    const list = perCourse.get(course.id) || [];
    // The first upcoming class per course is the one planned in full above.
    if (list.length <= AHEAD) list.push({ course, session, date });
    perCourse.set(course.id, list);
  }

  const later = [...perCourse.values()]
    .flatMap((list) => list.slice(1))
    .sort((a, b) => a.date - b.date || a.course.id.localeCompare(b.course.id));
  if (!later.length) return '';

  return `
    <section class="card">
      <div class="card-head">
        <h2>Working ahead</h2>
        <span class="card-when">not counted toward this week</span>
      </div>
      <p class="note">
        The classes after the one above. Nothing here is paced or owed yet — it is here so a
        good evening can be spent on next week rather than stopping at the edge of this one.
        Tick it off and it stays ticked off when its week comes round.
      </p>
      ${later
        .map(({ course, session, date }) => {
          const slot = session.date || session.id;
          const tasks = TASKS.filter((t) => t.courseId === course.id && t.sessionDate === slot);
          if (!tasks.length) return '';
          const w = S.workload(tasks);
          const id = `ahead:${course.id}:${slot}`;
          const shut = store.isCollapsed(id);
          return `
        <details class="fold ahead" ${shut ? '' : 'open'}>
          <summary data-collapse="${esc(id)}">
            <span class="fold-title">${dot(course.color)}${esc(course.short || course.name)} — ${esc(session.topic)}</span>
            <span class="card-when">
              ${esc(S.formatDate(date))}${w.remaining ? ` · ${S.formatMinutes(w.remaining)}` : ' · done'}
            </span>
          </summary>
          <ul class="tasks">${tasks.map((t) => taskLine(t, { withTimer: true })).join('')}</ul>
        </details>`;
        })
        .join('')}
      <p class="note">The whole term is in the Schedule tab.</p>
    </section>`;
}

function viewSchedule() {
  const today = S.startOfToday();
  const rows = [];
  for (const course of DATA.courses) {
    for (const session of course.sessions) {
      const when = S.sessionDate(course, session);
      if (!when) continue;
      rows.push({ course, session, date: S.parseDate(when) });
    }
  }
  rows.sort((a, b) => a.date - b.date || a.course.id.localeCompare(b.course.id));

  return `
    <section class="card">
      <h2>${esc(DATA.term)} — full schedule</h2>
      <div class="schedule">
        ${rows
          .map(({ course, session, date }) => {
            const past = date < today;
            const tasks = TASKS.filter((t) => t.courseId === course.id && t.sessionDate === (session.date || session.id));
            const w = S.workload(tasks);
            const pages = tasks.reduce((a, t) => a + (t.unit === 'pages' ? t.pages : 0), 0);
            return `
            <details class="sched-item ${past ? 'is-past' : ''}" ${S.daysBetween(today, date) >= 0 && S.daysBetween(today, date) <= 7 ? 'open' : ''}>
              <summary>
                <span class="sched-date">${esc(S.formatDate(date, { month: 'short', day: 'numeric' }))}</span>
                <span class="sched-course">${dot(course.color)}${esc(course.short)}</span>
                <span class="sched-topic">${esc(session.topic)}${session.mode ? ` <em class="sched-mode">${esc(MODE_LABELS[session.mode])}</em>` : ''}</span>
                <span class="sched-load">${pages ? `${pages} pp.` : ''}${w.total ? ` · ${S.formatMinutes(w.total)}` : ''}</span>
                ${w.total ? `<span class="sched-progress">${progressBar(w, { size: 'progress-sm', label: false })}</span>` : ''}
              </summary>
              <ul class="tasks">${tasks.map((t) => taskLine(t)).join('') || '<li class="empty">No work listed.</li>'}</ul>
            </details>`;
          })
          .join('')}
      </div>
    </section>
    ${arrangedSection()}`;
}

/** Every distinct work assigned this term, with where it is used. */
function materials() {
  const map = new Map();
  for (const t of TASKS) {
    if (t.kind !== 'reading') continue;
    const name = t.material || t.title;
    const id = lib.materialId(name);
    if (!map.has(id)) {
      map.set(id, { id, name, courses: new Set(), uses: 0, isPdf: false, nextDue: null, items: [] });
    }
    const m = map.get(id);
    m.courses.add(t.course);
    m.uses += 1;
    // Which readings are actually inside this book. Without them a row says
    // only "Christian Dogmatics, used in 3 classes", and the chapter you have
    // been told to read for Tuesday — Swain's, chapter four — is nowhere on the
    // page you attach it from.
    m.items.push(t);
    if (t.format === 'pdf') m.isPdf = true;
    // Undated work has no "next" — it stays out of this ordering entirely.
    const due = t.due ? S.parseDate(t.due) : null;
    if (due && !t.complete && due >= S.startOfToday() && (!m.nextDue || due < m.nextDue)) m.nextDue = due;
  }
  return [...map.values()].sort((a, b) => {
    if (a.nextDue && b.nextDue && +a.nextDue !== +b.nextDue) return a.nextDue - b.nextDue;
    if (a.nextDue && !b.nextDue) return -1;
    if (!a.nextDue && b.nextDue) return 1;
    return a.name.localeCompare(b.name);
  });
}

// Which materials already have text pulled out of them. Filled asynchronously
// before the Files view renders, because IndexedDB cannot be read inline.
let extractedIds = new Set();

/** "Read text" once text exists, "Get text" for a PDF we could read. */
/**
 * The readings a book holds, listed on the book.
 *
 * A collection is filed under its own title, and the chapters inside it are
 * filed under the people who wrote them — so the volume called "Christian
 * Dogmatics" is where you find Swain on the Trinity, and nothing on the shelf
 * says so. That is fine in a library, where you have the book in your hand, and
 * useless here, where this row is the only thing standing between the syllabus
 * and the PDF you are about to attach and read.
 *
 * Ordered by when each is wanted, so the one you are reading for Tuesday is at
 * the top rather than in syllabus order.
 */
function materialReadings(m, entry) {
  if (!m.items.length) return '';
  const today = S.startOfToday();
  const when = (t) => (t.due ? S.parseDate(t.due).getTime() : Infinity);
  const items = m.items.slice().sort((a, b) => {
    const past = (t) => (t.due && S.parseDate(t.due) < today ? 1 : 0);
    return past(a) - past(b) || when(a) - when(b) || a.order - b.order;
  });
  const readable = entry?.kind === 'file' && extractedIds.has(m.id);

  // A Greek grammar is assigned fourteen times over a term. The next few are
  // what anyone is looking at this row for; the rest fold away.
  const SHOWN = 4;
  const line = (t) => {
    const due = t.due ? S.dueAt(t) : null;
    const late = due && due < new Date() && !t.complete;
    return `
        <li class="material-reading ${t.complete ? 'is-done' : ''}">
          <div class="material-reading-body">
            ${
              // A book filed under its own author says its name twice otherwise.
              t.title.toLowerCase() === m.name.toLowerCase()
                ? ''
                : `<div class="material-reading-title">${esc(t.title)}</div>`
            }
            <div class="material-reading-meta">
              ${esc(t.detail || '')}${t.detail ? ' · ' : ''}${esc(t.course)}
              ${due ? ` · ${late ? 'was due ' : 'due '}${esc(S.formatDate(due))}` : ' · no date yet'}
            </div>
            <div class="tags">
              ${t.driver ? pill('drives discussion', 'accent') : ''}
              ${late ? pill('overdue', 'warn') : ''}
              ${t.complete ? pill('read', 'muted') : ''}
            </div>
          </div>
          ${
            readable
              ? `<button class="btn small ghost" data-action="read-here"
                         data-mat="${esc(m.id)}" data-key="${esc(t.key)}">Read</button>`
              : ''
          }
        </li>`;
  };

  const rest = items.slice(SHOWN);
  return `
    <ul class="material-readings">${items.slice(0, SHOWN).map(line).join('')}</ul>
    ${
      rest.length
        ? `<details class="material-more">
             <summary>${rest.length} more from this book</summary>
             <ul class="material-readings">${rest.map(line).join('')}</ul>
           </details>`
        : ''
    }`;
}

function readButton(m, entry) {
  if (entry.kind !== 'file') return '';
  if (!/\.pdf$/i.test(entry.fileName || '')) return '';
  if (extractedIds.has(m.id)) {
    const where = store.readingPos(m.id);
    const marks = store.bookmarksFor(m.id).length;
    return `<button class="btn small" data-action="read-text" data-mat="${esc(m.id)}">
              ${where ? `Continue p.${where.page}` : 'Read text'}${marks ? ` · ${marks} ⚑` : ''}
            </button>`;
  }
  return `<button class="btn small ghost" data-action="extract-text" data-mat="${esc(m.id)}">Get text</button>`;
}

/**
 * Once text has been stored the "Get text" button is gone, which left no way
 * to redo a bad reading — the results of an older, worse version were stuck
 * there for good. Both routes stay reachable, and either one overwrites.
 */
function redoRow(m, entry) {
  if (!entry || entry.kind !== 'file') return '';
  if (!/\.pdf$/i.test(entry.fileName || '')) return '';
  const info = entry.text;
  const how = info?.ocr
    ? `read by OCR${typeof info.confidence === 'number' && info.confidence ? `, ${info.confidence}% sure` : ''}`
    : 'from the PDF text layer';
  const size = info?.chars ? `${Math.round(info.chars / 1000)}k characters, ` : '';
  const has = extractedIds.has(m.id);

  // An OCR run that was interrupted — by switching apps, or by tapping Cancel —
  // keeps every page it had already read. Offer to carry on from there rather
  // than making you pay for those pages twice.
  const paused = info?.ocr && info.complete === false && info.nextPage > 1;
  const resume = paused
    ? `<div class="material-redo">
         <span class="note">Paused after page ${info.pageCount} of ${info.totalPages}. Nothing read so far is lost.</span>
         <button class="btn small" data-action="run-ocr" data-resume="1" data-mat="${esc(m.id)}">Resume OCR</button>
       </div>`
    : '';

  return `
    ${resume}
    <div class="material-redo">
      <span class="note">${has ? `Text stored — ${size}${how}.` : ''} ${paused ? 'Or start over:' : 'Read it again:'}</span>
      <button class="btn small ghost" data-action="extract-text" data-mat="${esc(m.id)}">Extract</button>
      <button class="btn small ghost" data-action="run-ocr" data-mat="${esc(m.id)}">OCR</button>
    </div>`;
}

/**
 * Work with no date on it yet.
 *
 * Applied Theology is arranged between you, the professor and your pastor, so
 * its syllabus names no dates at all. The homework is still real and still has
 * to be done, so it is listed and tickable — but it is kept out of the day plan
 * and the deadline list, which would otherwise have to invent a date for it.
 * Put a date on a meeting here and it joins the rest of the app at once.
 */
/**
 * The work you arrange yourself, as a standing checklist.
 *
 * Applied Theology has no dates in its syllabus at all — three book
 * discussions, a preaching slot, three pastoral meetings and two papers, every
 * one of them arranged between you, the professor and your pastor. That makes
 * it the easiest course to lose: nothing is ever due, so nothing ever asks. So
 * it is not planned against the week — it sits here, dated or not, as boxes to
 * tick eventually, with a date offered for each one inside the window the
 * syllabus gives. Take the offer and it joins the plan and the reminders like
 * anything else; ignore it and the box is still here next week.
 */
function arrangedSection({ collapsible = false } = {}) {
  const courses = DATA.courses.filter((c) => c.datesUnknown && (c.sessions || []).length);
  if (!courses.length) return '';

  return courses
    .map((course) => {
      // Walk the syllabus, not the task list: tasks re-sort themselves by date
      // and size, which made the rows shuffle under your finger as you ticked.
      const groups = (course.sessions || [])
        .map((session) => {
          const slot = session.date || session.id;
          const items = TASKS.filter((t) => t.courseId === course.id && t.sessionDate === slot);
          return { session, slot, items, date: S.sessionDate(course, session) };
        })
        .filter((g) => g.items.length);
      if (!groups.length) return '';

      const all = groups.flatMap((g) => g.items);
      const w = S.workload(all);
      const left = groups.filter((g) => g.items.some((t) => !t.complete)).length;
      const undated = groups.filter((g) => !g.date && g.items.some((t) => !t.complete)).length;
      const id = `arranged:${course.id}`;
      const shut = store.isCollapsed(id);

      const head = `
        <span class="fold-title">${dot(course.color)}${esc(course.name)}</span>
        <span class="card-when">${left ? `${left} to go` : 'all done'}${undated ? ` · ${undated} with no date` : ''}</span>`;

      const body = `
        <p class="note">
          Yours to arrange with ${esc(course.instructor || 'the professor')} and your pastor, so none of it
          counts toward the weekly target — it waits here until you put a date on it. Each row offers
          one: tap the date to take it, or pick your own.
        </p>
        ${progressBar(w)}
        ${groups
          .map((group) => {
            const { session, items } = group;
            const done = items.every((t) => t.complete);
            const suggested = session.suggest && !group.date;
            return `
          <div class="arranged ${done ? 'is-done' : ''} ${group.date ? 'is-dated' : ''}">
            <div class="arranged-head">
              <div>
                <div class="arranged-topic">${esc(session.topic)}</div>
                ${session.when ? `<div class="task-detail">${esc(session.when)}</div>` : ''}
                ${
                  suggested
                    ? `<div class="task-detail muted">${esc(session.suggestNote || 'Suggested date, inside the syllabus window.')}</div>`
                    : ''
                }
              </div>
              <div class="arranged-date">
                <label class="visually-hidden" for="date-${esc(course.id)}-${esc(session.id)}">Date</label>
                <input type="date" id="date-${esc(course.id)}-${esc(session.id)}"
                       value="${esc(group.date || '')}"
                       aria-label="Date for ${esc(session.topic)}"
                       data-sessiondate="${esc(course.id)}|${esc(session.id)}">
                ${
                  suggested
                    ? `<button class="btn small ghost" data-action="use-suggested"
                               data-session="${esc(course.id)}|${esc(session.id)}" data-date="${esc(session.suggest)}">
                         Use ${esc(S.formatDate(S.parseDate(session.suggest)))}
                       </button>`
                    : group.date
                      ? `<button class="btn small ghost" data-action="clear-session-date"
                                 data-session="${esc(course.id)}|${esc(session.id)}">Clear</button>`
                      : ''
                }
              </div>
            </div>
            <ul class="tasks">${items.map((t) => taskLine(t, { withTimer: true })).join('')}</ul>
          </div>`;
          })
          .join('')}
        ${
          groups.some((g) => !g.date)
            ? `<button class="btn ghost" data-action="use-all-suggested" data-course="${esc(course.id)}">
                 Take every suggested date
               </button>`
            : ''
        }`;

      return collapsible
        ? `<details class="card fold" ${shut ? '' : 'open'}>
             <summary data-collapse="${esc(id)}">${head}</summary>
             ${body}
           </details>`
        : `<section class="card">
             <div class="card-head">${head}</div>
             ${body}
           </section>`;
    })
    .join('');
}

/**
 * The syllabi themselves, shipped with the app.
 *
 * Everything else in Files is something you attach; these are already here, on
 * every device, offline, because the whole app is built out of them and the
 * answer to "what did the syllabus actually say?" should never be a hunt
 * through email. They read through the same machinery as anything else.
 */
function syllabusSection() {
  const withSyllabus = DATA.courses.filter((c) => c.syllabus);
  if (!withSyllabus.length) return '';

  return `
    <section class="card">
      <h2>Syllabi</h2>
      <p class="note">
        Both syllabus PDFs travel with the app — no attaching, and they work offline.
        Everything in Today, Plan and Schedule is taken from them.
      </p>
      ${withSyllabus
        .map((c) => {
          const id = `syllabus-${c.id}`;
          const has = extractedIds.has(id);
          return `
        <div class="material" id="mat-${esc(id)}">
          <div class="material-head">
            <div class="material-title">${dot(c.color)}${esc(c.code || c.name)} — ${esc(c.name)}</div>
            <div class="material-meta">
              ${esc(c.instructor || '')}${c.credits ? ` · ${c.credits} credits` : ''}
              ${c.classTime ? ` · ${esc(clockLabel(c.classTime))}–${esc(clockLabel(c.endTime))}` : ''}
              ${c.location ? `<br>${esc(c.location)}` : ''}
            </div>
          </div>
          <div class="material-actions">
            ${
              globalThis.__COURSES__
                ? '<span class="note">The PDF itself lives with the hosted app.</span>'
                : `<button class="btn small" data-action="open-syllabus" data-course="${esc(c.id)}">Open PDF</button>
                   ${
                     has
                       ? `<button class="btn small ghost" data-action="read-text" data-mat="${esc(id)}">Read text</button>`
                       : `<button class="btn small ghost" data-action="read-syllabus" data-course="${esc(c.id)}">Read it here</button>`
                   }`
            }
          </div>
          <div class="material-extract" id="extract-${esc(id)}"></div>
        </div>`;
        })
        .join('')}
    </section>`;
}

/** "7:00 pm" from "19:00". */
function clockLabel(hhmm) {
  if (!hhmm) return '';
  return S.withTime(new Date(), hhmm)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
}

/**
 * Every bookmark you have made, across every book, in one place.
 *
 * A bookmark buried inside the book it points at is only findable if you
 * already remember which book that was. This is the section that answers
 * "where was that passage?" without you having to.
 */
function bookmarksSection() {
  const books = materials()
    .map((m) => ({ m, marks: store.bookmarksFor(m.id) }))
    .filter((b) => b.marks.length);
  const total = books.reduce((sum, b) => sum + b.marks.length, 0);
  const named = new Map(materials().map((m) => [m.id, m.name]));
  const places = Object.entries(store.readingAll()).filter(([id]) => extractedIds.has(id));

  if (!total && !places.length) {
    return `
      <section class="card">
        <h2>Bookmarks</h2>
        <p class="note">
          Nothing marked yet. While you are reading, the ⚑ button in the bottom corner
          saves the spot you are at — and the app remembers where you stopped even if
          you do not mark it.
        </p>
      </section>`;
  }

  return `
    <section class="card">
      <h2>Bookmarks</h2>
      ${
        places.length
          ? `<p class="note">Reading now: ${places
              .map(([id, pos]) => {
                const name = named.get(id) || store.libraryEntry(id)?.title || id;
                return `<button class="linkbtn" data-action="resume-read" data-mat="${esc(id)}">${esc(name)} — p.${pos.page}</button>`;
              })
              .join(' · ')}</p>`
          : ''
      }
      ${books
        .map(
          ({ m, marks }) => `
        <div class="bookmark-book">
          <div class="bookmark-book-name">${esc(m.name)} <span class="muted">· ${marks.length}</span></div>
          <ul class="bookmark-rows">
            ${marks
              .map(
                (mk) => `
              <li>
                <button class="bookmark-go" data-action="open-mark" data-mat="${esc(m.id)}"
                        data-page="${mk.page}" data-para="${mk.para}">
                  <span class="bookmark-page">p.${mk.page}</span>
                  <span class="bookmark-text">${esc(mk.text)}</span>
                </button>
                <button class="bookmark-drop" data-action="drop-mark-here" data-mat="${esc(m.id)}"
                        data-key="${esc(store.bookmarkKey(mk))}" aria-label="Remove bookmark">✕</button>
              </li>`
              )
              .join('')}
          </ul>
        </div>`
        )
        .join('')}
    </section>`;
}

function viewFiles() {
  const list = materials();
  const attached = list.filter((m) => store.libraryEntry(m.id)).length;

  return `
    ${syllabusSection()}
    ${bookmarksSection()}

    <section class="card">
      <h2>Your materials</h2>
      <p class="note">
        Attach each book or PDF once and it opens from every class that assigns it —
        tap the <span class="inline-icon">${ICON_OPEN}</span> next to any reading. Each book
        lists the readings inside it, because a collection is filed under its own title while
        the chapters in it are by other people: Swain on the Trinity lives in
        <em>Christian Dogmatics</em>, and this is where that is said.
      </p>
      <div class="progress ${attached === list.length ? 'is-complete' : ''}">
        <div class="progress-track"><div class="progress-fill" style="width:${Math.round((attached / list.length) * 100)}%"></div></div>
        <span class="progress-pct">${attached}/${list.length}</span>
      </div>
      <p class="note" style="margin-top:10px">
        <strong>Link</strong> points at a file in Google Drive, Dropbox or iCloud — it syncs
        across your devices and costs no space here.
        <strong>File</strong> copies a PDF into this app so it opens instantly and works
        offline, but it lives on this device only.
      </p>
      <p class="note">
        For any PDF you have copied in, <strong>Get text</strong> pulls the words out and
        lays them out as plain readable prose — good for reading on a phone, searching, or
        copying a quotation. It only works on PDFs that carry a text layer; if yours is a
        photographed scan the app will say so and offer to read it with <strong>OCR</strong>
        instead.
      </p>
      <p class="note">
        Before reading a page, OCR cleans it: it straightens a crooked scan, decides black
        from white a patch at a time so the shadow down a book's gutter does not swallow a
        column, and takes off the dust the copier photographed. Then it reads columns as
        columns rather than straight across the page, keeps footnotes at the foot instead of
        running them into the sentence they interrupt, drops the running head and the page
        number, and checks every word against an English word list — so
        "incomprehensihility" comes back as the word it was meant to be. Anything your book
        uses repeatedly is left alone: names and technical terms are safe.
      </p>
      <p class="note">
        <strong>Greek comes across too.</strong> A scan of a page with Koine on it is read
        with a Greek model beside the English one, so <span lang="grc">ἐν ἀρχῇ ἦν ὁ λόγος</span>
        arrives as Greek — accents, breathings and all — instead of as the Latin gibberish an
        English-only reading makes of it. It works on a single word inside an English sentence
        as well as on a whole quotation. Turn it off in Settings if you would rather not fetch
        the extra 2 MB. Hebrew is still not read.
      </p>
      <p class="note">
        <strong>Italic and bold come across too.</strong> The engine will not tell you which
        words were emphasised — it reports every word as ordinary — so the app measures the
        page instead: a word whose stems lean is italic, one whose strokes are thicker than
        the rest of its line is bold. That keeps the difference between a book's title and a
        sentence about it, which is most of what italics are doing in a theology text.
        Copying the text out turns them into markdown.
      </p>
      <p class="note">
        When it has finished it says how sure it was, and names the pages it struggled with.
        Those are the ones to check against the PDF.
      </p>
      <p class="note">
        In the reader, <strong>select any passage and tap Highlight</strong>. Highlights are
        listed under the bookmarks so a chapter's worth can be found again without rereading
        it, and they survive re-reading the same PDF. Select highlighted words again and the
        same button offers <strong>Unhighlight</strong>, which takes the colour off and
        leaves every word where it is; tapping a highlight in the text does the same.
      </p>
      <p class="note">
        <strong>Strike out</strong> is the other thing, and a different kind of thing: it
        hides text, for what OCR leaves behind on a bad page — a caption read as a sentence,
        a line of a table, the ghost of the facing page. It asks before it does it. Even
        then nothing is deleted: struck text goes from the reading and from anything you copy
        out, but it is listed under "Struck out", where opening the list shows it back in
        place, crossed through, and one tap puts any of it back.
      </p>
    </section>

    <section class="card">
      ${list
        .map((m) => {
          const e = store.libraryEntry(m.id);
          const where = [...m.courses].join(', ');
          return `
          <div class="material ${focusMaterial === m.id ? 'is-focus' : ''}" id="mat-${esc(m.id)}">
            <div class="material-head">
              <div class="material-title">${esc(m.name)}</div>
              <div class="material-meta">
                ${esc(where)} · used in ${m.uses} ${m.uses === 1 ? 'class' : 'classes'}
                ${m.isPdf ? ' · syllabus supplies a PDF' : ''}
                ${m.nextDue ? ` · next ${esc(S.formatDate(m.nextDue, { month: 'short', day: 'numeric' }))}` : ''}
              </div>
              ${
                e
                  ? `<div class="material-attached">
                       ${e.kind === 'link' ? '🔗' : '📄'}
                       ${esc(e.kind === 'link' ? shortUrl(e.url) : `${e.fileName} (${lib.formatBytes(e.fileSize)})`)}
                     </div>`
                  : ''
              }
            </div>
            <div class="material-actions">
              ${
                e
                  ? `<button class="btn small" data-action="open-material" data-mat="${esc(m.id)}">Open</button>
                     ${readButton(m, e)}
                     <button class="btn small ghost" data-action="detach" data-mat="${esc(m.id)}">Remove</button>`
                  : `<button class="btn small ghost" data-action="attach-link" data-mat="${esc(m.id)}" data-title="${esc(m.name)}">Link</button>
                     <button class="btn small ghost" data-action="attach-file" data-mat="${esc(m.id)}" data-title="${esc(m.name)}">File</button>`
              }
            </div>
            ${materialReadings(m, e)}
            ${redoRow(m, e)}
            <div class="material-extract" id="extract-${esc(m.id)}"></div>
          </div>`;
        })
        .join('')}
    </section>

    <section class="card">
      <h2>Storage</h2>
      <p class="note" id="storage-line">Checking…</p>
      <p class="note">
        Links are included in <em>Settings → Export progress</em>. Copied files are not —
        they stay in this browser. If you clear site data or switch devices, re-attach them.
      </p>
    </section>`;
}

/** "drive.google.com/…/view" — enough to recognise, short enough to fit. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 24 ? `…${u.pathname.slice(-20)}` : u.pathname;
    return `${u.hostname.replace(/^www\./, '')}${tail}`;
  } catch {
    return url;
  }
}

function viewSettings() {
  const s = store.settings();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const perm = notify.permission();

  return `
    <section class="card">
      <h2>Reminders</h2>
      <p class="note">
        Reminders fire at ${store.settings().leadDays} days, 3 days, 1 day, and on the due date.
        This app has no server, so it raises them when it is open or when your browser wakes it in
        the background — keep it on your home screen and open it once a day.
      </p>
      ${
        location.protocol === 'file:'
          ? `<p class="note warn-note">You are running the single-file copy straight off this device.
               Everything works except reminders — browsers do not allow notifications from a page
               opened out of the filesystem. For those, use the hosted copy added to your home screen.</p>`
          : ''
      }
      <div class="row">
        <label for="notif">Notifications</label>
        <span class="status ${perm === 'granted' ? 'ok' : ''}">${esc(perm)}</span>
        <button class="btn" data-action="enable-notif" ${perm === 'granted' && s.notificationsEnabled ? 'disabled' : ''}>
          ${perm === 'granted' && s.notificationsEnabled ? 'On' : 'Turn on'}
        </button>
      </div>
      <div class="row">
        <label for="lead">Warn me this far ahead</label>
        <input id="lead" type="number" min="1" max="21" value="${s.leadDays}" data-setting="leadDays">
        <span class="unit">days</span>
      </div>
      <div class="row">
        <label for="hour">Daily nudge after</label>
        <input id="hour" type="number" min="0" max="23" value="${s.reminderHour}" data-setting="reminderHour">
        <span class="unit">:00</span>
      </div>
      <button class="btn ghost" data-action="test-notif">Send a test notification</button>
    </section>

    <section class="card">
      <h2>Class times</h2>
      <p class="note">
        Taken from the syllabi: <strong>Greek at 5:00 pm</strong>, then <strong>Theology at 7:00 pm</strong>,
        both Tuesdays at Aiea Heights Church. The time matters for two things: when a due-date reminder
        counts as passed, and whether class day itself is still available to read in — for an evening
        class it is, so the plan uses it. Override either here if a class moves.
      </p>
      ${DATA.courses
        .map(
          (c) => `
        <div class="row">
          <label for="ct-${esc(c.id)}">${dot(c.color)}${esc(c.name)}${c.meetingDay ? ` <span class="muted">· ${esc(c.meetingDay)}s</span>` : ''}</label>
          ${S.classTimeIsAssumed(c) ? '<span class="status">assumed</span>' : '<span class="status ok">set</span>'}
          <input id="ct-${esc(c.id)}" type="time" value="${esc(S.classTimeFor(c))}" data-classtime="${esc(c.id)}">
        </div>`
        )
        .join('')}
      <button class="btn ghost" data-action="clear-times">Back to assumed times</button>
    </section>

    <section class="card">
      <h2>Work already past</h2>
      <p class="note">
        Reading set for a class that has already met is normally carried forward and planned
        ahead of this week's, so it is not quietly forgotten. That is right while you mean to
        catch up. Once you have decided you are not going to, it is the opposite of helpful:
        a fortnight of it fills every day between now and Tuesday, and the chapter the seminar
        is actually on ends up behind all of it.
      </p>
      <div class="chips">
        <button class="chip ${s.carryOverdue ? 'on' : ''}" data-action="toggle-carry">Carry it forward</button>
        <button class="chip ${s.carryOverdue ? '' : 'on'}" data-action="toggle-carry">Set it aside</button>
      </div>
      <p class="note">
        ${
          s.carryOverdue
            ? 'Anything owed is planned first, before this week\'s reading.'
            : 'Only what is still ahead is planned. What is past is listed on the home page under "Set aside", where it can still be ticked off — nothing is deleted.'
        }
      </p>
    </section>

    <section class="card">
      <h2>Finish line</h2>
      <p class="note">
        The day a week's work is meant to be <em>done</em>, as opposed to the day it is due. Both
        classes meet on Tuesday, so without this the plan quite reasonably reads right up to Tuesday
        evening — and a week ends with Monday night holding four hours of Bavinck. Set it to Saturday
        and the same reading lands by the weekend, with Sunday and Monday as margin instead of as the
        plan. Being "behind" is measured against this day too. It never pushes work later than the
        class, and if this week's finish line has already gone by, the class deadline stands.
      </p>
      <div class="chips">
        ${dayNames
          .map(
            (n, i) =>
              `<button class="chip ${s.finishDay === i ? 'on' : ''}" data-action="set-finish" data-day="${i}">${n}</button>`
          )
          .join('')}
        <button class="chip ${s.finishDay === null || s.finishDay === undefined ? 'on' : ''}" data-action="set-finish" data-day="off">Off</button>
      </div>
      <p class="note">
        ${
          Number.isInteger(s.finishDay)
            ? `Aiming to have each week finished by <strong>${esc(dayNames[s.finishDay])}</strong>.`
            : 'No finish line — the plan runs up to each class.'
        }
      </p>
    </section>

    <section class="card">
      <h2>Languages</h2>
      <p class="note">
        Which scripts OCR should expect when it reads a scan. English is always on. Greek is
        worth having for this term's reading: without it a line of Koine is read as though it
        were English and comes back as nonsense — with it, breathings and accents and all,
        <span lang="grc">ἐν ἀρχῇ ἦν ὁ λόγος</span>. It costs about 2 MB more the first time and
        a little longer per page, and it does not make the English any worse.
      </p>
      <div class="chips">
        <button class="chip on" disabled>English</button>
        <button class="chip ${s.readGreek ? 'on' : ''}" data-action="toggle-greek">Greek</button>
      </div>
      <p class="note">
        ${
          s.readGreek
            ? 'Greek is read. Hebrew is not — there is no model for it here.'
            : 'Greek will be read as though it were English, which is to say not at all.'
        }
      </p>
    </section>

    <section class="card">
      <h2>Reading days</h2>
      <p class="note">
        The days you block out for the books. Reading is packed into these and nowhere else, so
        ticking only Monday puts the whole week's reading into one Monday sitting — which is a real
        way to do it, and often a better one than twenty minutes a night. Bible reading ignores this
        and stays a chapter a day.
      </p>
      <div class="chips">
        ${dayNames
          .map(
            (n, i) =>
              `<button class="chip ${s.studyDays.includes(i) ? 'on' : ''}" data-action="toggle-day" data-day="${i}">${n}</button>`
          )
          .join('')}
      </div>
      <p class="note">
        ${
          s.studyDays.length === 1
            ? `One block a week, on ${esc(dayNames[s.studyDays[0]])}.`
            : `${s.studyDays.length} reading days a week.`
        }
      </p>
    </section>

    <section class="card">
      <h2>Daily rhythm</h2>
      <p class="note">
        The small daily things — vocabulary and the like — that work by repetition rather than by
        sitting down for an hour. These never appear as work owed and never go red: they are boxes to
        tick on the home page, and that is all.
      </p>
      ${
        store.rhythm().length
          ? store
              .rhythm()
              .map(
                (h) => `
        <div class="habit-edit">
          <div class="row">
            <label for="habit-${esc(h.id)}">${h.courseId && courseById(h.courseId) ? dot(courseById(h.courseId).color) : ''}Name</label>
            <input id="habit-${esc(h.id)}" type="text" value="${esc(h.title)}" data-habit-field="title" data-habit="${esc(h.id)}">
          </div>
          <div class="row">
            <label for="habit-note-${esc(h.id)}">Note</label>
            <input id="habit-note-${esc(h.id)}" type="text" value="${esc(h.detail || '')}"
                   placeholder="optional" data-habit-field="detail" data-habit="${esc(h.id)}">
          </div>
          <div class="row">
            <label for="habit-mins-${esc(h.id)}">Minutes a burst</label>
            <input id="habit-mins-${esc(h.id)}" type="number" min="0" max="120"
                   value="${Number(h.minutes) || 0}" data-habit-field="minutes" data-habit="${esc(h.id)}">
          </div>
          <div class="chips">
            ${store.SLOT_ORDER.map(
              (slot) =>
                `<button class="chip ${h.slots.includes(slot) ? 'on' : ''}" data-action="toggle-slot"
                         data-habit="${esc(h.id)}" data-slot="${slot}">${esc(store.SLOT_LABELS[slot])}</button>`
            ).join('')}
            <button class="chip danger" data-action="drop-habit" data-habit="${esc(h.id)}">Remove</button>
          </div>
        </div>`
              )
              .join('')
          : '<p class="empty">Nothing daily set.</p>'
      }
      <button class="btn ghost" data-action="add-habit">Add a daily habit</button>
    </section>

    <section class="card">
      <h2>Pace</h2>
      <p class="note">How the app converts pages and verses into a daily time target. Tune these once you know your real speed.</p>
      <div class="row">
        <label for="mpp">Minutes per page</label>
        <input id="mpp" type="number" min="1" max="20" value="${s.minsPerPage}" data-setting="minsPerPage">
      </div>
      <div class="row">
        <label for="mpv">Minutes per Greek verse</label>
        <input id="mpv" type="number" min="1" max="30" value="${s.minsPerGreekVerse}" data-setting="minsPerGreekVerse">
      </div>
      <div class="row">
        <label for="mpc">Minutes per Bible chapter</label>
        <input id="mpc" type="number" min="1" max="30" value="${s.minsPerBibleChapter}" data-setting="minsPerBibleChapter">
      </div>
      <div class="row">
        <label for="dcp">Default pages per chapter</label>
        <input id="dcp" type="number" min="1" max="80" value="${s.defaultChapterPages}" data-setting="defaultChapterPages">
      </div>
    </section>

    <section class="card">
      <h2>Data</h2>
      <p class="note">
        Progress lives on this device only. Page counts marked <em>estimated</em> are guesses —
        tap any page count in the app to replace it with the real number.
      </p>
      <div class="btn-row">
        <button class="btn ghost" data-action="export">Export progress</button>
        <button class="btn ghost" data-action="import">Import progress</button>
        <button class="btn danger" data-action="reset">Reset progress</button>
      </div>
      <p class="note">Term: ${esc(DATA.term)} · ${DATA.courses.length} courses · ${TASKS.length} tracked items</p>
    </section>

    <section class="card">
      <h2>If something goes wrong</h2>
      <p class="note">
        The app writes down anything that breaks while you are using it. If it misbehaves,
        tap Copy and send it over — that turns "it glitched" into something fixable.
      </p>
      <p class="note" id="diagnostics">Checking…</p>
      <div class="btn-row">
        <button class="btn ghost" data-action="copy-diagnostics">Copy report</button>
        <button class="btn ghost" data-action="clear-problems">Clear the list</button>
      </div>
    </section>

    <section class="card">
      <h2>App version</h2>
      <p class="note">
        Running <strong>${esc(BUILD)}</strong>. The app updates itself in the background, but if a
        new feature has not shown up, this forces it: it clears the offline copy and reloads.
        Your progress and attachments are untouched.
      </p>
      <button class="btn ghost" data-action="force-update">Reload the latest version</button>
    </section>`;
}

/* ---------------- shell ---------------- */

const VIEWS = { today: viewToday, plan: viewPlan, schedule: viewSchedule, files: viewFiles, settings: viewSettings };

/** "read:bavinck-...|theo1|2026-09-29|r|0" — every other view is a bare name. */
function parseView(hash) {
  const raw = hash.replace('#', '') || 'today';
  const [name, ...rest] = raw.split(':');
  const arg = rest.join(':') || null;
  if (name !== 'read' || !arg) return { name, arg, taskKey: null };
  // The material id has no pipes; anything after the first one is the task key.
  const [mat, ...key] = arg.split('|');
  return { name, arg: mat, taskKey: key.length ? key.join('|') : null };
}

// The view the screen is currently showing, so a redraw of the same one can be
// told apart from a move to a different one.
let showing = null;

function render() {
  const main = $('#app');
  const { name, arg } = parseView(view);

  if (name === 'read') {
    main.innerHTML = '<section class="card"><p class="note">Opening…</p></section>';
    renderReader(arg, parseView(view).taskKey);
  } else {
    window.removeEventListener('scroll', readerScroll);
    reading = null;
    // Every tick, every stopwatch, every date set redraws the whole view — and
    // this used to jump to the top each time it happened. Halfway down a list
    // of readings, ticking one off threw you back to the top to find your place
    // again, on every single one. Going to the top belongs to arriving at a
    // view, not to redrawing the view you are already reading.
    const arriving = name !== showing;
    const wasAt = window.scrollY;
    main.innerHTML = (VIEWS[name] || viewToday)();
    window.scrollTo(0, arriving ? 0 : wasAt);
  }
  showing = name;
  document.querySelectorAll('.tab').forEach((el) =>
    el.classList.toggle('on', el.dataset.view === name || (name === 'read' && el.dataset.view === 'files'))
  );
  document.title = name === 'today' ? 'Seminary — Today' : `Seminary — ${name}`;

  if (name === 'files') {
    // Which materials have text is read from IndexedDB, which cannot be waited
    // on while painting — so paint, then correct once if the answer changed.
    //
    // This used to compare storage against the buttons on screen, and redraw
    // whenever they disagreed. Anything stored that the view has no button for
    // — text left behind by a removed attachment, say — disagreed for ever, and
    // every redraw started the check again: the app rebuilt this view hundreds
    // of times a second and locked up. Comparing the set with its own previous
    // value settles after one pass, whatever is in storage.
    const before = new Set(extractedIds);
    loadExtractedIds().then(() => {
      const changed =
        before.size !== extractedIds.size || [...extractedIds].some((id) => !before.has(id));
      if (changed && parseView(view).name === 'files') render();
    });
    if (focusMaterial) {
      $(`#mat-${CSS.escape(focusMaterial)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      focusMaterial = null;
    }
    showStorageUsage();
  }

  if (name === 'settings') showDiagnostics();

  paintRunningStrip();
  watchTimer();
}

/**
 * What this week actually assigns out of the work, so the reader is not just a
 * wall of text. Page numbers here are the book's, which need not line up with
 * the PDF's own page order — so this states them rather than jumping.
 */
function assignedNote(taskKey) {
  const task = taskKey && TASKS.find((t) => t.key === taskKey);
  if (!task) return '';
  const due = `${task.due ? S.relativeDay(S.dueAt(task)) : 'not yet scheduled'} · ${esc(task.courseName)}`;
  return `<p class="note assigned">Assigned this week: <strong>${esc(task.detail)}</strong> — due ${due}</p>`;
}

/** Which material the reader is showing, so scrolling knows what to remember. */
let reading = null;
let readerScroll = () => {};
/** A passage to land on once the reader has painted, set by the bookmark list. */
let pendingJump = null;

/** The reader: extracted text, laid out to be read rather than skimmed. */
async function renderReader(id, taskKey) {
  /**
   * Redrawing the page you are already reading — after a highlight, or after
   * striking something out — must leave the words where they were.
   *
   * Not the scroll offset: the first highlight adds a "Highlights" list to the
   * card above the text, which pushes everything down by the height of it, and
   * restoring the same offset then shows you a different part of the chapter.
   * So the anchor is a paragraph and where it sat on the screen, and after the
   * redraw it is put back exactly there.
   */
  const anchor = (() => {
    if (reading?.id !== id) return null;
    for (const el of document.querySelectorAll('.reader p[data-page]')) {
      const top = el.getBoundingClientRect().top;
      if (top > -el.offsetHeight) return { id: el.id, top };
    }
    return null;
  })();
  const entry = store.libraryEntry(id);
  const extracted = await lib.getText(id).catch(() => null);
  const main = $('#app');
  reading = null;

  if (!entry || !extracted) {
    main.innerHTML = `
      <section class="card">
        <h2>Nothing to read yet</h2>
        <p class="note">Extract the text from the Files tab first.</p>
        <button class="btn" data-action="goto-files">Back to Files</button>
      </section>`;
    return;
  }

  const size = store.settings().readerFontSize || 17;
  const marks = store.bookmarksFor(id);
  const marked = new Set(marks.map(store.bookmarkKey));
  const where = store.readingPos(id);

  const highlights = store.highlightsFor(id);
  const removals = store.removalsFor(id);

  /**
   * One paragraph, with everything laid over it that belongs there.
   *
   * Emphasis comes out of the reading as markers; highlights come out of the
   * store as offsets into the text as it reads. Both are spans over the same
   * string, so they are resolved together: a flag per character, and a tag
   * opened wherever the flags change. Done separately, an italic phrase
   * half-covered by a highlight would need one of the two tags to be closed and
   * reopened, and the markup would nest wrongly.
   */
  const paragraph = (page, index, raw, kind = '') => {
    const key = `${page}:${index}`;
    const { plain, runs } = emphasisRuns(raw);
    const mine = highlights.filter((h) => h.page === page && h.para === index);

    const flags = new Array(plain.length).fill(0);
    const EM_BIT = 1;
    const STRONG_BIT = 2;
    for (const run of runs) {
      const bit = run.kind === 'strong' ? STRONG_BIT : EM_BIT;
      for (let i = Math.max(0, run.start); i < Math.min(plain.length, run.end); i++) flags[i] |= bit;
    }
    // A highlight is identified by where it starts, so each needs its own bit
    // rather than one shared "highlighted" flag; two abutting marks must stay
    // two marks, each removable on its own.
    const marks = new Array(plain.length).fill(null);
    for (const h of mine) {
      for (let i = Math.max(0, h.start); i < Math.min(plain.length, h.end); i++) marks[i] = store.highlightKey(h);
    }
    // Struck-out text stays in the paragraph and is hidden, rather than being
    // cut out of it. Everything else here — highlights, bookmarks, the place
    // you had got to — is an offset into this string, and cutting it would
    // shift all of them; hiding it moves nothing and loses nothing.
    const cuts = new Array(plain.length).fill(null);
    for (const c of removals.filter((c) => c.page === page && c.para === index)) {
      for (let i = Math.max(0, c.start); i < Math.min(plain.length, c.end); i++) cuts[i] = store.removalKey(c);
    }

    let html = '';
    let at = 0;
    while (at < plain.length) {
      const flag = flags[at];
      const mark = marks[at];
      const cut = cuts[at];
      let to = at + 1;
      while (to < plain.length && flags[to] === flag && marks[to] === mark && cuts[to] === cut) to++;
      let piece = esc(plain.slice(at, to));
      if (flag & EM_BIT) piece = `<em>${piece}</em>`;
      if (flag & STRONG_BIT) piece = `<strong>${piece}</strong>`;
      if (mark && !cut) piece = `<mark data-mark="${esc(mark)}" tabindex="0">${piece}</mark>`;
      if (cut) {
        piece = showCut
          ? `<span class="cut is-shown" data-cut="${esc(cut)}" tabindex="0"
                   title="Struck out — tap to put it back">${piece}</span>`
          : `<span class="cut" data-cut="${esc(cut)}" hidden>${piece}</span>`;
      }
      html += piece;
      at = to;
    }

    return `<p class="${kind} ${marked.has(key) ? 'is-marked' : ''}" id="para-${esc(key)}"
              data-page="${page}" data-para="${index}">${html || esc(plain)}</p>`;
  };

  main.innerHTML = `
    <section class="card reader-bar">
      <div class="card-head">
        <h2>${esc(entry.title)}</h2>
        <span class="card-when">${extracted.pageCount} pages · ${Math.round(extracted.chars / 1000)}k characters${extracted.ocr ? ' · read by OCR' : ''}</span>
      </div>
      ${assignedNote(taskKey)}
      ${
        where
          ? `<p class="note resumed" id="resumed">Picked up where you left off — page ${where.page}.
               <button class="linkbtn" data-action="reader-top">Start at the beginning</button></p>`
          : ''
      }
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost small" data-action="goto-files">Files</button>
        <button class="btn ghost small" data-action="reader-smaller">A−</button>
        <button class="btn ghost small" data-action="reader-bigger">A+</button>
        <button class="btn small" data-action="bookmark-here" id="bookmark-btn">Bookmark</button>
        <button class="btn ghost small" data-action="copy-text">Copy all</button>
      </div>
      <div class="reader-progress">
        <div class="progress progress-sm">
          <div class="progress-track"><div class="progress-fill" id="reader-fill" style="width:0%"></div></div>
        </div>
        <span class="progress-pct" id="reader-place">page ${where?.page || 1} of ${extracted.pageCount}</span>
      </div>
      <div id="bookmark-list">${bookmarkList(marks)}</div>
      <div id="highlight-list">${highlightList(highlights)}</div>
      <div id="removal-list">${removalList(removals)}</div>
    </section>
    <section class="card reader" style="--reader-size:${size}px">
      ${extracted.pages
        .filter((p) => p.text || p.notes)
        .map((p) => {
          const body = (p.text || '').split('\n\n').filter(Boolean);
          const notes = (p.notes || '').split('\n\n').filter(Boolean);
          return `
        <div class="reader-page">
          <div class="reader-pagenum">page ${p.page}</div>
          ${body.map((para, i) => paragraph(p.page, i, para)).join('')}
          ${
            notes.length
              ? `<div class="reader-notes">
                   <div class="reader-notes-head">Footnotes</div>
                   ${notes.map((para, i) => paragraph(p.page, body.length + i, para, 'note-para')).join('')}
                 </div>`
              : ''
          }
        </div>`;
        })
        .join('')}
    </section>
    <button class="fab" data-action="bookmark-here" id="fab-bookmark" title="Bookmark this spot">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>
    </button>
    <div class="selection-bar" id="selection-bar" hidden>
      <span id="selection-count"></span>
      <button class="btn small" id="highlight-button" data-action="highlight-selection">Highlight</button>
      <button class="btn small ghost danger" data-action="strike-selection"
              title="Hide this text from the reading — for what OCR got wrong">Strike out</button>
    </div>`;

  reading = { id, pages: extracted.pageCount };
  watchReadingPosition();
  // A bookmark you tapped wins over where you happened to stop reading.
  const target = pendingJump || (anchor ? null : where);
  pendingJump = null;
  if (target) {
    jumpTo(target, { smooth: false });
  } else if (anchor) {
    const el = document.getElementById(anchor.id);
    if (el) window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - anchor.top);
  }
}

/**
 * Where the text you marked can be found again.
 *
 * A highlight is worth having twice over: in place, so the page you are reading
 * shows what struck you, and in a list, so the striking bits can be found again
 * without reading the chapter for them. Both are the same store; this is the
 * second view of it.
 */
function highlightList(highlights) {
  if (!highlights.length) return '';
  return `
    <details class="marks" open>
      <summary>Highlights (${highlights.length})</summary>
      <ul class="mark-list">
        ${highlights
          .map((h) => {
            const key = store.highlightKey(h);
            const text = h.text.length > 120 ? `${h.text.slice(0, 118)}…` : h.text;
            return `
          <li class="mark-row">
            <button class="linkbtn mark-jump" data-action="goto-highlight" data-key="${esc(key)}"
                    data-page="${h.page}" data-para="${h.para}">
              <span class="mark-page">p. ${h.page}</span>
              <span class="mark-text">${esc(text)}</span>
            </button>
            <button class="linkbtn mark-drop" data-action="drop-highlight" data-key="${esc(key)}"
                    title="Remove this highlight">×</button>
          </li>`;
          })
          .join('')}
      </ul>
    </details>`;
}

/**
 * The same reading with the struck-out passages actually taken out.
 *
 * The screen hides them; anything leaving the app has to lose them, or copying
 * a chapter would paste back the very lines you struck. The cut is made on the
 * stored text, where emphasis is still marked, so the markers survive it: the
 * offsets are counted over the text as it reads, and the markers are simply
 * carried across.
 */
function cutFromStored(raw, ranges) {
  if (!ranges.length) return raw;
  let plainAt = 0;
  let out = '';
  for (const ch of String(raw)) {
    if (ch === EM_MARK || ch === STRONG_MARK) {
      out += ch;
      continue;
    }
    if (!ranges.some((r) => plainAt >= r.start && plainAt < r.end)) out += ch;
    plainAt++;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,;:.!?])/g, '$1').trim();
}

/** A whole extraction with every struck passage removed, for copying out. */
function withoutRemovals(extracted, removals) {
  if (!removals.length) return extracted;
  const cut = (text, page, from) =>
    String(text || '')
      .split('\n\n')
      .map((para, i) => cutFromStored(para, removals.filter((r) => r.page === page && r.para === from + i)))
      .filter(Boolean)
      .join('\n\n');
  return {
    ...extracted,
    pages: extracted.pages.map((p) => {
      const bodyCount = String(p.text || '').split('\n\n').filter(Boolean).length;
      return { ...p, text: cut(p.text, p.page, 0), notes: cut(p.notes, p.page, bodyCount) };
    })
  };
}

/**
 * What has been struck out of a reading, and the way back.
 *
 * OCR on a bad page leaves wreckage: a caption read as a sentence, a line of a
 * table, the ghost of the facing page. Striking it out makes the reading
 * readable — but silently deleting text a machine produced from a book you own
 * is not something an app should do, so nothing is deleted. It is hidden, it is
 * listed here, and any of it comes back with one tap.
 */
function removalList(removals) {
  if (!removals.length) return '';
  return `
    <details class="marks" ${showCut ? 'open' : ''}>
      <summary data-action="toggle-cut">
        Struck out (${removals.length})${showCut ? ' — showing in place' : ''}
      </summary>
      <p class="note">
        Nothing here is deleted. It is hidden from the reading and from anything you copy out.
      </p>
      <ul class="mark-list">
        ${removals
          .map((c) => {
            const key = store.removalKey(c);
            const text = c.text.length > 120 ? `${c.text.slice(0, 118)}…` : c.text;
            return `
          <li class="mark-row">
            <span class="mark-jump">
              <span class="mark-page">p. ${c.page}</span>
              <span class="mark-text cut-text">${esc(text)}</span>
            </span>
            <button class="linkbtn mark-drop" data-action="restore-removal" data-key="${esc(key)}"
                    title="Put this back">↩</button>
          </li>`;
          })
          .join('')}
      </ul>
    </details>`;
}

/**
 * What is selected, as offsets into the paragraphs it covers.
 *
 * Two things make this harder than reading the selection out.
 *
 * A selection is not one paragraph's worth. On a phone a drag runs past the end
 * of a paragraph and into the next about as often as it stops neatly inside
 * one, and this used to answer "nothing selected" to anything that crossed a
 * boundary — so the button never appeared and the feature looked broken. Every
 * paragraph the range touches is returned, clipped to the part inside it.
 *
 * And the rendered paragraph is not one text node: emphasis, earlier
 * highlights, struck-out passages have all broken it into several. Offsets are
 * counted across them in document order. Nothing is inserted into the text
 * while rendering, so those lengths add up to exactly the string the offsets
 * are stored against.
 */
function selectionSpans() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  const reader = document.querySelector('.reader');
  if (!reader) return [];

  const spans = [];
  for (const para of reader.querySelectorAll('p[data-page]')) {
    if (!range.intersectsNode(para)) continue;

    // Where this paragraph's own text starts and stops inside the selection.
    let at = 0;
    let from = null;
    let to = null;
    const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent.length;
      const startsHere = node === range.startContainer;
      const endsHere = node === range.endContainer;
      // A node entirely inside the range counts whole; the two ends are clipped.
      const covered = range.intersectsNode(node);
      if (covered) {
        const lo = startsHere ? range.startOffset : 0;
        const hi = endsHere ? range.endOffset : length;
        if (hi > lo) {
          if (from === null) from = at + lo;
          to = at + hi;
        }
      }
      at += length;
    }
    if (from === null || to === null || to <= from) continue;
    spans.push({
      page: Number(para.dataset.page),
      para: Number(para.dataset.para),
      start: from,
      end: to,
      text: para.textContent.slice(from, to).replace(/\s+/g, ' ').trim()
    });
  }
  return spans.filter((s) => s.text);
}

/**
 * The last selection worth acting on, kept because the tap that acts on it may
 * be the very thing that destroys it: on a touch device, touching anything
 * outside a selection collapses it, and the click handler then finds nothing
 * there. Remembering it is what makes the button work with a thumb.
 */
let pendingSelection = [];

/**
 * Show the Highlight button while there is something to highlight — and take it
 * away only when you touch something else.
 *
 * Not when the selection collapses, which is the obvious rule and the wrong
 * one: a selection collapses for two very different reasons, because you
 * dismissed it, or because you touched the Highlight button and the browser
 * cleared it on the way down. Hiding on collapse makes the second case
 * unwinnable — the button leaves while the tap is still travelling, and nothing
 * happens, which is exactly what "the button is there but it does nothing"
 * looks like from the outside. So the bar goes when a touch lands outside it,
 * which is unambiguous, and no timer has to guess how fast a thumb is.
 */
function watchSelection() {
  const bar = $('#selection-bar');
  if (!bar) return;
  const found = selectionSpans();
  if (!found.length) return;
  pendingSelection = found;
  bar.hidden = false;
  const words = found.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);
  const across = found.length > 1 ? ` across ${found.length} paragraphs` : '';
  $('#selection-count').textContent = `${words} word${words === 1 ? '' : 's'}${across}`;

  // Select something already highlighted and the obvious thing to want is the
  // highlighting off it again. Offering "Highlight" there, next to a button
  // that hides text, is how you end up hiding the text instead.
  const id = parseView(view).arg;
  const marked = id && found.some((span) => store.isHighlighted(id, span));
  const button = $('#highlight-button');
  if (button) {
    button.textContent = marked ? 'Unhighlight' : 'Highlight';
    button.dataset.action = marked ? 'unhighlight-selection' : 'highlight-selection';
  }
}

/** Put the bar away, once whatever it was offered for is over. */
function dismissSelectionBar() {
  const bar = $('#selection-bar');
  if (bar) bar.hidden = true;
  pendingSelection = [];
}

/** What the buttons act on: what is selected now, or the last thing that was. */
const selectionToUse = () => {
  const live = selectionSpans();
  return live.length ? live : pendingSelection;
};

function bookmarkList(marks) {
  if (!marks.length) return '';
  return `
    <details class="bookmarks" ${marks.length <= 3 ? 'open' : ''}>
      <summary>${marks.length} bookmark${marks.length === 1 ? '' : 's'}</summary>
      <ul>
        ${marks
          .map(
            (m) => `
          <li>
            <button class="bookmark-go" data-action="goto-mark" data-page="${m.page}" data-para="${m.para}">
              <span class="bookmark-page">p.${m.page}</span>
              <span class="bookmark-text">${esc(m.text)}</span>
            </button>
            <button class="bookmark-drop" data-action="drop-mark" data-key="${esc(store.bookmarkKey(m))}"
                    aria-label="Remove bookmark">✕</button>
          </li>`
          )
          .join('')}
      </ul>
    </details>`;
}

/** The paragraph currently at the top of the screen — where you are reading. */
function topParagraph() {
  const paras = document.querySelectorAll('.reader p[data-page]');
  const line = 120; // below the sticky header, where the eye actually is
  let last = null;
  for (const p of paras) {
    if (p.getBoundingClientRect().top > line) break;
    last = p;
  }
  return last || paras[0] || null;
}

function markOf(el) {
  return el && { page: Number(el.dataset.page), para: Number(el.dataset.para), text: el.textContent.trim().slice(0, 70) };
}

function jumpTo({ page, para }, { smooth = true } = {}) {
  const el = document.getElementById(`para-${page}:${para}`) || document.getElementById(`para-${page}:0`);
  if (!el) return;
  // Leave room for the header, which would otherwise sit over the line you came
  // back for.
  const top = el.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  el.classList.add('just-jumped');
  setTimeout(() => el.classList.remove('just-jumped'), 1400);
}

/**
 * Remember the place without being asked. Reading is not something you should
 * have to bookmark to keep — the app should simply know where you were.
 */
function watchReadingPosition() {
  let queued = false;
  const update = () => {
    queued = false;
    if (!reading) return;
    const mark = markOf(topParagraph());
    if (!mark) return;
    store.setReadingPos(reading.id, { page: mark.page, para: mark.para });
    const place = $('#reader-place');
    if (place) place.textContent = `page ${mark.page} of ${reading.pages}`;
    const fill = $('#reader-fill');
    if (fill) fill.style.width = `${Math.round((mark.page / Math.max(1, reading.pages)) * 100)}%`;
    const on = store.bookmarksFor(reading.id).some((m) => store.bookmarkKey(m) === `${mark.page}:${mark.para}`);
    const btn = $('#bookmark-btn');
    if (btn) {
      btn.textContent = on ? 'Bookmarked' : 'Bookmark';
      btn.classList.toggle('ghost', on);
    }
    $('#fab-bookmark')?.classList.toggle('on', on);
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  window.removeEventListener('scroll', readerScroll);
  readerScroll = onScroll;
  window.addEventListener('scroll', readerScroll, { passive: true });
  update();
}

/**
 * Read one stored PDF's text layer and keep it, unless what came out cannot be
 * trusted. Returns the result on success, or null having already explained why
 * not — a scan to be OCR'd, or a text layer with pieces missing.
 */
async function extractAndStore(id, blob, { force = false, say }) {
  const { extractText } = await import('./pdftext.js');
  const result = await extractText(blob, ({ done, total }) => {
    say(`<span class="note">Reading page ${done} of ${total}…</span>
         ${progressBar(Math.round((done / total) * 100), { size: 'progress-sm' })}`);
  });

  if (result.looksScanned) {
    say(
      `<span class="note warn-note">This PDF is a photographed scan — pictures of pages,
       not text, so there is nothing to pull straight out.</span>
       <button class="btn small" data-action="run-ocr" data-mat="${esc(id)}">Read it with OCR</button>`
    );
    return null;
  }

  // Text came out, but not all of it. Storing it would leave a document that
  // reads convincingly and is wrong in the places that matter most.
  if (result.mangled && !force) {
    say(
      `<span class="note warn-note">This PDF's text layer is broken —
       ${esc(result.mangled)}. OCR reads the picture of the page instead of the file's own
       lettering, so it gets them right.</span>
       <button class="btn small" data-action="run-ocr" data-mat="${esc(id)}">Read it with OCR</button>
       <button class="btn small ghost" data-action="extract-anyway" data-mat="${esc(id)}">Use it as it is</button>`
    );
    return null;
  }

  await lib.putText(id, result);
  extractedIds.add(id);
  const entry = store.libraryEntry(id);
  if (entry) {
    store.setLibraryEntry(id, { ...entry, text: { chars: result.chars, pageCount: result.pageCount, ocr: false } });
  }
  const partial =
    result.emptyPages > 0
      ? ` ${result.emptyPages} of ${result.pageCount} pages had no text — probably images or plates.`
      : '';
  say(`<span class="note">Got ${Math.round(result.chars / 1000)}k characters from
       ${result.pageCount - result.emptyPages} pages.${partial}</span>`);
  refresh();
  return result;
}

/** What the app knows about its own state, in one block you can send to me. */
async function diagnosticReport() {
  const lines = [`Seminary ${BUILD}`, `${navigator.userAgent}`];
  lines.push(`display: ${matchMedia('(display-mode: standalone)').matches ? 'home screen' : 'browser'}`);
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    const names = (await caches?.keys?.()) || [];
    lines.push(`offline copy: ${regs.length} worker(s), caches [${names.join(', ')}]`);
  } catch (err) {
    lines.push(`offline copy: could not be read (${err.message})`);
  }
  try {
    const est = await lib.usage();
    if (est) lines.push(`storage: ${lib.formatBytes(est.used)} of ${lib.formatBytes(est.quota)}`);
    lines.push(`files: ${(await lib.listFileIds()).length}, extracted: ${(await lib.listTextIds()).length}`);
  } catch (err) {
    lines.push(`storage: unreadable (${err.message})`);
  }
  const list = store.problems();
  lines.push(list.length ? `${list.length} problem(s) recorded:` : 'no problems recorded');
  for (const p of list) {
    lines.push(`  ${p.at.slice(0, 16).replace('T', ' ')} ${p.what}${p.count > 1 ? ` (×${p.count})` : ''} — ${p.where}`);
  }
  return lines.join('\n');
}

async function showDiagnostics() {
  const line = $('#diagnostics');
  if (!line) return;
  line.textContent = await diagnosticReport();
}

async function showStorageUsage() {
  const line = $('#storage-line');
  if (!line) return;
  if (!lib.available) {
    line.textContent = 'This browser cannot copy files in — links still work.';
    return;
  }
  const est = await lib.usage();
  const files = await lib.listFileIds().catch(() => []);
  const count = `${files.length} file${files.length === 1 ? '' : 's'} copied into the app`;
  line.textContent = est ? `${count} · ${lib.formatBytes(est.used)} used of about ${lib.formatBytes(est.quota)} available.` : count;
}

function go(next) {
  view = next;
  location.hash = next;
  render();
}

/* ---------------- interactions ---------------- */

// The Highlight button follows the selection: there is nothing to offer until
// something is selected, and nothing to keep once it is not.
document.addEventListener('selectionchange', () => {
  if (parseView(view).name === 'read') watchSelection();
});

/**
 * Do what the selection bar offers, from whichever event gets there first.
 *
 * On a touch device the tap that acts on a selection is also the thing that
 * destroys it, and browsers differ on what they deliver afterwards — sometimes
 * a click, sometimes only the touch, sometimes the first tap is swallowed
 * dismissing the selection and nothing reaches the button at all. So both
 * touchend and click run this, and whichever arrives first wins; the other is
 * ignored as a repeat.
 */
let lastBarAction = 0;
function runSelectionAction(action) {
  const now = Date.now();
  // Both events firing for one tap is the normal case, not the exception.
  if (now - lastBarAction < 800) return;
  const id = parseView(view).arg;
  const found = selectionToUse();
  if (!id) return;
  if (!found.length) {
    // Better than a button that silently does nothing, which is what this
    // looked like from the outside for two rounds of trying to fix it.
    const count = $('#selection-count');
    if (count) count.textContent = 'select some text first';
    return;
  }

  // Striking out takes words off the page. It is the right thing for what OCR
  // invented and the wrong thing for everything else, and it sits one button
  // away from Highlight — so it asks first, and says where the text goes.
  if (action === 'strike-selection') {
    const sample = found[0].text.slice(0, 90);
    if (!confirm(`Hide this from the reading?\n\n"${sample}"\n\nThe text is not deleted — it is listed under "Struck out", and one tap puts it back.`)) {
      dismissSelectionBar();
      return;
    }
  }

  lastBarAction = now;
  for (const span of found) {
    if (action === 'strike-selection') store.addRemoval(id, span);
    else if (action === 'unhighlight-selection') store.unhighlight(id, span);
    else store.addHighlight(id, span);
  }
  dismissSelectionBar();
  document.getSelection()?.removeAllRanges();
  renderReader(id, parseView(view).taskKey);
}

// A touch that lands on the bar acts at once, without waiting for a click that
// may never come. Deliberately NOT preventing the default here: on iOS,
// preventDefault on a touch event cancels the click the browser would have
// synthesised — which is how the last attempt at this left the button
// completely untappable rather than merely ineffective.
document.addEventListener('touchend', (e) => {
  const button = e.target.closest?.('#selection-bar [data-action]');
  if (button) runSelectionAction(button.dataset.action);
});

// With a mouse there is no such hazard, and refusing the default on the way
// down keeps the selection visible while you click it.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest?.('#selection-bar')) e.preventDefault();
});

// A touch or click anywhere else is the end of the offer — including the one
// that begins the next selection, which will put the bar back itself.
for (const event of ['pointerdown', 'touchstart']) {
  document.addEventListener(
    event,
    (e) => {
      if (e.target.closest?.('#selection-bar')) return;
      if (parseView(view).name === 'read') dismissSelectionBar();
    },
    { passive: true }
  );
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) return go(tab.dataset.view);

  // Remember whether a section is folded. Today redraws every time you tick
  // something off, and without this it would spring shut again each time. The
  // click lands before <details> flips, so the state being saved is the one it
  // is about to be in.
  const fold = e.target.closest('[data-collapse]');
  if (fold) {
    store.setCollapsed(fold.dataset.collapse, Boolean(fold.closest('details')?.open));
    return;
  }

  const cut = e.target.closest('span.cut.is-shown');
  if (cut && !e.target.closest('[data-action]')) {
    const id = parseView(view).arg;
    if (id) {
      store.restoreRemoval(id, cut.dataset.cut);
      return renderReader(id, parseView(view).taskKey);
    }
    return;
  }

  // A mark in the middle of the text is not a button, but it is the obvious
  // place to tap to be rid of one, so it behaves like one.
  const mark = e.target.closest('mark[data-mark]');
  if (mark && !e.target.closest('[data-action]')) {
    const id = parseView(view).arg;
    if (id && confirm(`Remove this highlight?\n\n"${mark.textContent.trim().slice(0, 120)}"`)) {
      store.removeHighlight(id, mark.dataset.mark);
      return renderReader(id, parseView(view).taskKey);
    }
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, key } = el.dataset;

  if (action === 'toggle') {
    store.setDone(key, el.checked);
    if (!el.checked) store.setProgress(key, 0);
    return refresh();
  }

  if (action === 'chunk') {
    const through = Number(el.dataset.through);
    const total = Number(el.dataset.total);
    if (el.checked) {
      store.setProgress(key, through);
      // The whole item in one go, or the last chunk of one split across days.
      if (el.dataset.whole || through >= total) store.setDone(key, true);
    } else {
      // Rewind to the page this chunk started on.
      store.setDone(key, false);
      store.setProgress(key, Number(el.dataset.from) || 0);
    }
    return refresh();
  }

  if (action === 'force-update') {
    // Drop the offline copy and every worker, then come back from the network.
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = (await caches?.keys?.()) || [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (err) {
      console.warn('Could not clear the offline copy', err);
    }
    location.replace(`${location.pathname}?updated=${Date.now()}${location.hash}`);
    return;
  }

  if (action === 'goto-files') return go('files');

  if (action === 'reader-bigger' || action === 'reader-smaller') {
    const cur = store.settings().readerFontSize || 17;
    const next = Math.min(26, Math.max(13, cur + (action === 'reader-bigger' ? 1 : -1)));
    store.updateSettings({ readerFontSize: next });
    $('.reader')?.style.setProperty('--reader-size', `${next}px`);
    return;
  }

  if (action === 'copy-text') {
    const id = parseView(view).arg;
    const extracted = await lib.getText(id).catch(() => null);
    if (!extracted) return;
    const { toPlainText } = await import('./pdftext.js');
    try {
      await navigator.clipboard.writeText(toPlainText(withoutRemovals(extracted, store.removalsFor(id))));
      el.textContent = 'Copied';
      setTimeout(() => (el.textContent = 'Copy all'), 1500);
    } catch {
      alert('This browser would not let the app write to the clipboard.');
    }
    return;
  }

  if (action === 'bookmark-here') {
    if (!reading) return;
    const mark = markOf(topParagraph());
    if (!mark) return;
    const added = store.toggleBookmark(reading.id, mark);
    const marks = store.bookmarksFor(reading.id);
    $('#bookmark-list').innerHTML = bookmarkList(marks);
    document.getElementById(`para-${mark.page}:${mark.para}`)?.classList.toggle('is-marked', added);
    readerScroll();
    return;
  }

  if (action === 'highlight-selection') return runSelectionAction(action);

  if (action === 'strike-selection') return runSelectionAction(action);

  if (action === 'unhighlight-selection') return runSelectionAction(action);

  if (action === 'restore-removal') {
    const id = parseView(view).arg;
    if (!id) return;
    store.restoreRemoval(id, el.dataset.key);
    return renderReader(id, parseView(view).taskKey);
  }

  if (action === 'toggle-cut') {
    // The click lands before <details> flips, so this is the state it is going to.
    showCut = !el.closest('details')?.open;
    const id = parseView(view).arg;
    if (id) renderReader(id, parseView(view).taskKey);
    return;
  }

  if (action === 'drop-highlight') {
    const id = parseView(view).arg;
    if (!id) return;
    store.removeHighlight(id, el.dataset.key);
    return renderReader(id, parseView(view).taskKey);
  }

  if (action === 'goto-highlight') {
    jumpTo({ page: Number(el.dataset.page), para: Number(el.dataset.para) });
    return;
  }

  if (action === 'goto-mark') {
    return jumpTo({ page: Number(el.dataset.page), para: Number(el.dataset.para) });
  }

  // From the Bookmarks section: open the book, then land on the passage.
  if (action === 'open-mark') {
    pendingJump = { page: Number(el.dataset.page), para: Number(el.dataset.para) };
    return go(`read:${el.dataset.mat}`);
  }

  if (action === 'resume-read') return go(`read:${el.dataset.mat}`);

  if (action === 'drop-mark-here') {
    store.removeBookmark(el.dataset.mat, el.dataset.key);
    return refresh();
  }

  if (action === 'drop-mark') {
    if (!reading) return;
    const [page, para] = el.dataset.key.split(':');
    store.removeBookmark(reading.id, el.dataset.key);
    document.getElementById(`para-${page}:${para}`)?.classList.remove('is-marked');
    $('#bookmark-list').innerHTML = bookmarkList(store.bookmarksFor(reading.id));
    readerScroll();
    return;
  }

  if (action === 'reader-top') {
    $('#resumed')?.remove();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (action === 'read-text') return go(`read:${el.dataset.mat}`);

  if (action === 'read-here') {
    return go(`read:${el.dataset.mat}|${el.dataset.key}`);
  }

  if (action === 'extract-text' || action === 'extract-anyway') {
    const id = el.dataset.mat;
    // "Use it as it is" — you have been told the text layer is broken and want
    // the partial reading anyway.
    const force = action === 'extract-anyway';
    const entry = store.libraryEntry(id);
    const status = $(`#extract-${CSS.escape(id)}`);
    if (!entry || entry.kind !== 'file') return;

    const say = (html) => status && (status.innerHTML = html);

    if (globalThis.__COURSES__) {
      // The single-file copy has no sibling files to lazily import from.
      say(`<span class="note warn-note">Reading text out of a PDF needs the hosted app —
           this is the standalone offline copy. Opening the PDF still works.</span>`);
      return;
    }

    el.disabled = true;
    say('<span class="note">Loading the PDF reader (about 1.6 MB, once)…</span>');

    try {
      const blob = await lib.getFile(id);
      if (!blob) throw new Error('That file is not stored on this device any more.');
      if (await extractAndStore(id, blob, { force, say })) return go(`read:${id}`);
      el.disabled = false;
    } catch (err) {
      say(`<span class="note warn-note">Could not read that PDF: ${esc(err.message)}</span>`);
      el.disabled = false;
    }
    return;
  }

  if (action === 'open-syllabus') {
    const course = DATA.courses.find((c) => c.id === el.dataset.course);
    if (!course?.syllabus) return;
    const status = $(`#extract-${CSS.escape(`syllabus-${course.id}`)}`);
    const say = (html) => status && (status.innerHTML = html);
    try {
      // The service worker keeps these, so this works with no signal too.
      const res = await fetch(course.syllabus);
      if (!res.ok) throw new Error(`the file would not load (${res.status})`);
      lib.openBlob(await res.blob(), course.syllabus.split('/').pop());
      say('');
    } catch (err) {
      say(`<span class="note warn-note">Could not open the PDF: ${esc(err.message)}.
           "Read it here" shows the same syllabus inside the app.</span>`);
    }
    return;
  }

  // The syllabi ship with the app rather than being attached. Bringing one into
  // the library first means every later step — reading, OCR, re-reading — is
  // the same code as for anything else you attach yourself.
  if (action === 'read-syllabus') {
    const course = DATA.courses.find((c) => c.id === el.dataset.course);
    if (!course?.syllabus) return;
    const id = `syllabus-${course.id}`;
    const status = $(`#extract-${CSS.escape(id)}`);
    const say = (html) => status && (status.innerHTML = html);

    if (globalThis.__COURSES__) {
      say(`<span class="note warn-note">Reading text out of a PDF needs the hosted app —
           this is the standalone offline copy.</span>`);
      return;
    }

    el.disabled = true;
    say('<span class="note">Loading the syllabus…</span>');
    try {
      const res = await fetch(course.syllabus);
      if (!res.ok) throw new Error(`the file would not load (${res.status})`);
      const blob = await res.blob();
      await lib.putFile(id, blob);
      store.setLibraryEntry(id, {
        title: `${course.code || course.short || course.name} syllabus`,
        kind: 'file',
        fileName: course.syllabus.split('/').pop(),
        fileSize: blob.size
      });
      if (await extractAndStore(id, blob, { say })) return go(`read:${id}`);
      el.disabled = false;
    } catch (err) {
      say(`<span class="note warn-note">Could not read the syllabus: ${esc(err.message)}</span>`);
      el.disabled = false;
    }
    return;
  }

  if (action === 'run-ocr') {
    const id = el.dataset.mat;
    const status = $(`#extract-${CSS.escape(id)}`);
    const say = (html) => status && (status.innerHTML = html);
    const ocr = await import('./ocr.js');

    if (!(await ocr.supported())) {
      say('<span class="note warn-note">This browser is too old to run the OCR engine.</span>');
      return;
    }

    // Resume picks up the saved pages; the plain OCR button starts from page 1
    // and overwrites, which is how you redo a bad reading.
    const prior = el.dataset.resume ? await lib.getText(id).catch(() => null) : null;
    const from = prior?.ocr && prior.complete === false && prior.nextPage > 1 ? prior : null;

    const languages = store.settings().readGreek ? ['eng', 'grc'] : ['eng'];

    if (
      !confirm(
        from
          ? `Carry on reading from page ${from.nextPage}?\n\n` +
              `The ${from.pageCount} pages already read are kept.`
          : `Read this scan with OCR?\n\n` +
              `It downloads a ~${ocr.engineMb(languages)} MB engine and word list the first time` +
              `${languages.includes('grc') ? ', Greek included' : ''}, ` +
              `then takes roughly 10–20 seconds per page. Everything happens on this device — ` +
              `nothing is uploaded.\n\n` +
              `Keep this screen in front of you while it works. Switching to another app pauses ` +
              `it — phones freeze web pages in the background, and no app on the web can get ` +
              `around that. Nothing is lost when it does: every page is saved the moment it is ` +
              `read, and a Resume button picks up where it stopped.`
      )
    ) {
      return;
    }

    // Saving after each page means an interruption costs one page, not the run.
    const remember = async (result) => {
      await lib.putText(id, result);
      extractedIds.add(id);
      const cur = store.libraryEntry(id);
      if (cur) {
        store.setLibraryEntry(id, {
          ...cur,
          text: {
            chars: result.chars,
            pageCount: result.pageCount,
            totalPages: result.totalPages,
            complete: result.complete,
            nextPage: result.nextPage,
            confidence: result.confidence,
            poorPages: result.poorPages,
            ocr: true
          }
        });
      }
    };

    say('<span class="note">Fetching the OCR engine…</span>');
    const started = Date.now();
    ocrRunning = id;
    try {
      const blob = await lib.getFile(id);
      if (!blob) throw new Error('That file is not on this device any more.');

      const alreadyDone = from ? from.pages.length : 0;
      const result = await ocr.ocrPdf(
        blob,
        ({ done, total, stage, progress }) => {
          if (stage === 'engine') {
            const pct = Math.round((progress || 0) * 100);
            say(`<span class="note">Fetching the OCR engine… ${pct}%</span>
                 ${progressBar(pct, { size: 'progress-sm' })}
                 <button class="btn small ghost" data-action="cancel-ocr">Cancel</button>`);
            return;
          }
          if (stage === 'words') {
            say('<span class="note">Checking the words against English…</span>');
            return;
          }
          const per = (Date.now() - started) / Math.max(done - alreadyDone, 1);
          const left = Math.round(((total - done) * per) / 1000);
          say(`<span class="note">Reading page ${done} of ${total}${left > 5 ? ` · about ${left}s left` : ''}
               <br>Saved as it goes — leaving the app only pauses it.</span>
               ${progressBar(Math.round((done / total) * 100), { size: 'progress-sm' })}
               <button class="btn small ghost" data-action="cancel-ocr">Cancel</button>`);
        },
        {
          startPage: from ? from.nextPage : 1,
          pages: from ? from.pages : [],
          languages,
          onPage: ({ pages, lastPage, total }) => remember(ocr.summarise(pages, lastPage, total))
        }
      );

      if (!result.pages.length) {
        say('<span class="note warn-note">Stopped before any page was read.</span>');
        return;
      }

      await remember(result);
      say(
        `<span class="note">OCR read ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}
         of ${result.totalPages} (${Math.round(result.chars / 1000)}k characters)${
           result.partial ? ' — stopped early; the Resume button carries on' : ''
         }.
         ${result.confidence ? `The engine rates its own reading ${result.confidence}%. ` : ''}
         ${result.repaired ? `Repaired ${result.repaired} misread word${result.repaired === 1 ? '' : 's'}. ` : ''}
         ${result.deskewed ? `Straightened ${result.deskewed} crooked page${result.deskewed === 1 ? '' : 's'}. ` : ''}
         ${result.notePages ? `Footnotes were found on ${result.notePages} page${result.notePages === 1 ? '' : 's'} and kept separate. ` : ''}
         ${result.emphasised ? `Kept the italics and bold on ${result.emphasised} word${result.emphasised === 1 ? '' : 's'}. ` : ''}
         ${
           languages.includes('grc')
             ? 'It read <strong>English and Greek</strong>; Hebrew still comes back as nonsense.'
             : 'It read <strong>English only</strong> — turn on Greek in Settings if this book has any.'
         }
         It still misreads the odd word, so check anything you quote against the PDF.</span>
         ${
           result.poorPages?.length
             ? `<span class="note warn-note">It struggled with
                  page${result.poorPages.length === 1 ? '' : 's'} ${esc(result.poorPages.slice(0, 8).join(', '))}${
                    result.poorPages.length > 8 ? ` and ${result.poorPages.length - 8} more` : ''
                  }. Those are the ones to check against the PDF first — usually a page that was
                  photographed at an angle or came out too faint.</span>`
             : ''
         }`
      );
      if (result.partial) return refresh();
      refresh();
      return go(`read:${id}`);
    } catch (err) {
      say(`<span class="note warn-note">OCR failed: ${esc(err.message)}</span>`);
    } finally {
      ocrRunning = null;
    }
    return;
  }

  if (action === 'cancel-ocr') {
    const ocr = await import('./ocr.js');
    ocr.cancel();
    el.disabled = true;
    el.textContent = 'Stopping…';
    return;
  }

  if (action === 'find-material') {
    // Tapped the paperclip on a reading: jump to Files and highlight that work.
    focusMaterial = el.dataset.mat;
    return go('files');
  }

  if (action === 'open-material') {
    const id = el.dataset.mat;
    const entry = store.libraryEntry(id);
    if (!entry) return;
    if (entry.kind === 'link') {
      if (!lib.openLink(entry.url)) alert('That link is no longer valid. Remove it and add it again.');
      return;
    }
    const opened = await lib.openStoredFile(id, entry.fileName);
    if (!opened) {
      alert(`"${entry.fileName}" is not stored on this device.\n\nAttach it again from the Files tab — copied files do not travel between devices.`);
    }
    return;
  }

  if (action === 'attach-link') {
    const { mat: id, title } = el.dataset;
    const current = store.libraryEntry(id);
    const answer = prompt(
      `Paste a link for "${title}".\n\nGoogle Drive, Dropbox, OneDrive, iCloud — any https:// address.`,
      current?.url || 'https://'
    );
    if (answer === null) return;
    const url = lib.safeUrl(answer);
    if (!url) {
      alert('That does not look like a web link — it needs to start with https://');
      return;
    }
    store.setLibraryEntry(id, { title, kind: 'link', url });
    return refresh();
  }

  if (action === 'attach-file') {
    const { mat: id, title } = el.dataset;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.epub,application/pdf,application/epub+zip,image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await lib.putFile(id, file);
        store.setLibraryEntry(id, { title, kind: 'file', fileName: file.name, fileSize: file.size });
        lib.requestPersistence();
        refresh();
      } catch (err) {
        alert(
          `Could not store that file: ${err.message}\n\n` +
            'Copying files needs the hosted version of the app, not the single-file offline copy. ' +
            'A link works either way.'
        );
      }
    };
    input.click();
    return;
  }

  if (action === 'detach') {
    const entry = store.libraryEntry(el.dataset.mat);
    if (!entry) return;
    if (!confirm(`Remove the attachment for "${entry.title}"?`)) return;
    if (entry.kind === 'file') {
      await lib.deleteFile(el.dataset.mat).catch(() => {});
      await lib.deleteText(el.dataset.mat).catch(() => {});
      extractedIds.delete(el.dataset.mat);
      store.forgetReading(el.dataset.mat);
    }
    store.removeLibraryEntry(el.dataset.mat);
    return refresh();
  }

  if (action === 'edit-pages') {
    const task = TASKS.find((t) => t.key === key);
    const answer = prompt(`How many pages is "${task.title}" really?`, task.pages);
    if (answer === null) return;
    const n = parseInt(answer, 10);
    store.setOverride(key, Number.isFinite(n) && n > 0 ? n : null);
    return refresh();
  }

  if (action === 'start-timer') {
    const banked = store.startTimer(key, el.dataset.course);
    // Starting something else banks whatever was already running.
    if (banked?.minutes) creditTime(banked);
    return refresh();
  }

  if (action === 'stop-timer') {
    const banked = store.stopTimer();
    if (banked) creditTime(banked);
    return refresh();
  }

  if (action === 'edit-time') {
    const task = TASKS.find((t) => t.key === key);
    if (!task) return;
    const running = store.runningTimer();
    if (running?.key === key) {
      alert('The clock is running on this one. Stop it first and the sitting will be added.');
      return;
    }
    const now = store.totalOn(key);
    const answer = prompt(
      `Total minutes spent on "${task.title}" so far?\n\nThe stopwatch adds to this by itself; ` +
        `set it by hand for time you did not time.`,
      now || 30
    );
    if (answer === null) return;
    const n = Math.round(Number(answer));
    if (!Number.isFinite(n) || n < 0) return;
    store.setTotal(key, n);
    return refresh();
  }

  if (action === 'log-project') {
    const task = TASKS.find((t) => t.key === key);
    const answer = prompt(`Minutes to log for "${task.title}"?`, 30);
    if (answer === null) return;
    const n = parseInt(answer, 10);
    if (Number.isFinite(n) && n > 0) store.setProgress(key, store.progressFor(key) + n);
    return refresh();
  }

  if (action === 'tick-rhythm') {
    store.toggleRhythmDone(el.dataset.rkey);
    return refresh();
  }

  if (action === 'add-habit') {
    const title = prompt('What do you want to do a little of each day?', 'Greek paradigms');
    if (!title) return;
    const id = `habit-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || Date.now()}`;
    if (store.rhythm().some((h) => h.id === id)) return;
    store.setRhythm([
      ...store.rhythm(),
      { id, title: title.trim(), detail: '', courseId: null, minutes: store.DEFAULT_BURST, slots: [...store.SLOT_ORDER] }
    ]);
    return refresh();
  }

  if (action === 'drop-habit') {
    const habit = store.rhythm().find((h) => h.id === el.dataset.habit);
    if (!habit || !confirm(`Stop tracking "${habit.title}"?`)) return;
    store.setRhythm(store.rhythm().filter((h) => h.id !== habit.id));
    return refresh();
  }

  if (action === 'toggle-slot') {
    const { habit: id, slot } = el.dataset;
    store.setRhythm(
      store.rhythm().map((h) => {
        if (h.id !== id) return h;
        const has = h.slots.includes(slot);
        const slots = has ? h.slots.filter((s) => s !== slot) : store.SLOT_ORDER.filter((s) => h.slots.includes(s) || s === slot);
        // A habit with no times of day left has nothing to tick.
        return slots.length ? { ...h, slots } : h;
      })
    );
    return refresh();
  }

  if (action === 'toggle-carry') {
    store.updateSettings({ carryOverdue: !store.settings().carryOverdue });
    return refresh();
  }

  if (action === 'toggle-greek') {
    store.updateSettings({ readGreek: !store.settings().readGreek });
    return refresh();
  }

  if (action === 'toggle-day') {
    const day = Number(el.dataset.day);
    const days = store.settings().studyDays;
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    if (next.length) store.updateSettings({ studyDays: next });
    return refresh();
  }

  if (action === 'set-finish') {
    const raw = el.dataset.day;
    store.updateSettings({ finishDay: raw === 'off' ? null : Number(raw) });
    return refresh();
  }

  // A meeting you arrange yourself, taking the date the app offers for it.
  if (action === 'use-suggested') {
    const [courseId, sessionId] = el.dataset.session.split('|');
    store.setSessionDate(courseId, sessionId, el.dataset.date);
    return refresh();
  }

  if (action === 'use-all-suggested') {
    const course = courseById(el.dataset.course);
    for (const session of course?.sessions || []) {
      if (session.suggest && !S.sessionDate(course, session)) {
        store.setSessionDate(course.id, session.id, session.suggest);
      }
    }
    return refresh();
  }

  if (action === 'clear-session-date') {
    const [courseId, sessionId] = el.dataset.session.split('|');
    store.setSessionDate(courseId, sessionId, null);
    return refresh();
  }

  if (action === 'enable-notif') {
    const result = await notify.requestPermission();
    if (result === 'granted') {
      await notify.registerBackgroundChecks();
      await notify.testNotification();
    } else {
      alert(`Your browser answered: ${result}. On iPhone, add this app to your Home Screen first, then try again.`);
    }
    return refresh();
  }

  if (action === 'test-notif') {
    const ok = await notify.testNotification();
    if (!ok) alert('Notifications are not permitted yet — turn them on above.');
    return;
  }

  if (action === 'export') {
    const blob = new Blob([store.exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `seminary-progress-${S.toISO(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  if (action === 'import') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      try {
        store.importData(await input.files[0].text());
        refresh();
      } catch (err) {
        alert(`That file could not be read: ${err.message}`);
      }
    };
    input.click();
    return;
  }

  if (action === 'copy-diagnostics') {
    const report = await diagnosticReport();
    try {
      await navigator.clipboard.writeText(report);
      el.textContent = 'Copied';
      setTimeout(() => (el.textContent = 'Copy report'), 1500);
    } catch {
      // Clipboard refused — show it instead so it can still be selected.
      $('#diagnostics').textContent = report;
      alert('This browser would not let the app copy. The report is on screen — select and copy it.');
    }
    return;
  }

  if (action === 'clear-problems') {
    store.clearProblems();
    return showDiagnostics();
  }

  if (action === 'clear-times') {
    store.updateSettings({ classTimes: {} });
    return refresh();
  }

  if (action === 'reset') {
    if (confirm('Clear every tick, page marker and fired reminder? Settings are kept.')) {
      store.resetProgress();
      refresh();
    }
  }
});

document.addEventListener('change', (e) => {
  const when = e.target.closest('[data-sessiondate]');
  if (when) {
    const [courseId, sessionId] = when.dataset.sessiondate.split('|');
    store.setSessionDate(courseId, sessionId, when.value || null);
    return refresh();
  }

  const time = e.target.closest('[data-classtime]');
  if (time) {
    const next = { ...store.settings().classTimes };
    if (time.value) next[time.dataset.classtime] = time.value;
    else delete next[time.dataset.classtime];
    store.updateSettings({ classTimes: next });
    return refresh();
  }

  const habitField = e.target.closest('[data-habit-field]');
  if (habitField) {
    const { habit: id, habitField: field } = habitField.dataset;
    const raw = habitField.value.trim();
    // Renaming must not rename the id: the ticks you have already made are
    // filed under it, and a streak should survive a change of wording.
    if (field === 'title' && !raw) return refresh();
    let value = raw;
    if (field === 'minutes') {
      const n = parseInt(raw, 10);
      // 0 is a real answer: it means "do it, do not time it".
      value = Number.isFinite(n) && n >= 0 ? Math.min(120, n) : store.DEFAULT_BURST;
    }
    store.setRhythm(store.rhythm().map((h) => (h.id === id ? { ...h, [field]: value } : h)));
    return refresh();
  }

  const el = e.target.closest('[data-setting]');
  if (!el) return;
  const n = Number(el.value);
  if (!Number.isFinite(n)) return;
  store.updateSettings({ [el.dataset.setting]: n });
  refresh();
});

window.addEventListener('hashchange', () => {
  const next = location.hash.replace('#', '') || 'today';
  if (next !== view) go(next);
});

function refresh() {
  rebuild();
  render();
}

/* ---------------- boot ---------------- */

async function checkReminders() {
  await notify.checkReminders(TASKS);
  await notify.dailyNudge(todayBucket());
}

async function boot() {
  // Before anything else, so a failure during start-up is recorded too.
  addEventListener('error', (e) =>
    store.logProblem(e.message || 'script error', `${e.filename || '?'}:${e.lineno || 0}`)
  );
  addEventListener('unhandledrejection', (e) =>
    store.logProblem(e.reason?.message || String(e.reason), 'a task that never finished')
  );

  try {
    DATA = await loadData();
  } catch (err) {
    $('#app').innerHTML = `<section class="card"><h2>Could not start</h2><p class="note">${esc(err.message)}</p>
      <p class="note">This app must be served over http(s), not opened as a file.</p></section>`;
    return;
  }
  rebuild();
  await loadExtractedIds();
  render();

  // A page opened straight off the filesystem cannot have a service worker,
  // and does not need one — it is already local.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      // If a newer worker takes over mid-session, pick up its files right away
      // rather than leaving a stale app on screen until the next cold start.
      const hadController = Boolean(navigator.serviceWorker.controller);
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });

      // updateViaCache 'none' keeps the browser's HTTP cache out of the update
      // check, so a new worker is noticed the first time the app is opened.
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      reg.update().catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'check-deadlines') checkReminders();
      });
    } catch (err) {
      console.warn('Service worker registration failed', err);
    }
  }

  await checkReminders();

  // Re-check when you come back to the app, and if it is left open overnight.
  // Leaving the app must not lose the last few lines you read.
  addEventListener('pagehide', () => store.flush());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return store.flush();
    // Coming back to a run in progress: leave the screen exactly as it was, or
    // the redraw would detach the very element it is reporting into.
    if (!ocrRunning) refresh();
    checkReminders();
  });
  setInterval(checkReminders, 60 * 60 * 1000);
}

boot();
