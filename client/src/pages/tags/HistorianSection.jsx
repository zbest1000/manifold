import { Link } from 'react-router-dom';
import clsx from 'clsx';
import ErrorBanner from './Banner';
import { historianReason } from './bindingView';

const help = 'text-xs leading-snug text-slate-400';
const TYPE_LABEL = { timebase: 'Timebase', timescaledb: 'TimescaleDB', influxdb: 'InfluxDB' };

/** Opt-in "also write history directly". Hidden (with a pointer) when no eligible historian exists. */
export default function HistorianSection({ historians, loaded, error, onRetry, form, set }) {
  if (error) return <ErrorBanner title="Could not load historians" message={error} onRetry={onRetry} />;
  if (!loaded) return <p className={help}>Loading historians...</p>;
  const eligible = (historians || []).filter((h) => !historianReason(h));
  if (!eligible.length) {
    return (
      <p className={help}>
        Direct history is not available: no Timebase or TimescaleDB historian is configured.{' '}
        <Link to="/pipelines" className="text-accent-300 underline">Configure historians under Pipelines</Link>.
      </p>
    );
  }
  const on = Boolean(form.historianId);
  return (
    <fieldset className="space-y-2 rounded-xl border border-white/10 px-3 py-2.5">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">History</legend>
      <label className="flex items-start gap-2 text-sm text-slate-100">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => set({ historianId: e.target.checked ? eligible[0].id : '' })}
          className="mt-1 accent-accent-500"
        />
        <span>
          Also write history directly
          <span className={clsx(help, 'block')}>
            The broker publish always happens. This adds store-and-forward history that survives a broker outage.
          </span>
        </span>
      </label>
      {on && (
        <div role="radiogroup" aria-label="Historian" className="space-y-1 pl-6">
          {historians.map((h) => {
            const reason = historianReason(h);
            return (
              <label key={h.id} className={clsx('flex items-start gap-2 text-sm', reason ? 'cursor-not-allowed text-slate-500' : 'cursor-pointer text-slate-100')}>
                <input
                  type="radio"
                  name="historian"
                  value={h.id}
                  checked={form.historianId === h.id}
                  disabled={Boolean(reason)}
                  onChange={() => set({ historianId: h.id })}
                  className="mt-1 accent-accent-500"
                />
                <span>
                  {h.name || h.id} <span className="text-xs text-slate-400">({TYPE_LABEL[h.type] || h.type})</span>
                  {reason && <span className="block text-xs">{reason}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
