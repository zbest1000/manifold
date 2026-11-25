'use strict';

const fs = require('fs');
const { messageQuality, messageTime } = require('./pipelineEngine');
const { bucketSeries } = require('./historians');
const path = require('path');
const readline = require('readline');
const { matchParts, compiledView } = require('./mqttMatch');

/**
 * Recorder — historian-lite time-series capture. A recording watches one
 * broker + filter on the coalesced message tap and appends every matching
 * message to an append-only JSONL file in the data dir (or forwards to a
 * historian via the store-and-forward outbox). Files are the replay source.
 *
 * Hot-path discipline: recording configs are compiled (filters pre-split) and
 * rebuilt only when the profile store's revision changes, and file appends go
 * through per-recording WriteStreams — Node buffers and flushes off the event
 * loop, instead of a synchronous disk write per message.
 *
 * Line format (one JSON object per line):
 *
 *   {"t":<epoch ms>,"topic":"...","v":<payload>,"q":<MQTT qos>,       <- every version
 *    "qc":<quality 0-255>,"u":"<unit>","m":[<sparkplug metrics>]}      <- since format 2
 *
 *   t   source time when the payload carried one (TVQ t, Sparkplug timestamp),
 *       else arrival time (pipelineEngine.messageTime);
 *   v   the payload exactly as received (the replay source);
 *   q   the MQTT QoS (NOT quality: the name predates quality capture and the
 *       replayer republishes with it, so it keeps its meaning);
 *   qc  sample quality, OPC 0-255 (pipelineEngine.messageQuality: TVQ q,
 *       Sparkplug decode failure = Bad, otherwise Good);
 *   u   unit, when the payload carries one (TVQ envelope "u", or a "unit" /
 *       "units" field next to the value); omitted otherwise;
 *   m   Sparkplug only: the numeric metrics of the message as
 *       [{"n":name,"v":value,"qc"?:quality,"u"?:unit,"t"?:ms}], so a metric
 *       charts as the tag "<topic>/<metric name>".
 *
 * Backward compatibility: format 1 lines (no qc / u / m) still read, chart and
 * replay. Their quality and unit are derived from the payload the same way
 * (a TVQ q, a unit field) and default to Good / no unit, which is what
 * messageQuality would have said when they were recorded. New fields are only
 * ever ADDED; a reader ignores keys it does not know.
 */

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const READ_LIMIT_MAX = 5000;

// Pull a numeric value out of a recorded payload for charting. Mirrors the
// Trends live source: handles a bare number, a numeric string, or a JSON object
// carrying a value-ish field ({ value: 46, unit: 'C' } — the demo's shape).
function numericOf(payload) {
  if (typeof payload === 'number') return Number.isFinite(payload) ? payload : null;
  if (typeof payload === 'string') {
    // Number('') and Number('  ') are 0: an empty payload (e.g. a retained
    // clear) on a numeric topic must not chart a fake 0 dip.
    const t = payload.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (payload && typeof payload === 'object') {
    for (const k of ['value', 'v', 'val', 'reading']) {
      if (typeof payload[k] === 'number' && Number.isFinite(payload[k])) return payload[k];
    }
    const first = Object.values(payload).find((v) => typeof v === 'number' && Number.isFinite(v));
    return first ?? null;
  }
  return null;
}

// A TVQ envelope, optionally with a unit: { v, t?, q?, u? } and nothing else.
// (The intake's own tvqOf accepts v/t/q only, so an envelope carrying `u` has
// its quality read here instead.)
function envelopeOf(p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p) || !('v' in p)) return null;
  let keys = 0;
  for (const k in p) {
    if (++keys > 4 || (k !== 'v' && k !== 't' && k !== 'q' && k !== 'u')) return null;
  }
  return p;
}

const MAX_UNIT_LEN = 16;
const unitString = (u) => (typeof u === 'string' && u.trim() && u.length <= MAX_UNIT_LEN ? u.trim() : undefined);

/** Unit carried by a payload: TVQ `u`, or a `unit` / `units` field beside the value. */
function unitOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const env = envelopeOf(payload);
  if (env) return unitString(env.u);
  return unitString(payload.unit) ?? unitString(payload.units);
}

/** Unit of a Sparkplug metric from its property set (EngUnit is the common key). */
function sparkplugUnit(props) {
  if (!props || typeof props !== 'object') return undefined;
  for (const k of ['EngUnit', 'engUnit', 'EngUnits', 'engUnits', 'Units', 'units', 'Unit', 'unit']) {
    const u = unitString(props[k]);
    if (u) return u;
  }
  return undefined;
}

/**
 * Quality of a tapped message, OPC 0-255. Same rules as the pipelines
 * (messageQuality), plus the q of an envelope that also carries a unit.
 */
