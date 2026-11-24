'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const historians = require('./historians');
const { fetchWithTimeout } = require('./httpTimeout');

// A wedged historian must not stall the others for undici's multi-minute
// default: every write has a hard deadline, and historians flush independently.
const OUTBOX_TIMEOUT_MS = Number(process.env.MANIFOLD_HISTORIAN_TIMEOUT_MS) || 15_000;
const timedFetch = (url, opts) => fetchWithTimeout(url, opts, OUTBOX_TIMEOUT_MS);

/**
 * Historian outbox — store-and-forward for time-series writes.
 *
 * Every point destined for a historian goes through here. In-memory queues
 * flush on an interval; when a write FAILS transiently (network, 5xx, 408,
 * 429), the batch spills to disk (survives restarts) and is drained back —
 * oldest first, ahead of new traffic — once writes succeed again. A historian
 * outage delays data, it doesn't delete it.
 *
 * Ordering guarantee (Timebase ignores points older than a tag's newest):
 * delivery per historian is strictly oldest-first. While a spill backlog
 * exists, live points are never sent ahead of it: if the backlog cannot be
 * drained they are appended BEHIND it on disk. Memory overflow spills the
 * oldest queued points, and points that overflow while a live batch is in
 * flight are held back so a failed batch is re-spilled in front of them.
 *
 * Poison batches: a batch the historian PERMANENTLY rejects (HTTP 4xx except
 * 408/429 and credential errors 401/403; Postgres data/integrity errors) is
 * bisected (bounded number of extra requests) to isolate the bad points, which
 * move to `<historian>.deadletter.jsonl` (size-capped, counted); the rest are
 * delivered and draining continues.
 *
 * Spill format (per historian, in <data>/outbox/):
 *   <id>.<seq>.seg    append-only JSONL segments (one point per line), rotated
 *                     at `segmentBytes`; <seq> is a monotonic 13-digit number.
 *   <id>.cursor       JSON {seg, offset}: bytes already delivered from the
 *                     oldest segment. Written tmp + fsync + rename, so a crash
 *                     either keeps the old offset (re-send = at-least-once) or
 *                     the new one — never a lost or half-written spill.
 *   <id>.jsonl        LEGACY single-file spill (pre-segment versions). It is
 *                     read as the oldest segment (offset 0 when no cursor) and
 *                     drained before any segment; nothing is ever appended to
 *                     it, so upgrading needs no conversion.
 * Draining reads each segment once, forward, so it is O(n). All writes are
 * async and serialized per historian.
 *
 * Bounds are explicit and reported, never silent: the memory queue caps at
 * MEM_MAX (overflow spills), the live spill caps at SPILL_MAX_BYTES (beyond it
 * the drop policy decides which end goes) and the dead-letter file is capped.
 */

const FLUSH_MS = 2000;
const MEM_MAX = 5000;
const BATCH = 1000;
const SPILL_MAX_BYTES = 20 * 1024 * 1024;
const SEGMENT_BYTES = 4 * 1024 * 1024;
const DEADLETTER_MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_CONCURRENCY = 4;
const MAX_BISECT_SPLITS = 64; // extra requests spent isolating bad points per rejected batch
const READ_CHUNK = 256 * 1024;

const SEG_RE = /^([A-Za-z0-9-]+)\.(\d{13,})\.seg$/;
const LEGACY_RE = /^([A-Za-z0-9-]+)\.jsonl$/;

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9-]/g, '');

class HistorianOutbox {
  constructor({
    profiles,
    dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'),
    fetchImpl = timedFetch,
    spillMaxBytes = SPILL_MAX_BYTES,
    segmentBytes = SEGMENT_BYTES,
    deadLetterMaxBytes = DEADLETTER_MAX_BYTES,
    concurrency = FLUSH_CONCURRENCY,
    memMax = MEM_MAX,
    batchSize = BATCH
  }) {
    this.profiles = profiles;
    this.dir = path.join(dir, 'outbox');
    this.fetchImpl = fetchImpl;
    this.spillMaxBytes = spillMaxBytes;
    this.segmentBytes = segmentBytes;
    this.deadLetterMaxBytes = deadLetterMaxBytes;
    this.concurrency = Math.max(1, concurrency);
    this.memMax = memMax;
    this.batchSize = batchSize;
    this.queues = new Map(); // historianId -> points[]
    this.stats = new Map(); // historianId -> counters
    this.disk = new Map(); // historianId -> spill state
    this.sending = new Set(); // ids with a live batch in flight
    this.hold = new Map(); // id -> points that overflowed while a live batch was in flight
    this.inflight = new Map(); // id -> promise of the running flush
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), FLUSH_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _stat(id) {
    let s = this.stats.get(id);
    if (!s) {
      s = {
        written: 0,
        spilled: 0,
        drained: 0,
        dropped: 0,
        skipped: 0,
        deadLettered: 0,
        deadLetterDropped: 0,
        corrupt: 0,
        lastDeadLetter: null,
        lastError: null,
        lastWrite: 0
      };
      this.stats.set(id, s);
    }
    return s;
  }

