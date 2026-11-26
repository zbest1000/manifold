'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Durable alert history: an append-only JSONL journal in the data directory
 * (`alerts.jsonl`), so firings, resolutions, acknowledgements and restarts are
 * still there after the server restarts.
 *
 * Size: like the recorder, the cap covers TWO segments. When the current file
 * would grow past half the cap it is renamed to `alerts.jsonl.1` (replacing the
 * previous one) and a fresh file starts, so the journal is bounded to ~maxBytes
 * while always keeping the newest history. MANIFOLD_ALERT_HISTORY_MAX_BYTES
 * (default 8 MiB).
 *
 * Writes never block the engine: `append()` only queues the line; a timer
 * drains the queue with asynchronous appends (one write in flight at a time,
 * batches coalesced). Lines that were queued but not yet written when the
 * process dies are lost (at most one flush interval, 250 ms by default); a
 * clean shutdown awaits `flush()`.
 *
 * Crash safety: a process killed mid-write can leave a torn last line. On load
 * every line is parsed on its own; unparseable lines are skipped and counted,
 * and a current file that does not end in a newline is truncated back to its
 * last complete line before anything new is appended, so a torn tail can never
 * swallow the next record.
 *
 * Everything that is on disk is also held in memory (`events()`), in the same
 * two-segment shape, so queries need no file I/O and match the file exactly
 * (plus the few lines still queued).
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FLUSH_MS = 250;

class AlertHistory {
  constructor({ dir, maxBytes, flushMs = FLUSH_MS } = {}) {
    if (!dir) throw new Error('AlertHistory needs a data directory');
    this.dir = dir;
    this.file = path.join(dir, 'alerts.jsonl');
    this.prevFile = `${this.file}.1`;
    this.maxBytes = Number(maxBytes) > 0 ? Number(maxBytes) : Number(process.env.MANIFOLD_ALERT_HISTORY_MAX_BYTES) || DEFAULT_MAX_BYTES;
    this.segCap = Math.max(1, Math.floor(this.maxBytes / 2));
    this.flushMs = flushMs;
    this.prev = []; // events in alerts.jsonl.1, oldest first
    this.cur = []; // events in alerts.jsonl, oldest first
    this.pending = []; // [{ evt, line }] queued, not yet written
    this.curBytes = 0;
    this.prevBytes = 0;
    this.timer = null;
    this.draining = null; // promise of the drain in flight
    this.loaded = false;
    this.stats = { written: 0, rollovers: 0, writeErrors: 0, lastError: null, tornLines: 0 };
  }

  /**
   * Read both segments (synchronously: this runs once, at start-up, before
   * anything is appended). Returns every event, oldest first.
   */
  load() {
    this.prev = this._readSegment(this.prevFile, false);
    this.cur = this._readSegment(this.file, true);
    this.prevBytes = this._size(this.prevFile);
    this.curBytes = this._size(this.file);
    this.loaded = true;
    return this.events();
  }

  _size(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  _readSegment(file, repairTail) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return []; // no file yet
    }
    if (repairTail && raw.length && !raw.endsWith('\n')) {
      // A torn last line (crash mid-write). Cut the file back to its last complete line so the next
      // append starts on a fresh line instead of being glued onto the fragment.
      const keep = raw.lastIndexOf('\n') + 1;
      try {
        fs.truncateSync(file, Buffer.byteLength(raw.slice(0, keep)));
      } catch (error) {
        this.stats.lastError = `could not repair torn line: ${error.message}`;
      }
      if (raw.slice(keep).trim()) this.stats.tornLines++;
      raw = raw.slice(0, keep);
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt && typeof evt === 'object' && !Array.isArray(evt)) out.push(evt);
        else this.stats.tornLines++;
      } catch {
        this.stats.tornLines++;
      }
    }
    // Lines are appended in seq order except across a shutdown race; sort so readers can rely on it.
    out.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return out;
  }

  /** Highest seq on disk (0 when empty). */
  lastSeq() {
    let max = 0;
    for (const e of this.events()) if (Number(e.seq) > max) max = Number(e.seq);
    return max;
  }

  /** Every known event, oldest first: previous segment, current segment, then the queued ones. */
  events() {
    const queued = this.pending.map((p) => p.evt);
    return this.prev.length || queued.length ? [...this.prev, ...this.cur, ...queued] : this.cur;
  }

  /** Queue one event. Never throws, never touches the disk on the caller's stack. */
  append(evt) {
    let line;
    try {
      line = JSON.stringify(evt) + '\n';
    } catch (error) {
      this.stats.writeErrors++;
      this.stats.lastError = `unserializable event: ${error.message}`;
      return;
    }
    this.pending.push({ evt, line });
    if (!this.timer && !this.draining) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this._drain();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  _drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        // Items leave `pending` only once written, so a query during a write still sees them.
        while (this.pending.length) {
          const batch = this.pending.slice();
          let chunk = '';
          let chunkBytes = 0;
          let n = 0;
          const writeChunk = async () => {
            if (!n) return;
            const data = chunk;
            const count = n;
            chunk = '';
            chunkBytes = 0;
            n = 0;
            try {
              await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
              await fs.promises.appendFile(this.file, data, { mode: 0o600 });
              this.curBytes += Buffer.byteLength(data);
              this.stats.written += count;
            } catch (error) {
              // The events stay visible in memory; a broken disk must not break alerting.
              this.stats.writeErrors++;
              this.stats.lastError = error.message;
            }
            for (const p of this.pending.splice(0, count)) this.cur.push(p.evt);
          };
          for (const { line } of batch) {
            const bytes = Buffer.byteLength(line);
            // An empty segment always takes the line, so one oversized line cannot wedge the journal.
            if (this.curBytes + chunkBytes > 0 && this.curBytes + chunkBytes + bytes > this.segCap) {
              await writeChunk();
              await this._rollover();
            }
            chunk += line;
            chunkBytes += bytes;
            n++;
          }
          await writeChunk();
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  async _rollover() {
    try {
      await fs.promises.rm(this.prevFile, { force: true });
      await fs.promises.rename(this.file, this.prevFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.stats.writeErrors++;
        this.stats.lastError = `roll-over failed: ${error.message}`;
      }
    }
    this.prev = this.cur;
    this.prevBytes = this.curBytes;
    this.cur = [];
    this.curBytes = 0;
    this.stats.rollovers++;
  }

  /** Write everything queued; resolves once it is on disk (shutdown, tests). */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.length || this.draining) await this._drain();
  }

  async close() {
    await this.flush();
  }

  bytes() {
    return this.prevBytes + this.curBytes;
  }
}

