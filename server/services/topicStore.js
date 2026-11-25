'use strict';

/**
 * Memory-lean topic store (pure JS, no native dependency).
 *
 * At millions of resident topics, a Map of `{count, qos, retain, ts, payload}`
 * record objects plus a Buffer per topic costs hundreds of MB in per-object /
 * per-Buffer overhead and creates GC pressure. This store instead keeps a
 * struct-of-arrays: one `Map(topic -> slot)` plus parallel typed arrays for the
 * scalar fields, and the latest payload as a **latin1 string** — which V8 stores
 * at one byte per char, is lossless for arbitrary bytes, and avoids Buffer object
 * overhead entirely. Bytes are recovered lazily at flush (`Buffer.from(str,
 * 'latin1')`) only for the coalesced dirty topics.
 *
 * Same coalescing semantics as before: `ingest` is O(1); `drain` returns the
 * latest value per topic touched since the last drain.
 *
 * Un-coalesced queue (opt-in per topic): topics the `queueClassifier` marks at
 * slot creation (Sparkplug, whose NDATA/DDATA carry only CHANGED metrics, so
 * latest-wins loses data) additionally append every payload to a bounded
 * per-flush queue, drained in arrival order with `drainQueued()`. The bounds
 * (`sparkQueueMax` entries, `sparkQueueMaxBytes` payload bytes per flush) are
 * hard: past them a message is not queued, `sparkOverflow` is incremented, and
 * the topic falls back to latest-wins for the rest of the window (its latest
 * payload is appended at drain, so it is never lost and never reordered). The
 * classification is cached per slot, so non-queued topics pay one typed-array
 * read per message.
 *
 * Slots are monotonic, except that `evictIdle` (only when a caller invokes it;
 * the manager's TTL sweep is off by default) frees slots of topics idle past a
 * cutoff onto a free list for reuse. Consumers that index by slot learn about
 * frees from `evictIdle`'s return value and about reuse from `takeReused()`
 * (recorded only while `trackReuse` is set).
 */
// Per-topic payload cap. Manifold auto-subscribes '#' to brokers whose other
// clients are untrusted, so a single publisher sending huge payloads across many
// topics could otherwise grow the store (topics x payload bytes) without bound
// and OOM the process. Payloads above the cap are truncated for storage/preview;
// the full message is never retained. 256 KB is already far larger than normal
// telemetry; override with MANIFOLD_MAX_PAYLOAD_BYTES.
const DEFAULT_MAX_PAYLOAD_BYTES = Number(process.env.MANIFOLD_MAX_PAYLOAD_BYTES) || 256 * 1024;
// Per-flush bounds on the un-coalesced (Sparkplug) queue. At the 100 ms flush
// cadence the defaults admit ~50k Sparkplug messages/s per broker (decode +
// fold measured ~5 us/message, so a full queue costs ~25 ms per flush) before
// degrading to latest-wins (counted in `sparkOverflow`).
const DEFAULT_QUEUE_MAX = Number(process.env.MANIFOLD_SPARKPLUG_QUEUE_MAX) || 5_000;
const DEFAULT_QUEUE_MAX_BYTES = Number(process.env.MANIFOLD_SPARKPLUG_QUEUE_BYTES) || 8 * 1024 * 1024;
// A consumer that never collects reused slots stops being tracked past this
// (it must then rebuild its slot index; see `reuseOverflow`).
const REUSE_LOG_MAX = 100_000;

class TopicStore {
  constructor(maxTopics = 2_000_000, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES, opts = {}) {
    this.index = new Map(); // topic -> slot
    this.cap = 1024;
    this.n = 0; // high-water mark of allocated slots
    this.count = new Uint32Array(this.cap);
    this.ts = new Float64Array(this.cap);
    this.flags = new Uint8Array(this.cap); // bit0 retain, bits1-2 qos, bit3 truncated
    this.payload = new Array(this.cap); // latest payload as a latin1 string (capped)
    this.fullSize = new Uint32Array(this.cap); // slot -> true byte size before truncation
    this.topics = new Array(this.cap); // slot -> topic (reverse of index; enables incremental consumers)
    this.firstSeen = new Float64Array(this.cap); // slot -> first-observation ts
    this.events = []; // bounded ring of namespace events (new topics only — rare in steady state)
    this.eventSeq = 0; // monotonic event id — lets consumers watermark exactly (ms timestamps collide)
    this.dirty = new Set();
    this.maxTopics = maxTopics;
    this.maxPayloadBytes = maxPayloadBytes;
    this.total = 0;
    this.dropped = 0;
    this.truncatedCount = 0;
    this.capReached = false; // set when the topic cap refuses a topic; cleared if eviction makes room

    // Un-coalesced queue (see header). Parallel arrays, truncated (not
    // reallocated) per drain, so queuing allocates nothing beyond array growth.
    this.queueClassifier = typeof opts.queueClassifier === 'function' ? opts.queueClassifier : null;
    this.queued = new Uint8Array(this.cap); // slot -> 1 if every payload is queued
    this.sparkQueueMax = opts.queueMax || DEFAULT_QUEUE_MAX;
    this.sparkQueueMaxBytes = opts.queueMaxBytes || DEFAULT_QUEUE_MAX_BYTES;
    this.qSlot = [];
    this.qPayload = [];
    this.qTs = [];
    this.qFlags = [];
    this.qSize = [];
    this.qBytes = 0;
    this.qOverflowSlots = null; // Set(slot) of queued topics that overflowed this window
    this.sparkOverflow = 0; // messages that fell back to latest-wins (cumulative)

    // Slot reuse after eviction.
    this.free = []; // freed slots, reused before growing `n`
    this.trackReuse = false;
    this.reused = []; // slots reassigned since the last takeReused()
    this.reuseOverflow = false; // reuse log exceeded REUSE_LOG_MAX: slot consumers must rebuild
    this.evicted = 0;
  }

