import { useCallback, useState } from 'react';
import { Plus, Pencil, Trash2, FlaskConical } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Input, Textarea, Field, Select, Checkbox, Badge, Banner, IconButton, Dialog, StatusDot, StatusText, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { useEngineMetrics } from './hooks';
import { Count, HeadHint, ListState, TabToolbar } from './shared';
import { BLANK_HISTORIAN, historianFormFrom, historianPayload, historianSaveDisabled, historianSummary, historianUsers, outboxHealth, formatBytes } from './helpers';

const TYPE_LABEL = { influxdb: 'InfluxDB v2', timebase: 'Timebase', timescaledb: 'TimescaleDB' };

/** What each field needs, for the "required until you try to save" validation. */
function historianProblems(form) {
  const p = {};
  if (form.type === 'timescaledb') {
    if (!form.host) p.host = 'Enter the database host.';
    if (!form.database) p.database = 'Enter the database name.';
    if (!form.user) p.user = 'Enter the database user.';
  } else {
    if (!form.url) p.url = 'Enter the historian URL, including http:// or https://.';
    if (form.type === 'influxdb' && !form.org) p.org = 'Enter the InfluxDB organisation.';
    if (form.type === 'influxdb' && !form.bucket) p.bucket = 'Enter the bucket to write into.';
    if (form.type === 'timebase' && !form.dataset) p.dataset = 'Enter the dataset name.';
  }
  return p;
}

