/**
 * Pure chart math shared by the uPlot wrappers in charts.jsx (no DOM, no uPlot),
 * kept separate so it is unit-tested in node (src/test/chartMath.test.js).
 */

/** Min / max of the finite numbers in an array (loop: spread overflows the stack on long series). */
export function finiteExtent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : [min, max];
}

/** Is a sample's quality Bad? (false, 'bad', or an OPC-style quality code below 64). */
export function isBadQuality(q) {
  if (q == null || q === true) return false;
  if (q === false) return true;
  if (typeof q === 'number') return q < 64;
  return /^(bad|false|0)$/i.test(String(q));
}

/** Is a sample's quality Uncertain? ('uncertain', or an OPC-style code from 64 to 191). */
export function isUncertainQuality(q) {
  if (typeof q === 'number') return q >= 64 && q < 192;
  return typeof q === 'string' && /^uncertain$/i.test(q);
}

/**
 * State of one point as the series readers return it ([ts, value, quality,
 * partial?], see server/services/historians.js bucketSeries):
 *   'partial'   a downsampled bucket that mixed Bad and usable samples: its value
 *               is the mean of the usable ones (drawn, with a distinct marker);
 *   'bad'       a Bad sample or a Bad-only bucket: NOT drawn (a gap + marker);
 *   'uncertain' drawn, flagged in the readout;
 *   null        Good, or no quality known.
 */
export function pointState(p) {
  if (p?.[3]) return 'partial';
  if (isBadQuality(p?.[2])) return 'bad';
  if (isUncertainQuality(p?.[2])) return 'uncertain';
  return null;
}

/**
 * Align historian series on the union of their timestamps for uPlot.
 * Returns [xsSeconds, ...ys]. A series that simply has no sample at another
 * series' timestamp gets `undefined` there (uPlot draws straight across it),
 * while a REAL outage — a silence longer than `gapFactor` x that series' median
 * sample interval — gets an explicit `null`, which uPlot renders as a break
 * instead of a misleading straight line across the hole. Non-finite values
 * (NaN, Infinity, strings) are treated as missing.
 *
 * A point may carry a quality and a partial flag ([ts, value, quality, partial?],
 * see pointState). A Bad point is never drawn as a value: it becomes an explicit
 * `null` (a break in the line) even when the source still sent a number, and is
 * listed for the overlay marker. A point may carry its raw (pre-normalisation)
 * value as a 5th element, for the readout.
 * The result carries non-enumerable extras for the chart's overlay and readout:
 *   result.bad      per series, the x indices of Bad points (gaps);
 *   result.partial  per series, the x indices of partial buckets;
 *   result.state    per series, Map(x index -> 'bad' | 'partial' | 'uncertain');
 *   result.raw      per series, Map(x index -> raw value) where it differs;
 *   result.gaps     per series, [xIndexBefore, xIndexAfter] pairs around each outage.
 */
export function alignSeries(series, { gapFactor = 5 } = {}) {
  const per = series.map((s) => {
    const pts = [];
    for (const p of s.points || []) {
      const ts = Number(p?.[0]);
      const v = p?.[1];
      const state = pointState(p);
      const finite = typeof v === 'number' && Number.isFinite(v);
      if (!Number.isFinite(ts) || (!finite && state !== 'bad')) continue;
      pts.push([ts, state === 'bad' ? null : v, state, p.length > 4 ? p[4] : undefined]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    return pts;
  });
  // Gap markers: one timestamp just after the last sample before each outage.
  const gapTs = per.map((pts) => {
    if (pts.length < 3) return [];
    const deltas = [];
    for (let i = 1; i < pts.length; i++) deltas.push(pts[i][0] - pts[i - 1][0]);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!(median > 0)) return [];
    const out = [];
    for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] > median * gapFactor) out.push(pts[i - 1][0] + median);
    return out;
  });
  const tsSet = new Set();
  per.forEach((pts, i) => {
    for (const [ts] of pts) tsSet.add(ts);
    for (const ts of gapTs[i]) tsSet.add(ts);
  });
  const xsMs = [...tsSet].sort((a, b) => a - b);
  const idx = new Map(xsMs.map((t, i) => [t, i]));
  const ys = per.map((pts, i) => {
    const arr = new Array(xsMs.length).fill(undefined);
    for (const ts of gapTs[i]) arr[idx.get(ts)] = null;
    for (const [ts, v] of pts) arr[idx.get(ts)] = v;
    return arr;
  });
  const out = [xsMs.map((t) => t / 1000), ...ys];
  const bad = per.map((pts) => pts.filter((p) => p[2] === 'bad').map((p) => idx.get(p[0])));
  const partial = per.map((pts) => pts.filter((p) => p[2] === 'partial').map((p) => idx.get(p[0])));
  const state = per.map((pts) => new Map(pts.filter((p) => p[2]).map((p) => [idx.get(p[0]), p[2]])));
  const raw = per.map((pts) => new Map(pts.filter((p) => p[3] !== undefined).map((p) => [idx.get(p[0]), p[3]])));
  const gaps = per.map((pts, i) =>
    gapTs[i].map((g) => {
      const before = pts.filter((p) => p[0] < g).pop();
      const after = pts.find((p) => p[0] > g);
      return before && after ? [idx.get(before[0]), idx.get(after[0])] : null;
    }).filter(Boolean)
  );
  Object.defineProperty(out, 'bad', { value: bad, enumerable: false });
  Object.defineProperty(out, 'partial', { value: partial, enumerable: false });
  Object.defineProperty(out, 'state', { value: state, enumerable: false });
  Object.defineProperty(out, 'raw', { value: raw, enumerable: false });
  Object.defineProperty(out, 'gaps', { value: gaps, enumerable: false });
  return out;
}

