import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RotateCcw, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { latestOnly } from '@/lib/usePolled';
import { downloadText } from '@/lib/download';
import { Banner, Button, EmptyState, Field, Input, LoadingState, Select, StatusText, Table, THead, Th, Tr, Td, Toolbar } from '@/components/ui';
import { EMPTY_HISTORY_FILTERS, STATUS_LABEL, alertTone, formatBytes, hasHistoryFilters, historyQuery, severityView } from './helpers';

const PAGE = 100;
const STATE_OPTIONS = [
  { value: '', label: 'Any state' },
  { value: 'firing', label: 'Firing' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'ended', label: 'Ended (rule removed, restart)' },
  { value: 'event', label: 'Event (new topic)' }
];
const SEVERITY_OPTIONS = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' }
];

const when = (ts) => {
  const d = new Date(ts);
  return { text: d.toLocaleString(), title: `${d.toLocaleString()} (local) · ${d.toISOString()}` };
};

/** What happened (an acknowledgement's detail carries who and the note). */
function EventDetail({ e }) {
  return (
    <>
      <span className="line-clamp-2 block min-w-[12rem] break-words text-xs text-muted" title={e.detail}>
        {e.detail}
      </span>
    </>
  );
}

/**
 * Alarm history: every firing, resolution, acknowledgement and end, newest first, from the server's
 * durable journal (it survives restarts). Filters run on the server; pages load 100 at a time ("Load
 * older"); Export CSV downloads every matching event, not only the loaded pages. The first page follows
 * new events live while no older page has been loaded.
 */