/** Historians: the time-series databases routes and recordings write into, with their store-and-forward health. */
export default function HistoriansTab() {
  const [outbox, setOutbox] = useState({});
  const [form, setForm] = useState(BLANK_HISTORIAN);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState(null);
  const [testing, setTesting] = useState(null); // { id, state: running | ok | fail, error }
  const [saving, setSaving] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [blocked, setBlocked] = useState(null); // { name, users } for the "still in use" notice
  const readOnly = useReadOnly();
  const ro = readOnly ? { disabled: true, title: READ_ONLY_REASON } : {};
  const { data, error, loading, reload } = usePolled(() => api.listHistorians());
  useEngineMetrics(useCallback((m) => m.outbox && setOutbox(m.outbox), []));

  const historians = data?.historians || [];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const problems = historianProblems(form);
  const shown = attempted ? problems : {};

  const openForm = (h) => {
    setForm(h ? historianFormFrom(h) : BLANK_HISTORIAN);
    setEditingId(h?.id || null);
    setAttempted(false);
    setFormError(null);
    setShowForm(true);
  };
  const closeForm = () => {
    setEditingId(null);
    setForm(BLANK_HISTORIAN);
    setShowForm(false);
    setFormError(null);
  };

  const save = async () => {
    if (saving || readOnly) return;
    setAttempted(true);
    if (historianSaveDisabled(form) || Object.keys(problems).length) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.saveHistorian(historianPayload(form, editingId));
      closeForm();
      reload();
      toast.success('Historian saved');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // The server refuses to delete a historian that is still written to. Look first, so the dialog can say what uses it.
  const remove = async (h) => {
    const name = h.name || h.url;
    let users = [];
    try {
      const [routes, recs, bindings] = await Promise.all([api.listPipelines(), api.listRecordings(), api.listBindings().catch(() => ({ bindings: [] }))]);
      users = historianUsers(h.id, { routes: routes.routes, recordings: recs.recordings, bindings: bindings.bindings });
    } catch {
      /* the server still enforces it: a 409 is shown below */
    }
    if (users.length) {
      setBlocked({ name, users });
      return;
    }
    const ok = await confirm({
      title: `Remove historian "${name}"?`,
      message: 'This deletes the stored connection and its credentials. Data already written to the database stays there. Nothing is currently writing to this historian.',
      confirmLabel: 'Remove historian',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteHistorian(h.id);
      reload();
      toast.success(`Removed historian "${name}"`);
    } catch (e) {
      if (e.status === 409) setBlocked({ name, users: [], message: e.message });
      else toast.error(e.message);
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

  const problemCount = historians.filter((h) => ['bad', 'warn'].includes(outboxHealth(outbox[h.id]).tone)).length;

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={historians.length}
        label="historians"
        empty={{
          title: 'No historians yet',
          hint: 'A historian is a time-series database (InfluxDB, TimescaleDB, Timebase) that routes and recordings write into and that Trends reads back.',
          action: (
            <Button onClick={() => openForm()} {...ro}>
              <Plus size={14} aria-hidden="true" /> Add a historian
            </Button>
          )
        }}
      >
        <TabToolbar summary={problemCount ? `${historians.length} historians, ${problemCount} need attention` : `${historians.length} ${historians.length === 1 ? 'historian' : 'historians'}`}>
          <Button onClick={() => openForm()} {...ro}>
            <Plus size={14} aria-hidden="true" /> Add historian
          </Button>
        </TabToolbar>
        <Table caption="Historian connections" className="min-w-[64rem]">
          <THead>
            <Th>Historian</Th>
            <Th>State</Th>
            <Th align="right"><HeadHint hint="Points the historian accepted">Written</HeadHint></Th>
            <Th align="right"><HeadHint hint="Waiting in memory to be sent">Queued</HeadHint></Th>
            <Th align="right"><HeadHint hint="Held on disk while the historian is unreachable">Spilled</HeadHint></Th>
            <Th align="right"><HeadHint hint="Refused for good (bad tag or value), kept in a dead-letter file">Dead-lettered</HeadHint></Th>
            <Th align="right"><HeadHint hint="Had no usable value, so they were not sent">Skipped</HeadHint></Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {historians.map((h) => {
              const name = h.name || h.url;
              const o = outbox[h.id];
              const health = outboxHealth(o);
              const t = testing?.id === h.id ? testing : null;
              return [
                <Tr key={h.id} highlight={editingId === h.id} className={t && t.state !== 'running' ? 'border-b-0' : undefined}>
                  <Td header className="max-w-[22rem]">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={health.tone} className="md:hidden" />
                      <span className="truncate font-medium text-fg">{name}</span>
                      <Badge>{TYPE_LABEL[h.type] || h.type}</Badge>
                    </span>
                    <span className="mono block truncate text-xs text-muted" title={historianSummary(h)}>
                      {historianSummary(h)}
                    </span>
                    <span className="block text-xs text-subtle">{h.hasSecret ? 'Credentials stored on the server' : 'No credentials stored'}</span>
                  </Td>
                  <Td className="max-w-[18rem]">
                    <StatusText tone={health.tone}>{health.label}</StatusText>
                    {health.detail && (
                      <span className="block truncate text-xs text-subtle" title={health.detail}>
                        {health.detail}
                      </span>
                    )}
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={o?.written} />
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={o?.queued} tone="warn" />
                  </Td>
                  <Td align="right" className="mono whitespace-nowrap">
                    {o?.spillBytes > 0 ? <span className="tabular-nums text-warn">{formatBytes(o.spillBytes)}</span> : <Count value={0} />}
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={o?.deadLettered} tone="bad" />
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={o?.skipped} />
                  </Td>
                  <Td align="right" className="w-40">
                    <span className="inline-flex items-center justify-end gap-0.5">
                      <Button size="sm" variant="secondary" loading={t?.state === 'running'} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : 'Writes one point (manifold/connection-test) to the historian'} aria-label={`Test write to ${name}`} onClick={() => test(h.id)}>
                        {t?.state !== 'running' && <FlaskConical size={12} aria-hidden="true" />} Test
                      </Button>
                      <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} historian ${name}`} size={14} onClick={() => openForm(h)} />
                      <IconButton icon={Trash2} label={`Delete historian ${name}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={() => remove(h)} {...(readOnly ? { disabled: true, title: READ_ONLY_REASON } : {})} />
                    </span>
                  </Td>
                </Tr>,
                t && t.state !== 'running' && (
                  <tr key={`${h.id}-test`}>
                    <td colSpan={8} className="px-3 pb-3 pt-0">
                      {t.state === 'ok' ? (
                        <Banner variant="success" title="Test write succeeded" onDismiss={() => setTesting(null)}>
                          One point (<span className="mono text-xs">manifold/connection-test</span>) was accepted by {name}.
                        </Banner>
                      ) : (
                        <Banner variant="error" title="Test write failed" onDismiss={() => setTesting(null)}>
                          {t.error}
                        </Banner>
                      )}
                    </td>
                  </tr>
                )
              ];
            })}
          </tbody>
        </Table>
      </ListState>

      {showForm && (
        <Dialog
          title={editingId ? (readOnly ? 'View historian' : 'Edit historian') : 'Add historian'}
          description="Credentials are stored on the server and never shown again."
          size="lg"
          onClose={closeForm}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                {editingId ? 'Save changes' : 'Add historian'}
              </Button>
            </>
          }
        >
          <div className="space-y-6">
            {formError && (
              <Banner variant="error" title="Could not save the historian">
                {formError}
              </Banner>
            )}
            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Connection</legend>
              <Select label="Type" value={form.type} onChange={(e) => set({ type: e.target.value })}>
                <option value="influxdb">InfluxDB v2</option>
                <option value="timebase">Timebase historian (Flow Software)</option>
                <option value="timescaledb">TimescaleDB / PostgreSQL</option>
              </Select>
              <Field label="Name">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Plant historian" data-autofocus />
              </Field>
              {form.type !== 'timescaledb' && (
                <Field label="URL" className="sm:col-span-2" error={shown.url}>
                  <Input
                    className="mono"
                    aria-invalid={shown.url ? 'true' : undefined}
                    value={form.url}
                    onChange={(e) => set({ url: e.target.value })}
                    placeholder={form.type === 'influxdb' ? 'http://influx-host:8086' : 'http://historian-host:4511'}
                  />
                </Field>
              )}
              {form.type === 'timescaledb' && (
                <>
                  <Field label="Host" error={shown.host}>
                    <Input className="mono" aria-invalid={shown.host ? 'true' : undefined} value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="tsdb-host" />
                  </Field>
                  <Field label="Port">
                    <Input className="mono" value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="5432" />
                  </Field>
                  <Field label="Database" error={shown.database}>
                    <Input className="mono" aria-invalid={shown.database ? 'true' : undefined} value={form.database} onChange={(e) => set({ database: e.target.value })} />
                  </Field>
                  <Field label="Table (optional)">
                    <Input className="mono" value={form.table} onChange={(e) => set({ table: e.target.value })} placeholder="manifold_samples" />
                  </Field>
                  <Field label="User" error={shown.user}>
                    <Input aria-invalid={shown.user ? 'true' : undefined} value={form.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="Password">
                    <Input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={editingId ? 'Unchanged' : undefined} />
                  </Field>
                  <Checkbox className="sm:col-span-2" label="Use SSL" checked={form.ssl} onChange={(v) => set({ ssl: v })} />
                </>
              )}
              {form.type === 'influxdb' && (
                <>
                  <Field label="Org" error={shown.org}>
                    <Input aria-invalid={shown.org ? 'true' : undefined} value={form.org} onChange={(e) => set({ org: e.target.value })} />
                  </Field>
                  <Field label="Bucket" error={shown.bucket}>
                    <Input aria-invalid={shown.bucket ? 'true' : undefined} value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} />
                  </Field>
                  <Field label="Token">
                    <Input type="password" value={form.token} onChange={(e) => set({ token: e.target.value })} autoComplete="new-password" placeholder={editingId ? 'Unchanged' : undefined} />
                  </Field>
                  <Field label="Measurement (optional)">
                    <Input className="mono" value={form.measurement} onChange={(e) => set({ measurement: e.target.value })} placeholder="manifold" />
                  </Field>
                </>
              )}
              {form.type === 'timebase' && (
                <>
                  <Field label="Dataset" error={shown.dataset} help="Created on the first write if it does not exist.">
                    <Input aria-invalid={shown.dataset ? 'true' : undefined} value={form.dataset} onChange={(e) => set({ dataset: e.target.value })} placeholder="Manifold" />
                  </Field>
                  <Field label="API key (optional)">
                    <Input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoComplete="new-password" placeholder={editingId ? 'Unchanged' : undefined} />
                  </Field>
                  <Field label="Write path (optional)" className="sm:col-span-2" help="Default: /api/datasets/{dataset}/data">
                    <Input className="mono" value={form.writePath} onChange={(e) => set({ writePath: e.target.value })} />
                  </Field>
                </>
              )}
            </fieldset>

            {form.type === 'timebase' && (
              <Banner variant="info">
                Timebase takes TVQ samples; points older than a tag&apos;s newest sample are ignored by the historian. Timebase can also ingest MQTT and Sparkplug directly, so pointing its collector at a
                pipeline&apos;s output namespace works just as well.
              </Banner>
            )}

            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">When the historian is unreachable</legend>
              <Select label="When the offline buffer is full" fieldClassName="sm:col-span-2" value={form.dropPolicy} onChange={(e) => set({ dropPolicy: e.target.value })} help="Points are buffered in memory and on disk, then sent when the historian is back.">
                <option value="newest">Drop the newest points (keep the start of the outage)</option>
                <option value="oldest">Drop the oldest points (keep the latest data)</option>
              </Select>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium text-fg">TLS</legend>
              <Checkbox
                label="Allow a self-signed certificate (skip verification)"
                description={`Needed for on-premise historians with a self-signed certificate, such as a default Timebase install whose HTTP port redirects to a self-signed HTTPS listener. Leave off for internet-facing targets${form.type === 'timescaledb' ? ' (applies only when SSL is on)' : ''}.`}
                checked={form.sslInsecure}
                onChange={(v) => set({ sslInsecure: v })}
              />
              {!form.sslInsecure && (
                <Field label="CA certificate (PEM, optional)">
                  <Textarea className="mono text-xs" value={form.sslRootCert} onChange={(e) => set({ sslRootCert: e.target.value })} rows={3} placeholder="-----BEGIN CERTIFICATE-----" />
                </Field>
              )}
            </fieldset>
          </div>
        </Dialog>
      )}

      {blocked && (
        <Dialog
          title={`"${blocked.name}" is still in use`}
          description="A historian that something writes to cannot be removed: those points would be lost."
          size="md"
          onClose={() => setBlocked(null)}
          footer={<Button onClick={() => setBlocked(null)}>Close</Button>}
        >
          {blocked.users.length > 0 ? (
            <>
              <p className="mb-2 text-sm text-muted">Point these somewhere else, or delete them, then remove the historian:</p>
              <ul className="divide-y divide-line rounded-md border border-line text-sm">
                {blocked.users.map((u) => (
                  <li key={u} className="px-3 py-2 text-fg">
                    {u}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted">{blocked.message}</p>
          )}
        </Dialog>
      )}
      {confirmDialog}
    </>
  );
}