  // ---- spill state -----------------------------------------------------------

  /** Legacy single-file spill path (kept for tooling/tests; new data is in segments). */
  spillPath(id) {
    return path.join(this.dir, `${safeId(id)}.jsonl`);
  }

  _cursorPath(id) {
    return path.join(this.dir, `${safeId(id)}.cursor`);
  }

  deadLetterPath(id) {
    return path.join(this.dir, `${safeId(id)}.deadletter.jsonl`);
  }

  /** Per-historian spill state, loaded from disk synchronously ONCE (startup-time cost). */
  _disk(id) {
    const key = safeId(id);
    let st = this.disk.get(key);
    if (st) return st;
    st = { segs: [], offset: 0, lastSeq: 0, chain: Promise.resolve(), avgLine: 200, dlBytes: 0, dlChain: Promise.resolve() };
    this.disk.set(key, st);
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return st; // no outbox dir yet
    }
    for (const name of names) {
      let m = LEGACY_RE.exec(name);
      let seqKey = null;
      if (m && m[1] === key) seqKey = '0';
      else if ((m = SEG_RE.exec(name)) && m[1] === key) {
        seqKey = m[2];
        st.lastSeq = Math.max(st.lastSeq, Number(m[2]));
      }
      if (seqKey === null) continue;
      try {
        st.segs.push({ name, key: seqKey, size: fs.statSync(path.join(this.dir, name)).size });
      } catch {
        // vanished
      }
    }
    st.segs.sort((a, b) => (a.key === b.key ? 0 : a.key === '0' ? -1 : b.key === '0' ? 1 : a.key < b.key ? -1 : 1));
    try {
      const cur = JSON.parse(fs.readFileSync(this._cursorPath(id), 'utf8'));
      // The cursor names the oldest segment it applies to. If that segment is
      // gone it was fully consumed: start at the first remaining one.
      if (st.segs.length && st.segs[0].name === cur.seg && Number.isFinite(cur.offset)) {
        st.offset = Math.min(Math.max(0, cur.offset), st.segs[0].size);
      }
    } catch {
      // no / unreadable cursor: offset 0
    }
    // A crash mid-append can leave an unterminated last line; terminate it so
    // the next append can't glue onto it.
    const last = st.segs[st.segs.length - 1];
    if (last && last.size > 0) {
      try {
        const fd = fs.openSync(path.join(this.dir, last.name), 'r');
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, last.size - 1);
        fs.closeSync(fd);
        if (b[0] !== 10 && last.key !== '0') {
          fs.appendFileSync(path.join(this.dir, last.name), '\n');
          last.size += 1;
        }
      } catch {
        // best effort
      }
    }
    try {
      st.dlBytes = fs.statSync(this.deadLetterPath(id)).size;
    } catch {
      // none
    }
    return st;
  }

  _liveBytes(st) {
    let total = 0;
    for (const sg of st.segs) total += sg.size;
    return Math.max(0, total - st.offset);
  }

  /** Run fn after every earlier disk operation for this historian settled. */
  _locked(id, fn) {
    const st = this._disk(id);
    const run = st.chain.then(fn, fn);
    st.chain = run.catch(() => {});
    return run;
  }

  async _writeCursor(id, st) {
    const file = this._cursorPath(id);
    if (!st.segs.length) {
      await fsp.unlink(file).catch(() => {});
      return;
    }
    const tmp = `${file}.tmp`;
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify({ seg: st.segs[0].name, offset: st.offset }));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  }

  /** Delete fully consumed leading segments (and the cursor when nothing is left). Caller holds the lock. */
  async _gc(id, st) {
    let changed = false;
    while (st.segs.length && st.offset >= st.segs[0].size) {
      const done = st.segs.shift();
      st.offset = 0;
      changed = true;
      // Cursor first when something follows (crash => old segment re-read from
      // the stale cursor is impossible: cursor names the NEW head).
      if (st.segs.length) await this._writeCursor(id, st);
      await fsp.unlink(path.join(this.dir, done.name)).catch(() => {});
    }
    if (changed && !st.segs.length) await this._writeCursor(id, st); // removes cursor file
  }

  /** Append points as JSONL to the newest segment (rotating at segmentBytes), honoring the cap. */
  async _appendLines(id, st, text, count) {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    let seg = st.segs[st.segs.length - 1];
    if (!seg || seg.key === '0' || seg.size >= this.segmentBytes) {
      const seq = Math.max(st.lastSeq + 1, Date.now());
      st.lastSeq = seq;
      seg = { name: `${safeId(id)}.${String(seq).padStart(13, '0')}.seg`, key: String(seq).padStart(13, '0'), size: 0 };
      st.segs.push(seg);
    }
    const fh = await fsp.open(path.join(this.dir, seg.name), 'a', 0o600);
    try {
      await fh.appendFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    seg.size += Buffer.byteLength(text);
    return count;
  }

  /** Drop `needed` bytes from the head of the spill (whole lines), returning the number of points dropped. */
  async _dropOldest(id, st, needed) {
    let dropped = 0;
    let freed = 0;
    while (freed < needed && st.segs.length) {
      const seg = st.segs[0];
      if (st.offset >= seg.size) {
        await this._gc(id, st);
        if (st.segs[0] === seg) break;
        continue;
      }
      const fh = await fsp.open(path.join(this.dir, seg.name), 'r');
      try {
        const buf = Buffer.alloc(Math.min(65536, seg.size - st.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, st.offset);
        let pos = 0;
        while (freed < needed && pos < bytesRead) {
          const nl = buf.indexOf(10, pos);
          if (nl === -1 || nl >= bytesRead) {
            if (bytesRead < buf.length || st.offset + bytesRead >= seg.size) {
              freed += bytesRead - pos; // unterminated tail
              dropped++;
              pos = bytesRead;
            }
            break;
          }
          freed += nl + 1 - pos;
          pos = nl + 1;
          dropped++;
        }
        st.offset += pos;
        if (pos === 0) break;
      } finally {
        await fh.close();
      }
    }
    await this._gc(id, st);
    if (st.segs.length) await this._writeCursor(id, st);
    return dropped;
  }

  /** Spill points to disk (behind everything already there). Serialized per historian. */
  _spill(id, points) {
    if (!points.length) return Promise.resolve();
    return this._locked(id, async () => {
      const st = this._disk(id);
      const s = this._stat(id);
      try {
        const text = points.map((p) => JSON.stringify(p)).join('\n') + '\n';
        const bytes = Buffer.byteLength(text);
        const live = this._liveBytes(st);
        if (live + bytes > this.spillMaxBytes) {
          // At the cap something must go; which end is a per-historian choice.
          // 'oldest' (keep newest — what most historians want: recent data is
          // most valuable) advances past the head; default keeps the outage's
          // beginning and drops incoming. Either way the count is reported.
          const conn = this.profiles.getIn('historians', id);
          if (conn?.dropPolicy === 'oldest') {
            const droppedOld = await this._dropOldest(id, st, live + bytes - this.spillMaxBytes);
            await this._appendLines(id, st, text, points.length);
            s.spilled += points.length;
            s.dropped += droppedOld;
            s.lastError = `spill cap: dropped ${droppedOld} oldest point(s) to keep newest`;
          } else {
            s.dropped += points.length;
            s.lastError = `spill cap reached (${this.spillMaxBytes} bytes) — dropping new points`;
          }
          return;
        }
        await this._appendLines(id, st, text, points.length);
        s.spilled += points.length;
      } catch (error) {
        s.dropped += points.length;
        s.lastError = `spill failed: ${error.message}`;
      }
    });
  }

  /**
   * Read up to n points from the oldest segment, starting at the persisted
   * offset. Returns { points, commit(k) } — commit(k) marks the first k points
   * (plus any corrupt lines before them) delivered — or null when empty.
   */
  _peekSpill(id, n) {
    return this._locked(id, async () => {
      const st = this._disk(id);
      const s = this._stat(id);
      for (;;) {
        await this._gc(id, st);
        const seg = st.segs[0];
        if (!seg || st.offset >= seg.size) return null;
        const items = []; // { point|null, end } — null = blank/corrupt line (consumed with its neighbours)
        let real = 0;
        let corrupt = 0;
        const fh = await fsp.open(path.join(this.dir, seg.name), 'r');
        try {
          let pos = st.offset;
          let carry = Buffer.alloc(0);
          while (real < n && pos < seg.size) {
            // Read roughly what the batch needs (+25%), not a fixed big chunk: total bytes read stay O(spill size).
            const want = Math.ceil((n - real) * st.avgLine * 1.25);
            const buf = Buffer.alloc(Math.min(READ_CHUNK, seg.size - pos, Math.max(4096, want)));
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            if (!bytesRead) break;
            pos += bytesRead;
            const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
            const base = pos - data.length; // absolute offset of data[0]
            let start = 0;
            while (real < n) {
              const nl = data.indexOf(10, start);
              if (nl === -1) break;
              const line = data.subarray(start, nl).toString('utf8');
              start = nl + 1;
              let point = null;
              if (line) {
                try {
                  point = JSON.parse(line);
                } catch {
                  corrupt++;
                }
              }
              if (point) real++;
              items.push({ point, end: base + start });
            }
            carry = Buffer.from(data.subarray(start));
          }
          // An unterminated tail of a segment that can no longer grow (not the
          // newest, or a legacy file) is taken as a final line.
          if (real < n && carry.length && pos >= seg.size && (st.segs.length > 1 || seg.key === '0')) {
            let point = null;
            try {
              point = JSON.parse(carry.toString('utf8'));
            } catch {
              corrupt++;
            }
            if (point) real++;
            items.push({ point, end: seg.size });
          }
        } finally {
          await fh.close();
        }
        if (corrupt) s.corrupt += corrupt;
        if (!items.length) return null;
        st.avgLine = Math.max(16, Math.round((items[items.length - 1].end - st.offset) / items.length));
        if (!real) {
          // Only blank/corrupt lines: consume them so they can't wedge the head.
          st.offset = items[items.length - 1].end;
          await this._writeCursor(id, st);
          continue;
        }
        const segName = seg.name;
        const points = items.filter((it) => it.point).map((it) => it.point);
        return {
          points,
          // Mark the first k points (and any corrupt lines before them) delivered.
          commit: (k) =>
            this._locked(id, async () => {
              if (k <= 0) return;
              let endOffset;
              if (k >= points.length) endOffset = items[items.length - 1].end;
              else {
                let seen = 0;
                for (const it of items) {
                  if (it.point && ++seen === k) {
                    endOffset = it.end;
                    break;
                  }
                }
              }
              // The segment may have been consumed/dropped (cap policy) meanwhile.
              if (st.segs[0]?.name !== segName || endOffset <= st.offset) return;
              st.offset = endOffset;
              try {
                await this._writeCursor(id, st);
                await this._gc(id, st);
              } catch {
                // worst case the same points re-send — at-least-once, not at-most-once
              }
            })
        };
      }
    });
  }

  // ---- dead letters ------------------------------------------------------------

  _deadLetter(id, points, error) {
    const st = this._disk(id);
    const s = this._stat(id);
    s.deadLettered += points.length;
    const at = Date.now();
    const text = points.map((p) => JSON.stringify({ at, error: String(error.message || error).slice(0, 300), point: p })).join('\n') + '\n';
    const run = st.dlChain.then(async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
        const file = this.deadLetterPath(id);
        await fsp.appendFile(file, text, { mode: 0o600 });
        st.dlBytes += Buffer.byteLength(text);
        if (st.dlBytes > this.deadLetterMaxBytes) {
          // Keep the newest ~80% of the cap: whole lines, oldest evicted and counted.
          const raw = await fsp.readFile(file);
          const keepFrom = raw.length - Math.floor(this.deadLetterMaxBytes * 0.8);
          let cut = raw.indexOf(10, Math.max(0, keepFrom));
          cut = cut === -1 ? raw.length : cut + 1;
          const evicted = raw.subarray(0, cut).toString('utf8').split('\n').filter(Boolean).length;
          const tmp = `${file}.tmp`;
          await fsp.writeFile(tmp, raw.subarray(cut), { mode: 0o600 });
          await fsp.rename(tmp, file);
          st.dlBytes = raw.length - cut;
          s.deadLetterDropped += evicted;
        }
      } catch (err) {
        s.deadLetterDropped += points.length;
        s.lastError = `dead-letter write failed: ${err.message}`;
      }
    });
    st.dlChain = run.catch(() => {});
    return run;
  }

  // ---- delivery ---------------------------------------------------------------

  /**
   * Deliver `points` oldest-first, isolating permanently rejected points.
   * Returns { consumed, written, error }: `consumed` is how many leading points are
   * finished (written, skipped as unrepresentable, or dead-lettered); on a
   * transient error the rest stay with the caller (error is set).
   */
  async _send(conn, id, s, points) {
    let budget = MAX_BISECT_SPLITS;
    let written = 0;
    const work = [points];
    let remaining = points.length;
    while (work.length) {
      const batch = work.shift();
      try {
        const res = await historians.writePoints(conn, batch, this.fetchImpl);
        const w = res?.written ?? batch.length;
        written += w;
        s.written += w;
        s.skipped += res?.skipped || 0;
        if (w) s.lastWrite = Date.now();
        s.lastError = null;
        remaining -= batch.length;
      } catch (error) {
        if (!historians.isPermanentError(error)) {
          s.lastError = error.message;
          return { consumed: points.length - remaining, written, error };
        }
        if (batch.length > 1 && budget > 0) {
          budget--;
          const mid = batch.length >> 1;
          work.unshift(batch.slice(0, mid), batch.slice(mid));
          continue;
        }
        await this._deadLetter(id, batch, error);
        s.lastDeadLetter = `dead-lettered ${batch.length} point(s): ${error.message}`;
        s.lastError = s.lastDeadLetter;
        remaining -= batch.length;
      }
    }
    return { consumed: points.length, written, error: null };
  }

  enqueue(historianId, points) {
    if (!points.length) return;
    let q = this.queues.get(historianId);
    if (!q) {
      q = [];
      this.queues.set(historianId, q);
    }
    q.push(...points);
    // Memory bound: overflow goes straight to disk rather than being dropped.
    if (q.length > this.memMax) {
      const over = q.splice(0, q.length - this.memMax);
      if (this.sending.has(historianId)) {
        // A live batch (older than these points) is in flight; if it fails it
        // must land on disk BEFORE these. Hold them until it settles.
        const h = this.hold.get(historianId) || [];
        h.push(...over);
        this.hold.set(historianId, h);
      } else {
        this._spill(historianId, over);
      }
    }
  }

  /** Flush every historian independently (bounded concurrency, one in-flight flush per historian). */
  async flush() {
    const ids = new Set([...this.queues.keys(), ...this.stats.keys(), ...this.inflight.keys()]);
    // Also pick up spill files left over from a previous process.
    try {
      for (const f of await fsp.readdir(this.dir)) {
        const m = SEG_RE.exec(f) || LEGACY_RE.exec(f);
        if (m) ids.add(m[1]);
      }
    } catch {
      // no outbox dir yet
    }
    const pending = [...ids];
    const workers = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
      while (pending.length) {
        const id = pending.shift();
        await this._flushOne(id).catch(() => {});
      }
    });
    await Promise.all(workers);
  }

  /** One in-flight flush per historian: a concurrent caller joins the running one. */
  _flushOne(id) {
    let p = this.inflight.get(id);
    if (!p) {
      p = this._flushOneInner(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  async _flushOneInner(id) {
    const conn = this.profiles.getIn('historians', id);
    const s = this._stat(id);
    const q = this.queues.get(id) || [];
    if (!conn) {
      // Historian deleted: drop queue and spill, honestly counted.
      if (q.length) {
        s.dropped += q.length;
        q.length = 0;
      }
      await this._locked(id, async () => {
        const st = this._disk(id);
        for (const sg of st.segs) await fsp.unlink(path.join(this.dir, sg.name)).catch(() => {});
        st.segs = [];
        st.offset = 0;
        await fsp.unlink(this._cursorPath(id)).catch(() => {});
      });
      return;
    }

    // Oldest first: drain the spill completely before any live point is sent.
    let backlogBlocked = false;
    for (;;) {
      const spill = await this._peekSpill(id, this.batchSize);
      if (!spill) break;
      const r = await this._send(conn, id, s, spill.points);
      await spill.commit(r.consumed);
      s.drained += r.written;
      if (r.error) {
        backlogBlocked = true; // historian still down — spill stays for next round
        break;
      }
    }

    if (backlogBlocked) {
      // Live points must not overtake the backlog: queue them behind it.
      if (q.length) await this._spill(id, q.splice(0, q.length));
      return;
    }

    while (q.length) {
      const batch = q.splice(0, this.batchSize);
      this.sending.add(id);
      let r;
      try {
        r = await this._send(conn, id, s, batch);
      } finally {
        this.sending.delete(id);
      }
      const held = this.hold.get(id) || [];
      this.hold.delete(id);
      if (r.error) {
        // Failed batch (its unconsumed tail) first, then held overflow, then the rest — arrival order.
        await this._spill(id, batch.slice(r.consumed).concat(held, q.splice(0, q.length)));
        return;
      }
      // Held overflow is OLDER than what is still queued: send it first.
      if (held.length) q.unshift(...held);
    }
  }

  getStats() {
    const out = {};
    for (const [id, s] of this.stats) {
      const st = this._disk(id);
      out[id] = {
        ...s,
        queued: (this.queues.get(id)?.length || 0) + (this.hold.get(id)?.length || 0),
        spillBytes: this._liveBytes(st),
        deadLetterBytes: st.dlBytes
      };
    }
    return out;
  }
}

module.exports = HistorianOutbox;
