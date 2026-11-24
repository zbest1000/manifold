'use strict';

const fs = require('fs');
const path = require('path');
const { isSecretKey, stripUrlCredentials } = require('./secrets');

/**
 * Audit log — who did what to the control plane, and when.
 *
 * Every mutating API call (anything but GET) is recorded with role, source IP,
 * route, outcome, and a redacted body summary, to an in-memory ring (for the
 * UI) and an append-only JSONL file in the data dir (for the record). Failed
 * authentication (401), viewer-forbidden (403) and throttled (429) requests are
 * audited too, GET or not — they are exactly what an investigator looks for.
 * This is table stakes for industrial software: "who published to line1/cmd"
 * must have an answer.
 *
 * Secrets never land in the log: credential-like fields (see ./secrets) are
 * redacted by name before serialization, bearer tokens are never recorded (only
 * the matched token's NAME), and the query string is dropped from the path.
 *
 * The file rotates by size: audit.jsonl -> audit.jsonl.1 -> ... .N (oldest
 * dropped). MANIFOLD_AUDIT_MAX_BYTES (default 10 MiB) and MANIFOLD_AUDIT_KEEP
 * (default 5 rotated files).
 */

const RING_MAX = 500;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 5;
const DENIED_STATUSES = new Set([401, 403, 429]);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function redact(value, depth = 0) {
  if (typeof value === 'string') return stripUrlCredentials(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.length > 20 ? `[${value.length} items]` : value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretKey(k) && v ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

class AuditLog {
  constructor(dir = process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'), opts = {}) {
    this.file = path.join(dir, 'audit.jsonl');
    this.dir = dir;
    this.maxBytes = opts.maxBytes ?? (Number(process.env.MANIFOLD_AUDIT_MAX_BYTES) || DEFAULT_MAX_BYTES);
    this.keep = opts.keep ?? (Number(process.env.MANIFOLD_AUDIT_KEEP) || DEFAULT_KEEP);
    this.ring = [];
    this.stream = null;
    this.size = 0;
    this._middleware = null;
  }

  _open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
    // Synchronous appends: one small line per audited request, and it keeps
    // rotation (rename) race-free — a lazily-opened stream may not have created
    // the file yet when we try to rotate it.
    this.stream = fs.openSync(this.file, 'a', 0o600);
  }

  _closeFd() {
    const fd = this.stream;
    this.stream = null;
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }

  /** audit.jsonl -> .1 -> .2 ... .keep; the oldest is dropped. */
  _rotate() {
    this._closeFd();
    try {
      fs.rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      if (this.keep >= 1) fs.renameSync(this.file, `${this.file}.1`);
      else fs.rmSync(this.file, { force: true });
    } catch {
      // a failed rotation must not break the API; the next write retries
    }
    this.size = 0;
  }

  record(entry) {
    const evt = { ts: new Date().toISOString(), ...entry };
    this.ring.push(evt);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    try {
      const line = JSON.stringify(evt) + '\n';
      if (this.stream === null) this._open();
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        this._rotate();
        this._open();
      }
      fs.writeSync(this.stream, line);
      this.size += bytes;
    } catch {
      this._closeFd(); // re-open on the next record
      // the ring still has it; a broken disk must not break the API
    }
  }

  /**
   * Express middleware. Mount it BEFORE the auth middleware so rejected requests
   * are seen; it records on 'finish', by which time auth has set req.role /
   * req.tokenName (or not — a rejected request is role 'none'). Mutating
   * requests are always audited; reads only when denied (401/403/429).
   */
  middleware() {
    if (this._middleware) return this._middleware;
    this._middleware = (req, res, next) => {
      const read = READ_METHODS.has(req.method);
      const started = Date.now();
      res.on('finish', () => {
        const denied = DENIED_STATUSES.has(res.statusCode);
        if (read && !denied) return;
        let summary;
        try {
          summary =
            !read && req.body && typeof req.body === 'object' && Object.keys(req.body).length
              ? JSON.stringify(redact(req.body)).slice(0, 400)
              : undefined;
        } catch {
          summary = '[unserializable]';
        }
        this.record({
          role: req.role || 'none',
          ...(req.tokenName && req.tokenName !== 'open' ? { tokenName: req.tokenName } : {}),
          ip: req.ip,
          method: req.method,
          path: String(req.originalUrl || req.url || '').split('?')[0],
          status: res.statusCode,
          ...(denied ? { outcome: res.statusCode === 401 ? 'unauthorized' : res.statusCode === 403 ? 'forbidden' : 'throttled' } : {}),
          ms: Date.now() - started,
          ...(summary ? { body: summary } : {})
        });
      });
      next();
    };
    return this._middleware;
  }

  recent(limit = 200) {
    return this.ring.slice(-limit).reverse();
  }

  /** Close the file (lines are written synchronously, so nothing is buffered). */
  close() {
    this._closeFd();
    return Promise.resolve();
  }
}

module.exports = { AuditLog, redact };
