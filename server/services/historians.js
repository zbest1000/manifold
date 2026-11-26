'use strict';

const crypto = require('crypto');
const { Agent } = require('undici');
const { fetchWithTimeout } = require('./httpTimeout');

// All historian HTTP calls get a hard deadline: a wedged historian (TCP accepts,
// never responds) must degrade to an error, not hang the store-and-forward
// outbox or a historian route for undici's multi-minute default.
const HISTORIAN_TIMEOUT_MS = Number(process.env.MANIFOLD_HISTORIAN_TIMEOUT_MS) || 15_000;
const timedFetch = (url, opts) => fetchWithTimeout(url, opts, HISTORIAN_TIMEOUT_MS);

// HTTP historians (influxdb, timebase) verify the server's TLS certificate by
// default. On-prem historians commonly serve a self-signed cert — Timebase
// 1.3.4 even 307-redirects HTTP→HTTPS onto one — so, mirroring the timescaledb
// sslInsecure/sslRootCert escape hatch (see the pg pool below), a per-connection
// undici dispatcher opts into accept-any-cert or a pinned CA. No flag ⇒ no
// dispatcher ⇒ the global default ⇒ full verification. sslInsecure wins over
// sslRootCert (same precedence as the pg path). Agents are cached so each
// distinct TLS setting keeps one socket pool, not one per request.
const tlsAgents = new Map();
function tlsDispatcher(conn) {
  const insecure = Boolean(conn.sslInsecure);
  const ca = conn.sslRootCert ? String(conn.sslRootCert) : '';
  if (!insecure && !ca) return undefined;
  const key = insecure ? 'insecure' : `ca:${ca}`;
  let agent = tlsAgents.get(key);
  if (!agent) {
    agent = new Agent({ connect: insecure ? { rejectUnauthorized: false } : { ca } });
    tlsAgents.set(key, agent);
  }
  return agent;
}

// Node surfaces a rejected certificate as an opaque "fetch failed" (the real
// reason hides in error.cause.code). Translate the common TLS failures into an
// actionable message that points at the exact fix, so a self-signed historian
// reads as a config choice — not a mystery outage — in the outbox lastError and
// the "Test write" button.
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

