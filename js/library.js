// Course materials you attach yourself: a link you paste (Drive, Dropbox,
// iCloud, anything https) or a file copied into this browser's own storage.
//
// Attachments are keyed by the *work*, not the week, so attaching Bavinck once
// makes it openable from all four classes that assign it.
//
// Metadata lives in store.js (localStorage, travels with export/import).
// File bytes live here in IndexedDB — device-local, too big for localStorage.

const DB_NAME = 'seminary-library';
const STORE = 'files';
// Extracted text lives beside the file it came from, keyed by the same id.
const TEXT_STORE = 'text';

export const available = typeof indexedDB !== 'undefined';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 2);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(TEXT_STORE)) db.createObjectStore(TEXT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

async function tx(mode, run, storeName = STORE) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = run(t.objectStore(storeName));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putFile = (id, blob) => tx('readwrite', (s) => s.put(blob, id));
export const getFile = (id) => tx('readonly', (s) => s.get(id));
export const deleteFile = (id) => tx('readwrite', (s) => s.delete(id));
export const listFileIds = () => tx('readonly', (s) => s.getAllKeys());

/* ---------- text extracted from those files ---------- */

export const putText = (id, extracted) => tx('readwrite', (s) => s.put(extracted, id), TEXT_STORE);
export const getText = (id) => tx('readonly', (s) => s.get(id), TEXT_STORE);
export const deleteText = (id) => tx('readwrite', (s) => s.delete(id), TEXT_STORE);
export const listTextIds = () => tx('readonly', (s) => s.getAllKeys(), TEXT_STORE);

/** A stable key for a work, derived from its title. */
export function materialId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Accept only real web links — never javascript: or data: from a paste. */
export function safeUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}

export function openLink(url) {
  const safe = safeUrl(url);
  if (!safe) return false;
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}

/** Open a stored file in a new tab, falling back to a download. */
/**
 * Hand a file to the browser to display or save.
 *
 * Deliberately not a plain link to the file's address. Added to the home
 * screen, the app runs without browser chrome, and following a link to a PDF
 * from there either does nothing or navigates the app itself away to a document
 * it has no back button from. Handing over a blob keeps the app where it is.
 */
export function openBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'material';
    a.rel = 'noopener';
    a.click();
  }
  // Give the new tab time to load before the URL stops resolving.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export async function openStoredFile(id, fileName) {
  let blob;
  try {
    blob = await getFile(id);
  } catch {
    return false;
  }
  if (!blob) return false;
  return openBlob(blob, fileName);
}

/** Ask the browser not to evict our files when storage runs low. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return navigator.storage?.persist ? await navigator.storage.persist() : false;
  } catch {
    return false;
  }
}

export async function usage() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage: used, quota } = await navigator.storage.estimate();
    return { used, quota };
  } catch {
    return null;
  }
}

export const formatBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
