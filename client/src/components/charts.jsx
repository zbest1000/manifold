import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './charts-uplot.css';
import { alignSeries, finiteExtent, paddedRange } from './chartMath';
import { FALLBACK_TOKENS, getCanvasTokens, useCanvasTokens } from '@/graph/canvasTokens';
import { SERIES_DASH } from '@/graph/dataPalette';
import { withAlpha } from '@/graph/colorMath';
import { buildChartTheme, CHART_THEME } from './chartTheme';

export { buildChartTheme, CHART_THEME };

export { alignSeries, finiteExtent, paddedRange };

/**
 * Shared chart components — every sparkline and time-series in the app renders
 * through these. They wrap uPlot (https://github.com/leeoniya/uPlot): a mature,
 * dependency-free, ~40KB canvas charting engine — the same rendering approach
 * Grafana's time-series panels use. We don't draw axes/lines/tooltips ourselves;
 * uPlot does, so every chart shares one look, one crosshair, one readout.
 */

/** The chart theme for the current app theme, read at PAINT time by every colour callback. */
const nowTheme = () => buildChartTheme(getCanvasTokens());
const CHART_FONT = buildChartTheme(FALLBACK_TOKENS.dark).font; // same face in both themes
const CHART_LABEL_FONT = buildChartTheme(FALLBACK_TOKENS.dark).labelFont;

/** React hook: the chart theme for the current app theme. */
export function useChartTheme() {
  return buildChartTheme(useCanvasTokens());
}

/** Width (CSS px) a y axis needs for its tick labels, so long values are never clipped. */
function yAxisSize(u, values, axisIdx, cycleNum) {
  const axis = u.axes[axisIdx];
  if (cycleNum > 1) return axis._size; // keep the size uPlot settled on (avoids layout ping-pong)
  let w = 0;
  // A private context: uPlot caches the font it last set on its own ctx.
  measureCtx ||= document.createElement('canvas').getContext('2d');
  if (values && measureCtx) {
    measureCtx.font = CHART_FONT;
    for (const v of values) w = Math.max(w, measureCtx.measureText(String(v)).width);
  }
  return Math.max(40, Math.ceil(w) + (axis.ticks?.show ? axis.ticks.size : 0) + (axis.gap ?? 5) + 8 + (axis.label ? 18 : 0));
}
let measureCtx = null;

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return n.toExponential(2);
  return Number(n.toFixed(a < 1 ? 4 : a < 100 ? 2 : 1)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const tickClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const tickClockS = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const tickDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export function formatTick(ts, multiDay, incr = 60) {
  const d = new Date(ts * 1000);
  if (multiDay) return d.getHours() === 0 && d.getMinutes() === 0 ? tickDate.format(d) : `${tickDate.format(d)} ${tickClock.format(d)}`;
  return incr < 60 ? tickClockS.format(d) : tickClock.format(d);
}

/** The viewer's time zone, for axis captions: "Europe/Berlin, UTC+1". */
export function timeZoneLabel(date = new Date()) {
  let zone = 'local time';
  let offset = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
    offset = new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    /* older engines: zone name only */
  }
  if (/^(Etc\/)?(UTC|GMT|UCT|Universal|Zulu)$/.test(zone)) return 'UTC';
  offset = offset.replace(/^GMT/, 'UTC');
  if (offset === 'UTC') offset = 'UTC+0';
  return offset && offset !== zone ? `${zone}, ${offset}` : zone;
}

// Flat 10% wash under an area series, in the colour `getColor()` returns at
// paint time (so it follows the theme). Layers, not effects: no fades.
function areaFill(getColor) {
  return () => withAlpha(getColor(), 0.1);
}

/**
 * Minimal responsive uPlot lifecycle wrapper: creates the chart sized to its
 * container, keeps it sized via a ResizeObserver, and pushes data updates
 * through setData (no teardown) so live charts stay cheap. The chart is only
 * rebuilt when `options` changes (a structural change). A theme change does NOT
 * rebuild it (zoom and cursor are kept): every colour in the options is a
 * function reading the current theme, so a redraw recolours, and the legend
 * markers (DOM, set once by uPlot) are recoloured here.
 */
