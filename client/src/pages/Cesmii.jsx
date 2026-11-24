import { useMemo, useRef, useState } from 'react';
import { LogOut, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Banner, Input, Field, LoadingState, Skeleton, PageBody, Panel, SegmentedControl, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { Sparkline as ChartSparkline, fmtNum } from '@/components/charts';
import PageHeader from '@/components/PageHeader';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';

const BLANK = { endpoint: '', authenticator: '', role: '', userName: '', secret: '' };

// SMIP expects 'YYYY-MM-DD HH:MM:SS+00' (UTC).
const SMIP_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

// 'YYYY-MM-DD HH:MM:SS.mmm+00' -> 'YYYY-MM-DD HH:MM:SS' (UTC): short enough that the Value column stays in view.
function fmtTs(ts) {
  const d = new Date(String(ts).replace(' ', 'T').replace(/\+00(:?00)?$/, 'Z'));
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 19).replace('T', ' ');
}
// Same instant in the viewer's own time zone, for the tooltip.
const localTs = (ts) => {
  const d = new Date(String(ts).replace(' ', 'T').replace(/\+00(:?00)?$/, 'Z'));
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleString()} local`;
};

const smipTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + '+00';
/** A SMIP timestamp `agoMs` before now (0 = now). Kept outside the component so render stays pure. */
const smipAgo = (agoMs) => smipTime(Date.now() - agoMs);

const PRESETS = [
  { value: '1h', label: '1 h', ms: 3600e3 },
  { value: '24h', label: '24 h', ms: 24 * 3600e3 },
  { value: '7d', label: '7 d', ms: 7 * 24 * 3600e3 },
  { value: 'custom', label: 'Custom' }
];

/** "UTC+02:00" for this browser, so a UTC input can be read against local time. */
function utcOffsetLabel() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const fmtValue = (s) => {
  if (s.floatvalue !== null && s.floatvalue !== undefined && s.floatvalue !== '') {
    const n = Number(s.floatvalue);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(s.floatvalue);
  }
  return s.stringvalue ?? '';
};

// Stable empty list so memo deps below don't change identity every render.
const NONE = [];

export default function Cesmii() {
  const { data: loadedStatus, error: statusError, loading: statusLoading, reload: reloadStatus } = usePolled(() => api.cesmiiStatus());
  const [localStatus, setStatus] = useState(null); // set by connect/disconnect; otherwise the loaded status applies
  const status = localStatus ?? loadedStatus;
  const [form, setForm] = useState(BLANK);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [samples, setSamples] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [preset, setPreset] = useState('7d');
  const [range, setRange] = useState({ startTime: smipAgo(7 * 24 * 3600e3), endTime: smipAgo(0), maxSamples: 100 });
  const historyReq = useRef(0);
  const readOnly = useReadOnly();
  const [confirm, confirmDialog] = useConfirm();

  const connected = Boolean(status?.configured && status?.authenticated);

  // Equipment and attributes load once authenticated (and again on Retry).
  const lists = usePolled(
    async () => {
      if (!connected) return null;
      const [eq, at] = await Promise.all([api.cesmiiEquipment(), api.cesmiiAttributes()]);
      return { equipment: eq.equipment, attributes: at.attributes };
    },
    { deps: [connected] }
  );
  const equipment = (connected && lists.data?.equipment) || NONE;
  const attributes = (connected && lists.data?.attributes) || NONE;
  const listError = connected ? lists.error : null;
  const loadLists = lists.reload;

  const connect = async (e) => {
    e?.preventDefault();
    if (busy || readOnly) return;
    setAttempted(true);
    if (!form.endpoint.trim()) return;
    setBusy(true);
    setConnectError(null);
    try {
      const s = await api.cesmiiConfig(form);
      setStatus(s);
      toast.success('Connected to CESMII SMIP');
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect from CESMII SMIP?',
      message: 'The credentials the server holds for this session are discarded. You will need to enter them again to reconnect.',
      confirmLabel: 'Disconnect',
      danger: true
    });
    if (!ok) return;
    try {
      setStatus(await api.cesmiiReset());
      setSelected(null);
      setSamples(null);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const loadHistory = async (attr, usePreset = preset) => {
    const req = (historyReq.current += 1); // only the latest request may write its result (a slow earlier one must not overwrite it)
    const p = PRESETS.find((x) => x.value === usePreset);
    const r = p?.ms ? { ...range, startTime: smipAgo(p.ms), endTime: smipAgo(0) } : range; // a preset follows "now" each time it loads
    setSelected(attr);
    setSamples(null);
    setHistoryError(null);
    if (!SMIP_TIME.test(r.startTime.trim()) || !SMIP_TIME.test(r.endTime.trim())) {
      setHistoryError(new Error('From and To must be UTC timestamps like 2025-01-31 08:00:00+00.'));
      return;
    }
    if (p?.ms) setRange(r);
    try {
      const res = await api.cesmiiHistory({ ids: [attr.id], ...r });
      if (req === historyReq.current) setSamples(res.samples);
    } catch (e) {
      if (req === historyReq.current) setHistoryError(e);
    }
  };
  const editRange = (patch) => {
    setPreset('custom');
    setRange((r) => ({ ...r, ...patch }));
  };
  const pickPreset = (v) => {
    setPreset(v);
    if (selected && v !== 'custom') loadHistory(selected, v);
  };

  const filteredAttributes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return attributes;
    return attributes.filter((a) => a.displayName?.toLowerCase().includes(q) || String(a.id).includes(q));
  }, [attributes, filter]);

  const numeric = (samples || []).filter((s) => Number.isFinite(Number(s.floatvalue)) && s.floatvalue !== null);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="CESMII SMIP"
        subtitle={connected ? `Authenticated to ${status.endpoint}${status.userName ? ` as ${status.userName}` : ''}` : 'Not connected'}
        actions={
          connected && (
            <Button variant="secondary" onClick={disconnect} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
              <LogOut size={14} aria-hidden="true" /> Disconnect
            </Button>
          )
        }
      />

      <PageBody>
        <ReadOnlyNote className="" />
        {statusError && !status && (
          <Banner variant="error" title="Could not read the SMIP connection status" onRetry={reloadStatus}>
            {statusError.message}
          </Banner>
        )}
        {statusLoading && !status && !statusError && <LoadingState label="connection status" rows={2} />}

        {!connected && (status || statusError) && (
          <div className="max-w-2xl">
            <Panel title="Connect to a SMIP instance" description="Query equipment, attributes and time series from the Smart Manufacturing Innovation Platform.">
              <form onSubmit={connect} noValidate className="space-y-4">
                <Banner variant="info">Credentials are used on the server for the JWT handshake and are not written to disk. They are forgotten when the server restarts.</Banner>
                {connectError && (
                  <Banner variant="error" title="Could not connect">
                    {connectError}
                  </Banner>
                )}
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="GraphQL endpoint" className="sm:col-span-2" error={attempted && !form.endpoint.trim() ? 'Enter the SMIP GraphQL endpoint.' : undefined}>
                    <Input className="mono" aria-invalid={attempted && !form.endpoint.trim() ? 'true' : undefined} value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://demo.cesmii.net/graphql" />
                  </Field>
                  <Field label="Authenticator">
                    <Input value={form.authenticator} onChange={(e) => setForm({ ...form, authenticator: e.target.value })} />
                  </Field>
                  <Field label="Role">
                    <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
                  </Field>
                  <Field label="User name">
                    <Input value={form.userName} onChange={(e) => setForm({ ...form, userName: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="Secret / API key">
                    <Input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} autoComplete="new-password" />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" loading={busy} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                    Connect to SMIP
                  </Button>
                </div>
              </form>
            </Panel>
          </div>
        )}

        {connected && (
          <>
            {listError && (
              <Banner variant="error" title="Could not load equipment and attributes" onRetry={loadLists}>
                {listError.message}
              </Banner>
            )}
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
              <Panel title="Equipment" count={equipment.length} flush>
                {equipment.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">{listError ? 'Equipment could not be loaded.' : 'The server returned no equipment.'}</p>
                ) : (
                  <Table caption="Equipment" wrapperClassName="max-h-96 overflow-y-auto rounded-none border-0" className="!min-w-0">
                    <THead>
                      <Th>Name</Th>
                      <Th align="right">ID</Th>
                    </THead>
                    <tbody>
                      {equipment.map((e) => (
                        <Tr key={e.id}>
                          <Td header className="text-fg">
                            {e.displayName}
                          </Td>
                          <Td align="right" className="mono text-xs tabular-nums text-muted">
                            {e.id}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Panel>

              <Panel title="Attributes" count={attributes.length} flush>
                <div className="relative border-b border-line p-2">
                  <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
                  <Input aria-label="Filter attributes" className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${attributes.length.toLocaleString()} attributes…`} />
                </div>
                {filteredAttributes.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">{attributes.length === 0 ? 'The server returned no attributes.' : 'No attributes match the filter.'}</p>
                ) : (
                  <Table caption="Attributes: choose one to load its history" wrapperClassName="max-h-80 overflow-y-auto rounded-none border-0" className="!min-w-0">
                    <THead>
                      <Th>Attribute</Th>
                    </THead>
                    <tbody>
                      {filteredAttributes.map((a) => (
                        <Tr key={a.id} highlight={selected?.id === a.id}>
                          <Td header className="p-0">
                            <button
                              type="button"
                              onClick={() => loadHistory(a)}
                              aria-pressed={selected?.id === a.id}
                              className="block w-full truncate px-3 py-2 text-left text-fg transition-colors hover:text-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--focus))]"
                            >
                              {a.displayName}
                            </button>
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Panel>

              <Panel title={selected ? selected.displayName : 'Time series'} description={selected ? `Attribute ${selected.id}` : undefined}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SegmentedControl label="Time range" size="sm" options={PRESETS} value={preset} onChange={pickPreset} />
                    {selected && (
                      <Button size="sm" variant="secondary" onClick={() => loadHistory(selected)}>
                        Reload
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <Field label="From (UTC)">
                      <Input className="mono" value={range.startTime} onChange={(e) => editRange({ startTime: e.target.value })} />
                    </Field>
                    <Field label="To (UTC)">
                      <Input className="mono" value={range.endTime} onChange={(e) => editRange({ endTime: e.target.value })} />
                    </Field>
                  </div>
                  <p className="text-xs text-subtle">
                    Times are UTC, written like 2025-01-31 08:00:00+00. This browser is on {utcOffsetLabel()}. Choose Custom to type your own range.
                  </p>

                  {!selected ? (
                    <p className="py-4 text-center text-sm text-muted">Pick an attribute to load its history.</p>
                  ) : historyError ? (
                    <Banner variant="error" title="Could not load history" onRetry={() => loadHistory(selected)}>
                      {historyError.message}
                    </Banner>
                  ) : samples === null ? (
                    <div role="status" aria-busy="true" className="space-y-2">
                      <span className="sr-only">Loading history…</span>
                      <Skeleton className="h-16 w-full" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  ) : samples.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted">No samples in this range.</p>
                  ) : (
                    <>
                      {numeric.length > 1 && <Sparkline values={numeric.map((s) => Number(s.floatvalue))} />}
                      <p className="text-xs text-muted">
                        <span className="tabular-nums text-fg">{samples.length.toLocaleString()}</span> samples, showing the latest {Math.min(40, samples.length)}
                      </p>
                      <Table caption="Most recent samples" wrapperClassName="max-h-52 overflow-y-auto" className="!min-w-0">
                        <THead>
                          <Th>Time (UTC)</Th>
                          <Th align="right">Value</Th>
                        </THead>
                        <tbody>
                          {samples
                            .slice(-40)
                            .reverse()
                            .map((s, i) => (
                              <Tr key={i}>
                                <Td className="mono whitespace-nowrap py-1.5 text-xs tabular-nums text-muted" title={localTs(s.ts)}>
                                  {fmtTs(s.ts)}
                                </Td>
                                <Td align="right" className="mono py-1.5 text-xs tabular-nums text-fg">
                                  {fmtValue(s)}
                                </Td>
                              </Tr>
                            ))}
                        </tbody>
                      </Table>
                    </>
                  )}
                </div>
              </Panel>
            </div>
          </>
        )}
      </PageBody>
      {confirmDialog}
    </div>
  );
}

function Sparkline({ values }) {
  return (
    <div className="rounded-md border border-line bg-app p-2">
      <ChartSparkline values={values} height={64} />
      <div className="mono mt-1 flex justify-between text-xs tabular-nums text-muted">
        <span>min {fmtNum(Math.min(...values))}</span>
        <span>max {fmtNum(Math.max(...values))}</span>
      </div>
    </div>
  );
}