function qualityOfMessage(msg) {
  if (msg.quality === undefined && !msg.sparkplugError) {
    const env = envelopeOf(msg.payload);
    if (env && typeof env.q === 'number') return messageQuality({ quality: env.q });
  }
  return messageQuality(msg);
}

/**
 * Sample time of a tapped message: pipelineEngine.messageTime, plus the t of an
 * envelope that also carries a unit (the intake reads v/t/q envelopes only).
 */
function timeOfMessage(msg) {
  if (msg.sourceTimestamp === undefined) {
    const env = envelopeOf(msg.payload);
    if (env && typeof env.t === 'number') return messageTime({ ...msg, sourceTimestamp: env.t });
  }
  return messageTime(msg);
}

/** Numeric Sparkplug metrics of a decoded message, compact, for the `m` field. */
function sparkplugMetrics(msg) {
  const metrics = msg.sparkplug?.metrics;
  if (!Array.isArray(metrics)) return undefined;
  const out = [];
  for (const m of metrics) {
    if (!m || m.name === undefined || m.name === null || m.name === '') continue;
    let v = m.value;
    if (typeof v === 'bigint') v = Number(v);
    else if (v && typeof v === 'object' && typeof v.toNumber === 'function') v = v.toNumber(); // protobuf Long
    if (typeof v === 'boolean') v = v ? 1 : 0;
    const isNull = m.isNull === true;
    if (!(typeof v === 'number' && Number.isFinite(v)) && !isNull) continue;
    const e = { n: String(m.name), v: isNull ? null : v };
    const qc = m.quality !== undefined ? messageQuality({ quality: m.quality }) : undefined;
    if (qc !== undefined && qc !== 192) e.qc = qc;
    const u = sparkplugUnit(m.properties);
    if (u) e.u = u;
    if (Number.isFinite(m.sourceTimestamp)) e.t = m.sourceTimestamp;
    out.push(e);
  }
  return out.length ? out : undefined;
}

/** The JSONL record for one tapped message (format 2). */
function recordLine(msg) {
  const rec = { t: timeOfMessage(msg), topic: msg.topic, v: msg.payload, q: msg.qos, qc: qualityOfMessage(msg) };
  const u = unitOf(msg.payload);
  if (u) rec.u = u;
  const m = sparkplugMetrics(msg);
  if (m) rec.m = m;
  return rec;
}

/** Quality of a stored record: its qc (format 2), else derived from the payload (format 1). */
function recordQuality(p) {
  if (typeof p.qc === 'number' && Number.isFinite(p.qc)) return p.qc;
  const env = envelopeOf(p.v);
  if (env && typeof env.q === 'number') return messageQuality({ quality: env.q });
  return 192; // what messageQuality said for a payload without a quality
}

const recordUnit = (p) => unitString(p.u) ?? unitOf(p.v);

/**
 * The chartable samples of one stored record: [{ tag, t, value, quality, unit }].
 * A plain message yields one sample (its numeric value); a Sparkplug message
 * one per numeric metric, tagged "<topic>/<metric>". A Bad sample is kept even
 * without a number, so the chart can show the gap.
 */
function recordSamples(p) {
  if (Array.isArray(p.m)) {
    return p.m
      .filter((e) => e && typeof e.n === 'string')
      .map((e) => ({
        tag: `${p.topic}/${e.n}`,
        t: Number.isFinite(e.t) ? e.t : p.t,
        value: typeof e.v === 'number' && Number.isFinite(e.v) ? e.v : null,
        quality: typeof e.qc === 'number' ? e.qc : 192,
        unit: unitString(e.u)
      }))
      .filter((smp) => smp.value != null || smp.quality < 64);
  }
  const value = numericOf(envelopeOf(p.v) ? p.v.v : p.v);
  const quality = recordQuality(p);
  if (value == null && quality >= 64) return [];
  return [{ tag: p.topic, t: p.t, value, quality, unit: recordUnit(p) }];
}