// Single entry point for every historian HTTP call: injects the TLS dispatcher
// and rewrites certificate failures into a fix-it hint.
async function httpFetch(conn, url, opts, fetchImpl) {
  const dispatcher = tlsDispatcher(conn);
  try {
    return await fetchImpl(url, dispatcher ? { ...opts, dispatcher } : opts);
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (TLS_ERROR_CODES.has(code)) {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* url is already fetch-valid; fall back to the raw string */
      }
      throw new Error(
        `TLS certificate rejected (${code}) connecting to ${host}. If this historian uses a ` +
          `self-signed certificate, enable "Allow self-signed TLS" (or supply its CA certificate) ` +
          `in the historian settings.`,
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * Historian integrations — time-series targets for pipelines and the recorder.
 *
 * Backends normalize to one write call:
 *   writePoints(conn, points)  with  points: [{ tag, ts, value, quality? }]
 *   -> { written, skipped }  (skipped = points with no representable value/tag/ts)
 * where `tag` is the (possibly re-pathed) topic, `ts` is epoch ms, and `value`
 * is whatever the transform chain produced (numbers become proper numeric
 * fields; everything else is stringified).
 *
 * - `influxdb`: InfluxDB v2 line-protocol write
 *   (POST {url}/api/v2/write?org=&bucket=&precision=ms, `Authorization: Token`).
 *   Config: { type:'influxdb', url, org, bucket, token, measurement?,
 *   sslInsecure?, sslRootCert? }.
 * - `timescaledb`: TimescaleDB (or plain PostgreSQL) over the `pg` driver.
 *   Batched multi-row inserts into a samples table (created on first write:
 *   ts timestamptz, topic text, value double precision, raw text, quality
 *   smallint, indexed by (topic, ts DESC)). On TimescaleDB the table is
 *   promoted to a hypertable via `create_hypertable(..., if_not_exists)`;
 *   on plain Postgres that call fails harmlessly and the table still works.
 *   Config: { type:'timescaledb', host, port?, database, user, password?,
 *   ssl?, table? }.
 * - `timebase`: Timebase historian (Flow Software) public REST API — TVQ
 *   writes into a dataset (datasets auto-create on first write; the historian
 *   ignores TVQs older than a tag's newest point). Documented endpoint,
 *   exercised against the real product (timebase/historian:1.3.4 service
 *   container in CI — see .github/workflows/ci.yml and test/services-int.test.js):
 *     POST {url}/api/datasets/{dataset}/data
 *     body: { "<tagname>": [ { t: ISO-8601, v: value, q: quality }, ... ], ... }
 *   Docs: https://timebase.flow-software.com/en/knowledge-base/timebase-historian-public-rest-api
 *   (the same spec is on any instance's own Swagger at
 *   `http://<host>:4511/api/help`; default HTTP port 4511). NOTE: a default
 *   1.3.4 install enables ASP.NET HTTPS redirection, so `http://host:4511`
 *   307-redirects to `https://host:4512` — and that TLS listener uses a
 *   self-signed dev certificate. Point `url` at either port: with `sslInsecure`
 *   (or `sslRootCert`) set, the dispatcher follows the redirect and accepts the
 *   cert; without it, the write fails closed with a clear certificate error.
 *   The API ships with no authentication by default; `apiKey` adds
 *   `Authorization: Bearer` for deployments that front it with a token.
 *   `writePath` overrides the whole path if a future version moves it.
 *   Config: { type:'timebase', url, dataset, writePath?, apiKey?,
 *   sslInsecure?, sslRootCert? }.
 *   NOTE: Timebase also ingests MQTT/Sparkplug natively — pointing its MQTT
 *   collector at your broker (or at a Manifold pipeline's output namespace)
 *   is an equally supported, often simpler path.
 */

// Documented multi-tag TVQ write endpoint. The dataset name is a URL path
// segment — encodeURIComponent handles spaces and slashes (vendor docs use
// dataset names like "The Juice Factory").
function timebaseWritePath(dataset) {
  return `/api/datasets/${encodeURIComponent(dataset)}/data`;
}

// ---- value classification -----------------------------------------------------
//
// Decision (documented here and in ARCHITECTURE.md): only a REAL finite number,
// or a string that is unambiguously a plain decimal number (optional sign,
// digits, optional fraction, optional exponent; NO whitespace, hex, "Infinity"
// or empty string), is numeric. Booleans are NOT 0/1 — they are stored as the
// text "true"/"false" (raw). "", " ", [], {}, NaN, Infinity are raw text.
// null/undefined carry no information: the point is skipped and counted.
const NUMERIC_STRING = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function classifyValue(v) {
  if (v === null || v === undefined) return { kind: 'null' };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'num', num: v } : { kind: 'raw', raw: String(v) };
  if (typeof v === 'string') {
    if (NUMERIC_STRING.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) return { kind: 'num', num: n };
    }
    return { kind: 'raw', raw: v };
  }
  if (typeof v === 'object') {
    try {
      return { kind: 'raw', raw: JSON.stringify(v) };
    } catch {
      return { kind: 'raw', raw: String(v) };
    }
  }
  return { kind: 'raw', raw: String(v) }; // boolean, bigint, ...
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ---- line protocol helpers (InfluxDB) ---------------------------------------
//
// Measurement, tag keys and tag values cannot carry a newline in line protocol
// at all (there is no escape), so a name containing a control character is
// REJECTED (the point is skipped and counted; a bad measurement in the config
// throws). Backslashes are doubled so a trailing or `\,`-looking backslash in a
// topic cannot escape the following delimiter. String field values are
// escaped: `"` and `\` per spec, newline/CR/other control characters become the
// visible text `\n`, `\r`, `\xNN` so a line can never be split.

function escMeasurement(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/([, ])/g, '\\$1');
}

function escTag(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/([,= ])/g, '\\$1');
}

function escFieldString(s) {
  return String(s)
    .replace(/(["\\])/g, '\\$1')
    // eslint-disable-next-line no-control-regex -- escaping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
}

/** Build the write body; returns { body, skipped } (skipped = points that cannot be represented). */
function buildLineProtocol(points, measurement) {
  if (CONTROL_CHARS.test(String(measurement))) throw new Error('influxdb measurement must not contain control characters');
  const m = escMeasurement(measurement);
  const lines = [];
  let skipped = 0;
  for (const p of points) {
    const tag = p.tag === undefined || p.tag === null ? '' : String(p.tag);
    const ts = Math.round(Number(p.ts));
    const c = classifyValue(p.value);
    if (c.kind === 'null' || !tag || CONTROL_CHARS.test(tag) || !Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    // Numerics and strings go to DIFFERENT fields (`value` vs `raw`): InfluxDB
    // locks a field's type per shard, so a topic that alternates 21.5 / "error"
    // would otherwise get its writes rejected — and with store-and-forward those
    // rejects would spill and retry forever. Two fields make mixed topics legal.
    const field = c.kind === 'num' ? `value=${c.num}` : `raw="${escFieldString(c.raw)}"`;
    lines.push(`${m},topic=${escTag(tag)} ${field} ${ts}`);
  }
  return { body: lines.join('\n'), skipped };
}

function toLineProtocol(points, measurement) {
  return buildLineProtocol(points, measurement).body;
}

// Permanent vs transient failures (drives outbox dead-lettering). HTTP 4xx is
// a permanent rejection of THIS payload except 408/429 (retry) and 401/403
// (credentials — operator-fixable, so the backlog must wait, not be discarded).
// Postgres: SQLSTATE class 22 (data exception) and 23 (integrity violation).
function httpError(label, res, text) {
  const err = new Error(`${label} (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  err.status = res.status;
  err.permanent = res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status);
  return err;
}

function isPermanentError(err) {
  if (!err) return false;
  if (typeof err.permanent === 'boolean') return err.permanent;
  return typeof err.code === 'string' && /^(22|23)/.test(err.code);
}

async function influxWrite(conn, points, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('influxdb url is required');
  const q = new URLSearchParams({ org: conn.org || '', bucket: conn.bucket || '', precision: 'ms' });
  const { body, skipped } = buildLineProtocol(points, conn.measurement || 'manifold');
  if (!body) return { written: 0, skipped };
  const res = await httpFetch(conn, `${base}/api/v2/write?${q}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...(conn.token ? { Authorization: `Token ${conn.token}` } : {})
    },
    body
  }, fetchImpl);
  if (!res.ok) throw httpError('influxdb write failed', res, await res.text().catch(() => ''));
  return { written: points.length - skipped, skipped };
}

// ---- Timebase (TVQ into a dataset) ------------------------------------------

async function timebaseWrite(conn, points, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('timebase url is required');
  if (!conn.dataset) throw new Error('timebase dataset is required');

  // Group points per tag. The documented body is an object keyed by tag name,
  // each value an array of TVQs: { "plant/temp": [{ t, v, q }, ...], ... }
  // (t = ISO-8601 timestamp, v = value, q = OPC quality — 192 is "good",
  // matching the vendor's own examples).
  //
  // Ordering: Timebase may ignore a TVQ older than the tag's newest point, so
  // each tag's TVQs are sorted oldest-first (stable) before sending, and the
  // outbox replays strictly in arrival order, never letting live points
  // overtake a spilled backlog.
  //
  // Quality: carried from p.quality for every point (0 = Bad is preserved —
  // no falsy-coalescing); 192 only when the source supplied none.
  //
  // Null value: a Bad-quality sample (e.g. the Bad point published on
  // disconnect) has no value. We send `v: null` with its `q`. UNVERIFIED:
  // Timebase's accepted shape for a null v has not been checked against the
  // real product (the old code sent the string "null", which is wrong). A null
  // value WITHOUT an explicit quality carries no information and is skipped.
  const byTag = new Map();
  let skipped = 0;
  for (const p of points) {
    const ts = Number(p.ts);
    const hasQ = p.quality !== undefined && p.quality !== null && Number.isFinite(Number(p.quality));
    const isNull = p.value === null || p.value === undefined;
    if (!Number.isFinite(ts) || !p.tag || (isNull && !hasQ)) {
      skipped++;
      continue;
    }
    if (!byTag.has(p.tag)) byTag.set(p.tag, []);
    byTag.get(p.tag).push({
      ms: ts,
      tvq: {
        t: new Date(ts).toISOString(),
        v: isNull ? null : typeof p.value === 'object' ? JSON.stringify(p.value) : p.value,
        q: hasQ ? Number(p.quality) : 192 // OPC "good"
      }
    });
  }
  for (const [tag, arr] of byTag) {
    arr.sort((x, y) => x.ms - y.ms); // Array.prototype.sort is stable
    byTag.set(tag, arr.map((e) => e.tvq));
  }
  if (!byTag.size) return { written: 0, skipped };
  const body = Object.fromEntries(byTag);

  const path = conn.writePath || timebaseWritePath(conn.dataset);
  const res = await httpFetch(conn, `${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {})
    },
    body: JSON.stringify(body)
  }, fetchImpl);
  if (!res.ok) throw httpError('timebase write failed', res, await res.text().catch(() => ''));
  return { written: points.length - skipped, skipped };
}

// ---- TimescaleDB / PostgreSQL ------------------------------------------------

let PgPool = null; // lazy — the pg driver only loads if a timescaledb historian exists
const pgPools = new Map(); // config hash -> { pool, schemaReady: Set(table) }
const pgIdentityKey = new Map(); // identity (historian id, else host/port/db) -> current config hash

function safeIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) throw new Error(`invalid table name "${name}"`);
  return name;
}

// The cache key is a hash of the FULL connection config (password and every
// SSL option included) so an edited credential takes effect immediately; the
// pool it replaces is closed. The hash keeps the password out of Map keys.
function pgConfigKey(conn) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        conn.host,
        Number(conn.port) || 5432,
        conn.database,
        conn.user,
        conn.password || '',
        Boolean(conn.ssl),
        Boolean(conn.sslInsecure),
        conn.sslRootCert ? String(conn.sslRootCert) : ''
      ])
    )
    .digest('hex');
}

function pgEntryFor(conn) {
  if (conn.__pool) return { pool: conn.__pool, schemaReady: conn.__schemaReady || new Set() }; // test injection
  if (!PgPool) PgPool = require('pg').Pool;
  const key = pgConfigKey(conn);
  const identity = conn.id ? `id:${conn.id}` : `addr:${conn.host}|${Number(conn.port) || 5432}|${conn.database}`;
  const previous = pgIdentityKey.get(identity);
  if (previous && previous !== key) {
    const old = pgPools.get(previous);
    pgPools.delete(previous);
    if (old) old.pool.end().catch(() => {}); // checked-out clients finish first
  }
  pgIdentityKey.set(identity, key);
  let entry = pgPools.get(key);
  if (!entry) {
    entry = {
      pool: new PgPool({
        host: conn.host,
        port: Number(conn.port) || 5432,
        database: conn.database,
        user: conn.user,
        password: conn.password || undefined,
        // TLS verifies the server certificate by default; opting into ssl must
        // not silently downgrade to accept-any-cert (which lets an on-path
        // attacker MITM the DB auth + forwarded data). conn.sslInsecure is the
        // explicit, UI-labellable escape hatch; conn.sslRootCert supplies a CA.
        ssl: conn.ssl
          ? conn.sslInsecure
            ? { rejectUnauthorized: false }
            : { rejectUnauthorized: true, ...(conn.sslRootCert ? { ca: conn.sslRootCert } : {}) }
          : undefined,
        max: 4,
        // Bounded waits: pg's defaults block FOREVER on an unreachable host,
        // which turns "database down" into a hung process (seen as CI jobs
        // spinning for hours). A write outage must surface as an error the
        // outbox can spill on, and idle pools must never pin the event loop.
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
        idleTimeoutMillis: 30_000,
        allowExitOnIdle: true
      }),
      schemaReady: new Set()
    };
    pgPools.set(key, entry);
  }
  return entry;
}

async function timescaleWrite(conn, points) {
  if (!conn.host || !conn.database || !conn.user) throw new Error('timescaledb needs host, database, and user');
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool, schemaReady } = pgEntryFor(conn);

  if (!schemaReady.has(table)) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
         ts timestamptz NOT NULL,
         topic text NOT NULL,
         value double precision,
         raw text,
         quality smallint
       )`
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_topic_ts ON ${table} (topic, ts DESC)`);
    try {
      // TimescaleDB promotion; on plain Postgres the function doesn't exist —
      // the table still works, just without hypertable chunking.
      await pool.query(`SELECT create_hypertable('${table}', 'ts', if_not_exists => TRUE)`);
    } catch {
      // not a Timescale instance — fine
    }
    schemaReady.add(table);
  }

  // One multi-row parameterized INSERT per batch. `value` holds only real
  // numbers (see classifyValue); `raw` keeps the text of every non-null value.
  // A null value with an explicit quality (a Bad sample) is stored as
  // NULL/NULL + quality; without a quality there is nothing to record: skipped.
  const params = [];
  const rows = [];
  let skipped = 0;
  for (const p of points) {
    const c = classifyValue(p.value);
    const hasQ = p.quality !== undefined && p.quality !== null && Number.isFinite(Number(p.quality));
    const ts = new Date(p.ts);
    if (!p.tag || Number.isNaN(ts.getTime()) || (c.kind === 'null' && !hasQ)) {
      skipped++;
      continue;
    }
    const base = rows.length * 5;
    params.push(
      ts,
      p.tag,
      c.kind === 'num' ? c.num : null,
      c.kind === 'null' ? null : c.kind === 'num' ? String(p.value) : c.raw,
      hasQ ? Number(p.quality) : 192
    );
    rows.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
  }
  if (!rows.length) return { written: 0, skipped };
  await pool.query(`INSERT INTO ${table} (ts, topic, value, raw, quality) VALUES ${rows.join(',')}`, params);
  return { written: rows.length, skipped };
}

// ---- read-back (Trends) ------------------------------------------------------
//
// The write path above is one-way; these two calls close the loop so the UI can
// trend what Manifold recorded:
//   queryTags(conn, { search, limit })            -> string[] of topic names
//   querySeries(conn, { tags, start, end, maxPoints })
//     -> { series: [{ tag, points }], meta: { quality: 'stored' | 'unavailable', qualityNote } }
// with points as documented at bucketSeries above ([tsMs, value, quality,
// partial?] where the backend stores quality, [tsMs, value] where it does not).
// start/end are epoch ms (the route normalizes ISO input). Timebase has no
// tag-listing API, so queryTags rejects with a clear message and the UI
// degrades to free-text tag entry.

// ---- sample quality on the read path ------------------------------------------
//
// Point format returned by every series reader (historians AND file recordings):
//   [tsMs, value, quality]            a sample or a Good / Uncertain bucket
//   [tsMs, value, quality, 1]         a PARTIAL bucket (see below)
//   [tsMs, null, quality]             a Bad sample or a Bad-only bucket: a GAP
// `quality` is the OPC-style 0-255 code (Bad < 64 <= Uncertain < 192 <= Good).
// A backend that stores no quality (InfluxDB) returns plain [tsMs, value] points
// and says so in `meta.quality` ('unavailable') instead of pretending Good.
//
// Bucket rules when a series is downsampled (the definition; the Trends help text and the chart key say the same):
//   - a bucket's quality is the WORST quality of the samples in it;
//   - its value is the mean of the usable (Good or Uncertain) samples only, so a
//     Bad sample is never averaged into a value;
//   - a bucket with only Bad samples has no value (null): the chart shows a gap;
//   - a bucket mixing Bad and usable samples keeps the mean of the usable ones
//     and is marked partial (4th element = 1).
const QUALITY_BAD_BELOW = 64;
const QUALITY_GOOD = 192;

/** OPC-style quality code from a stored value, or null when unknown. */
function qualityCode(q) {
  if (q === null || q === undefined || q === '') return null;
  if (q === true) return QUALITY_GOOD;
  if (q === false) return 0;
  const n = Number(q);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const isBadCode = (q) => q !== null && q < QUALITY_BAD_BELOW;

/**
 * Downsample chronological samples [[tsMs, value|null, quality|null], ...] to at
 * most `maxPoints` buckets over [start, end] with the quality rules above. When
 * the series already fits (and `always` is not set) the samples are returned
 * one-to-one, a Bad sample becoming a gap. Unknown quality counts as Good.
 */
function bucketSeries(points, { start = null, end = null, maxPoints = 1000, always = false, width: fixedWidth = null } = {}) {
  if (!points.length) return [];
  const cap = Math.max(1, Math.floor(maxPoints));
  if (!always && points.length <= cap) {
    return points.map(([t, v, q]) => {
      const code = qualityCode(q) ?? QUALITY_GOOD;
      return [t, isBadCode(code) || !Number.isFinite(v) ? null : v, code];
    });
  }
  const lo = Number.isFinite(start) ? start : points[0][0];
  const hi = Number.isFinite(end) ? end : points[points.length - 1][0];
  const width = fixedWidth > 0 ? fixedWidth : Math.max(1, Math.ceil((hi - lo + 1) / cap));
  const buckets = new Map();
  for (const [t, v, q] of points) {
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    const b = Math.floor((t - lo) / width);
    let agg = buckets.get(b);
    if (!agg) buckets.set(b, (agg = { sum: 0, n: 0, bad: 0, worst: Infinity }));
    const code = qualityCode(q) ?? QUALITY_GOOD;
    if (code < agg.worst) agg.worst = code;
    if (isBadCode(code) || !Number.isFinite(v)) agg.bad += isBadCode(code) ? 1 : 0;
    else {
      agg.sum += v;
      agg.n++;
    }
  }
  const out = [];
  for (const [b, agg] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
    if (!agg.n && !agg.bad) continue; // only non-numeric samples of usable quality: nothing to chart
    const ts = lo + b * width;
    if (!agg.n) out.push([ts, null, agg.worst]);
    else if (agg.bad) out.push([ts, agg.sum / agg.n, agg.worst, 1]);
    else out.push([ts, agg.sum / agg.n, agg.worst]);
  }
  return out;
}

const QUALITY_META = {
  timescaledb: { quality: 'stored', qualityNote: 'Quality from the samples table (quality column); rows written without one count as Good.' },
  timebase: { quality: 'stored', qualityNote: 'Quality from the TVQ q field.' },
  influxdb: { quality: 'unavailable', qualityNote: 'InfluxDB stores no quality for these samples, so Bad or uncertain values cannot be marked.' }
};

/** Millisecond timestamp from epoch-ms number or ISO string. */
function toMillis(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return Date.parse(v);
}

function normalizeRange({ start, end, maxPoints = 1000 }) {
  const s = toMillis(start);
  const e = toMillis(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error('start and end must be ISO timestamps or epoch milliseconds');
  if (e <= s) throw new Error('end must be after start');
  const mp = Math.round(Number(maxPoints));
  if (!Number.isFinite(mp) || mp < 10 || mp > 5000) throw new Error('maxPoints must be between 10 and 5000');
  return { start: s, end: e, maxPoints: mp };
}

/**
 * Quote a value for interpolation into a Flux script. Flux has no parameter
 * binding over the raw /query endpoint, so rather than attempt clever escaping
 * we REJECT values containing quote/backslash/newline — topic names never
 * legitimately contain them and a reject can't be out-escaped.
 */
function fluxString(value, what) {
  const s = String(value);
  if (/["\\\n\r]/.test(s)) throw new Error(`${what} must not contain quotes, backslashes, or newlines`);
  return `"${s}"`;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse InfluxDB annotated CSV into row objects keyed by column name.
 * `#`-prefixed annotation lines are skipped; a blank line ends a table so the
 * next non-blank line is a fresh header (multi-table responses).
 */
function parseFluxCsv(text) {
  const rows = [];
  let header = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) {
      header = null;
      continue;
    }
    if (line.startsWith('#')) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) if (header[i]) row[header[i]] = cells[i];
    rows.push(row);
  }
  return rows;
}

async function influxQuery(conn, flux, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('influxdb url is required');
  const q = new URLSearchParams({ org: conn.org || '' });
  const res = await httpFetch(conn, `${base}/api/v2/query?${q}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.flux',
      Accept: 'application/csv',
      ...(conn.token ? { Authorization: `Token ${conn.token}` } : {})
    },
    body: flux
  }, fetchImpl);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`influxdb query failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return parseFluxCsv(await res.text());
}

async function influxQueryTags(conn, { search, limit }, fetchImpl) {
  const flux = `import "influxdata/influxdb/schema"\nschema.tagValues(bucket: ${fluxString(conn.bucket, 'bucket')}, tag: "topic", start: -30d)`;
  const rows = await influxQuery(conn, flux, fetchImpl);
  const needle = search.toLowerCase();
  const seen = new Set();
  for (const row of rows) {
    const v = row._value;
    if (v && (!needle || v.toLowerCase().includes(needle))) seen.add(v);
  }
  return [...seen].sort().slice(0, limit);
}

async function influxQuerySeries(conn, { tags, start, end, maxPoints }, fetchImpl) {
  const everySec = Math.max(1, Math.ceil((end - start) / 1000 / maxPoints));
  const topicFilter = tags.map((t) => `r.topic == ${fluxString(t, 'tag')}`).join(' or ');
  const flux = [
    `from(bucket: ${fluxString(conn.bucket, 'bucket')})`,
    `  |> range(start: ${new Date(start).toISOString()}, stop: ${new Date(end).toISOString()})`,
    `  |> filter(fn: (r) => r._measurement == ${fluxString(conn.measurement || 'manifold', 'measurement')} and r._field == "value")`,
    `  |> filter(fn: (r) => ${topicFilter})`,
    `  |> aggregateWindow(every: ${everySec}s, fn: mean, createEmpty: false)`,
    `  |> keep(columns: ["_time", "_value", "topic"])`
  ].join('\n');
  const rows = await influxQuery(conn, flux, fetchImpl);
  const byTag = new Map(tags.map((t) => [t, []]));
  for (const row of rows) {
    if (!byTag.has(row.topic) || !row._time || row._value === '' || row._value === undefined) continue;
    const ts = Date.parse(row._time);
    const value = Number(row._value);
    if (Number.isFinite(ts) && Number.isFinite(value)) byTag.get(row.topic).push([ts, value]);
  }
  // No quality in this schema: plain [ts, value] points, and the response says so.
  return { series: tags.map((tag) => ({ tag, points: byTag.get(tag) })), meta: QUALITY_META.influxdb };
}

async function timescaleQueryTags(conn, { search, limit }) {
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool } = pgEntryFor(conn);
  const { rows } = await pool.query(
    `SELECT DISTINCT topic FROM ${table} WHERE topic ILIKE $1 ORDER BY topic LIMIT $2`,
    [`%${search}%`, limit]
  );
  return rows.map((r) => r.topic);
}

async function timescaleQuerySeries(conn, { tags, start, end, maxPoints }) {
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool } = pgEntryFor(conn);
  // The bucket width is the ONLY interpolated value and it is built from an
  // integer we computed — user text never reaches the SQL string.
  const bucketSeconds = Math.max(1, Math.ceil((end - start) / 1000 / maxPoints));
  if (!Number.isSafeInteger(bucketSeconds)) throw new Error('invalid time range');
  // Bucket quality rules (see bucketSeries): the value averages usable samples
  // only (quality >= 64, or no quality = Good), the bucket carries the worst
  // quality, and the Bad / usable counts tell a gap from a partial bucket.
  // Bad samples are stored with a NULL value, so they are NOT filtered out here.
  const { rows } = await pool.query(
    `SELECT topic, time_bucket('${bucketSeconds} seconds'::interval, ts) AS bucket,
            avg(value) FILTER (WHERE value IS NOT NULL AND coalesce(quality, ${QUALITY_GOOD}) >= ${QUALITY_BAD_BELOW}) AS value,
            min(coalesce(quality, ${QUALITY_GOOD})) AS quality,
            count(*) FILTER (WHERE coalesce(quality, ${QUALITY_GOOD}) < ${QUALITY_BAD_BELOW}) AS bad,
            count(value) FILTER (WHERE coalesce(quality, ${QUALITY_GOOD}) >= ${QUALITY_BAD_BELOW}) AS usable
     FROM ${table}
     WHERE topic = ANY($1) AND ts BETWEEN $2 AND $3
     GROUP BY topic, bucket
     ORDER BY bucket`,
    [tags, new Date(start), new Date(end)]
  );
  const byTag = new Map(tags.map((t) => [t, []]));
  for (const row of rows) {
    if (!byTag.has(row.topic)) continue;
    const ts = row.bucket instanceof Date ? row.bucket.getTime() : Date.parse(row.bucket);
    if (!Number.isFinite(ts)) continue;
    const q = qualityCode(row.quality) ?? QUALITY_GOOD;
    const usable = Number(row.usable ?? (row.value == null ? 0 : 1));
    const bad = Number(row.bad ?? 0);
    const value = row.value == null ? NaN : Number(row.value);
    if (usable > 0 && Number.isFinite(value)) byTag.get(row.topic).push(bad > 0 ? [ts, value, q, 1] : [ts, value, q]);
    else if (bad > 0) byTag.get(row.topic).push([ts, null, q]); // Bad-only bucket: a gap
  }
  return { series: tags.map((tag) => ({ tag, points: byTag.get(tag) })), meta: QUALITY_META.timescaledb };
}

const TIMEBASE_TAGS_ERROR = 'tag listing not supported for timebase — enter the tag path directly';

/**
 * Timebase read-back: same documented GET the CI integration test uses —
 *   GET {url}/api/datasets/{dataset}/data?tagname=...&start=ISO&end=ISO
 * (tagname repeats per tag; tag paths keep literal '/' — the API matches raw
 * paths). Response: { tl: [{ t: { n }, d: [{ t, v, q }] }] }. The API returns
 * raw TVQs with no documented server-side downsampling, so points are
 * bucket-averaged down to maxPoints here.
 */
async function timebaseQuerySeries(conn, { tags, start, end, maxPoints }, fetchImpl) {
  const base = String(conn.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('timebase url is required');
  if (!conn.dataset) throw new Error('timebase dataset is required');
  const tagParams = tags.map((t) => `tagname=${encodeURIComponent(t).replace(/%2F/gi, '/')}`).join('&');
  const url =
    `${base}/api/datasets/${encodeURIComponent(conn.dataset)}/data?${tagParams}` +
    `&start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}`;
  const res = await httpFetch(conn, url, {
    headers: { ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}) }
  }, fetchImpl);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`timebase query failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data?.tl) ? data.tl : [];
  const series = tags.map((tag) => {
    const raw = list.find((s) => s?.t?.n === tag)?.d;
    const samples = [];
    for (const p of Array.isArray(raw) ? raw : []) {
      const ts = Date.parse(p?.t);
      const q = qualityCode(p?.q);
      const value = p?.v === null || p?.v === undefined || p?.v === '' ? NaN : Number(p.v);
      // The window is re-applied locally so a server that ignored start/end
      // (or returned edge points) can't leak data outside the asked range.
      if (!Number.isFinite(ts) || ts < start || ts > end) continue;
      if (!Number.isFinite(value) && !isBadCode(q)) continue; // text values do not chart
      samples.push([ts, Number.isFinite(value) ? value : null, q]);
    }
    samples.sort((a, b) => a[0] - b[0]);
    // The API returns raw TVQs: always bucket (keeps the response bounded).
    return { tag, points: bucketSeries(samples, { start, end, maxPoints, always: true, width: Math.max(1, Math.ceil((end - start) / maxPoints)) }) };
  });
  return { series, meta: QUALITY_META.timebase };
}

const TAG_QUERY_BACKENDS = {
  influxdb: influxQueryTags,
  timescaledb: timescaleQueryTags,
  // No documented tag-enumeration endpoint — Trends falls back to manual
  // tag-path entry for timebase.
  timebase: () => {
    throw new Error(TIMEBASE_TAGS_ERROR);
  }
};

const SERIES_QUERY_BACKENDS = {
  influxdb: influxQuerySeries,
  timescaledb: timescaleQuerySeries,
  timebase: timebaseQuerySeries
};

/** List distinct topic/tag names stored in a historian. */
async function queryTags(conn = {}, { search = '', limit = 100 } = {}, fetchImpl = timedFetch) {
  const backend = TAG_QUERY_BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  const lim = Math.min(1000, Math.max(1, Math.round(Number(limit) || 100)));
  return backend(conn, { search: String(search), limit: lim }, fetchImpl);
}

/** Read downsampled series for up to 10 tags over a time range. */
async function querySeries(conn = {}, { tags = [], start, end, maxPoints = 1000 } = {}, fetchImpl = timedFetch) {
  const backend = SERIES_QUERY_BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new Error('tags must be an array of 1-10 non-empty strings');
  }
  const range = normalizeRange({ start, end, maxPoints });
  return backend(conn, { tags, ...range }, fetchImpl);
}

// ---- raw read-back (CSV export) ------------------------------------------------
//
//   queryRaw(conn, { tags, start, end }) -> async iterator of
//     { tag, t, value: number|null, quality: number|null } in time order
// Unlike querySeries nothing is averaged: every stored sample comes back, so the
// export can stream a long range without holding it. Work is paged: TimescaleDB
// by keyset (ts, topic) pages of RAW_PAGE rows; InfluxDB and Timebase by time
// windows of RAW_WINDOW_MS, each window merged across tags and sorted. A Bad
// sample has a null value and its quality; InfluxDB returns quality null.

const RAW_PAGE = 10_000;
const RAW_WINDOW_MS = 3_600_000;

function rawTags(tags) {
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new Error('tags must be an array of 1-10 non-empty strings');
  }
  return tags;
}

async function* timescaleRaw(conn, { tags, start, end }) {
  const table = safeIdent(conn.table || 'manifold_samples');
  const { pool } = pgEntryFor(conn);
  let afterTs = new Date(start - 1);
  let afterTopic = '';
  for (;;) {
    const { rows } = await pool.query(
      `SELECT ts, topic, value, quality FROM ${table}
       WHERE topic = ANY($1) AND ts BETWEEN $2 AND $3 AND (ts, topic) > ($4, $5)
       ORDER BY ts, topic LIMIT ${RAW_PAGE}`,
      [tags, new Date(start), new Date(end), afterTs, afterTopic]
    );
    for (const row of rows) {
      const t = row.ts instanceof Date ? row.ts.getTime() : Date.parse(row.ts);
      if (!Number.isFinite(t)) continue;
      const q = qualityCode(row.quality) ?? QUALITY_GOOD;
      const v = row.value == null ? NaN : Number(row.value);
      yield { tag: row.topic, t, value: Number.isFinite(v) && !isBadCode(q) ? v : null, quality: q };
    }
    if (rows.length < RAW_PAGE) return;
    const last = rows[rows.length - 1];
    afterTs = last.ts instanceof Date ? last.ts : new Date(last.ts);
    afterTopic = last.topic;
  }
}

async function* influxRaw(conn, { tags, start, end }, fetchImpl) {
  const topicFilter = tags.map((t) => `r.topic == ${fluxString(t, 'tag')}`).join(' or ');
  for (let from = start; from < end; from += RAW_WINDOW_MS) {
    const to = Math.min(end, from + RAW_WINDOW_MS);
    const flux = [
      `from(bucket: ${fluxString(conn.bucket, 'bucket')})`,
      `  |> range(start: ${new Date(from).toISOString()}, stop: ${new Date(to).toISOString()})`,
      `  |> filter(fn: (r) => r._measurement == ${fluxString(conn.measurement || 'manifold', 'measurement')} and r._field == "value")`,
      `  |> filter(fn: (r) => ${topicFilter})`,
      `  |> keep(columns: ["_time", "_value", "topic"])`
    ].join('\n');
    const rows = await influxQuery(conn, flux, fetchImpl);
    const out = [];
    for (const row of rows) {
      if (!tags.includes(row.topic) || !row._time) continue;
      const t = Date.parse(row._time);
      const v = Number(row._value);
      if (Number.isFinite(t) && Number.isFinite(v)) out.push({ tag: row.topic, t, value: v, quality: null });
    }
    out.sort((a, b) => a.t - b.t);
    yield* out;
  }
}

async function* timebaseRaw(conn, { tags, start, end }, fetchImpl) {
  for (let from = start; from < end; from += RAW_WINDOW_MS) {
    const to = Math.min(end, from + RAW_WINDOW_MS);
    // The same documented dataset GET as timebaseQuerySeries, one window at a time, without bucketing.
    const base = String(conn.url || '').replace(/\/+$/, '');
    if (!base) throw new Error('timebase url is required');
    if (!conn.dataset) throw new Error('timebase dataset is required');
    const tagParams = tags.map((t) => `tagname=${encodeURIComponent(t).replace(/%2F/gi, '/')}`).join('&');
    const url =
      `${base}/api/datasets/${encodeURIComponent(conn.dataset)}/data?${tagParams}` +
      `&start=${encodeURIComponent(new Date(from).toISOString())}&end=${encodeURIComponent(new Date(to).toISOString())}`;
    const res = await httpFetch(conn, url, { headers: { ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}) } }, fetchImpl);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`timebase query failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = await res.json().catch(() => null);
    const out = [];
    for (const s of Array.isArray(data?.tl) ? data.tl : []) {
      const tag = s?.t?.n;
      if (!tags.includes(tag)) continue;
      for (const p of Array.isArray(s.d) ? s.d : []) {
        const t = Date.parse(p?.t);
        // Half-open windows [from, to) so a sample on a boundary is exported once; the last window includes `end`.
        if (!Number.isFinite(t) || t < from || (to < end ? t >= to : t > end)) continue;
        const q = qualityCode(p?.q);
        const v = p?.v === null || p?.v === undefined || p?.v === '' ? NaN : Number(p.v);
        if (!Number.isFinite(v) && !isBadCode(q)) continue; // text values do not export as numbers
        out.push({ tag, t, value: Number.isFinite(v) && !isBadCode(q) ? v : null, quality: q ?? QUALITY_GOOD });
      }
    }
    out.sort((a, b) => a.t - b.t);
    yield* out;
  }
}

