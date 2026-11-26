'use strict';

/**
 * Trends CSV export: the series and range shown on the Trends page as a CSV
 * file, streamed row by row.
 *
 * Layout:
 *   - comment lines first ("# ..."): source, range, whether the values are raw
 *     samples or bucketed as charted (and what a bucket means), the quality code
 *     scale, and a truncation note when the row cap was reached;
 *   - header: `time`, then per series `<tag> (<unit>)` and `<tag> quality`;
 *   - one row per distinct sample (or bucket) time, ISO 8601 UTC with
 *     milliseconds; samples of several series at the same time share a row.
 *
 * Gaps are preserved: a series with no sample at a row's time has empty cells;
 * a Bad sample (or a Bad-only bucket) has an empty value and its quality code;
 * a bucket that mixed Bad and usable samples has the quality "<code> partial".
 * A backend that stores no quality (InfluxDB) leaves the quality cells empty
 * and says so in the comments.
 *
 * Sources: `historian` (raw: historians.queryRaw, paged; bucketed:
 * querySeries), `recording` (raw: recorder.rawSamples, read from the file as it
 * goes; bucketed: recorder.series) and `live` (the broker's recent message
 * buffer, the same samples the chart shows; always raw).
 */

const historians = require('./historians');
const { recordLine, recordSamples } = require('./recorder');

const DEFAULT_MAX_ROWS = 1_000_000;
const CHART_POINTS = 1000; // what Trends asks for when it charts
const LIVE_MESSAGES = 500; // what the live chart reads per topic

