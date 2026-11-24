import { useMemo, useRef, useState } from 'react';
import { Factory, Plug, LogOut, Search, LineChart, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Badge, Input, Field, EmptyState, Banner, LoadingState, Skeleton, PageBody, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
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

function isoDaysAgo(days) {
  // Build a SMIP-friendly timestamp without relying on Date.now at module load
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ') + '+00';
}

// Stable empty list so memo deps below don't change identity every render.
const NONE = [];

export default function Cesmii() {
  const { data: loadedStatus, error: statusError, loading: statusLoading, reload: reloadStatus } = usePolled(() => api.cesmiiStatus());
  const [localStatus, setStatus] = useState(null); // set by connect/disconnect; otherwise the loaded status applies
  const status = localStatus ?? loadedStatus;
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [samples, setSamples] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [range, setRange] = useState({ startTime: isoDaysAgo(7), endTime: isoDaysAgo(0), maxSamples: 100 });
  const rangeTouched = useRef(false); // an untouched range follows "now" each time history is (re)loaded
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
    if (busy || readOnly || !form.endpoint) return;
    setBusy(true);
    try {
      const s = await api.cesmiiConfig(form);
      setStatus(s);
      toast.success('Connected to CESMII SMIP');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect from CESMII SMIP?',
      message: 'The session credentials held by the server are discarded; you will need to enter them again to reconnect.',
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

  const loadHistory = async (attr) => {
    const req = (historyReq.current += 1); // only the latest request may write its result (a slow earlier one must not overwrite it)
    const r = rangeTouched.current ? range : { ...range, startTime: isoDaysAgo(7), endTime: isoDaysAgo(0) };
    setSelected(attr);
    setSamples(null);
    setHistoryError(null);
    if (!SMIP_TIME.test(r.startTime.trim()) || !SMIP_TIME.test(r.endTime.trim())) {
      setHistoryError(new Error('Start and End must be UTC timestamps like 2025-01-31 08:00:00+00.'));
      return;
    }
    if (!rangeTouched.current) setRange(r);
    try {
      const res = await api.cesmiiHistory({ ids: [attr.id], ...r });
      if (req === historyReq.current) setSamples(res.samples);
    } catch (e) {
      if (req === historyReq.current) setHistoryError(e);
    }
  };
  const editRange = (patch) => {
    rangeTouched.current = true;
    setRange((r) => ({ ...r, ...patch }));
  };

  const filteredAttributes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return attributes;
    return attributes.filter((a) => a.displayName?.toLowerCase().includes(q) || String(a.id).includes(q));
  }, [attributes, filter]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="CESMII SMIP"
        subtitle="Query equipment, attributes and time-series from the Smart Manufacturing Innovation Platform"
        actions={
          connected ? (
            <>
              <Badge status="connected">authenticated</Badge>
              <Button variant="outline" onClick={disconnect} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                <LogOut size={15} aria-hidden="true" /> Disconnect
              </Button>
            </>
          ) : (
            <Badge>not connected</Badge>
          )
        }
      />

      <PageBody>
        <ReadOnlyNote />
        {statusError && !status && (
          <Banner variant="error" title="Could not read the SMIP connection status" onRetry={reloadStatus}>
            {statusError.message}
          </Banner>
        )}
        {statusLoading && !status && !statusError && <LoadingState label="connection status" rows={2} />}

        {!connected && (status || statusError) && (
          <div className="mx-auto max-w-2xl">
            <Card className="p-4 sm:p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-orange-400 to-amber-600 shadow-lg">
                  <Factory size={20} className="text-white" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">Connect a SMIP instance</h2>
                  <p className="helper">Credentials are used server-side for the JWT handshake and are not stored on disk.</p>
                </div>
              </div>
              <form onSubmit={connect}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="GraphQL endpoint" className="sm:col-span-2">
                  <Input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://demo.cesmii.net/graphql" />
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
              <div className="mt-5 flex justify-end">
                <Button type="submit" disabled={busy || !form.endpoint || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                  <Plug size={15} aria-hidden="true" /> {busy ? 'Authenticating…' : 'Connect to SMIP'}
                </Button>
              </div>
              </form>
            </Card>
          </div>
        )}

        {connected && (
          <>
            {listError && (
              <Banner variant="error" title="Could not load equipment and attributes" onRetry={loadLists}>
                {listError.message}
              </Banner>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-slate-100">Equipment ({equipment.length})</h2>
                {equipment.length === 0 ? (
                  <p className="helper py-6 text-center">{listError ? 'Equipment could not be loaded.' : 'No equipment returned.'}</p>
                ) : (
                  <Table caption="Equipment" wrapperClassName="max-h-72 overflow-y-auto rounded-xl" className="min-w-0">
                    <THead>
                      <Th>Name</Th>
                      <Th align="right">ID</Th>
                    </THead>
                    <tbody>
                      {equipment.map((e) => (
                        <Tr key={e.id}>
                          <Td header className="py-2 text-slate-200">
                            {e.displayName}
                          </Td>
                          <Td align="right" className="mono py-2 text-xs text-muted">
                            #{e.id}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>

              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2 rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2">
                  <Search size={15} className="text-subtle" aria-hidden="true" />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter attributes"
                    placeholder={`Filter ${attributes.length} attributes…`}
                    className="w-full bg-transparent text-sm text-slate-200 placeholder:text-faint focus:outline-none"
                  />
                </div>
                {filteredAttributes.length === 0 ? (
                  <p className="helper py-6 text-center">{attributes.length === 0 ? 'No attributes returned.' : 'No attributes match the filter.'}</p>
                ) : (
                  <Table caption="Attributes — choose one to load its history" wrapperClassName="max-h-72 overflow-y-auto rounded-xl" className="min-w-0">
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
                              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-slate-200 hover:text-white"
                            >
                              <span className="truncate">{a.displayName}</span>
                              <LineChart size={13} className="shrink-0 text-muted" aria-hidden="true" />
                            </button>
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-slate-100">{selected ? selected.displayName : 'Time series'}</h2>
                <div className="mb-3 grid grid-cols-1 gap-2">
                  <Field label="Start (UTC)" help="Format 2025-01-31 08:00:00+00">
                    <Input value={range.startTime} onChange={(e) => editRange({ startTime: e.target.value })} />
                  </Field>
                  <Field label="End (UTC)">
                    <Input value={range.endTime} onChange={(e) => editRange({ endTime: e.target.value })} />
                  </Field>
                  {selected && (
                    <Button size="sm" variant="subtle" onClick={() => loadHistory(selected)}>
                      <RefreshCw size={13} aria-hidden="true" /> Reload
                    </Button>
                  )}
                </div>

                {!selected ? (
                  <EmptyState icon={LineChart} title="Pick an attribute" hint="Select an attribute to load its history." className="min-h-0 py-4" />
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
                  <p className="helper py-6 text-center">No samples in this range.</p>
                ) : (
                  <>
                    <Sparkline samples={samples} />
                    <Table caption="Most recent samples" wrapperClassName="mt-2 max-h-40 overflow-y-auto rounded-xl" className="min-w-0">
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
                              <Td className="whitespace-nowrap py-1.5 text-xs text-muted">{fmtTs(s.ts)}</Td>
                              <Td align="right" className="mono py-1.5 text-xs text-slate-200">
                                {s.floatvalue ?? s.stringvalue}
                              </Td>
                            </Tr>
                          ))}
                      </tbody>
                    </Table>
                  </>
                )}
              </Card>
            </div>
          </>
        )}
      </PageBody>
      {confirmDialog}
    </div>
  );
}

function Sparkline({ samples }) {
  const values = samples.map((s) => Number(s.floatvalue)).filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  return (
    <div className="rounded-lg border border-white/5 bg-surface-950/50 p-2">
      <ChartSparkline values={values} height={64} />
      <div className="mono mt-1 flex justify-between text-xs text-muted">
        <span>min {fmtNum(Math.min(...values))}</span>
        <span>max {fmtNum(Math.max(...values))}</span>
      </div>
    </div>
  );
}