export default function AlarmHistory({ rules }) {
  const [filters, setFilters] = useState(EMPTY_HISTORY_FILTERS);
  const [text, setText] = useState(''); // search box, applied after a pause
  const [state, setState] = useState({ events: [], nextCursor: null, loading: true, error: null, journal: null, more: false });
  const [exporting, setExporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false); // phones only
  const [gate] = useState(latestOnly);
  const pagedRef = useRef(false); // true once an older page is loaded: stop following live

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text ? f : { ...f, q: text })), 300);
    return () => clearTimeout(t);
  }, [text]);

  const loadFirst = useCallback(() => {
    const isCurrent = gate.next();
    pagedRef.current = false;
    Promise.resolve()
      .then(() => {
        if (isCurrent()) setState((s) => ({ ...s, loading: true }));
        return api.alertHistory(historyQuery(filters, { limit: PAGE }));
      })
      .then((r) => isCurrent() && setState({ events: r.events || [], nextCursor: r.nextCursor, journal: r.journal, loading: false, error: null, more: false }))
      .catch((error) => isCurrent() && setState((s) => ({ ...s, loading: false, error })));
  }, [filters, gate]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  // Live: a new event reloads the first page (throttled), unless the reader has paged back.
  useEffect(() => {
    let t = null;
    const onAlert = () => {
      if (pagedRef.current || t) return;
      t = setTimeout(() => {
        t = null;
        if (!pagedRef.current) loadFirst();
      }, 1000);
    };
    socket.on('alert', onAlert);
    return () => {
      socket.off('alert', onAlert);
      clearTimeout(t);
    };
  }, [loadFirst]);

  const loadOlder = () => {
    if (!state.nextCursor || state.more) return;
    const isCurrent = gate.next();
    pagedRef.current = true;
    setState((s) => ({ ...s, more: true }));
    api
      .alertHistory(historyQuery(filters, { limit: PAGE, cursor: state.nextCursor }))
      .then((r) => isCurrent() && setState((s) => ({ ...s, events: [...s.events, ...(r.events || [])], nextCursor: r.nextCursor, more: false, error: null })))
      .catch((error) => isCurrent() && setState((s) => ({ ...s, more: false, error })));
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await api.alertHistoryCsv(historyQuery(filters, { format: 'csv' }));
      downloadText(`manifold-alert-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, csv, 'text/csv');
    } catch (e) {
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const reset = () => {
    setText('');
    setFilters(EMPTY_HISTORY_FILTERS);
  };
  const filtered = hasHistoryFilters(filters);
  const activeFilterCount = ['ruleId', 'state', 'severity', 'from', 'to'].filter((k) => filters[k]).length;
  const ruleName = (id) => rules.find((r) => r.id === id)?.name;

  return (
    <div className="space-y-4">
      <Toolbar label="History filters" className="items-end">
        <Field label="Search" className="w-full sm:w-56">
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Rule, topic, detail, person" />
        </Field>
        {/* Phones: the other filters fold away behind one button so the results stay in view. */}
        <Button variant="secondary" className="sm:hidden" aria-expanded={showFilters} aria-controls="alert-history-filters" onClick={() => setShowFilters((v) => !v)}>
          <SlidersHorizontal size={14} aria-hidden="true" /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
        </Button>
        <div id="alert-history-filters" className={`${showFilters ? 'grid' : 'hidden'} w-full grid-cols-2 items-end gap-2 sm:flex sm:w-auto sm:flex-wrap`}>
          <Select label="Rule" fieldClassName="min-w-0 sm:w-48" value={filters.ruleId} onChange={(e) => set({ ruleId: e.target.value })}>
            <option value="">Any rule</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.type}
              </option>
            ))}
          </Select>
          <Select label="State" fieldClassName="min-w-0 sm:w-44" value={filters.state} onChange={(e) => set({ state: e.target.value })} options={STATE_OPTIONS} />
          <Select label="Severity" fieldClassName="min-w-0 sm:w-36" value={filters.severity} onChange={(e) => set({ severity: e.target.value })} options={SEVERITY_OPTIONS} />
          <span aria-hidden="true" className="sm:hidden" />
          <Field label="From" className="col-span-2 min-w-0 sm:w-52">
            <Input type="datetime-local" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="To" className="col-span-2 min-w-0 sm:w-52">
            <Input type="datetime-local" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={reset} disabled={!filtered && !text}>
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </Button>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} disabled={state.events.length === 0}>
            <Download size={14} aria-hidden="true" /> Export CSV
          </Button>
        </div>
      </Toolbar>

      {state.error && (
        <Banner variant="error" title="Could not load the alert history" onRetry={loadFirst}>
          {state.error.message}
        </Banner>
      )}
      {state.loading && state.events.length === 0 && !state.error && <LoadingState label="alert history" rows={4} />}

      {!state.loading && !state.error && state.events.length === 0 && (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState
            title={filtered ? 'No events match these filters' : 'No alert history yet'}
            hint={filtered ? 'Change or reset the filters.' : 'Every firing, resolution and acknowledgement is recorded here, and kept across restarts.'}
            action={
              filtered ? (
                <Button variant="secondary" onClick={reset}>
                  Reset filters
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {state.events.length > 0 && (
        <>
          <div className="hidden md:block">
            <Table caption="Alert history, newest first" className="min-w-[60rem]">
              <THead>
                <Th>When</Th>
                <Th>State</Th>
                <Th>Severity</Th>
                <Th>Rule</Th>
                <Th>Topic</Th>
                <Th align="right">Value</Th>
                <Th>Detail</Th>
              </THead>
              <tbody>
                {state.events.map((e) => {
                  const w = when(e.ts);
                  const sv = severityView(e.severity);
                  return (
                    <Tr key={e.seq} data-testid="history-row">
                      <Td className="whitespace-nowrap text-xs text-muted">
                        <span title={w.title}>{w.text}</span>
                      </Td>
                      <Td>
                        <StatusText tone={alertTone(e.status)}>{STATUS_LABEL[e.status] || e.status}</StatusText>
                      </Td>
                      <Td>
                        <StatusText tone={sv.tone}>{sv.label}</StatusText>
                      </Td>
                      <Td header className="min-w-[10rem] text-fg">
                        {e.ruleName || ruleName(e.ruleId) || e.ruleId}
                      </Td>
                      <Td className="mono max-w-[14rem] truncate text-xs text-muted" title={e.topic || ''}>
                        {e.topic || '—'}
                      </Td>
                      <Td align="right" className="mono tabular-nums text-xs">
                        {e.value ?? '—'}
                      </Td>
                      <Td>
                        <EventDetail e={e} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
          <ul className="space-y-2 md:hidden" aria-label="Alert history, newest first">
            {state.events.map((e) => {
              const w = when(e.ts);
              const sv = severityView(e.severity);
              return (
                <li key={e.seq} className="space-y-1 rounded-lg border border-line bg-panel p-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <StatusText tone={alertTone(e.status)}>{STATUS_LABEL[e.status] || e.status}</StatusText>
                    <StatusText tone={sv.tone} className="text-xs">
                      {sv.label}
                    </StatusText>
                  </div>
                  <p className="text-sm text-fg">{e.ruleName || ruleName(e.ruleId) || e.ruleId}</p>
                  {e.topic && <p className="mono break-all text-xs text-muted">{e.topic}</p>}
                  <p className="break-words text-xs text-muted">{e.detail}</p>
                  <p className="text-xs text-subtle" title={w.title}>
                    {w.text}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-subtle">
              {state.events.length.toLocaleString()} {state.events.length === 1 ? 'event' : 'events'} shown
              {state.journal && ` · history on disk ${formatBytes(state.journal.bytes)} of ${formatBytes(state.journal.maxBytes)}; the oldest events are dropped beyond that`}
              {state.journal?.writeErrors > 0 && ` · ${state.journal.writeErrors} write ${state.journal.writeErrors === 1 ? 'error' : 'errors'}`}
            </p>
            {state.nextCursor && (
              <Button variant="secondary" onClick={loadOlder} loading={state.more}>
                Load older
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
