import { ScrollText, X, Trash2, Filter } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { Tooltip, Modal, StatusDot } from './ui';

const LEVELS = ['error', 'warning', 'info', 'verbose'];
const LEVEL_TONE = { error: 'bad', warning: 'warn', info: 'info', verbose: 'neutral' };
const LEVEL_TEXT = { error: 'text-bad', warning: 'text-warn', info: 'text-info', verbose: 'text-muted' };

function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function Empty({ title, hint }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="max-w-xs text-sm text-muted">{hint}</p>
    </div>
  );
}

/** Persistent, leveled, filterable log. Opened from the sidebar or from a
 *  broker's error count (scoped to that broker). Open state lives in the store. */
export default function ErrorLog({ collapsed = false }) {
  const logs = useStore((s) => s.logs);
  const unseen = useStore((s) => s.unseen);
  const logFilters = useStore((s) => s.logFilters);
  const logOpen = useStore((s) => s.logOpen);
  const logBrokerFilter = useStore((s) => s.logBrokerFilter);
  const brokers = useStore((s) => s.brokers);
  const openLog = useStore((s) => s.openLog);
  const closeLog = useStore((s) => s.closeLog);
  const clearLogs = useStore((s) => s.clearLogs);
  const clearBrokerFilter = useStore((s) => s.clearBrokerFilter);
  const toggleLogFilter = useStore((s) => s.toggleLogFilter);

  const counts = LEVELS.reduce((acc, lv) => ({ ...acc, [lv]: 0 }), {});
  for (const l of logs) counts[l.level] = (counts[l.level] || 0) + 1;

  const visible = logs.filter(
    (l) => logFilters[l.level] && (!logBrokerFilter || l.meta?.brokerId === logBrokerFilter)
  );
  const filterBrokerName = logBrokerFilter
    ? brokers.find((b) => b.id === logBrokerFilter)?.name || logBrokerFilter
    : null;

  // The idle badge counts what the level chips count; verbose success lines
  // (every publish/subscribe) would otherwise show a number next to chips reading 0.
  const badge = unseen > 0 ? unseen : logs.filter((l) => l.level !== 'verbose').length;

  return (
    <>
      {collapsed ? (
        <Tooltip label={unseen > 0 ? `Log — ${unseen} new` : 'Event log'} side="right">
          <button
            onClick={() => openLog()}
            aria-label="View the event log"
            className={clsx(
              'relative grid h-8 w-8 place-items-center rounded-md transition-colors',
              unseen > 0 ? 'text-bad hover:bg-raised' : 'text-muted hover:bg-raised hover:text-fg'
            )}
          >
            <ScrollText size={16} aria-hidden="true" />
            {unseen > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-bad" />}
          </button>
        </Tooltip>
      ) : (
        <button
          onClick={() => openLog()}
          className={clsx(
            'flex h-8 w-full items-center justify-between rounded-md px-2.5 text-muted transition-colors hover:bg-raised hover:text-fg'
          )}
        >
          <span className="flex items-center gap-2.5 text-sm">
            <ScrollText size={16} aria-hidden="true" className="text-subtle" />
            Logs
          </span>
          <span className={clsx('flex items-center gap-1.5 text-xs tabular-nums', unseen > 0 ? 'font-medium text-bad' : 'text-subtle')}>
            {unseen > 0 && <StatusDot tone="bad" size={6} />}
            {unseen > 0 ? `${badge} new` : badge}
          </span>
        </button>
      )}

      {logOpen && (
        <Modal placement="right" title="Event log" onClose={closeLog} className="flex w-full max-w-md flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium text-fg">Log</h2>
          <span className="text-xs tabular-nums text-subtle">{logs.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearLogs}
            disabled={logs.length === 0}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
          >
            <Trash2 size={13} aria-hidden="true" /> Clear
          </button>
          <button
            onClick={closeLog}
            className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg"
            aria-label="Close log"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Broker scope (set when opened from a broker's error count) */}
      {logBrokerFilter && (
        <div className="flex items-center gap-2 border-b border-line bg-raised px-4 py-2 text-xs text-muted">
          <Filter size={12} aria-hidden="true" className="text-subtle" />
          <span>
            Filtered to <span className="font-medium text-fg">{filterBrokerName}</span>
          </span>
          <button
            onClick={clearBrokerFilter}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-panel hover:text-fg"
          >
            <X size={11} aria-hidden="true" /> clear
          </button>
        </div>
      )}

      {/* Level filter — persisted. Click a level to show/hide it. */}
      <div className="flex flex-wrap gap-1 border-b border-line px-4 py-2">
        {LEVELS.map((lv) => (
          <button
            key={lv}
            onClick={() => toggleLogFilter(lv)}
            aria-pressed={logFilters[lv]}
            className={clsx(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs capitalize transition-colors',
              logFilters[lv] ? 'border-line-strong bg-raised text-fg' : 'border-transparent text-subtle hover:text-fg'
            )}
          >
            <StatusDot tone={logFilters[lv] ? LEVEL_TONE[lv] : 'neutral'} size={6} />
            {lv} <span className="tabular-nums text-subtle">{counts[lv]}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {logs.length === 0 ? (
          <Empty
            title="No activity logged"
            hint="Failures, connections, and subscribe/publish events show up here."
          />
        ) : visible.length === 0 ? (
          <Empty
            title="Nothing matches"
            hint={logBrokerFilter ? 'No entries for this broker at the enabled levels.' : 'Enable a level above to see entries.'}
          />
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((e) => (
              <li key={e.id} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className={clsx('inline-flex items-center gap-1.5 text-xs font-medium capitalize', LEVEL_TEXT[e.level] || LEVEL_TEXT.verbose)}>
                      <StatusDot tone={LEVEL_TONE[e.level] || 'neutral'} size={6} />
                      {e.level}
                    </span>
                    <span className="mono text-2xs text-subtle">{e.source}</span>
                    {e.meta?.code && <span className="mono rounded border border-line px-1 text-2xs text-muted">{e.meta.code}</span>}
                    {e.count > 1 && <span className="mono text-2xs text-muted">×{e.count}</span>}
                  </span>
                  <span className="mono shrink-0 text-xs text-subtle">{relTime(e.ts)}</span>
                </div>
                <p className="mt-1 break-words text-sm text-fg">{e.message}</p>
                {e.meta?.hint && <p className="mt-0.5 text-xs text-muted">{e.meta.hint}</p>}
                {(e.meta?.topic || e.meta?.path) && (
                  <p className="mono mt-1 truncate text-xs text-subtle">
                    {e.meta.path || e.meta.topic}
                  </p>
                )}
                {e.meta?.raw && e.meta.raw !== e.message && (
                  <p className="mono mt-1 break-all text-xs text-subtle" title={e.meta.raw}>
                    {e.meta.raw}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
        </Modal>
      )}
    </>
  );
}
