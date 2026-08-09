import * as store from './store.js';
import * as S from './schedule.js';
import * as notify from './notify.js';
import * as lib from './library.js';

// Shown in Settings so you can tell at a glance which version a device is
// actually running. Bump it alongside the service worker's CACHE.
const BUILD = 'v8 · 2026-08-09';

let DATA = null;
let TASKS = [];
let view = location.hash.replace('#', '') || 'today';
// Set when you tap a paperclip in a reading list: the Files view scrolls to it.
let focusMaterial = null;

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
function currentPlans() {
  return S.nextSessionPerCourse(DATA).map(({ course, session, date }) => {
    const tasks = TASKS.filter((t) => t.courseId === course.id && t.sessionDate === session.date);
    // Pass the deadline with its hour attached: an evening class leaves the
    // class day itself available to read in.
    const deadline = S.withTime(date, S.classTimeFor(course));
    return { course, session, date, deadline, tasks, plan: S.planFor(tasks, deadline) };
  });
}

function activeProjects(from = S.startOfToday()) {
  return TASKS.filter((t) => t.unit === 'project' && !t.complete && S.dueAt(t) >= new Date())
    .map((t) => ({ task: t, pace: S.projectPace(t, from) }))
    .filter((p) => p.pace);
}

/** Everything the plan says to do today, flattened across courses. */
function todayBucket() {
  const today = S.startOfToday();
  const items = [];
  let minutes = 0;
  for (const { course, plan } of currentPlans()) {
    const day = plan.plan.find((d) => S.daysBetween(d.date, today) === 0);
    if (!day) continue;
    for (const atom of day.items) items.push({ ...atom, course });
    minutes += day.minutes;
  }
  const projects = activeProjects(today).filter((p) => p.pace.todayIsStudyDay);
  projects.forEach((p) => (minutes += p.pace.perDay));
  return { items, projects, minutes, title: items.map((i) => i.task.title) };
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

/** The open-it / attach-it button that sits on every reading. */
function materialButton(task) {
  if (task.kind !== 'reading') return '';
  const name = task.material || task.title;
  const id = lib.materialId(name);
  const entry = store.libraryEntry(id);
  if (entry) {
    return `<button class="matbtn has" data-action="open-material" data-mat="${esc(id)}"
              title="Open ${esc(entry.title)}" aria-label="Open ${esc(entry.title)}">${ICON_OPEN}</button>`;
  }
  return `<button class="matbtn" data-action="find-material" data-mat="${esc(id)}"
            title="Attach ${esc(name)}" aria-label="Attach ${esc(name)}">${ICON_CLIP}</button>`;
}

function taskLine(task, { showCourse = false, chunk = null } = {}) {
  const done = task.complete;
  const checked = chunk ? (task.read >= chunk.through ? 'checked' : '') : done ? 'checked' : '';
  const detail = chunk ? chunk.label : task.detail;
  const amount = chunk
    ? S.formatMinutes(chunk.minutes)
    : task.unit === 'project'
      ? S.formatMinutes(task.remaining || task.minutes)
      : S.amountLabel(task.raw, task.key);

  const attrs = chunk
    ? `data-action="chunk" data-key="${esc(task.key)}" data-from="${chunk.from}" data-through="${chunk.through}" data-total="${task.pages}"`
    : `data-action="toggle" data-key="${esc(task.key)}"`;

  const partial = !chunk && task.read > 0 && !done;
  const flags = [
    task.driver ? pill('drives discussion', 'accent') : '',
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
          ${showCourse ? dot(task.color) : ''}${esc(task.title)}
        </div>
        ${detail ? `<div class="task-detail">${esc(detail)}</div>` : ''}
        ${
          partial
            ? `<div class="task-detail muted">${task.read} of ${task.pages} pp. read</div>${progressBar(S.itemPct(task), { size: 'progress-sm' })}`
            : ''
        }
        ${task.flag ? `<div class="task-flag">⚠ ${esc(task.flag)}</div>` : ''}
        <div class="tags">${flags}</div>
      </div>
      ${materialButton(task)}
      <button class="amount ${task.unit === 'pages' && !chunk ? 'editable' : ''}"
              ${task.unit === 'pages' && !chunk ? `data-action="edit-pages" data-key="${esc(task.key)}"` : 'disabled'}>
        ${esc(amount)}
      </button>
    </li>`;
}

function dayRow(day, courseColor) {
  const isToday = S.daysBetween(day.date, S.startOfToday()) === 0;
  return `
    <div class="day ${isToday ? 'is-today' : ''}">
      <div class="day-head">
        <span class="day-name">${isToday ? 'Today' : S.formatDate(day.date)}</span>
        <span class="day-mins">${day.minutes ? S.formatMinutes(day.minutes) : '—'}</span>
      </div>
      <ul class="tasks">
        ${day.items.map((atom) => taskLine({ ...atom.task, color: courseColor }, { chunk: atom })).join('') || '<li class="empty">Nothing scheduled</li>'}
      </ul>
    </div>`;
}

/* ---------------- views ---------------- */

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
      <div class="hero-sub">${bucket.minutes ? "today's reading target" : 'enjoy the quiet'}</div>
      <div class="bar"><div class="bar-fill" style="width:${overall.pct}%"></div></div>
      <div class="hero-sub">${overall.pct}% of this week's work done</div>
    </section>

    ${
      plans.length
        ? `<section class="card">
             <h2>Progress toward next class</h2>
             ${plans
               .map(({ course, session, tasks }) => {
                 const w = S.workload(tasks);
                 return `
                 <div class="course-progress">
                   <div class="course-progress-head">
                     <span>${dot(course.color)}${esc(course.short || course.name)}</span>
                     <span class="muted">${esc(session.topic)}</span>
                   </div>
                   ${progressBar(w)}
                 </div>`;
               })
               .join('')}
           </section>`
        : ''
    }

    ${
      bucket.items.length
        ? `<section class="card">
             <h2>Read today</h2>
             <ul class="tasks">${bucket.items.map((a) => taskLine({ ...a.task, color: a.course.color }, { chunk: a, showCourse: true })).join('')}</ul>
           </section>`
        : ''
    }

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
                   <button class="amount editable" data-action="log-project" data-key="${esc(task.key)}">+${S.formatMinutes(pace.perDay)}</button>
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
      .map(({ course, session, date, tasks, plan }) => {
        const w = S.workload(tasks);
        const pages = tasks.reduce((a, t) => a + (t.unit === 'pages' ? t.pages : 0), 0);
        const pagesLeft = tasks.reduce((a, t) => a + (t.unit === 'pages' ? t.remainingPages : 0), 0);
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
            <div><span class="stat">${plan.days}</span><small>study days</small></div>
            <div><span class="stat">${S.formatMinutes(plan.perDay)}</span><small>per day</small></div>
          </div>
          <div class="days">${plan.plan.map((d) => dayRow(d, course.color)).join('')}</div>
          <details class="all-readings">
            <summary>Everything due for this class (${tasks.length})</summary>
            <ul class="tasks">${tasks.map((t) => taskLine(t)).join('')}</ul>
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
                  <button class="amount editable" data-action="log-project" data-key="${esc(task.key)}">log</button>
                </li>`
                )
                .join('')}
            </ul>
          </section>`
        : ''
    }`;
}