class Recorder {
  constructor({ mqttManager, profiles, outbox = null, dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data') }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.outbox = outbox;
    this.dir = path.join(dir, 'recordings');
    this.status = new Map(); // recordingId -> { points, bytes, full, lastTs, lastError }
    this.streams = new Map(); // recordingId -> WriteStream
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
    this.table = compiledView(profiles, () =>
      this.profiles
        .listIn('recordings')
        .filter((r) => r.enabled !== false && r.brokerId && r.filter)
        .map((r) => ({ rec: r, parts: String(r.filter).split('/') }))
    );
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on('message', this.onMessage);
  }

  stop() {
    this.manager.off('message', this.onMessage);
    for (const [, stream] of this.streams) stream.end();
    this.streams.clear();
    this.started = false;
  }

  filePath(id) {
    // ids are uuids from our own routes; keep path handling defensive anyway
    return path.join(this.dir, `${String(id).replace(/[^a-zA-Z0-9-]/g, '')}.jsonl`);
  }

  /**
   * Data files of a file recording, oldest first: the rolled-over previous
   * segment (".1") when there is one, then the current file. Only existing
   * files are returned.
   */
  dataFiles(id) {
    const cur = this.filePath(id);
    return [`${cur}.1`, cur].filter((file) => fs.existsSync(file));
  }

  _status(id) {
    let s = this.status.get(id);
    if (!s) {
      s = { points: 0, bytes: 0, full: false, lastTs: 0, lastError: null };
      try {
        s.bytes = fs.statSync(this.filePath(id)).size;
      } catch {
        // no file yet
      }
      this.status.set(id, s);
    }
    return s;
  }

  _stream(id) {
    let stream = this.streams.get(id);
    if (!stream) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      stream = fs.createWriteStream(this.filePath(id), { flags: 'a', mode: 0o600 });
      stream.on('error', (error) => {
        this._status(id).lastError = error.message;
      });
      this.streams.set(id, stream);
    }
    return stream;
  }

  /**
   * Rotate a full segment: flush + close the current file, move it to ".1" (the
   * one previous segment kept), and reset so the next write starts a fresh
   * file. Two segments bound a recording to ~maxBytes while always retaining
   * recent history: recording never stops at the cap. Fire-and-forget from
   * onMessage; `s.rolling` guards overlapping rolls, and the few messages that
   * arrive mid-roll are dropped and counted in `s.droppedOnRoll`.
   */
  async _rollover(id, s) {
    s.rolling = true;
    try {
      const stream = this.streams.get(id);
      if (stream) {
        this.streams.delete(id);
        await new Promise((resolve) => stream.end(resolve));
      }
      const cur = this.filePath(id);
      const prev = `${cur}.1`;
      if (fs.existsSync(cur)) {
        fs.rmSync(prev, { force: true });
        fs.renameSync(cur, prev);
      }
      s.bytes = 0; // a fresh current file is created on the next write
      s.rollovers = (s.rollovers || 0) + 1;
    } catch (error) {
      s.lastError = `roll-over failed: ${error.message}`;
    } finally {
      s.rolling = false;
    }
  }

  onMessage(msg) {
    const table = this.table();
    if (!table.length) return;
    const topicParts = msg.topicParts || msg.topic.split('/');

    for (const { rec, parts } of table) {
      if (rec.brokerId !== msg.brokerId) continue;
      if (!matchParts(parts, topicParts)) continue;
      const s = this._status(rec.id);
      const ts = timeOfMessage(msg);

      if (rec.target?.type === 'historian') {
        this.outbox?.enqueue(rec.target.historianId, [{ tag: msg.topic, ts, value: msg.payload, quality: qualityOfMessage(msg) }]);
        s.points++;
        s.lastTs = ts;
        continue;
      }

      // file target — buffered async append via the recording's WriteStream
      // The cap covers two segments (current + one previous); a full segment
      // rolls over instead of stopping the recording, so long-running
      // recordings keep their newest data and drop their oldest.
      const cap = Number(rec.maxBytes) > 0 ? Number(rec.maxBytes) : DEFAULT_MAX_BYTES;
      const segCap = Math.max(1, Math.floor(cap / 2));
      const line = JSON.stringify(recordLine(msg)) + '\n';
      // (An empty segment always takes the line, so one oversized line can't wedge it.)
      if (s.rolling || (s.bytes > 0 && s.bytes + line.length > segCap)) {
        if (!s.rolling) this._rollover(rec.id, s);
        s.droppedOnRoll = (s.droppedOnRoll || 0) + 1;
        continue;
      }
      this._stream(rec.id).write(line);
      s.bytes += line.length;
      s.points++;
      s.lastTs = ts;
    }
  }

  /** Flush buffered writes so a file is complete on disk (replay, shutdown). */
  async sync(id = null) {
    const targets = id ? [this.streams.get(id)].filter(Boolean) : [...this.streams.values()];
    await Promise.all(
      targets.map(
        (stream) =>
          new Promise((resolve) => {
            if (stream.writableLength === 0) return resolve();
            stream.write('', () => resolve());
          })
      )
    );
  }