function maxRows() {
  const n = Number(process.env.MANIFOLD_EXPORT_MAX_ROWS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ROWS;
}

/** One CSV field. Header cells that a spreadsheet would run as a formula get a leading apostrophe. */
function csvField(value, { header = false } = {}) {
  let s = value === null || value === undefined ? '' : String(value);
  if (header && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (ms) => new Date(ms).toISOString();

/** "3.6 s", "2 min", "1.5 h" for a bucket width in ms. */
function duration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${+(ms / 1000).toFixed(1)} s`;
  if (ms < 7_200_000) return `${+(ms / 60_000).toFixed(1)} min`;
  return `${+(ms / 3_600_000).toFixed(1)} h`;
}

/** File name: manifold-trends-<raw|bucketed>-<from>-<to>.csv (UTC, compact). */
function exportFilename(mode, from, to) {
  const stamp = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `manifold-trends-${mode}-${stamp(from)}-${stamp(to)}.csv`;
}

/** Comment lines describing the export. */
function headerComments({ sourceLabel, from, to, mode, quality, live }) {
  // A name with a line break would start a new CSV line of its choosing (e.g. "=HYPERLINK(...)").
  const lines = ['# Manifold Trends export', `# Source: ${String(sourceLabel).replace(/[\r\n]+/g, ' ')}`, `# Range: ${iso(from)} to ${iso(to)} (times are UTC)`];
  if (mode === 'raw') {
    lines.push(`# Values: raw samples${live ? ' (the broker\'s recent message buffer, up to 500 messages per topic)' : ''}. One row per sample time; an empty value cell means that series had no sample at that time.`);
  } else {
    const width = Math.max(1, Math.ceil((to - from) / CHART_POINTS));
    lines.push(
      `# Values: bucketed as charted, at most ${CHART_POINTS} points per series. A series with more samples in the range is averaged per interval of about ${duration(width)}: the value is the mean of its Good and Uncertain samples, the quality the worst in the interval, "partial" marks an interval that also held Bad samples, and an interval with only Bad samples has an empty value.`
    );
  }
  lines.push(
    quality === 'unavailable'
      ? '# Quality: this historian stores no quality (InfluxDB), so quality cells are empty.'
      : '# Quality: OPC code 0-255 (192 and above Good, 64-191 Uncertain, below 64 Bad). A Bad sample has an empty value.'
  );
  return lines;
}

/**
 * Write the CSV for time-ordered samples. `write(text)` may return a promise
 * (backpressure); `aborted()` stops early. Returns { rows, truncated }.
 */
async function writeCsv({ write, comments, columns, samples, aborted = () => false, limit = maxRows() }) {
  const index = new Map(columns.map((c, i) => [c.tag, i]));
  let out = comments.map((l) => `${l}\n`).join('');
  const head = ['time'];
  for (const c of columns) head.push(csvField(c.unit ? `${c.tag} (${c.unit})` : c.tag, { header: true }), csvField(`${c.tag} quality`, { header: true }));
  out += `${head.join(',')}\n`;

  let rows = 0;
  let truncated = false;
  let rowT = null;
  let cells = null;
  const flushRow = () => {
    if (cells === null) return;
    out += `${iso(rowT)},${cells.join(',')}\n`;
    rows++;
    cells = null;
  };
  for await (const s of samples) {
    if (aborted()) return { rows, truncated, aborted: true };
    const i = index.get(s.tag);
    if (i === undefined || !Number.isFinite(s.t)) continue;
    if (cells !== null && (s.t !== rowT || cells[i * 2] !== '' || cells[i * 2 + 1] !== '')) flushRow();
    if (rows >= limit) {
      truncated = true;
      break;
    }
    if (cells === null) {
      rowT = s.t;
      cells = new Array(columns.length * 2).fill('');
    }
    const isBad = typeof s.quality === 'number' && s.quality < 64;
    cells[i * 2] = !isBad && typeof s.value === 'number' && Number.isFinite(s.value) ? String(s.value) : '';
    cells[i * 2 + 1] = s.quality === null || s.quality === undefined ? '' : `${s.quality}${s.partial ? ' partial' : ''}`;
    if (out.length > 64 * 1024) {
      await write(out);
      out = '';
    }
  }
  if (!truncated) flushRow();
  if (truncated) out += `# Truncated: stopped at ${limit.toLocaleString('en-US')} rows (MANIFOLD_EXPORT_MAX_ROWS). Export a shorter range for the rest.\n`;
  if (out) await write(out);
  return { rows, truncated };
}

/** Time-ordered samples from reader-shaped series ({ tag, points: [[t, v, q, partial?]] }). */
function* fromSeries(series) {
  const all = [];
  for (const s of series) {
    for (const p of s.points || []) all.push({ tag: s.tag, t: p[0], value: p[1], quality: p.length > 2 ? p[2] : null, partial: p[3] === 1 });
  }
  all.sort((a, b) => a.t - b.t);
  yield* all;
}

/** Live samples of one broker's recent buffer, as the recorder would have stored them. */
function liveSamples(mqttManager, brokerId, tags, from, to) {
  const all = [];
  for (const tag of tags) {
    for (const msg of mqttManager.getMessages(brokerId, tag, LIVE_MESSAGES)) {
      for (const smp of recordSamples(recordLine(msg))) {
        if (smp.tag === tag && smp.t >= from && smp.t <= to) all.push(smp);
      }
    }
  }
  all.sort((a, b) => a.t - b.t);
  return all;
}

/**
 * Resolve what to export: { comments, columns, samples, filename }.
 * Throws an Error with `status` for a bad request (400/404).
 */
async function prepareExport({ source, id, tags, units = [], from, to, mode }, { profiles, recorder, mqttManager, fetchImpl }) {
  const bad = (status, message) => Object.assign(new Error(message), { status });
  if (!['live', 'historian', 'recording'].includes(source)) throw bad(400, 'source must be live, historian or recording');
  if (!['raw', 'bucketed'].includes(mode)) throw bad(400, 'mode must be raw or bucketed');
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10 || tags.some((t) => typeof t !== 'string' || !t.trim())) throw bad(400, 'tags must be 1-10 non-empty strings');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw bad(400, 'from and to must be epoch milliseconds with to after from');
  const effectiveMode = source === 'live' ? 'raw' : mode;
  const columns = tags.map((tag, i) => ({ tag, unit: typeof units[i] === 'string' && units[i].trim() ? units[i].trim().slice(0, 32) : '' }));
  let samples;
  let quality = 'stored';
  let sourceLabel;

  if (source === 'live') {
    const conn = mqttManager.getConnection(id);
    if (!conn) throw bad(404, 'Broker not found');
    sourceLabel = `live, broker "${conn.name || conn.host || id}"`;
    samples = liveSamples(mqttManager, id, tags, from, to);
  } else if (source === 'recording') {
    const rec = profiles.getIn('recordings', id);
    if (!rec) throw bad(404, 'Recording not found');
    sourceLabel = `recording "${rec.name || id}"`;
    if (effectiveMode === 'raw') samples = recorder.rawSamples(id, { tags, from, to });
    else {
      const r = await recorder.series(id, { tags, from, to, maxPoints: CHART_POINTS });
      for (const s of r.series) {
        const c = columns.find((x) => x.tag === s.tag);
        if (c && !c.unit && s.unit) c.unit = s.unit;
      }
      samples = fromSeries(r.series);
    }
  } else {
    const conn = profiles.getIn('historians', id);
    if (!conn) throw bad(404, 'Historian not found');
    sourceLabel = `historian "${conn.name || id}" (${conn.type})`;
    quality = historians.QUALITY_META[conn.type]?.quality || 'stored';
    if (effectiveMode === 'raw') samples = historians.queryRaw(conn, { tags, start: from, end: to }, fetchImpl);
    else samples = fromSeries((await historians.querySeries(conn, { tags, start: from, end: to, maxPoints: CHART_POINTS }, fetchImpl)).series);
  }
  return {
    comments: headerComments({ sourceLabel, from, to, mode: effectiveMode, quality, live: source === 'live' }),
    columns,
    samples,
    mode: effectiveMode,
    filename: exportFilename(effectiveMode, from, to)
  };
}

module.exports = { prepareExport, writeCsv, csvField, exportFilename, headerComments, fromSeries, DEFAULT_MAX_ROWS };
