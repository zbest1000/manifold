import { useMemo } from 'react';
import { TimeSeriesChart, fmtNum, useChartTheme } from './charts';
import { normalizeSeries, pointState, shortTag, unitLayout } from './chartMath';
import { SERIES_DASH } from '@/graph/dataPalette';
import { Banner, EmptyState, LoadingState } from '@/components/ui';

/**
 * TrendChart — the Trends page's multi-series time chart. Thin wrapper over the
 * shared uPlot TimeSeriesChart so every chart in the app looks the same; adds
 * the loading / error / empty states, the unit story, the quality key and a
 * persistent legend that stays readable with ten series (line sample with the
 * series' dash, tag, unit, and the raw range when normalised).
 *
 * Units (chartMath.unitLayout): one unit = one labelled axis; two units = a left
 * and a right axis; three or more = normalised (each series 0 to 100 % of its
 * own range), forced on with a note because no shared axis would be honest.
 * The readout always shows the real value with its unit.
 *
 * `series`: [{ tag, unit?, points: [[tsMs, value, quality?, partial?], ...] }]
 * `meta`:   the reader's quality metadata ({ quality: 'stored' | 'unavailable', qualityNote }).
 */

/** Series colour for slot i in a chart theme (the data palette). */
export function seriesColor(i, theme) {
  return theme.palette[i % theme.palette.length];
}

function LineSample({ color, dash }) {
  return (
    <svg width="22" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash ? dash.join(' ') : undefined} strokeLinecap="butt" />
    </svg>
  );
}

function qualityCounts(s) {
  let bad = 0;
  let partial = 0;
  for (const p of s.points || []) {
    const st = pointState(p);
    if (st === 'bad') bad++;
    else if (st === 'partial') partial++;
  }
  return { bad, partial };
}

export default function TrendChart({ series = [], loading = false, error = '', height = 380, normalize = false, meta = null, onRetry }) {
  const theme = useChartTheme();
  const totalPoints = series.reduce((n, s) => n + (s.points?.length || 0), 0);
  const state = error && !totalPoints ? 'error' : loading && !totalPoints ? 'loading' : series.length === 0 ? 'empty' : totalPoints === 0 ? 'nodata' : 'chart';
  const layout = useMemo(() => unitLayout(series, { normalize }), [series, normalize]);
  const plotted = useMemo(() => (layout.mode === 'normalize' ? normalizeSeries(series) : series), [layout.mode, series]);
  const counts = useMemo(() => series.map(qualityCounts), [series]);
  const anyBad = counts.some((c) => c.bad);
  const anyPartial = counts.some((c) => c.partial);
  const single = layout.mode === 'single' ? layout.groups[0] || '' : '';

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
    <div data-testid="trend-chart" data-axis-mode={layout.mode}>
      {error && (
        <Banner variant="warn" title="Refresh failed, showing the last good data" onRetry={onRetry} className="mb-3">
          {error}
        </Banner>
      )}
      {layout.forced && (
        <p role="status" className="mb-2 text-xs text-muted">
          These tags use {layout.groups.length} different units ({layout.groups.map((g) => g || 'no unit').join(', ')}), so each is scaled to its own range. The readout and legend show the real values.
        </p>
      )}
      <TimeSeriesChart series={plotted} height={height} colorFor={seriesColor} unit={single} layout={layout} area={false} testHook="trendChart" />
      {plotted.length > 0 && (
        <ul aria-label="Series" className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {plotted.map((s, i) => {
            const unit = layout.mode === 'normalize' ? s.rawUnit : s.unit;
            const c = counts[i] || { bad: 0, partial: 0 };
            return (
              <li key={s.tag || i} className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <LineSample color={seriesColor(i, theme)} dash={plotted.length > 1 ? SERIES_DASH[i] : null} />
                <span className="min-w-0 truncate font-mono text-fg" title={s.tag}>
                  {shortTag(s.tag, 40)}
                </span>
                <span className="shrink-0 text-subtle">
                  {unit || 'no unit'}
                  {layout.mode === 'dual' ? (layout.scaleOf[i] === 'y2' ? ' · right axis' : ' · left axis') : ''}
                </span>
                {layout.mode === 'normalize' && s.range && (
                  <span className="shrink-0 tabular-nums text-subtle">
                    {fmtNum(s.range[0])} to {fmtNum(s.range[1])}
                  </span>
                )}
                {(c.bad > 0 || c.partial > 0) && (
                  <span className="shrink-0 tabular-nums text-bad">
                    {c.bad > 0 ? `${c.bad.toLocaleString()} Bad` : ''}
                    {c.bad > 0 && c.partial > 0 ? ', ' : ''}
                    {c.partial > 0 ? <span className="text-warn">{c.partial.toLocaleString()} partial</span> : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(anyBad || anyPartial || meta?.quality === 'unavailable') && (
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle" data-testid="quality-key">
          {anyBad && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="9" aria-hidden="true">
                <path d="M5 0.5 L9.5 8.5 L0.5 8.5 Z" fill={theme.bad} />
              </svg>
              Bad quality: not plotted, the line breaks
            </span>
          )}
          {anyPartial && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden="true">
                <path d="M5 1 L9 5 L5 9 L1 5 Z" fill="none" stroke={theme.warn} strokeWidth="1.5" />
              </svg>
              Partial: some samples in this interval were Bad; the line shows the average of the rest
            </span>
          )}
          {meta?.quality === 'unavailable' && <span>{meta.qualityNote || 'This source stores no quality, so Bad values cannot be marked.'}</span>}
        </p>
      )}
      {layout.mode === 'normalize' && !layout.forced && <p className="mt-2 text-xs text-subtle">Each series is scaled to its own range (0 to 100 %) so shapes compare directly. The legend shows the real minimum and maximum.</p>}
    </div>
  );
}
