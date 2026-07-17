import { LineChart as LineIcon, Loader2, AlertTriangle } from 'lucide-react';
import { TimeSeriesChart } from './charts';

/**
 * TrendChart — the Trends page's multi-series time chart. Thin wrapper over the
 * shared uPlot TimeSeriesChart so every chart in the app looks the same;
 * keeps the loading / error / empty states, the categorical palette, and a
 * click-free legend.
 *
 * `series`: [{ tag, points: [[tsMs, value], ...] }]
 */

// Fixed slot order — assigned by series position, CVD-separated, >=3:1 contrast
// on the dark surface. Slots 9-10 reuse 1-2 (identity stays via the legend).
const PALETTE = ['#3987e5', '#22c55e', '#e879a6', '#eab308', '#2dd4bf', '#f97316', '#a78bfa', '#f87171'];

export function seriesColor(i) {
  return PALETTE[i % PALETTE.length];
}

// Compact number formatting for the legend range hint.
function fmtRange(n) {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toLocaleString(undefined, { maximumFractionDigits: abs < 10 ? 2 : 1 });
}

// Rescale each series to 0..1 by its own min/max so mixed-magnitude tags (a
// temperature near 50 next to a speed near 1450) become shape-comparable on one
// axis instead of one flattening the other. Constant series sit at the midline.
// The raw [min, max] rides along on `range` for the legend.
function normalizeSeries(series) {
  return series.map((s) => {
    const vals = (s.points || []).map((p) => p[1]).filter((v) => Number.isFinite(v));
    if (!vals.length) return s;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min;
    const points = s.points.map(([t, v]) => [t, Number.isFinite(v) ? (span ? (v - min) / span : 0.5) : v]);
    return { ...s, points, range: [min, max] };
  });
}

function State({ icon: Icon, tone = 'slate', children }) {
  const color = tone === 'error' ? 'text-rose-400' : 'text-slate-500';
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <Icon size={22} className={tone === 'error' ? 'text-rose-400' : color} />
      <p className={`max-w-md text-xs ${tone === 'error' ? 'text-rose-300' : 'text-slate-500'}`}>{children}</p>
    </div>
  );
}

export default function TrendChart({ series = [], loading = false, error = '', height = 380, normalize = false }) {
  const totalPoints = series.reduce((n, s) => n + (s.points?.length || 0), 0);
  const state = error ? 'error' : loading && !totalPoints ? 'loading' : series.length === 0 ? 'empty' : totalPoints === 0 ? 'nodata' : 'chart';
  const plotted = normalize ? normalizeSeries(series) : series;

  return (
    <div>
      <div className="w-full" style={{ height }}>
        {state === 'error' && (
          <State icon={AlertTriangle} tone="error">
            {error}
          </State>
        )}
        {state === 'loading' && (
          <State icon={Loader2}>
            <span className="inline-flex items-center gap-1.5">Querying…</span>
          </State>
        )}
        {state === 'empty' && <State icon={LineIcon}>Pick a source and add tags to trend.</State>}
        {state === 'nodata' && <State icon={LineIcon}>No samples for these tags in this time range.</State>}
        {state === 'chart' && <TimeSeriesChart series={plotted} height={height} colorFor={seriesColor} />}
      </div>
      {state === 'chart' && series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {plotted.map((s, i) => (
            <span key={s.tag || i} className="flex items-center gap-1.5 text-2xs text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
              <span className="mono max-w-[220px] truncate">{s.tag}</span>
              {normalize && s.range && (
                <span className="text-slate-500">
                  {fmtRange(s.range[0])}&ndash;{fmtRange(s.range[1])}
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {state === 'chart' && normalize && (
        <p className="mt-1.5 text-2xs text-slate-500">Each series scaled to its own range (0&ndash;100%) so shapes compare directly; the legend shows real min&ndash;max.</p>
      )}
    </div>
  );
}