const RAW_BACKENDS = { timescaledb: timescaleRaw, influxdb: influxRaw, timebase: timebaseRaw };

/** Every stored sample for up to 10 tags over [start, end], in time order (async iterator). */
function queryRaw(conn = {}, { tags = [], start, end } = {}, fetchImpl = timedFetch) {
  const backend = RAW_BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  const range = normalizeRange({ start, end });
  return backend(conn, { tags: rawTags(tags), start: range.start, end: range.end }, fetchImpl);
}

/** Close pooled Postgres connections and TLS socket pools (shutdown). */
async function closePools() {
  for (const { pool } of pgPools.values()) await pool.end().catch(() => {});
  pgPools.clear();
  pgIdentityKey.clear();
  for (const agent of tlsAgents.values()) await agent.close().catch(() => {});
  tlsAgents.clear();
}

const BACKENDS = { influxdb: influxWrite, timebase: timebaseWrite, timescaledb: timescaleWrite };

async function writePoints(conn = {}, points = [], fetchImpl = timedFetch) {
  const backend = BACKENDS[conn.type];
  if (!backend) throw new Error(`unsupported historian type "${conn.type}" (supported: ${Object.keys(BACKENDS).join(', ')})`);
  // timescaledb talks Postgres, not HTTP — only the HTTP backends need fetch
  if (conn.type !== 'timescaledb' && typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  if (!points.length) return { written: 0, skipped: 0 };
  return backend(conn, points, fetchImpl);
}

function supportedTypes() {
  return Object.keys(BACKENDS);
}

/** Redact secrets for API responses. */
function publicConfig(conn) {
  const { token, apiKey, apiSecret, password, ...rest } = conn;
  return { ...rest, hasSecret: Boolean(token || apiKey || apiSecret || password) };
}

module.exports = {
  writePoints,
  queryTags,
  querySeries,
  queryRaw,
  supportedTypes,
  publicConfig,
  toLineProtocol,
  closePools,
  timebaseWritePath,
  isPermanentError,
  classifyValue,
  bucketSeries,
  qualityCode,
  QUALITY_META
};
