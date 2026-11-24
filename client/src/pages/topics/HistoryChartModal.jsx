import { X } from 'lucide-react';
import { TimeSeriesChart, fmtNum } from '@/components/charts';
import { Modal } from '@/components/ui';

const Stat = ({ label, value }) => (
  <div>
    <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
    <p className="mono text-sm font-semibold text-slate-100">{value}</p>
  </div>
);

export default function HistoryChartModal({ topic, points, onClose }) {
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const last = points[points.length - 1];
  const tspan = points[points.length - 1].ts - points[0].ts || 1;
  const durS = Math.max(1, Math.round(tspan / 1000));
  const durLabel = durS < 90 ? `${durS}s` : durS < 5400 ? `${Math.round(durS / 60)}m` : `${(durS / 3600).toFixed(1)}h`;
  const chartSeries = [{ tag: topic, points: points.map((p) => [p.ts, p.v]) }];

  return (
    <Modal title="Value history" onClose={onClose} className="max-w-3xl p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">Value history · last {durLabel}</p>
          <p className="mono truncate text-sm font-medium text-slate-100">{topic}</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200">
          <X size={16} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/5 bg-surface-950/40 p-3 sm:grid-cols-4">
        <Stat label="Last" value={fmtNum(last.v)} />
        <Stat label="Min" value={fmtNum(min)} />
        <Stat label="Max" value={fmtNum(max)} />
        <Stat label="Avg" value={fmtNum(avg)} />
      </div>
      <div className="mt-3 rounded-xl border border-white/5 bg-surface-950/40 p-2">
        <TimeSeriesChart series={chartSeries} height={280} />
        <div className="mono mt-1 px-1 text-center text-xs text-slate-400">{points.length} points · from the live message ring</div>
      </div>
    </Modal>
  );
}