  _grow() {
    const nc = this.cap * 2;
    const count = new Uint32Array(nc);
    count.set(this.count);
    this.count = count;
    const ts = new Float64Array(nc);
    ts.set(this.ts);
    this.ts = ts;
    const flags = new Uint8Array(nc);
    flags.set(this.flags);
    this.flags = flags;
    this.payload.length = nc;
    this.topics.length = nc;
    const fullSize = new Uint32Array(nc);
    fullSize.set(this.fullSize);
    this.fullSize = fullSize;
    const fs = new Float64Array(nc);
    fs.set(this.firstSeen);
    this.firstSeen = fs;
    const queued = new Uint8Array(nc);
    queued.set(this.queued);
    this.queued = queued;
    this.cap = nc;
  }

  /** Hot path: record the latest payload for a topic and mark it dirty. */
  ingest(topic, message, qos, retain) {
    this.total++;
    let slot = this.index.get(topic);
    if (slot === undefined) {
      if (this.index.size >= this.maxTopics) {
        this.dropped++;
        if (!this.capReached) this._onCapReached(topic);
        return false;
      }
      if (this.free.length) {
        slot = this.free.pop();
        if (this.trackReuse) {
          this.reused.push(slot);
          if (this.reused.length > REUSE_LOG_MAX) {
            this.reuseOverflow = true;
            this.trackReuse = false;
            this.reused = [];
          }
        }
      } else {
        if (this.n >= this.cap) this._grow();
        slot = this.n++;
      }
      this.index.set(topic, slot);
      this.topics[slot] = topic; // string ref only; the string already lives as the Map key
      this.count[slot] = 0;
      this.firstSeen[slot] = Date.now();
      // Classification is a pure function of the topic string: once per slot.
      this.queued[slot] = this.queueClassifier !== null && this.queueClassifier(topic) ? 1 : 0;
      // Namespace event: a topic appearing is rare after warm-up and worth a ring
      // entry (drives the UNS "namespace events" feed). Bounded hard. $-topics
      // ($SYS etc.) are broker plumbing, not namespace changes.
      if (topic.charCodeAt(0) !== 36 /* '$' */) {
        this.events.push({ type: 'topic-added', topic, ts: this.firstSeen[slot], seq: ++this.eventSeq });
        if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
      }
    }
    this.count[slot]++;
    const now = Date.now();
    this.ts[slot] = now;
    // Cap the retained bytes: truncate above maxPayloadBytes and flag it (bit3),
    // so store, drain, the recent ring, and JSON.parse all inherit the bound.
    let stored = message;
    let truncated = 0;
    if (message.length > this.maxPayloadBytes) {
      stored = message.subarray(0, this.maxPayloadBytes);
      truncated = 8; // bit3
      this.truncatedCount++;
    }
    this.fullSize[slot] = message.length;
    const flags = (retain ? 1 : 0) | ((qos & 3) << 1) | truncated;
    this.flags[slot] = flags;
    // latin1 = 1 byte/char in V8, lossless for any byte sequence.
    const str = stored.toString('latin1');
    this.payload[slot] = str;
    this.dirty.add(topic);
    if (this.queued[slot] === 1) this._enqueue(slot, str, now, flags, message.length);
    return true;
  }

  // Queue one payload for in-order delivery (queued topics only). The string is
  // the same one held as the slot's latest payload — no extra copy.
  _enqueue(slot, str, ts, flags, size) {
    if (this.qSlot.length >= this.sparkQueueMax || this.qBytes + str.length > this.sparkQueueMaxBytes) {
      this.sparkOverflow++;
      (this.qOverflowSlots || (this.qOverflowSlots = new Set())).add(slot);
      return;
    }
    this.qSlot.push(slot);
    this.qPayload.push(str);
    this.qTs.push(ts);
    this.qFlags.push(flags);
    this.qSize.push(size);
    this.qBytes += str.length;
  }

  sparkQueueLength() {
    return this.qSlot.length;
  }

