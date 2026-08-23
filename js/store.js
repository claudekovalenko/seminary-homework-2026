// Local persistence: settings, per-item completion, page-count overrides,
// and a record of which reminders have already fired.

const KEY = 'seminary.v1';

export const DEFAULT_SETTINGS = {
  // Which days of the week you actually study. 0 = Sunday .. 6 = Saturday.
  studyDays: [1, 2, 3, 4, 5, 6],
  // How far ahead the app warns you about a deadline.
  leadDays: 7,
  // Effort model, used to turn mixed units into a daily time target.
  minsPerPage: 3,
  minsPerGreekVerse: 5,
  minsPerBibleChapter: 5,
  // Default guess when a reading is given as "ch. 4" with no page numbers.
  defaultChapterPages: 22,
  // Confirmed class times, keyed by course id — overrides whatever the
  // syllabus data says. Empty until you know when a class actually meets.
  classTimes: {},
  // Sections you have folded away, by id. Kept in settings so a section stays
  // shut across the re-renders that happen every time you tick something off.
  collapsed: {},
  readerFontSize: 17,
  notificationsEnabled: false,
  reminderHour: 8,
  theme: 'auto'
};

const EMPTY = {
  settings: { ...DEFAULT_SETTINGS },
  done: {}, // itemKey -> true
  progress: {}, // itemKey -> pages already read (for readings split across days)
  library: {}, // materialId -> { title, kind: 'link'|'file', url?, fileName?, fileSize? }
  overrides: {}, // itemKey -> page count (number)
  fired: {}, // reminderKey -> ISO timestamp
  reading: {}, // materialId -> { page, para } — where you had got to
  bookmarks: {}, // materialId -> [{ page, para, text, at }]
  sessionDates: {}, // "courseId|sessionId" -> ISO date, for meetings you arrange
  running: null, // { key, courseId, startedAt } — the stopwatch, if one is going
  timeLog: [] // [{ key, courseId, minutes, at }] — sittings, for weekly totals
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw);
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      done: parsed.done || {},
      progress: parsed.progress || {},
      library: parsed.library || {},
      overrides: parsed.overrides || {},
      fired: parsed.fired || {},
      reading: parsed.reading || {},
      bookmarks: parsed.bookmarks || {},
      sessionDates: parsed.sessionDates || {},
      running: parsed.running || null,
      timeLog: Array.isArray(parsed.timeLog) ? parsed.timeLog : []
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

let state = read();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save to localStorage', err);
  }
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const settings = () => state.settings;

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
}

export const isCollapsed = (id) => Boolean(state.settings.collapsed?.[id]);

export function setCollapsed(id, value) {
  const collapsed = { ...(state.settings.collapsed || {}) };
  if (value) collapsed[id] = true;
  else delete collapsed[id];
  updateSettings({ collapsed });
}

export const isDone = (key) => Boolean(state.done[key]);

export function setDone(key, value) {
  if (value) state.done[key] = true;
  else delete state.done[key];
  persist();
}

export function toggleDone(key) {
  setDone(key, !isDone(key));
  return isDone(key);
}

export const progressFor = (key) => state.progress[key] || 0;

export function setProgress(key, pages) {
  if (!pages || pages <= 0) delete state.progress[key];
  else state.progress[key] = pages;
  persist();
}

/* ---------- attached course materials ---------- */

export const libraryEntry = (id) => state.library[id];

export const libraryAll = () => state.library;

export function setLibraryEntry(id, entry) {
  state.library[id] = { ...entry, addedAt: entry.addedAt || new Date().toISOString() };
  persist();
}

export function removeLibraryEntry(id) {
  delete state.library[id];
  persist();
}

/* ---------- where you are in a book ---------- */

export const readingPos = (id) => state.reading[id] || null;

/**
 * Saved on every scroll, so it must not touch the disk on every scroll.
 * localStorage writes are synchronous and would stutter the page; the position
 * is only worth persisting once you have settled somewhere.
 */
let posTimer = null;
export function setReadingPos(id, pos) {
  if (!pos) delete state.reading[id];
  else state.reading[id] = { ...pos, at: new Date().toISOString() };
  clearTimeout(posTimer);
  posTimer = setTimeout(persist, 700);
}

/** Write a deferred change out now — before the app is closed or hidden. */
export function flush() {
  if (!posTimer) return;
  clearTimeout(posTimer);
  posTimer = null;
  persist();
}

export const bookmarksFor = (id) => state.bookmarks[id] || [];

export const bookmarksAll = () => state.bookmarks;

/* ---------- dates you have arranged yourself ---------- */

export const sessionDates = () => state.sessionDates;

export function setSessionDate(courseId, sessionId, iso) {
  const key = `${courseId}|${sessionId}`;
  if (iso) state.sessionDates[key] = iso;
  else delete state.sessionDates[key];
  persist();
}

export const readingAll = () => state.reading;

export const bookmarkKey = (mark) => `${mark.page}:${mark.para}`;

