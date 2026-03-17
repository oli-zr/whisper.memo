/**
 * storage.js – Datei-Persistierung
 * Nutzt File System Access API für echte Dateien auf dem Mac.
 * Nutzt IndexedDB um den Ordner-Handle über Browser-Neustarts zu merken.
 */

// ── IndexedDB ──────────────────────────────────────────────────────────────────
const DB_NAME    = 'memo-v2';
const DB_VERSION = 1;
const STORE      = 'settings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess       = e => resolve(e.target.result);
    req.onerror         = e => reject(e.target.error);
  });
}

export async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ── File System Access API ─────────────────────────────────────────────────────

/** Ist die File System Access API verfügbar? (Chrome/Arc/Brave – nicht Safari) */
export function fsaSupported() {
  return 'showDirectoryPicker' in window;
}

/**
 * Gespeicherten Ordner-Handle aus IndexedDB laden + Berechtigung prüfen.
 * Gibt null zurück wenn kein Handle oder keine Berechtigung.
 */
export async function restoreFolderHandle() {
  try {
    const handle = await dbGet('rootDirHandle');
    if (!handle) return null;
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted' ? handle : null;
  } catch {
    return null;
  }
}

/** Ordner öffnen oder erstellen */
export function getOrCreateDir(parentHandle, name) {
  return parentHandle.getDirectoryHandle(name, { create: true });
}

/**
 * Datei schreiben (String, Blob, ArrayBuffer oder Uint8Array).
 */
export async function writeFile(dirHandle, filename, content) {
  const fh       = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

/** Datei lesen → String oder null */
export async function readFile(dirHandle, filename) {
  try {
    const fh   = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return file.text();
  } catch {
    return null;
  }
}

/** Datei als Blob/File lesen → File oder null */
export async function readFileAsBlob(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename);
    return fh.getFile();
  } catch {
    return null;
  }
}

/** Datei löschen – kein Fehler wenn nicht vorhanden */
export async function deleteFile(dirHandle, filename) {
  try { await dirHandle.removeEntry(filename); } catch {}
}

/** Verzeichnis rekursiv löschen */
export async function deleteDir(parentHandle, name) {
  try { await parentHandle.removeEntry(name, { recursive: true }); } catch {}
}