  /**
   * Stream the parsed JSONL records of a recording (skips blank/corrupt lines),
   * the rolled-over previous segment first so records come oldest to newest.
   */
  async *_records(id) {
    for (const file of this.dataFiles(id)) {
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // skip corrupt line
        }
      }
    }
  }

  /**
   * Read back a bounded slice of a file recording (newest last). Each point is
   * the stored record plus its normalised `quality` (0-255) and `unit`, for
   * format 1 records too.
   */
  async read(id, { topic = null, from = 0, to = Infinity, limit = 500 } = {}) {
    await this.sync(id);
    const cap = Math.min(Number(limit) || 500, READ_LIMIT_MAX);
    const out = [];
    let total = 0;
    for await (const p of this._records(id)) {
      if (p.t < from || p.t > to) continue;
      if (topic && p.topic !== topic) continue;
      total++;
      const unit = recordUnit(p);
      out.push({ ...p, quality: recordQuality(p), ...(unit ? { unit } : {}) });
      if (out.length > cap) out.shift(); // keep the newest `cap` in range
    }
    return { points: out, total, truncated: total > out.length };
  }

  /**
   * Downsampled multi-tag numeric series over a file recording, shaped exactly
   * like historians.querySeries so the Trends UI charts a recording and a
   * historian the same way:
   *   { series: [{ tag, unit?, points }], meta: { quality: 'stored', qualityNote } }
   * Points follow historians.bucketSeries: [tsMs, value, quality] per sample
   * while a tag fits in maxPoints; beyond that, buckets (mean of the usable
   * samples, worst quality, Bad-only = gap, mixed = partial). A Sparkplug metric
   * is the tag "<topic>/<metric>".
   */
  async series(id, { tags = [], from = 0, to = Infinity, maxPoints = 1000 } = {}) {
    await this.sync(id);
    const wanted = new Set(tags);
    const byTag = new Map(); // tag -> { unit, numeric, points: [[tsMs, value|null, quality]] }
    let legacy = 0;
    for await (const p of this._records(id)) {
      if (p.t < from || p.t > to) continue;
      if (wanted.size && !wanted.has(p.topic) && !(Array.isArray(p.m) && p.m.some((e) => wanted.has(`${p.topic}/${e?.n}`)))) continue;
      const samples = recordSamples(p);
      if (p.qc === undefined && samples.length) legacy++;
      for (const smp of samples) {
        if (wanted.size && !wanted.has(smp.tag)) continue;
        let entry = byTag.get(smp.tag);
        if (!entry) byTag.set(smp.tag, (entry = { unit: undefined, numeric: false, points: [] }));
        if (smp.unit) entry.unit = smp.unit; // the latest unit wins
        if (smp.value != null) entry.numeric = true;
        entry.points.push([smp.t, smp.value, smp.quality]);
      }
    }
    const cap = Math.min(Math.max(Number(maxPoints) || 1000, 1), READ_LIMIT_MAX);
    const lo = Number.isFinite(from) && from > 0 ? from : null;
    const hi = Number.isFinite(to) ? to : null;
    const series = [];
    for (const [tag, entry] of byTag) {
      if (!entry.numeric) continue; // a tag with no number at all does not chart
      entry.points.sort((a, b) => a[0] - b[0]);
      series.push({ tag, ...(entry.unit ? { unit: entry.unit } : {}), points: bucketSeries(entry.points, { start: lo, end: hi, maxPoints: cap }) });
    }
    return {
      series,
      meta: {
        quality: 'stored',
        qualityNote: legacy
          ? `${legacy.toLocaleString()} samples were recorded before quality capture: they count as Good unless their payload carried a quality.`
          : 'Quality recorded with each sample.'
      }
    };
  }

  /**
   * Distinct numeric tags captured by a recording (topics, and Sparkplug
   * metrics as "<topic>/<metric>"), so the Trends "Recording" source can offer
   * a searchable tag list instead of blind typing. Bounded and sorted.
   */
  async tags(id, { query = '', limit = 50 } = {}) {
    await this.sync(id);
    const q = String(query || '').toLowerCase();
    const seen = new Set();
    for await (const p of this._records(id)) {
      if (!Array.isArray(p.m) && seen.has(p.topic)) continue;
      for (const smp of recordSamples(p)) if (smp.value != null) seen.add(smp.tag); // only chartable tags
    }
    let list = [...seen];
    if (q) list = list.filter((t) => t.toLowerCase().includes(q));
    return list.sort().slice(0, Math.min(Number(limit) || 50, 200));
  }

  remove(id) {
    const stream = this.streams.get(id);
    if (stream) {
      stream.end();
      this.streams.delete(id);
    }
    this.status.delete(id);
    // The current file and the rolled-over previous segment (if any).
    for (const file of [this.filePath(id), `${this.filePath(id)}.1`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // no file — fine
      }
    }
  }

  getStatus(id) {
    return this._status(id);
  }
}

module.exports = Recorder;
module.exports.recordLine = recordLine;
module.exports.recordQuality = recordQuality;
module.exports.recordSamples = recordSamples;
module.exports.unitOf = unitOf;
