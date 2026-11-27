/* ===== Browser storage: IndexedDB for large caches & custom projects, with localStorage migration ===== */
const DB_NAME = 'SiteLensDB';
const STORE_NAME = 'kv';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function idbGet(key) {
  const db = await openDB();
  if (db) {
    try {
      const val = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => reject(req.error);
      });
      if (val !== null) return val;
    } catch (e) { console.warn('idbGet failed:', key, e); }
  }
  return null;
}

export async function idbSet(key, val) {
  const db = await openDB();
  if (db) {
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) { console.warn('idbSet failed:', key, e); }
  }
  if (typeof localStorage === 'undefined') return false;
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { console.warn('localStorage fallback failed:', key, e); return false; }
}

export async function idbDel(key) {
  const db = await openDB();
  if (db) {
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn('idbDel failed:', key, e); }
  }
  try { localStorage.removeItem(key); } catch (e) {}
}

// Read from IndexedDB; if absent, migrate an existing JSON value from localStorage and free localStorage quota.
export async function idbGetWithMigration(key) {
  const val = await idbGet(key);
  if (val !== null) return val;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const saved = await idbSet(key, parsed);
    if (saved) localStorage.removeItem(key);
    return parsed;
  } catch (e) {
    return null;
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeMap(obj, validator) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (!validator || validator(v)) out[k] = v;
  }
  return out;
}