/** Adding a bookmark you already have removes it, so the button toggles. */
export function toggleBookmark(id, mark) {
  const list = state.bookmarks[id] || [];
  const key = bookmarkKey(mark);
  const without = list.filter((m) => bookmarkKey(m) !== key);
  const added = without.length === list.length;
  if (added) without.push({ ...mark, at: new Date().toISOString() });
  without.sort((a, b) => a.page - b.page || a.para - b.para);
  if (without.length) state.bookmarks[id] = without;
  else delete state.bookmarks[id];
  persist();
  return added;
}

export function removeBookmark(id, key) {
  const list = (state.bookmarks[id] || []).filter((m) => bookmarkKey(m) !== key);
  if (list.length) state.bookmarks[id] = list;
  else delete state.bookmarks[id];
  persist();
}

export function forgetReading(id) {
  delete state.reading[id];
  delete state.bookmarks[id];
  persist();
}

export const overrideFor = (key) => state.overrides[key];

export function setOverride(key, pages) {
  if (pages === null || pages === undefined || Number.isNaN(pages)) delete state.overrides[key];
  else state.overrides[key] = pages;
  persist();
}

/* ---------- the stopwatch ---------- */

// A sitting longer than this is somebody who forgot to press stop, not somebody
// who worked through the night. It is capped rather than discarded, so the work
// still counts for something and the number stays believable.
const LONGEST_SITTING = 6 * 60;
const LOG_LIMIT = 400;

export const runningTimer = () => state.running;

/**
 * Only one thing can be timed at once, which is how working actually goes.
 * Starting something else banks the sitting in progress first.
 */
export function startTimer(key, courseId) {
  const banked = stopTimer();
  state.running = { key, courseId: courseId || null, startedAt: new Date().toISOString() };
  persist();
  return banked;
}

/** Stop and bank whatever was running. Returns what was recorded, or null. */
export function stopTimer() {
  const running = state.running;
  state.running = null;
  if (!running) {
    persist();
    return null;
  }
  const minutes = Math.min(LONGEST_SITTING, Math.round((Date.now() - new Date(running.startedAt).getTime()) / 60000));
  if (minutes > 0) {
    state.timeLog = [
      ...state.timeLog,
      { key: running.key, courseId: running.courseId, minutes, at: new Date().toISOString() }
    ].slice(-LOG_LIMIT);
  }
  persist();
  return { ...running, minutes };
}

export function cancelTimer() {
  state.running = null;
  persist();
}

/** Record time worked away from the app, or corrected by hand. */
export function logTime(key, courseId, minutes) {
  if (!minutes) return;
  state.timeLog = [...state.timeLog, { key, courseId: courseId || null, minutes, at: new Date().toISOString() }].slice(-LOG_LIMIT);
  persist();
}

export const timeLog = () => state.timeLog;

/* ---------- a record of things going wrong ---------- */

const PROBLEM_KEY = 'seminary.problems';
const PROBLEM_LIMIT = 20;

/**
 * Keep the last few errors, so "it keeps glitching" can be answered with what
 * actually happened. Stored separately from everything else and capped, because
 * whatever is failing must not be able to fill the disk by failing repeatedly.
 * A repeat of the same fault bumps a counter rather than adding a line.
 */
export function logProblem(what, where) {
  try {
    const list = problems();
    const last = list[list.length - 1];
    if (last && last.what === what && last.where === where) {
      last.count = (last.count || 1) + 1;
      last.at = new Date().toISOString();
    } else {
      list.push({ what: String(what).slice(0, 300), where: String(where || '').slice(0, 200), at: new Date().toISOString(), count: 1 });
    }
    localStorage.setItem(PROBLEM_KEY, JSON.stringify(list.slice(-PROBLEM_LIMIT)));
  } catch {
    /* if even this fails, there is nothing useful left to do */
  }
}

export function problems() {
  try {
    const raw = localStorage.getItem(PROBLEM_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearProblems() {
  try {
    localStorage.removeItem(PROBLEM_KEY);
  } catch {
    /* nothing to do */
  }
}

export const hasFired = (key) => Boolean(state.fired[key]);

export function markFired(key, when) {
  state.fired[key] = when;
  persist();
}

export function exportData() {
  return JSON.stringify(state, null, 2);
}

export function importData(json) {
  const parsed = JSON.parse(json);
  state = {
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    done: parsed.done || {},
    progress: parsed.progress || {},
    library: parsed.library || {},
    overrides: parsed.overrides || {},
    fired: parsed.fired || {},
    reading: parsed.reading || {},
    bookmarks: parsed.bookmarks || {},
    sessionDates: parsed.sessionDates || {},
    running: parsed.running || null,
    timeLog: Array.isArray(parsed.timeLog) ? parsed.timeLog : []
  };
  persist();
}

export function resetProgress() {
  state.done = {};
  state.progress = {};
  state.fired = {};
  persist();
}

export function resetAll() {
  state = structuredClone(EMPTY);
  persist();
}
