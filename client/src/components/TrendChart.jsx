import { useMemo } from 'react';
import { TimeSeriesChart, finiteExtent, fmtNum, useChartTheme } from './charts';
import { SERIES_DASH } from '@/graph/dataPalette';
import { Banner, EmptyState, LoadingState } from '@/components/ui';

/**
 * TrendChart — the Trends page's multi-series time chart. Thin wrapper over the
 * shared uPlot TimeSeriesChart so every chart in the app looks the same; adds
 * the loading / error / empty states, normalisation, the y-axis unit and a
 * persistent legend that stays readable with ten series (line sample with the
 * series' dash, tag, unit, and the raw range when normalised).
 *
 * `series`: [{ tag, unit?, points: [[tsMs, value, quality?], ...] }]
 */

/** Series colour for slot i in a chart theme (the data palette). */
export function seriesColor(i, theme) {
  return theme.palette[i % theme.palette.length];
}

// Rescale each series to 0..100 % of its own min/max so mixed-magnitude tags (a
// temperature near 50 next to a speed near 1450) become shape-comparable on one
// axis instead of one flattening the other. Constant series sit at the midline.
// The raw [min, max] rides along on `range` for the legend.
function normalizeSeries(series) {
  return series.map((s) => {
    const ext = finiteExtent((s.points || []).map((p) => p[1]));
    if (!ext) return s;
    const [min, max] = ext;
    const span = max - min;
    const points = s.points.map(([t, v, q]) => [t, Number.isFinite(v) ? (span ? ((v - min) / span) * 100 : 50) : v, q]);
    return { ...s, points, range: [min, max], unit: '%', rawUnit: s.unit };
  });
}

function LineSample({ color, dash }) {
  return (
    <svg width="22" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash ? dash.join(' ') : undefined} strokeLinecap="butt" />
    </svg>
  );
}

export default function TrendChart({ series = [], loading = false, error = '', height = 380, normalize = false, onRetry }) {
  const theme = useChartTheme();
  const totalPoints = series.reduce((n, s) => n + (s.points?.length || 0), 0);
  const state = error && !totalPoints ? 'error' : loading && !totalPoints ? 'loading' : series.length === 0 ? 'empty' : totalPoints === 0 ? 'nodata' : 'chart';
  const plotted = useMemo(() => (normalize ? normalizeSeries(series) : series), [normalize, series]);
  // One unit on the y axis when every series shares it; otherwise each legend
  // entry carries its own (and normalising is the way to compare them).
  const units = [...new Set(plotted.map((s) => s.unit || ''))];
  const axisUnit = normalize ? '% of range' : units.length === 1 ? units[0] : '';

  if (state === 'error') {
    return (
      <div className="grid place-items-center" style={{ height }}>
        <Banner variant="error" title="Could not load the series" onRetry={onRetry} className="max-w-lg">
          {error}
        </Banner>
      </div>
    );
  }
  if (state === 'loading') return <LoadingState label="series" rows={4} className="border-0" />;
  if (state === 'empty') return <EmptyState title="Nothing to chart yet" hint="Pick a source and add up to ten tags." className="min-h-0" />;
  if (state === 'nodata') {
    return (
      <div style={{ height }} className="grid place-items-center">
        <EmptyState title="No samples in this range" hint="None of these tags has numeric samples between the start and end of the range. Try a longer range." className="min-h-0" />
      </div>
    );
  }

  return (
    <div>
      {error && (
        <Banner variant="warn" title="Refresh failed, showing the last good data" onRetry={onRetry} className="mb-3">
          {error}
        </Banner>
      )}
      <TimeSeriesChart series={plotted} height={height} colorFor={seriesColor} unit={axisUnit} area={false} />
      {plotted.length > 0 && (
        <ul aria-label="Series" className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {plotted.map((s, i) => (
            <li key={s.tag || i} className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <LineSample color={seriesColor(i, theme)} dash={plotted.length > 1 ? SERIES_DASH[i] : null} />
              <span className="min-w-0 truncate font-mono text-fg" title={s.tag}>
                {s.tag}
              </span>
              {!normalize && s.unit && units.length > 1 && <span className="shrink-0 text-subtle">{s.unit}</span>}
              {normalize && s.range && (
                <span className="shrink-0 tabular-nums text-subtle">
                  {fmtNum(s.range[0])} to {fmtNum(s.range[1])}
                  {s.rawUnit ? ` ${s.rawUnit}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {normalize && <p className="mt-2 text-xs text-subtle">Each series is scaled to its own range (0 to 100 %) so shapes compare directly. The legend shows the real minimum and maximum.</p>}
    </div>
  );
}