function viewSchedule() {
  const today = S.startOfToday();
  const rows = [];
  for (const course of DATA.courses) {
    for (const session of course.sessions) {
      rows.push({ course, session, date: S.parseDate(session.date) });
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
            const tasks = TASKS.filter((t) => t.courseId === course.id && t.sessionDate === session.date);
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
    </section>`;
}

/** Every distinct work assigned this term, with where it is used. */
function materials() {
  const map = new Map();
  for (const t of TASKS) {
    if (t.kind !== 'reading') continue;
    const name = t.material || t.title;
    const id = lib.materialId(name);
    if (!map.has(id)) {
      map.set(id, { id, name, courses: new Set(), uses: 0, isPdf: false, nextDue: null });
    }
    const m = map.get(id);
    m.courses.add(t.course);
    m.uses += 1;
    if (t.format === 'pdf') m.isPdf = true;
    const due = S.parseDate(t.due);
    if (!t.complete && due >= S.startOfToday() && (!m.nextDue || due < m.nextDue)) m.nextDue = due;
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
function readButton(m, entry) {
  if (entry.kind !== 'file') return '';
  const isPdf = /\.pdf$/i.test(entry.fileName || '');
  if (!isPdf) return '';
  if (extractedIds.has(m.id)) {
    return `<button class="btn small" data-action="read-text" data-mat="${esc(m.id)}">Read text</button>`;
  }
  return `<button class="btn small ghost" data-action="extract-text" data-mat="${esc(m.id)}">Get text</button>`;
}

function viewFiles() {
  const list = materials();
  const attached = list.filter((m) => store.libraryEntry(m.id)).length;

  return `
    <section class="card">
      <h2>Your materials</h2>
      <p class="note">
        Attach each book or PDF once and it opens from every class that assigns it —
        tap the <span class="inline-icon">${ICON_OPEN}</span> next to any reading.
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
        photographed scan the app will say so rather than hand you gibberish.
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
        Not confirmed yet, so the app assumes <strong>6:00 pm</strong> and marks it as an assumption.
        The time matters for two things: when a due-date reminder counts as passed, and whether class
        day itself is still available to read in — for an evening class it is, so the plan uses it.
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
      <h2>Study days</h2>
      <p class="note">Reading is spread across the days you tick. Untick your day off.</p>
      <div class="chips">
        ${dayNames
          .map(
            (n, i) =>
              `<button class="chip ${s.studyDays.includes(i) ? 'on' : ''}" data-action="toggle-day" data-day="${i}">${n}</button>`
          )
          .join('')}
      </div>
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

/** "read:bavinck-..." carries an argument; every other view is a bare name. */
function parseView(hash) {
  const raw = hash.replace('#', '') || 'today';
  const [name, ...rest] = raw.split(':');
  return { name, arg: rest.join(':') || null };
}

function render() {
  const main = $('#app');
  const { name, arg } = parseView(view);

  if (name === 'read') {
    main.innerHTML = '<section class="card"><p class="note">Opening…</p></section>';
    renderReader(arg);
  } else {
    main.innerHTML = (VIEWS[name] || viewToday)();
  }
  main.scrollTop = 0;
  document.querySelectorAll('.tab').forEach((el) =>
    el.classList.toggle('on', el.dataset.view === name || (name === 'read' && el.dataset.view === 'files'))
  );
  document.title = name === 'today' ? 'Seminary — Today' : `Seminary — ${name}`;

  if (name === 'files') {
    loadExtractedIds().then(() => {
      // Only redraw if the set actually changed the buttons we just painted.
      const shown = new Set([...document.querySelectorAll('[data-action="read-text"]')].map((b) => b.dataset.mat));
      const same = shown.size === extractedIds.size && [...extractedIds].every((id) => shown.has(id));
      if (!same && parseView(view).name === 'files') render();
    });
    if (focusMaterial) {
      $(`#mat-${CSS.escape(focusMaterial)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      focusMaterial = null;
    }
    showStorageUsage();
  }
}

/** The reader: extracted text, laid out to be read rather than skimmed. */
async function renderReader(id) {
  const entry = store.libraryEntry(id);
  const extracted = await lib.getText(id).catch(() => null);
  const main = $('#app');

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
  main.innerHTML = `
    <section class="card reader-bar">
      <div class="card-head">
        <h2>${esc(entry.title)}</h2>
        <span class="card-when">${extracted.pageCount} pages · ${Math.round(extracted.chars / 1000)}k characters</span>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost small" data-action="goto-files">Files</button>
        <button class="btn ghost small" data-action="reader-smaller">A−</button>
        <button class="btn ghost small" data-action="reader-bigger">A+</button>
        <button class="btn ghost small" data-action="copy-text">Copy all</button>
      </div>
    </section>
    <section class="card reader" style="--reader-size:${size}px">
      ${extracted.pages
        .filter((p) => p.text)
        .map(
          (p) => `
        <div class="reader-page">
          <div class="reader-pagenum">page ${p.page}</div>
          ${p.text
            .split('\n\n')
            .map((para) => `<p>${esc(para)}</p>`)
            .join('')}
        </div>`
        )
        .join('')}
    </section>`;
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

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) return go(tab.dataset.view);

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
      if (through >= total) store.setDone(key, true);
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
      await navigator.clipboard.writeText(toPlainText(extracted));
      el.textContent = 'Copied';
      setTimeout(() => (el.textContent = 'Copy all'), 1500);
    } catch {
      alert('This browser would not let the app write to the clipboard.');
    }
    return;
  }

  if (action === 'read-text') return go(`read:${el.dataset.mat}`);

  if (action === 'extract-text') {
    const id = el.dataset.mat;
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
        el.disabled = false;
        return;
      }

      await lib.putText(id, result);
      extractedIds.add(id);
      const partial =
        result.emptyPages > 0
          ? ` ${result.emptyPages} of ${result.pageCount} pages had no text — probably images or plates.`
          : '';
      say(`<span class="note">Got ${Math.round(result.chars / 1000)}k characters from
           ${result.pageCount - result.emptyPages} pages.${partial}</span>`);
      refresh();
      return go(`read:${id}`);
    } catch (err) {
      say(`<span class="note warn-note">Could not read that PDF: ${esc(err.message)}</span>`);
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
    if (
      !confirm(
        `Read this scan with OCR?\n\n` +
          `It downloads a ~${ocr.ENGINE_MB} MB engine the first time, then takes roughly ` +
          `10–20 seconds per page. Everything happens on this device — nothing is uploaded.\n\n` +
          `You can leave the app open and come back to it.`
      )
    ) {
      return;
    }

    say('<span class="note">Fetching the OCR engine…</span>');
    const started = Date.now();
    try {
      const blob = await lib.getFile(id);
      if (!blob) throw new Error('That file is not on this device any more.');

      const result = await ocr.ocrPdf(blob, ({ done, total, stage, progress }) => {
        if (stage === 'engine') {
          const pct = Math.round((progress || 0) * 100);
          say(`<span class="note">Fetching the OCR engine… ${pct}%</span>
               ${progressBar(pct, { size: 'progress-sm' })}
               <button class="btn small ghost" data-action="cancel-ocr">Cancel</button>`);
          return;
        }
        const per = (Date.now() - started) / Math.max(done, 1);
        const left = Math.round(((total - done) * per) / 1000);
        say(`<span class="note">Reading page ${done} of ${total}${left > 5 ? ` · about ${left}s left` : ''}</span>
             ${progressBar(Math.round((done / total) * 100), { size: 'progress-sm' })}
             <button class="btn small ghost" data-action="cancel-ocr">Cancel</button>`);
      });

      if (!result.pages.length) {
        say('<span class="note warn-note">Cancelled before any page was read.</span>');
        return;
      }

      await lib.putText(id, result);
      extractedIds.add(id);
      say(
        `<span class="note">OCR read ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}
         (${Math.round(result.chars / 1000)}k characters)${result.partial ? ', stopped early' : ''}.
         OCR misreads some words — check anything you quote against the PDF.</span>`
      );
      refresh();
      return go(`read:${id}`);
    } catch (err) {
      say(`<span class="note warn-note">OCR failed: ${esc(err.message)}</span>`);
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

  if (action === 'log-project') {
    const task = TASKS.find((t) => t.key === key);
    const answer = prompt(`Minutes to log for "${task.title}"?`, 30);
    if (answer === null) return;
    const n = parseInt(answer, 10);
    if (Number.isFinite(n) && n > 0) store.setProgress(key, store.progressFor(key) + n);
    return refresh();
  }

  if (action === 'toggle-day') {
    const day = Number(el.dataset.day);
    const days = store.settings().studyDays;
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    if (next.length) store.updateSettings({ studyDays: next });
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
  const time = e.target.closest('[data-classtime]');
  if (time) {
    const next = { ...store.settings().classTimes };
    if (time.value) next[time.dataset.classtime] = time.value;
    else delete next[time.dataset.classtime];
    store.updateSettings({ classTimes: next });
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refresh();
      checkReminders();
    }
  });
  setInterval(checkReminders, 60 * 60 * 1000);
}

boot();
