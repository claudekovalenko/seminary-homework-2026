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
  notificationsEnabled: false,
  reminderHour: 8,
  theme: 'auto'
};

const EMPTY = {
  settings: { ...DEFAULT_SETTINGS },
  done: {}, // itemKey -> true
  progress: {}, // itemKey -> pages already read (for readings split across days)
  overrides: {}, // itemKey -> page count (number)
  fired: {} // reminderKey -> ISO timestamp
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
      overrides: parsed.overrides || {},
      fired: parsed.fired || {}
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

export const overrideFor = (key) => state.overrides[key];

export function setOverride(key, pages) {
  if (pages === null || pages === undefined || Number.isNaN(pages)) delete state.overrides[key];
  else state.overrides[key] = pages;
  persist();
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
    overrides: parsed.overrides || {},
    fired: parsed.fired || {}
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
