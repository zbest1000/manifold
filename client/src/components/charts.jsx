import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './charts-uplot.css';
import { alignSeries, finiteExtent, paddedRange } from './chartMath';

export { alignSeries, finiteExtent, paddedRange };

/**
 * Shared chart components — every sparkline and time-series in the app renders
 * through these. They wrap uPlot (https://github.com/leeoniya/uPlot): a mature,
 * dependency-free, ~40KB canvas charting engine — the same rendering approach
 * Grafana's time-series panels use. We don't draw axes/lines/tooltips ourselves;
 * uPlot does, so every chart shares one look, one crosshair, one readout.
 */

/**
 * THE theme object for every uPlot chart (sparklines, the health popup, topic
 * history, Trends). Every colour a chart canvas draws comes from here, so
 * aligning charts with new design tokens is a one-object change.
 */
export const CHART_THEME = {
  accent: '#38bdf8',
  warn: '#f59e0b',
  grid: 'rgba(148,163,184,0.14)',
  axis: '#7c8aa0',
  // Categorical series slots (Trends): CVD-separated, >= 3:1 on the dark surface.
  // Slots 9-10 reuse 1-2 (identity stays via the legend).
  palette: ['#3987e5', '#22c55e', '#e879a6', '#eab308', '#2dd4bf', '#f97316', '#a78bfa', '#f87171'],
  font: '12px ui-sans-serif, system-ui, sans-serif'
};
const ACCENT = CHART_THEME.accent;
const GRID = CHART_THEME.grid;
const AXIS = CHART_THEME.axis;

/** Width (CSS px) a y axis needs for its tick labels, so long values are never clipped. */
function yAxisSize(u, values, axisIdx, cycleNum) {
  const axis = u.axes[axisIdx];
  if (cycleNum > 1) return axis._size; // keep the size uPlot settled on (avoids layout ping-pong)
  let w = 0;
  // A private context: uPlot caches the font it last set on its own ctx.
  measureCtx ||= document.createElement('canvas').getContext('2d');
  if (values && measureCtx) {
    measureCtx.font = CHART_THEME.font;
    for (const v of values) w = Math.max(w, measureCtx.measureText(String(v)).width);
  }
  return Math.max(40, Math.ceil(w) + (axis.ticks?.show ? axis.ticks.size : 0) + (axis.gap ?? 5) + 8);
}
let measureCtx = null;

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return n.toExponential(2);
  return Number(n.toFixed(a < 1 ? 4 : a < 100 ? 2 : 1)).toString();
}

// #rrggbb → rgba(...) with the given alpha.
function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}


// Vertical gradient fill under an area series (returns a canvas gradient uPlot
// paints each draw). Falls back to a flat wash before the plot box is measured
// (bbox is empty on the very first draw) — createLinearGradient throws on
// non-finite coordinates.
function areaFill(hex) {
  return (u) => {
    const top = u.bbox?.top;
    const h = u.bbox?.height;
    if (!Number.isFinite(top) || !Number.isFinite(h) || h <= 0) return withAlpha(hex, 0.14);
    const g = u.ctx.createLinearGradient(0, top, 0, top + h);
    g.addColorStop(0, withAlpha(hex, 0.28));
    g.addColorStop(1, withAlpha(hex, 0));
    return g;
  };
}

/**
 * Minimal responsive uPlot lifecycle wrapper: creates the chart sized to its
 * container, keeps it sized via a ResizeObserver, and pushes data updates
 * through setData (no teardown) so live charts stay cheap. The chart is only
 * rebuilt when `options` changes (a structural change — series count, colors).
 */
