import { TimeSeriesChart, fmtNum } from '@/components/charts';
import { Dialog, StatGroup, Stat } from '@/components/ui';

/** Full value-history chart of one topic (from the live message ring), as a Dialog. */
export default function HistoryChartModal({ topic, points, unit = '', onClose }) {
  const values = points.map((p) => p.v);
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const last = points[points.length - 1];
  const tspan = points[points.length - 1].ts - points[0].ts || 1;
  const durS = Math.max(1, Math.round(tspan / 1000));
  const durLabel = durS < 90 ? `${durS} s` : durS < 5400 ? `${Math.round(durS / 60)} min` : `${(durS / 3600).toFixed(1)} h`;
  const chartSeries = [{ tag: topic, unit, points: points.map((p) => [p.ts, p.v]) }];

  return (
    <Dialog title="Value history" description={`${topic} · last ${durLabel} · ${points.length} samples from the live message buffer`} onClose={onClose} size="xl">
      <StatGroup className="mb-4 grid-cols-2 sm:grid-cols-4" label="Summary">
        <Stat label="Last" value={fmtNum(last.v)} unit={unit} />
        <Stat label="Minimum" value={fmtNum(min)} unit={unit} />
        <Stat label="Maximum" value={fmtNum(max)} unit={unit} />
        <Stat label="Average" value={fmtNum(avg)} unit={unit} />
      </StatGroup>
      <TimeSeriesChart series={chartSeries} height={300} unit={unit} />
    </Dialog>
  );
}
