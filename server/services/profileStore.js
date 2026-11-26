'use strict';

const fs = require('fs');
const path = require('path');

// DataOps collections stored alongside connection profiles. Generic CRUD keeps
// the store from growing three near-identical method triples per module.
// `devices` / `deviceProfiles` hold the southbound device-driver config;
// `codecs` the payload codec bindings (topic filter -> codec + schema).
const COLLECTIONS = [
  'historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings', 'icons',
  'devices', 'deviceProfiles', 'codecs', 'iotDetection'
];
function emptyCollections() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
}

// Ids become object keys; these would rewrite a prototype instead of adding an entry.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeId(id) {
  if (typeof id !== 'string' || !id || UNSAFE_KEYS.has(id)) throw new Error(`invalid id ${JSON.stringify(String(id))}`);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Optimistic concurrency. Every stored object carries `rev` (integer, +1 on every
 * write, set by the store only; data written before this existed reads as rev 0)
 * and `updatedAt` (ISO). A write that passes `expectRev` is refused with this
 * error when the stored rev differs; `current` is the stored object (null when
 * it no longer exists). A write without `expectRev` is last-write-wins, as before.
 */
class StaleRevisionError extends Error {
  constructor(what, current) {
    super(`${what} was changed elsewhere (it is now at revision ${current?.rev || 0}); reload it and re-apply your edit`);
    this.name = 'StaleRevisionError';
    this.code = 'stale';
    this.current = current || null;
  }
}

function checkRev(prev, expectRev, what) {
  if (expectRev === undefined || expectRev === null || expectRev === '') return;
  const want = Number(expectRev);
  if (!Number.isInteger(want) || want !== (prev?.rev || 0)) throw new StaleRevisionError(what, prev);
}

/** The store-owned bookkeeping fields for the next write of `prev`. */
function nextStamp(prev) {
  return { rev: (prev?.rev || 0) + 1, updatedAt: new Date().toISOString() };
}

const DEFAULT_BACKUPS = 5;
const DEFAULT_BACKUP_INTERVAL_MS = 60_000;

// Stores with an unwritten change. One shared 'exit' hook flushes them so a
// normal process exit (including process.exit() in a signal handler) never loses
// the coalesced tail. A hard kill (SIGKILL / power loss) loses at most the writes
// of the current tick — everything earlier is already fsynced.
const dirtyStores = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const store of dirtyStores) store.flush();
  });
}

/**
 * Connection-profile persistence: saved brokers, OPC UA endpoints, CESMII / i3X
 * configs, and per-broker admin API configs survive a server restart.
 *
 * Storage is a single JSON file (default `<server>/data/profiles.json`,
 * override with MANIFOLD_DATA_DIR), mode 0600. It CAN contain credentials
 * (broker passwords, admin API secrets) — that is the point of persistence — so
 * the file is owner-readable only and the README says so plainly. Encrypting at
 * rest without a real key-management story would be security theater; restrict
 * the file and the host instead.
 *
 * Durability:
 *  - The in-memory view (`data`, `rev`) is updated synchronously on every
 *    mutation; the disk write is coalesced — all mutations in one tick produce
 *    ONE write (setImmediate). `flush()` writes synchronously (call it on
 *    shutdown; an 'exit' hook also does).
 *  - Each write is tmp file + fsync + rename + directory fsync, so a crash
 *    leaves either the old or the new complete file, never a zero-length one.
 *  - Rotating backups `profiles.json.bak.1..N` (newest first). A new backup
 *    slot is cut at most every `backupIntervalMs` so a burst of edits cannot
 *    push every good copy out of the rotation.
 *  - On load, an unreadable/corrupt main file falls back to the newest valid
 *    backup (loudly) instead of starting empty.
 *
 * Shape:
 *   { mqtt: { [id]: { config, admin? } }, opcua: { [id]: config },
 *     cesmii: config|null, i3x: config|null,
 *     mounts: { [id]: mount }, alertRules: { [id]: rule }, <collections...> }
 */
class ProfileStore {
  constructor(dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'), opts = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'profiles.json');
    this.backups = opts.backups ?? DEFAULT_BACKUPS;
    this.backupIntervalMs = opts.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
    this.data = { mqtt: {}, opcua: {}, cesmii: null, i3x: null, mounts: {}, alertRules: {}, ...emptyCollections() };
    // Monotonic revision, bumped on every save. Hot-path consumers (pipeline/
    // recorder/contract/model engines) compile the collections into matcher
    // tables and only rebuild when this changes — so the per-message cost is a
    // number comparison, not Object.values() + filter parsing per engine.
    this.rev = 1;
    this._dirty = false;
    this._timer = null;
    this.lastLoad = { source: 'none' }; // 'main' | 'backup.N' | 'none' — for diagnostics/tests
    this._load();
  }