  _onCapReached(topic) {
    this.capReached = true;
    this.events.push({ type: 'topic-cap-reached', topic, maxTopics: this.maxTopics, ts: Date.now(), seq: ++this.eventSeq });
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    console.warn(`topic store cap reached (${this.maxTopics} topics): new topics are dropped and counted`);
  }

  _rowAt(topic, slot) {
    const f = this.flags[slot];
    return {
      topic,
      slot,
      buffer: Buffer.from(this.payload[slot], 'latin1'),
      qos: (f >> 1) & 3,
      retain: (f & 1) === 1,
      truncated: (f & 8) === 8,
      fullSize: this.fullSize[slot],
      ts: this.ts[slot],
      count: this.count[slot]
    };
  }

  /** Coalesced drain of everything touched since the last drain. */
  drain() {
    const out = [];
    for (const topic of this.dirty) {
      const slot = this.index.get(topic);
      if (slot !== undefined && this.payload[slot] !== undefined) out.push(this._rowAt(topic, slot));
    }
    this.dirty.clear();
    return out;
  }

  /**
   * In-order drain of the un-coalesced queue since the last call, as rows
   * shaped like `drain()` rows. For a topic that overflowed the bounds in this
   * window its latest payload is appended: it is newer than any queued entry
   * for that topic, because the bounds only ever close within a window.
   */
  drainQueued() {
    const n = this.qSlot.length;
    const overflow = this.qOverflowSlots;
    if (n === 0 && overflow === null) return [];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const slot = this.qSlot[i];
      const f = this.qFlags[i];
      out[i] = {
        topic: this.topics[slot],
        slot,
        buffer: Buffer.from(this.qPayload[i], 'latin1'),
        qos: (f >> 1) & 3,
        retain: (f & 1) === 1,
        truncated: (f & 8) === 8,
        fullSize: this.qSize[i],
        ts: this.qTs[i],
        count: this.count[slot]
      };
    }
    if (overflow !== null) {
      for (const slot of overflow) {
        const topic = this.topics[slot];
        if (topic !== undefined && this.payload[slot] !== undefined) out.push(this._rowAt(topic, slot));
      }
      this.qOverflowSlots = null;
    }
    this.qSlot.length = 0;
    this.qPayload.length = 0;
    this.qTs.length = 0;
    this.qFlags.length = 0;
    this.qSize.length = 0;
    this.qBytes = 0;
    return out;
  }

  /**
   * Free the slots of topics whose last message is older than `cutoffTs`.
   * Scans at most `maxScan` slots starting at `cursor` (call repeatedly to
   * sweep incrementally; never on the hot path) and evicts at most `maxEvict`.
   * Topics touched since the last drain are skipped (their queue entries and
   * dirty marks reference the slot). Returns { evicted: [{ topic, slot }],
   * cursor } — `cursor` wraps to 0 once the sweep reaches the end.
   */
  evictIdle(cutoffTs, { cursor = 0, maxScan = 100_000, maxEvict = Infinity } = {}) {
    const evicted = [];
    let slot = cursor;
    const end = Math.min(this.n, cursor + maxScan);
    for (; slot < end && evicted.length < maxEvict; slot++) {
      const topic = this.topics[slot];
      if (topic === undefined || this.ts[slot] >= cutoffTs || this.dirty.has(topic)) continue;
      this.index.delete(topic);
      this.topics[slot] = undefined;
      this.payload[slot] = undefined;
      this.count[slot] = 0;
      this.ts[slot] = 0;
      this.flags[slot] = 0;
      this.fullSize[slot] = 0;
      this.queued[slot] = 0;
      this.free.push(slot);
      this.evicted++;
      evicted.push({ topic, slot });
    }
    if (this.index.size < this.maxTopics) this.capReached = false;
    return { evicted, cursor: slot >= this.n ? 0 : slot };
  }

  /** Slots reassigned since the last call (only recorded while `trackReuse`). */
  takeReused() {
    const r = this.reused;
    this.reused = [];
    return r;
  }

  /** Bounded snapshot of latest values for the REST endpoint. */
  getTopics(limit = Infinity) {
    const out = [];
    for (const [topic, slot] of this.index) {
      if (out.length >= limit) break;
      out.push(this._rowAt(topic, slot));
    }
    return out;
  }

  getLatest(topic) {
    const slot = this.index.get(topic);
    return slot === undefined ? null : this._rowAt(topic, slot);
  }

  /** All topics starting with `prefix` (used for the small `$SYS/` tree). */
  getByPrefix(prefix, limit = 2000) {
    const out = [];
    for (const [topic, slot] of this.index) {
      if (out.length >= limit) break;
      if (topic.startsWith(prefix)) out.push(this._rowAt(topic, slot));
    }
    return out;
  }

  /** Topic string for a slot (undefined for a freed slot). */
  topicAt(slot) {
    return this.topics[slot];
  }

  topicCount() {
    return this.index.size;
  }
}

module.exports = TopicStore;
