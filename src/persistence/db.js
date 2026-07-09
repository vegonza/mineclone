/**
 * Persists player block edits per chunk in IndexedDB.
 *
 * Only the diff against the generated terrain is stored, so a heavily-built
 * world still costs a few kilobytes. Each edit is packed as
 * `(blockIndex << 8) | blockId` in a Uint32Array.
 */
const DB_NAME = 'mineclon';
const DB_VERSION = 1;
const STORE = 'edits';

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export class EditStore {
  constructor(db, seed) {
    this.db = db;
    this.seed = seed;
    /** @type {Map<string, Map<number, number>>} */
    this.cache = new Map();
    /** @type {Set<string>} */
    this.dirty = new Set();
    this._flushTimer = null;
  }

  static async open(seed) {
    let db = null;
    try {
      db = await openDB();
    } catch {
      console.warn('[mineclon] IndexedDB unavailable — edits will not persist.');
    }
    const store = new EditStore(db, seed);
    if (db) await store._loadAll();
    return store;
  }

  _key(cx, cz) {
    return `${this.seed}:${cx},${cz}`;
  }

  async _loadAll() {
    const prefix = `${this.seed}:`;
    const store = tx(this.db, 'readonly');
    const keys = await wrap(store.getAllKeys());
    const values = await wrap(tx(this.db, 'readonly').getAll());

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const packed = values[i];
      if (!packed) continue;
      const map = new Map();
      for (const entry of packed) map.set(entry >>> 8, entry & 0xff);
      this.cache.set(key, map);
    }
  }

  /** @returns {Map<number, number>|null} */
  getEdits(cx, cz) {
    const m = this.cache.get(this._key(cx, cz));
    return m && m.size ? new Map(m) : null;
  }

  markDirty(chunk) {
    const key = this._key(chunk.cx, chunk.cz);
    this.cache.set(key, new Map(chunk.edits));
    this.dirty.add(key);
    this._scheduleFlush();
  }

  flushChunk(chunk) {
    if (!chunk.edits || chunk.edits.size === 0) return;
    const key = this._key(chunk.cx, chunk.cz);
    this.cache.set(key, new Map(chunk.edits));
    this.dirty.add(key);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (!this.db || this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, 1200);
  }

  async flush() {
    if (!this.db || this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();

    const store = tx(this.db, 'readwrite');
    for (const key of keys) {
      const map = this.cache.get(key);
      if (!map || map.size === 0) {
        store.delete(key);
        continue;
      }
      const packed = new Uint32Array(map.size);
      let i = 0;
      for (const [index, id] of map) packed[i++] = (index << 8) | id;
      store.put(packed, key);
    }
  }

  async clear() {
    this.cache.clear();
    this.dirty.clear();
    if (!this.db) return;
    const prefix = `${this.seed}:`;
    const store = tx(this.db, 'readwrite');
    const keys = await wrap(store.getAllKeys());
    const del = tx(this.db, 'readwrite');
    for (const key of keys) if (typeof key === 'string' && key.startsWith(prefix)) del.delete(key);
  }

  get editedChunkCount() {
    let n = 0;
    for (const m of this.cache.values()) if (m.size) n++;
    return n;
  }
}