  _backupPath(i) {
    return `${this.file}.bak.${i}`;
  }

  /** Parse + shape-check a profiles file; throws if unusable. */
  static _parse(raw) {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('profiles file is not a JSON object');
    const obj = (v) => (isPlainObject(v) ? v : {});
    const single = (v) => (isPlainObject(v) ? v : null);
    return {
      mqtt: obj(parsed.mqtt),
      opcua: obj(parsed.opcua),
      cesmii: single(parsed.cesmii),
      i3x: single(parsed.i3x),
      mounts: obj(parsed.mounts),
      alertRules: obj(parsed.alertRules),
      ...Object.fromEntries(COLLECTIONS.map((c) => [c, obj(parsed[c])]))
    };
  }

  _load() {
    let raw = null;
    let mainExists = true;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      mainExists = false;
    }
    if (mainExists) {
      try {
        this.data = ProfileStore._parse(raw);
        this.lastLoad = { source: 'main' };
        return;
      } catch {
        // fall through to the backups; keep the evidence first
        try {
          fs.writeFileSync(`${this.file}.bak`, raw, { mode: 0o600 });
        } catch {
          // best effort
        }
      }
    }
    for (let i = 1; i <= this.backups; i++) {
      let braw;
      try {
        braw = fs.readFileSync(this._backupPath(i), 'utf8');
      } catch {
        continue;
      }
      try {
        this.data = ProfileStore._parse(braw);
      } catch {
        continue;
      }
      this.lastLoad = { source: `backup.${i}` };
      console.error(
        `profileStore: ${this.file} was ${mainExists ? 'corrupt (preserved as profiles.json.bak)' : 'missing'} — ` +
          `RECOVERED from ${this._backupPath(i)}. Changes since that backup are lost; review your connections.`
      );
      this._markDirty(); // rewrite a good main file
      return;
    }
    if (mainExists) {
      console.error(`profileStore: ${this.file} is corrupt and no valid backup exists — backed up to ${this.file}.bak and starting clean`);
    }
  }

  _markDirty() {
    this._dirty = true;
    dirtyStores.add(this);
    installExitHook();
    if (!this._timer) {
      this._timer = setImmediate(() => {
        this._timer = null;
        this.flush();
      });
    }
  }

  _save() {
    this.rev++;
    this._markDirty();
  }

  /** Write pending changes now, synchronously and durably. Safe to call any time. */
  flush() {
    if (this._timer) {
      clearImmediate(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    this._dirty = false;
    try {
      this._writeDurably(JSON.stringify({ schemaVersion: 1, ...this.data }, null, 2));
      dirtyStores.delete(this);
    } catch (error) {
      this._dirty = true; // retry on the next save / exit
      console.error('profileStore: failed to persist profiles:', error.message);
    }
  }

  _writeDurably(json) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // none
    }
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this._rotateBackups();
    fs.renameSync(tmp, this.file);
    try {
      const dfd = fs.openSync(this.dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      // directory fsync is unsupported on some platforms (Windows) — best effort
    }
  }

  /** Cut a new .bak.1 from the current (valid) main file, shifting older ones down. */
  _rotateBackups() {
    if (this.backups < 1) return;
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return; // nothing to back up yet
    }
    if (st.size < 2) return; // never rotate a zero-length/empty file over good backups
    try {
      const newest = fs.statSync(this._backupPath(1));
      if (this.backupIntervalMs > 0 && Date.now() - newest.mtimeMs < this.backupIntervalMs) return;
    } catch {
      // no backup yet
    }
    for (let i = this.backups - 1; i >= 1; i--) {
      try {
        fs.renameSync(this._backupPath(i), this._backupPath(i + 1));
      } catch {
        // slot empty
      }
    }
    try {
      fs.copyFileSync(this.file, this._backupPath(1));
      fs.chmodSync(this._backupPath(1), 0o600);
    } catch (error) {
      console.error('profileStore: backup rotation failed:', error.message);
    }
  }

  /**
   * Throw StaleRevisionError when `expectRev` is given and the stored object is
   * at another revision. For routes that must refuse BEFORE a side effect (a
   * broker edit reconnects, a device edit restarts a driver). `bucket` is a
   * collection name or one of 'mqtt' | 'opcua' | 'mounts' | 'alertRules'.
   */
  assertRev(bucket, id, expectRev) {
    const b = this.data[bucket];
    if (!isPlainObject(b)) throw new Error(`unknown collection ${bucket}`);
    checkRev(Object.hasOwn(b, id) ? b[id] : null, expectRev, 'This item');
  }

  // ---- MQTT brokers ----
  // The wrapper `{ config, admin?, rev, updatedAt }` carries the revision, so the
  // connection config itself stays exactly what the user typed.
  upsertBroker(id, config, { expectRev } = {}) {
    assertSafeId(id);
    const prev = this.data.mqtt[id];
    checkRev(prev, expectRev, 'Broker');
    const { rev: _r, updatedAt: _u, ...clean } = config || {};
    this.data.mqtt[id] = { ...(prev || {}), config: { ...clean, id }, ...nextStamp(prev) };
    this._save();
    return this.data.mqtt[id];
  }

  removeBroker(id) {
    if (this.data.mqtt[id]) {
      delete this.data.mqtt[id];
      this._save();
    }
  }

  setBrokerAdmin(id, adminConfig) {
    assertSafeId(id);
    if (!this.data.mqtt[id]) this.data.mqtt[id] = { config: { id } };
    this.data.mqtt[id].admin = adminConfig;
    Object.assign(this.data.mqtt[id], nextStamp(this.data.mqtt[id]));
    this._save();
  }

  clearBrokerAdmin(id) {
    if (this.data.mqtt[id]?.admin) {
      delete this.data.mqtt[id].admin;
      Object.assign(this.data.mqtt[id], nextStamp(this.data.mqtt[id]));
      this._save();
    }
  }

  /** Stored `{ config, admin?, rev, updatedAt }` of a broker, or null. */
  getBroker(id) {
    return Object.hasOwn(this.data.mqtt, id) ? this.data.mqtt[id] : null;
  }

  brokers() {
    return Object.values(this.data.mqtt);
  }

  // ---- OPC UA ----
  upsertOpcua(id, config, { expectRev } = {}) {
    assertSafeId(id);
    const prev = this.data.opcua[id];
    checkRev(prev, expectRev, 'OPC UA connection');
    this.data.opcua[id] = { ...config, id, ...nextStamp(prev) };
    this._save();
    return this.data.opcua[id];
  }

  removeOpcua(id) {
    if (this.data.opcua[id]) {
      delete this.data.opcua[id];
      this._save();
    }
  }

  opcuaEndpoints() {
    return Object.values(this.data.opcua);
  }

  // ---- singleton configs ----
  setCesmii(config) {
    this.data.cesmii = config;
    this._save();
  }

  clearCesmii() {
    this.data.cesmii = null;
    this._save();
  }

  setI3x(config) {
    this.data.i3x = config;
    this._save();
  }

  clearI3x() {
    this.data.i3x = null;
    this._save();
  }

  // ---- UNS mounts (external sources grafted into the namespace view) ----
  upsertMount(id, mount, { expectRev } = {}) {
    assertSafeId(id);
    const prev = this.data.mounts[id];
    checkRev(prev, expectRev, 'Mount');
    this.data.mounts[id] = { ...mount, id, ...nextStamp(prev) };
    this._save();
    return this.data.mounts[id];
  }

  removeMount(id) {
    if (this.data.mounts[id]) {
      delete this.data.mounts[id];
      this._save();
      return true;
    }
    return false;
  }

  mounts() {
    return Object.values(this.data.mounts);
  }

  // ---- alert rules ----
  upsertAlertRule(id, rule, { expectRev } = {}) {
    assertSafeId(id);
    const prev = this.data.alertRules[id];
    checkRev(prev, expectRev, 'Alert rule');
    this.data.alertRules[id] = { ...rule, id, ...nextStamp(prev) };
    this._save();
    return this.data.alertRules[id];
  }

  removeAlertRule(id) {
    if (this.data.alertRules[id]) {
      delete this.data.alertRules[id];
      this._save();
      return true;
    }
    return false;
  }

  alertRules() {
    return Object.values(this.data.alertRules);
  }

  // ---- generic DataOps collections (historians, pipelines, models, ...) ----
  upsertIn(collection, id, obj, { expectRev } = {}) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    assertSafeId(id);
    const prev = Object.hasOwn(this.data[collection], id) ? this.data[collection][id] : null;
    checkRev(prev, expectRev, 'This item');
    this.data[collection][id] = { ...obj, id, ...nextStamp(prev) };
    this._save();
    return this.data[collection][id];
  }

  removeIn(collection, id) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    if (Object.hasOwn(this.data[collection], id)) {
      delete this.data[collection][id];
      this._save();
      return true;
    }
    return false;
  }

  listIn(collection) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    return Object.values(this.data[collection]);
  }

  getIn(collection, id) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown collection ${collection}`);
    return Object.hasOwn(this.data[collection], id) ? this.data[collection][id] : null;
  }
}

module.exports = ProfileStore;
module.exports.COLLECTIONS = COLLECTIONS;
module.exports.assertSafeId = assertSafeId;
module.exports.StaleRevisionError = StaleRevisionError;
