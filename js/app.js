import * as store from './store.js';
import * as S from './schedule.js';
import * as notify from './notify.js';

let DATA = null;
let TASKS = [];
let view = location.hash.replace('#', '') || 'today';

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
    </section>`;
}

/* ---------------- shell ---------------- */

const VIEWS = { today: viewToday, plan: viewPlan, schedule: viewSchedule, settings: viewSettings };

function render() {
  const main = $('#app');
  main.innerHTML = (VIEWS[view] || viewToday)();
  main.scrollTop = 0;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.view === view));
  document.title = view === 'today' ? 'Seminary — Today' : `Seminary — ${view}`;
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
  render();

  // A page opened straight off the filesystem cannot have a service worker,
  // and does not need one — it is already local.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      await navigator.serviceWorker.register('./sw.js');
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