function UplotChart({ options, data, height, className, theme, seriesColor }) {
  const wrapRef = useRef(null);
  const uRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const width = Math.max(Math.floor(el.clientWidth), 1);
    const u = new uPlot({ ...options, width, height }, data, el);
    u.manifoldMeta = { bad: data.bad, gaps: data.gaps }; // read by the outage / quality overlay hook
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
    // DPR change (monitor move, browser zoom): uPlot sizes its backing store at
    // creation; re-apply the size so lines stay crisp at the new ratio.
    let mql = null;
    const onDpr = () => {
      u.setSize({ width: lastW, height });
      arm();
    };
    const arm = () => {
      mql?.removeEventListener?.('change', onDpr);
      mql = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
      mql?.addEventListener?.('change', onDpr);
    };
    arm();
    return () => {
      ro.disconnect();
      mql?.removeEventListener?.('change', onDpr);
      u.destroy();
      uRef.current = null;
    };
    // data is intentionally omitted — updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options/height rebuild the chart; data streams in through the effect below
  }, [options, height]);

  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    u.manifoldMeta = { bad: data.bad, gaps: data.gaps };
    u.setData(data);
  }, [data]);

  // Theme change: repaint in place and recolour the legend markers.
  useEffect(() => {
    const u = uRef.current;
    if (!u || !theme) return;
    u.redraw(false, false);
    const rows = u.root.querySelectorAll('.u-legend .u-series');
    rows.forEach((row, i) => {
      if (i === 0 || !seriesColor) return;
      const m = row.querySelector('.u-marker');
      if (!m) return;
      const c = seriesColor(i - 1);
      m.style.borderColor = c;
      m.style.background = c;
    });
  }, [theme, seriesColor]);

  return <div ref={wrapRef} className={className} style={{ width: '100%', height }} />;
}

/**
 * Compact inline sparkline. `values` is a number[] (or []). Optional `warn`
 * flips the colour to the warn token. No axes/legend/cursor — for stat rows.
 */
export function Sparkline({ values, height = 28, warn = false, area = true, label = 'Trend' }) {
  const theme = useChartTheme();
  const nums = (values || []).filter((v) => Number.isFinite(v));
  const ext = finiteExtent(nums);
  const flat = nums.length >= 2 && ext[0] === ext[1];
  const data = useMemo(() => [nums.map((_, i) => i), nums], [values]); // eslint-disable-line react-hooks/exhaustive-deps -- depends on `values` only; `nums` is derived from it each render
  const options = useMemo(() => {
    const colorNow = () => (warn ? nowTheme().warn : nowTheme().accent);
    return {
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: (_u, dmin, dmax) => paddedRange(dmin, dmax) } },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke: () => (flat ? withAlpha(colorNow(), 0.5) : colorNow()),
          width: 1.5,
          fill: area && !flat ? areaFill(colorNow) : undefined,
          points: { show: false }
        }
      ]
    };
  }, [warn, area, flat]);
  const color = warn ? theme.warn : theme.accent;
  if (nums.length < 2) {
    // Blank state: a 1px baseline instead of nothing, so a row that is still
    // collecting its first samples (needs 2) reads as waiting, not broken.
    return (
      <div role="img" aria-label={`${label}: collecting samples`} title="Collecting samples" style={{ height, width: '100%' }} className="flex items-end">
        <div className="w-full border-b border-dashed" style={{ borderColor: withAlpha(color, 0.5) }} />
      </div>
    );
  }
  return (
    <div role="img" aria-label={`${label}: ${nums.length} samples, latest ${fmtNum(nums[nums.length - 1])}, min ${fmtNum(ext[0])}, max ${fmtNum(ext[1])}`}>
      <UplotChart options={options} data={data} height={height} className="u-spark" theme={theme} />
    </div>
  );
}

/**
 * Time-series line/area chart. `series` is the historian shape:
 *   [{ tag, unit?, points: [[tsMs, value, quality?], ...] }]
 * Multiple series are merged on their union of timestamps (gaps → null), so one
 * series (a topic-history popup) or ten (Trends) render the same way.
 * `colorFor(index, theme)` supplies per-series colours (default: the data
 * palette, with slots 6-10 dashed); a single series gets an area fill.
 * `unit` labels the y axis (pass it when every series shares it). Outages are
 * bridged with a faint dashed line and Bad-quality samples get a hollow marker.
 */