/**
 * How the y axes are arranged for a set of series with units (Trends):
 *   - one unit (or none):     one axis, labelled with it;
 *   - two units:              two axes, left and right, each series on its unit's;
 *   - three or more:          no honest shared axis exists: 'normalize' (each
 *                              series scaled to its own range, real values and
 *                              units in the readout and legend).
 * Series without a unit form their own group ("no unit").
 * Returns { mode: 'single' | 'dual' | 'normalize', groups: [unit...], scaleOf: [i -> 'y' | 'y2'] }.
 */
export function unitLayout(series, { normalize = false } = {}) {
  const groups = [];
  for (const s of series) {
    const u = s.unit || '';
    if (!groups.includes(u)) groups.push(u);
  }
  if (normalize || groups.length > 2) return { mode: 'normalize', groups, scaleOf: series.map(() => 'y'), forced: !normalize && groups.length > 2 };
  if (groups.length === 2) return { mode: 'dual', groups, scaleOf: series.map((s) => (groups.indexOf(s.unit || '') === 0 ? 'y' : 'y2')), forced: false };
  return { mode: 'single', groups, scaleOf: series.map(() => 'y'), forced: false };
}

/**
 * Rescale each series to 0..100 % of its own min/max (usable samples only), so
 * tags of different magnitude or unit compare by shape on one axis. Every point
 * keeps its raw value as a 5th element for the readout; a constant series sits
 * at the midline. The raw [min, max] rides along on `range`, the real unit on `rawUnit`.
 */
export function normalizeSeries(series) {
  return series.map((s) => {
    const usable = (s.points || []).filter((p) => pointState(p) !== 'bad').map((p) => p[1]);
    const ext = finiteExtent(usable);
    if (!ext) return { ...s, unit: '%', rawUnit: s.unit };
    const [min, max] = ext;
    const span = max - min;
    const points = s.points.map((p) => {
      const v = p[1];
      const scaled = typeof v === 'number' && Number.isFinite(v) ? (span ? ((v - min) / span) * 100 : 50) : v;
      return [p[0], scaled, p[2], p[3] || 0, v];
    });
    return { ...s, points, range: [min, max], unit: '%', rawUnit: s.unit };
  });
}

/** One readout line for a value: "21.5 C", "Bad quality: no value", "12 kPa · partial (some samples Bad)". */
export function describeValue(v, { unit = '', state = null, fmt = String } = {}) {
  if (state === 'bad') return 'Bad quality: no value';
  if (v == null || !Number.isFinite(v)) return '—';
  const base = unit ? `${fmt(v)} ${unit}` : fmt(v);
  if (state === 'partial') return `${base} · partial (some samples Bad)`;
  if (state === 'uncertain') return `${base} · uncertain`;
  return base;
}

// Pad the y-scale so a trace has breathing room instead of jamming edge-to-edge;
// a constant series (min===max) gets a symmetric band so it reads as a flat line.
// Never pads across zero: an all-positive series (a counter, an energy meter)
// used to get a negative axis (-500 under data that starts at 1000).
export function paddedRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1;
    return min >= 0 ? [Math.max(0, min - d), max + d] : [min - d, max + d];
  }
  const pad = (max - min) * 0.35;
  let lo = min - pad;
  let hi = max + pad;
  if (min >= 0 && lo < 0) lo = 0;
  if (max <= 0 && hi > 0) hi = 0;
  return [lo, hi];
}
// Unit riding along in a payload: a TVQ envelope's `u`, or `unit` / `units`
// beside the value (the same rule the recorder uses, server/services/recorder.js unitOf).
export function unitFrom(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const u = payload.unit ?? payload.units ?? payload.u;
  return typeof u === 'string' && u.trim() && u.length <= 16 ? u.trim() : '';
}

/**
 * Quality of a live message, OPC 0-255, with the server's rules
 * (pipelineEngine.messageQuality): the quality the intake read from a TVQ
 * envelope or Sparkplug, an envelope `q` (also next to a `u`), a payload that
 * failed to decode = Bad, otherwise Good.
 */
export function liveQuality(m) {
  if (m.sparkplugError) return 0;
  const q = m.quality ?? (m.payload && typeof m.payload === 'object' && 'v' in m.payload ? m.payload.q : undefined);
  return q === 0 || q === 64 || q === 192 ? q : 192;
}

/** Sample time of a live message: the source timestamp when plausible, else arrival (messageTime). */
export function liveTime(m, now = Date.now()) {
  const src = Number(m.sourceTimestamp);
  if (Number.isFinite(src) && src >= Date.UTC(2000, 0, 1) && src <= now + 86_400_000) return src;
  return new Date(m.timestamp).getTime();
}


/**
 * A long tag shortened from the START, keeping its trailing path segments (the
 * part that tells tags apart: ".../Edge1/Dev1/Temperature"). Short tags are
 * returned unchanged; a single over-long segment is cut in the middle.
 */
export function shortTag(tag, max = 32) {
  const s = String(tag ?? '');
  if (s.length <= max) return s;
  const segs = s.split('/');
  let out = segs.pop();
  while (segs.length && out.length + segs[segs.length - 1].length + 3 <= max) out = `${segs.pop()}/${out}`;
  if (out.length + 2 > max) return `${out.slice(0, Math.ceil((max - 1) / 2))}…${out.slice(out.length - Math.floor((max - 1) / 2))}`;
  return `…/${out}`;
}