function UplotChart({ options, data, height, className }) {
  const wrapRef = useRef(null);
  const uRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const width = Math.max(Math.floor(el.clientWidth), 1);
    const u = new uPlot({ ...options, width, height }, data, el);
    uRef.current = u;
    // Follow the container (window resize, sidebar collapse, a panel opening).
    // Created while hidden / before layout, the chart starts 1px wide; the first
    // observation sizes it. Unchanged widths are skipped (no redundant redraw).
    let lastW = width;
    const ro = new ResizeObserver(() => {
      const w = Math.max(Math.floor(el.clientWidth), 1);
      if (w === lastW) return;
      lastW = w;
      u.setSize({ width: w, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
    // data is intentionally omitted — updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options/height rebuild the chart; data streams in through the effect below
  }, [options, height]);

  useEffect(() => {
    if (uRef.current) uRef.current.setData(data);
  }, [data]);

  return <div ref={wrapRef} className={className} style={{ width: '100%', height }} />;
}

/**
 * Compact inline sparkline. `values` is a number[] (or []). Optional `warn`
 * flips the color to amber. No axes/legend/cursor — for stat tiles etc.
 */
export function Sparkline({ values, height = 28, warn = false, area = true, label = 'Trend' }) {
  const color = warn ? CHART_THEME.warn : ACCENT;
  const nums = (values || []).filter((v) => Number.isFinite(v));
  const ext = finiteExtent(nums);
  const flat = nums.length >= 2 && ext[0] === ext[1];
  const data = useMemo(() => [nums.map((_, i) => i), nums], [values]); // eslint-disable-line react-hooks/exhaustive-deps -- depends on `values` only; `nums` is derived from it each render
  const options = useMemo(
    () => ({
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: (_u, dmin, dmax) => paddedRange(dmin, dmax) } },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke: flat ? withAlpha(color, 0.45) : color,
          width: 1.5,
          fill: area && !flat ? areaFill(color) : undefined,
          points: { show: false }
        }
      ]
    }),
    [color, area, flat]
  );
  if (nums.length < 2) {
    // Blank state: a 1px baseline instead of nothing, so a tile that is still
    // collecting its first samples (needs 2) reads as waiting, not broken.
    return (
      <div role="img" aria-label={`${label}: collecting samples`} title="Collecting samples" style={{ height, width: '100%' }} className="flex items-end">
        <div className="w-full border-b border-dashed" style={{ borderColor: withAlpha(color, 0.45) }} />
      </div>
    );
  }
  return (
    <div role="img" aria-label={`${label}: ${nums.length} samples, latest ${fmtNum(nums[nums.length - 1])}, min ${fmtNum(ext[0])}, max ${fmtNum(ext[1])}`}>
      <UplotChart options={options} data={data} height={height} className="u-spark" />
    </div>
  );
}

/**
 * Time-series line/area chart. `series` is the historian shape:
 *   [{ tag, points: [[tsMs, value], ...] }]
 * Multiple series are merged on their union of timestamps (gaps → null), so one
 * series (a topic-history popup) or ten (Trends) render the same way.
 * `colorFor(index)` supplies per-series colors; a single series gets an area fill.
 */
export function TimeSeriesChart({ series = [], height = 260, colorFor, area, showGrid = true }) {
  const single = series.length === 1;
  const useArea = (area ?? single) && single;
  const color = (i) => (colorFor ? colorFor(i) : ACCENT);

  // uPlot data: shared, sorted x in SECONDS (its time scale), each series
  // aligned with nulls for gaps.
  const data = useMemo(() => alignSeries(series), [series]);
  // A window longer than a day needs the date in the hover readout, not just the clock.
  const xs = data[0] || [];
  const multiDay = xs.length > 1 && xs[xs.length - 1] - xs[0] > 86400;

  // Structural signature: the SET of series (tags + count), NOT their data. The
  // chart is only rebuilt when this changes — live data updates flow through
  // uPlot's setData (see UplotChart), so a 3s poll no longer destroys and
  // recreates the chart (which flashed and reset any zoom).
  const structKey = series.map((s) => s.tag || '').join('|');
  const options = useMemo(
    () => ({
      padding: [10, 14, 2, 2],
      cursor: { show: true, points: { show: true, size: 6 }, focus: { prox: 24 } },
      legend: { show: series.length > 0, live: true },
      scales: { x: { time: true }, y: { range: (_u, dmin, dmax) => paddedRange(dmin, dmax) } },
      axes: [
        { stroke: AXIS, grid: { show: false }, ticks: { stroke: GRID, size: 4 }, font: CHART_THEME.font, space: 90 }, // room for the date-bearing first label
        {
          stroke: AXIS,
          grid: { show: showGrid, stroke: GRID, width: 1 },
          ticks: { show: false },
          font: CHART_THEME.font,
          size: yAxisSize,
          values: (_u, ticks) => ticks.map(fmtNum)
        }
      ],
      series: [
        {
          value: (_u, ts) =>
            ts == null
              ? ''
              : multiDay
                ? new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        },
        ...series.map((s, i) => ({
          label: s.tag || `series ${i + 1}`,
          stroke: color(i),
          width: 2,
          fill: useArea ? areaFill(color(i)) : undefined,
          // A lone sample between two gaps would otherwise be invisible.
          points: { show: (u, si) => u.data[si].filter((v) => v != null).length < 3, size: 5 },
          // undefined (alignment holes) is drawn across; null (a real outage) breaks the line.
          spanGaps: false,
          value: (_u, v) => (v == null ? '—' : fmtNum(v))
        }))
      ]
    }),
    // Rebuild ONLY on a structural change (series added/removed, area/grid
    // toggled) — never on new data points, which stream through setData.
    [structKey, useArea, showGrid, multiDay] // eslint-disable-line react-hooks/exhaustive-deps -- rebuilds only on structure changes; data streams through setData
  );

  if (!data[0] || data[0].length < 2) {
    return (
      <div style={{ height }} className="grid place-items-center text-xs text-slate-400" role="status">
        Not enough data to chart yet. Samples arrive every few seconds.
      </div>
    );
  }
  return <UplotChart options={options} data={data} height={height} className="u-ts" />;
}