export function TimeSeriesChart({ series = [], height = 260, colorFor, area, showGrid = true, unit = '', legend = 'hover' }) {
  const theme = useChartTheme();
  const single = series.length === 1;
  const useArea = (area ?? single) && single;
  // Resolved at paint time, so a theme switch recolours without a rebuild.
  const colorAt = useMemo(
    () => (i) => {
      const t = nowTheme();
      return colorFor ? colorFor(i, t) : single ? t.accent : t.palette[i % t.palette.length];
    },
    [single, colorFor]
  );

  // uPlot data: shared, sorted x in SECONDS (its time scale), each series
  // aligned with nulls for gaps (plus .bad / .gaps for the overlay).
  const data = useMemo(() => alignSeries(series), [series]);
  // A window longer than a day needs the date in the axis and readout, not just the clock.
  const xs = data[0] || [];
  const multiDay = xs.length > 1 && xs[xs.length - 1] - xs[0] > 86400;
  const tz = useMemo(() => timeZoneLabel(), []);

  // Structural signature: the SET of series (tags + count), NOT their data. The
  // chart is only rebuilt when this changes — live data updates flow through
  // uPlot's setData (see UplotChart), so a 3s poll no longer destroys and
  // recreates the chart (which flashed and reset any zoom).
  const structKey = series.map((s) => s.tag || '').join('|');
  const options = useMemo(
    () => ({
      padding: [12, 12, 0, 4],
      cursor: { show: true, points: { show: true, size: 7, width: 2, fill: () => nowTheme().surface }, focus: { prox: 24 } },
      legend: { show: series.length > 0, live: true },
      focus: { alpha: 0.35 },
      scales: { x: { time: true }, y: { range: (_u, dmin, dmax) => paddedRange(dmin, dmax) } },
      axes: [
        {
          stroke: () => nowTheme().axis,
          grid: { show: false },
          ticks: { stroke: () => nowTheme().axisLine, size: 4, width: 1 },
          border: { show: true, stroke: () => nowTheme().axisLine, width: 1 },
          font: CHART_FONT,
          labelFont: CHART_LABEL_FONT,
          label: `Time (${tz})`,
          // 24-hour local clock; the date joins it when the window spans days.
          values: (_u, splits, _ax, _space, incr) => splits.map((ts) => formatTick(ts, multiDay, incr)),
          labelSize: 20,
          labelGap: 2,
          space: multiDay ? 110 : 80
        },
        {
          stroke: () => nowTheme().axis,
          grid: { show: showGrid, stroke: () => nowTheme().grid, width: 1 },
          ticks: { show: false },
          font: CHART_FONT,
          labelFont: CHART_LABEL_FONT,
          label: unit || undefined,
          labelSize: unit ? 18 : 0,
          labelGap: 4,
          size: yAxisSize,
          values: (_u, ticks) => ticks.map(fmtNum)
        }
      ],
      series: [
        {
          label: 'Time',
          value: (_u, ts) =>
            ts == null
              ? ''
              : multiDay
                ? new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        },
        ...series.map((s, i) => ({
          label: s.unit ? `${s.tag || `Series ${i + 1}`} (${s.unit})` : s.tag || `Series ${i + 1}`,
          stroke: () => colorAt(i),
          width: 1.75,
          dash: single ? undefined : SERIES_DASH[i % SERIES_DASH.length] || undefined,
          fill: useArea ? areaFill(() => colorAt(i)) : undefined,
          // A lone sample between two gaps would otherwise be invisible.
          points: { show: (u, si) => u.data[si].filter((v) => v != null).length < 3, size: 5, fill: () => colorAt(i) },
          // undefined (alignment holes) is drawn across; null (a real outage) breaks the line.
          spanGaps: false,
          value: (_u, v) => (v == null ? '—' : s.unit ? `${fmtNum(v)} ${s.unit}` : fmtNum(v))
        }))
      ],
      hooks: {
        // Outages and Bad-quality samples, so they are visibly distinct from data:
        // a faint dashed bridge across each gap, a hollow ring on each Bad sample.
        draw: [
          (u) => {
            const d = u.manifoldMeta;
            if (!d?.gaps && !d?.bad) return;
            const ctx = u.ctx;
            const pr = uPlot.pxRatio;
            ctx.save();
            ctx.beginPath();
            ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
            ctx.clip();
            const X = (i) => u.valToPos(u.data[0][i], 'x', true);
            (d.gaps || []).forEach((pairs, si) => {
              if (!u.series[si + 1]?.show) return;
              ctx.strokeStyle = nowTheme().gap;
              ctx.lineWidth = pr;
              ctx.setLineDash([3 * pr, 4 * pr]);
              for (const [a, b] of pairs) {
                const ya = u.data[si + 1][a];
                const yb = u.data[si + 1][b];
                if (ya == null || yb == null) continue;
                ctx.beginPath();
                ctx.moveTo(X(a), u.valToPos(ya, 'y', true));
                ctx.lineTo(X(b), u.valToPos(yb, 'y', true));
                ctx.stroke();
              }
            });
            ctx.setLineDash([]);
            (d.bad || []).forEach((idxs, si) => {
              if (!u.series[si + 1]?.show || !idxs.length) return;
              ctx.strokeStyle = nowTheme().bad;
              ctx.fillStyle = nowTheme().surface;
              ctx.lineWidth = 1.5 * pr;
              for (const i of idxs) {
                const v = u.data[si + 1][i];
                if (v == null) continue;
                ctx.beginPath();
                ctx.arc(X(i), u.valToPos(v, 'y', true), 3.5 * pr, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
              }
            });
            ctx.restore();
          }
        ]
      }
    }),
    // Rebuild ONLY on a structural change (series added/removed, area/grid
    // toggled) — never on new data points, which stream through setData.
    [structKey, useArea, showGrid, multiDay, unit, tz, colorAt, single] // eslint-disable-line react-hooks/exhaustive-deps -- rebuilds only on structure changes; data streams through setData
  );

  if (!data[0] || data[0].length < 2) {
    return (
      <div style={{ height }} className="grid place-items-center text-sm text-muted" role="status">
        Not enough data to chart yet. Samples arrive every few seconds.
      </div>
    );
  }
  return <UplotChart options={options} data={data} height={height} className={legend === 'below' ? 'u-ts u-legend-below' : 'u-ts'} theme={theme} seriesColor={colorAt} />;
}
