'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Retained-topic ledger: the retained topics mappings published (or own by configuration) and
 * have not cleared yet, per broker, persisted so a cleanup survives a restart or a crash.
 *
 * File: <data dir>/binding-retained.json (not profiles.json, so a config export stays clean):
 *
 *   { "version": 1, "savedAt": 1795540707783,
 *     "brokers": { "<brokerId>": { "<topic>": { "b": "<bindingId>", "d": 1?, "n": "<mapping name>"? } } } }
 *
 * `d: 1` marks a topic recorded at publish time (a filter-mode MQTT source or a Sparkplug source
 * with retain on: names only known at run time); without it the topic is derived from config.
 * Writes are atomic (tmp + fsync + rename). A corrupt file is moved aside (`.corrupt-<ms>`) and the
 * ledger starts empty: nothing is ever cleared that was not recorded here.
 * Bounded: at most MAX_PER_BROKER topics per broker and MAX_BROKERS brokers; what does not fit is
 * counted in `overflow` and cannot be cleaned automatically.
 */

const VERSION = 1;
const MAX_PER_BROKER = 20000;
const MAX_BROKERS = 64;
const SAVE_DEBOUNCE_MS = 1000;

/** One ledger entry: binding id, dynamic flag, the mapping's name (shown after it is deleted). */
function entry(b, dynamic, name) {
  const e = { b };
  if (dynamic) e.d = 1;
  if (name) e.n = String(name).slice(0, 128);
  return e;
}

class RetainedLedger {
  constructor({ file = null, maxPerBroker = MAX_PER_BROKER } = {}) {
    this.file = file;
    this.maxPerBroker = maxPerBroker;
    this.brokers = new Map(); // brokerId -> Map(topic -> { b, d? })
    this.overflow = 0;
    this.loadError = null;
    this.dirty = false;
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = error.message;
      return;
    }
    try {
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || doc.version !== VERSION || typeof doc.brokers !== 'object' || !doc.brokers) throw new Error('unexpected shape');
      for (const [brokerId, topics] of Object.entries(doc.brokers).slice(0, MAX_BROKERS)) {
        if (!topics || typeof topics !== 'object') continue;
        const m = new Map();
        for (const [topic, e] of Object.entries(topics)) {
          if (m.size >= this.maxPerBroker) break;
          if (typeof topic === 'string' && topic && e && typeof e.b === 'string') m.set(topic, entry(e.b, Boolean(e.d), typeof e.n === 'string' ? e.n : null));
        }
        if (m.size) this.brokers.set(brokerId, m);
      }
    } catch (error) {
      this.loadError = `retained ledger ${this.file} was unreadable (${error.message}); moved aside, starting empty`;
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      console.warn(this.loadError);
    }
  }

  get size() {
    let n = 0;
    for (const m of this.brokers.values()) n += m.size;
    return n;
  }

  get(brokerId, topic) {
    return this.brokers.get(brokerId)?.get(topic) || null;
  }

  /** Record a topic (idempotent). Returns false when the ledger is full. */
  add(brokerId, topic, bindingId, dynamic = false, name = null) {
    let m = this.brokers.get(brokerId);
    const prev = m?.get(topic);
    if (prev && prev.b === bindingId && Boolean(prev.d) === dynamic && (prev.n ?? null) === (name ?? null)) return true;
    if (!m) {
      if (this.brokers.size >= MAX_BROKERS) {
        this.overflow++;
        return false;
      }
      m = new Map();
      this.brokers.set(brokerId, m);
    }
    if (!prev && m.size >= this.maxPerBroker) {
      this.overflow++;
      return false;
    }
    m.set(topic, entry(bindingId, dynamic, name));
    this.dirty = true;
    return true;
  }

  delete(brokerId, topic) {
    const m = this.brokers.get(brokerId);
    if (!m || !m.delete(topic)) return;
    if (!m.size) this.brokers.delete(brokerId);
    this.dirty = true;
  }

  /** [[brokerId, topic, entry]] */
  *entries() {
    for (const [brokerId, m] of this.brokers) for (const [topic, e] of m) yield [brokerId, topic, e];
  }

  /** Write now if anything changed (atomic). */
  save() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.file) return;
    const brokers = {};
    for (const [brokerId, m] of this.brokers) brokers[brokerId] = Object.fromEntries(m);
    const body = JSON.stringify({ version: VERSION, savedAt: Date.now(), brokers });
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      console.warn(`retained ledger: could not write ${this.file}: ${error.message}`);
    }
  }

  /** Save soon (coalesces bursts of run-time additions). */
  saveSoon() {
    if (!this.dirty || !this.file || this.timer) return;
    this.timer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }
}

/** Default ledger file next to the profile store (null for in-memory stores, e.g. tests). */
function defaultLedgerFile(profiles) {
  if (process.env.MANIFOLD_RETAINED_LEDGER) return process.env.MANIFOLD_RETAINED_LEDGER;
  return profiles?.file ? path.join(path.dirname(profiles.file), 'binding-retained.json') : null;
}

module.exports = { RetainedLedger, defaultLedgerFile, MAX_PER_BROKER };
