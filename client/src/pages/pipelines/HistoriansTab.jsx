import { useCallback, useState } from 'react';
import { Database, Plus, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Input, Textarea, Field, Select, Checkbox, Badge, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { useEngineMetrics } from './hooks';
import { ListState } from './shared';
import { RowActions } from '@/components/ui';
import { BLANK_HISTORIAN, historianFormFrom, historianPayload, historianSaveDisabled, historianSummary, outboxSummary } from './helpers';

function Outbox({ o }) {
  const s = outboxSummary(o);
  if (!s) return null;
  return (
    <p className="mt-0.5 text-xs">
      <span className="text-subtle">store-and-forward: </span>
      <span className="font-mono text-muted">
        {s.written} written · {s.queued} queued
        {s.spilledKb && <span className="text-amber-300"> · {s.spilledKb} KB spilled to disk</span>}
        {s.dropped && <span className="text-rose-300"> · {s.dropped} dropped</span>}
      </span>
      {s.lastError && <span className="ml-1 text-rose-300">· {s.lastError}</span>}
    </p>
  );
}

export default function HistoriansTab() {
  const [outbox, setOutbox] = useState({});
  const [form, setForm] = useState(BLANK_HISTORIAN);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testing, setTesting] = useState(null); // { id, state, error }
  const [confirm, confirmDialog] = useConfirm();
  const { data, error, loading, reload } = usePolled(() => api.listHistorians());
  useEngineMetrics(useCallback((m) => m.outbox && setOutbox(m.outbox), []));

  const historians = data?.historians || [];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const closeForm = () => {
    setEditingId(null);
    setForm(BLANK_HISTORIAN);
    setShowForm(false);
  };

  const save = async () => {
    try {
      await api.saveHistorian(historianPayload(form, editingId));
      closeForm();
      reload();
      toast.success('Historian saved');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const edit = (h) => {
    setForm(historianFormFrom(h));
    setEditingId(h.id);
    setShowForm(true);
  };

  const remove = async (h) => {
    const ok = await confirm({
      title: `Remove historian "${h.name || h.url}"?`,
      message: 'This deletes the stored connection, including its credentials. Data already written to the database is not affected.',
      confirmLabel: 'Remove historian',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteHistorian(h.id);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const test = async (id) => {
    setTesting({ id, state: 'running' });
    try {
      await api.testHistorian(id);
      setTesting({ id, state: 'ok' });
    } catch (e) {
      setTesting({ id, state: 'fail', error: e.message });
    }
  };

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={historians.length}
        label="historians"
        empty={
          showForm
            ? null
            : {
                icon: Database,
                title: 'No historians configured',
                hint: 'A historian is a time-series database (InfluxDB, TimescaleDB, Timebase) that routes and the recorder write into, and that Trends reads back.',
                action: (
                  <Button onClick={() => setShowForm(true)}>
                    <Plus size={15} aria-hidden="true" /> Add a historian
                  </Button>
                )
              }
        }
      >
        <Table caption="Historian connections">
          <THead>
            <Th>Historian</Th>
            <Th>Connection</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {historians.map((h) => {
              const name = h.name || h.url;
              const running = testing?.id === h.id && testing.state === 'running';
              return (
                <Tr key={h.id} highlight={editingId === h.id}>
                  <Td header>
                    <span className="block max-w-[14rem] truncate text-slate-100">{name}</span>
                    <Badge className="mt-1">{h.type}</Badge>
                  </Td>
                  <Td className="max-w-[26rem]">
                    <p className="truncate font-mono text-xs text-muted">{historianSummary(h)}</p>
                    <Outbox o={outbox[h.id]} />
                    {testing?.id === h.id && testing.state === 'ok' && (
                      <p role="status" className="mt-1 flex items-center gap-1 text-xs text-emerald-300">
                        <CheckCircle2 size={13} aria-hidden="true" /> Test write succeeded
                      </p>
                    )}
                    {testing?.id === h.id && testing.state === 'fail' && (
                      <p role="alert" className="mt-1 flex items-center gap-1 text-xs text-rose-300">
                        <AlertTriangle size={13} aria-hidden="true" /> {testing.error}
                      </p>
                    )}
                  </Td>
                  <Td align="right">
                    <RowActions what={`historian ${name}`} onEdit={() => edit(h)} onDelete={() => remove(h)}>
                      <Button size="sm" variant="outline" onClick={() => test(h.id)} disabled={running} aria-label={`Test write to ${name}`}>
                        <RefreshCw size={12} aria-hidden="true" className={clsx(running && 'animate-spin')} /> Test write
                      </Button>
                    </RowActions>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      {!showForm && historians.length > 0 && (
        <Button variant="outline" onClick={() => setShowForm(true)}>
          <Plus size={14} aria-hidden="true" /> Add historian
        </Button>
      )}

      {showForm && (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-100">{editingId ? 'Edit historian' : 'Add historian'}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select label="Type" value={form.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="influxdb">InfluxDB v2</option>
              <option value="timebase">Timebase historian (Flow Software)</option>
              <option value="timescaledb">TimescaleDB / PostgreSQL</option>
            </Select>
            <Field label="Name">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="plant historian" />
            </Field>
            <Select label="When offline buffer is full" value={form.dropPolicy} onChange={(e) => set({ dropPolicy: e.target.value })}>
              <option value="newest">Drop newest (keep outage start)</option>
              <option value="oldest">Drop oldest (keep latest data)</option>
            </Select>
            {form.type !== 'timescaledb' && (
              <Field label="URL" className="sm:col-span-2">
                <Input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder={form.type === 'influxdb' ? 'http://influx-host:8086' : 'http://historian-host:4511'} />
              </Field>
            )}
            {form.type === 'timescaledb' && (
              <>
                <Field label="Host">
                  <Input value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="tsdb-host" />
                </Field>
                <Field label="Port">
                  <Input value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="5432" />
                </Field>
                <Field label="Database">
                  <Input value={form.database} onChange={(e) => set({ database: e.target.value })} />
                </Field>
                <Field label="User">
                  <Input value={form.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Password">
                  <Input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={editingId ? 'unchanged' : undefined} />
                </Field>
                <Field label="Table (optional)">
                  <Input value={form.table} onChange={(e) => set({ table: e.target.value })} placeholder="manifold_samples" />
                </Field>
                <div className="flex items-end pb-2">
                  <Checkbox label="SSL" checked={form.ssl} onChange={(v) => set({ ssl: v })} />
                </div>
              </>
            )}
            {form.type === 'influxdb' && (
              <>
                <Field label="Org">
                  <Input value={form.org} onChange={(e) => set({ org: e.target.value })} />
                </Field>
                <Field label="Bucket">
                  <Input value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} />
                </Field>
                <Field label="Token">
                  <Input type="password" value={form.token} onChange={(e) => set({ token: e.target.value })} autoComplete="new-password" placeholder={editingId ? 'unchanged' : undefined} />
                </Field>
                <Field label="Measurement (optional)">
                  <Input value={form.measurement} onChange={(e) => set({ measurement: e.target.value })} placeholder="manifold" />
                </Field>
              </>
            )}
            {form.type === 'timebase' && (
              <>
                <Field label="Dataset">
                  <Input value={form.dataset} onChange={(e) => set({ dataset: e.target.value })} placeholder="Manifold" />
                </Field>
                <Field label="API key (optional)">
                  <Input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoComplete="new-password" placeholder={editingId ? 'unchanged' : undefined} />
                </Field>
                <Field label="Write path (optional)" className="sm:col-span-2">
                  <Input value={form.writePath} onChange={(e) => set({ writePath: e.target.value })} placeholder="default: /api/datasets/{dataset}/data" />
                </Field>
              </>
            )}
          </div>
          <div className="mt-3 rounded-lg border border-white/5 bg-surface-950/40 p-3">
            <Checkbox
              label="Allow self-signed TLS certificate (skip verification)"
              description={`Needed for on-prem historians with a self-signed certificate — e.g. a default Timebase install, whose HTTP port 307-redirects to a self-signed HTTPS listener. Leave off for internet-facing or properly-certificated targets${form.type === 'timescaledb' ? ' (applies only when SSL is enabled above)' : ''}.`}
              checked={form.sslInsecure}
              onChange={(v) => set({ sslInsecure: v })}
            />
            {!form.sslInsecure && (
              <Field label="CA certificate (PEM, optional)" className="mt-2">
                <Textarea value={form.sslRootCert} onChange={(e) => set({ sslRootCert: e.target.value })} rows={3} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-xs" />
              </Field>
            )}
          </div>
          {form.type === 'timebase' && (
            <p className="helper mt-2">
              Timebase writes TVQ samples into the dataset (auto-created on first write; points older than a tag&apos;s newest sample are ignored by the historian).
              Timebase also ingests MQTT/Sparkplug natively — pointing its collector at this broker, or at a pipeline&apos;s output namespace, is an equally good path.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={historianSaveDisabled(form)}>
              {editingId ? (
                'Save changes'
              ) : (
                <>
                  <Plus size={14} aria-hidden="true" /> Add historian
                </>
              )}
            </Button>
            <Button variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {confirmDialog}
    </>
  );
}
