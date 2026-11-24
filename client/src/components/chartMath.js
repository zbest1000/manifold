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

/**
 * Align historian series on the union of their timestamps for uPlot.
 * Returns [xsSeconds, ...ys]. A series that simply has no sample at another
 * series' timestamp gets `undefined` there (uPlot draws straight across it),
 * while a REAL outage — a silence longer than `gapFactor` x that series' median
 * sample interval — gets an explicit `null`, which uPlot renders as a break
 * instead of a misleading straight line across the hole. Non-finite values
 * (NaN, Infinity, strings) are treated as missing.
 */
export function alignSeries(series, { gapFactor = 5 } = {}) {
  const per = series.map((s) => {
    const pts = [];
    for (const p of s.points || []) {
      const ts = Number(p?.[0]);
      const v = p?.[1];
      if (Number.isFinite(ts) && typeof v === 'number' && Number.isFinite(v)) pts.push([ts, v]);
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
  return [xsMs.map((t) => t / 1000), ...ys];
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