// ---- queries (pure, shared with the in-memory fallback) -------------------------------------

const toTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const toSet = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const parts = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  return parts.length ? new Set(parts) : null;
};

/**
 * Normalise query parameters: { cursor, limit, ruleId, state, severity, q, from, to }.
 * `state` and `severity` accept a comma-separated list. `from`/`to` accept epoch ms or ISO text.
 */
function parseQuery(query = {}, { maxLimit = 500, defaultLimit = 100 } = {}) {
  const limit = Math.min(Math.max(1, Math.floor(Number(query.limit) || defaultLimit)), maxLimit);
  const cursor = Number(query.cursor) > 0 ? Number(query.cursor) : null;
  return {
    limit,
    cursor,
    ruleId: typeof query.ruleId === 'string' && query.ruleId ? query.ruleId : null,
    states: toSet(query.state),
    severities: toSet(query.severity),
    q: typeof query.q === 'string' && query.q.trim() ? query.q.trim().toLowerCase() : null,
    from: toTime(query.from),
    to: toTime(query.to)
  };
}

function matches(e, f) {
  if (f.ruleId && e.ruleId !== f.ruleId) return false;
  if (f.states && !f.states.has(e.status)) return false;
  if (f.severities && !f.severities.has(e.severity || 'warning')) return false;
  if (f.from !== null && !(e.ts >= f.from)) return false;
  if (f.to !== null && !(e.ts <= f.to)) return false;
  if (f.q) {
    const hay = `${e.ruleName || ''}\n${e.topic || ''}\n${e.detail || ''}\n${e.ackBy || ''}\n${e.note || ''}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/**
 * One page of `events` (oldest first in, newest first out). The cursor is the `seq` of the last event
 * of the previous page: the next page holds strictly older events, so paging is stable while new events
 * arrive. Returns { events, nextCursor } (nextCursor null on the last page).
 */
function queryEvents(events, filters) {
  const out = [];
  let nextCursor = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (filters.cursor !== null && !(e.seq < filters.cursor)) continue;
    if (!matches(e, filters)) continue;
    if (out.length === filters.limit) {
      nextCursor = out[out.length - 1].seq;
      break;
    }
    out.push(e);
  }
  return { events: out, nextCursor };
}

const CSV_COLUMNS = ['time', 'seq', 'state', 'severity', 'rule', 'ruleId', 'type', 'broker', 'topic', 'value', 'acknowledgedBy', 'note', 'detail'];

function csvCell(v) {
  if (v === undefined || v === null) return '';
  let s = String(v);
  // Spreadsheet formula injection: a text cell starting with = + - @ (or a tab/CR) is neutralised.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (header + one row per event, in the order given). */
function toCsv(events) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const e of events) {
    rows.push(
      [
        new Date(e.ts).toISOString(),
        e.seq,
        e.status,
        e.severity || 'warning',
        e.ruleName,
        e.ruleId,
        e.type,
        e.brokerId,
        e.topic,
        e.value,
        e.ackBy,
        e.note,
        e.detail
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return rows.join('\r\n') + '\r\n';
}

module.exports = { AlertHistory, parseQuery, queryEvents, toCsv, CSV_COLUMNS, DEFAULT_MAX_BYTES };
