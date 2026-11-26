import { useState } from 'react';
import { Plus, Trash2, ChevronRight, Pencil, PanelRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { nextSort, sortRows } from '@/lib/sortRows';
import {
  Button, Input, Field, Select, Checkbox, EmptyState, IconButton, Banner, LoadingState, PageBody, Dialog, StatusText, Timestamp,
  Table, THead, TableSort, Th, Tr, Td, useConfirm
} from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { useConflict } from '@/components/ConflictDialog';
import BrokerDetail from '@/pages/brokers/BrokerDetail';
import { canaryConfigFromForm, canaryFormFromBroker, canaryLine, canaryTone, postureText, postureTone, presetToForm, defaultCanaryTopic } from '@/lib/brokerHealth';

/**
 * MQTT brokers: the list + form-dialog pattern (docs/design/ui-design-system.md#list-page).
 * A sortable table of connections; create and edit happen in one dialog.
 */

const BLANK = {
  name: '',
  host: 'localhost',
  port: 1883,
  protocol: 'mqtt',
  wsPath: '/mqtt',
  mqttVersion: 4,
  username: '',
  password: '',
  // Connection config (advanced)
  clientId: '',
  keepalive: 60,
  timeout: 15000,
  reconnect: true,
  reconnectPeriod: 5000,
  maxReconnect: 0,
  cleanSession: true,
  autoSubscribe: true,
  subscribeFilter: '#',
  subscribeQos: 1,
  rejectUnauthorized: true,
  // Canary (opt-in): publishes a probe message through the broker
  canaryEnabled: false,
  canaryTopic: '',
  canaryQos: 0,
  canaryIntervalSec: 30,
  canarySlowMs: 1000,
  presetId: null // the public test broker the form was filled from (not sent)
};

const SORT_ACCESSORS = {
  name: (b) => b.name,
  status: (b) => b.status,
  messages: (b) => b.metrics?.messagesReceived ?? 0,
  topics: (b) => b.metrics?.topicCount ?? 0,
  activity: (b) => new Date(b.lastActivity || 0).getTime(),
  errors: (b) => b.metrics?.errors ?? 0,
  security: (b) => (b.posture ? b.posture.high * 10000 + b.posture.medium * 100 + b.posture.low : -1)
};

export default function Brokers() {
  const brokers = useStore((s) => s.brokers);
  const setBrokers = useStore((s) => s.setBrokers);
  const openLog = useStore((s) => s.openLog);
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingRev, setEditingRev] = useState(undefined); // the revision the form was loaded at (conflict detection)
  const [duplicate, setDuplicate] = useState(null); // 409 duplicate: { id, name } of the connection that already exists
  const [refused, setRefused] = useState(null); // 409 in-use: { broker, usedBy } when a delete is refused
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState(null); // the broker whose details drawer is open
  const [presets, setPresets] = useState([]);
  const { resolveConflict, conflictDialog } = useConflict();
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [confirm, confirmDialog] = useConfirm();

  // Initial load (live updates then arrive over the socket and keep the store current).
  const { loading, error, reload } = usePolled(async () => {
    const res = await api.listBrokers();
    setBrokers(res.brokers || []);
    return res;
  });

  const isWs = form.protocol === 'ws' || form.protocol === 'wss';
  const rows = sortRows(brokers, sort, SORT_ACCESSORS);
  const connected = brokers.filter((b) => b.status === 'connected').length;
  const detail = brokers.find((b) => b.id === detailId) || null;

  const buildConfig = () => ({
    name: form.name || undefined,
    host: form.host,
    port: Number(form.port),
    protocol: form.protocol,
    wsPath: isWs ? form.wsPath || '/mqtt' : undefined,
    mqttVersion: Number(form.mqttVersion) || 4,
    username: form.username || undefined,
    // Blank while editing = keep the stored password (never echoed back).
    password: form.password || undefined,
    clientId: form.clientId || undefined,
    keepalive: Number(form.keepalive) || 60,
    timeout: Number(form.timeout) || 15000,
    reconnect: form.reconnect,
    reconnectPeriod: Number(form.reconnectPeriod) || 5000,
    maxReconnect: Number(form.maxReconnect) || 0,
    cleanSession: form.cleanSession,
    autoSubscribe: form.autoSubscribe,
    subscribeFilter: form.subscribeFilter || '#',
    subscribeQos: Number(form.subscribeQos),
    rejectUnauthorized: form.rejectUnauthorized,
    canary: canaryConfigFromForm(form, editingId)
  });

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setEditingRev(undefined);
    setDuplicate(null);
    setForm(BLANK);
  };

  const openNew = () => {
    api
      .brokerPresets()
      .then((r) => setPresets(r.presets || []))
      .catch(() => setPresets([])); // the form works without them
    setForm(BLANK);
    setEditingId(null);
    setEditingRev(undefined);
    setDuplicate(null);
    setShowForm(true);
  };

  const save = async () => {
    if (!form.host) return toast.error('Host is required');
    if (isWs && !Number(form.port)) return toast.error('Port is required for WebSocket connections');
    setBusy(true);
    setDuplicate(null);
    const config = buildConfig();
    try {
      if (editingId) {
        try {
          await api.updateBroker(editingId, { ...config, rev: editingRev });
        } catch (e) {
          // Someone else saved this broker after the form was opened: show what differs, never overwrite silently.
          const choice = await resolveConflict(e, { what: 'broker', mine: config });
          if (choice === null) throw e;
          if (choice === 'cancel') return;
          if (choice === 'theirs') {
            loadForm(await api.getBroker(editingId));
            toast('Showing the saved version');
            return;
          }
          await api.updateBroker(editingId, { ...config, rev: e.current?.rev });
        }
        toast.success('Broker updated — reconnecting…');
      } else {
        await api.connectBroker(config);
        toast.success('Connecting to broker…');
      }
      closeForm();
    } catch (e) {
      // Same protocol, host, port, user and filter as a connection that exists: shown inline, in the form.
      if (e.status === 409 && e.code === 'duplicate') setDuplicate(e.existing || { name: 'an existing connection' });
      else toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Fill the form from GET /api/mqtt/brokers/:id: the live row plus the saved settings (timeouts, keep-alive,
  // TLS verification...) so an edit starts from the real values, not defaults. The password is never echoed.
  const loadForm = ({ broker: b, config: c = {} }) => {
    setForm({
      ...BLANK,
      name: b.name || '',
      host: b.host,
      port: b.port,
      protocol: b.protocol,
      wsPath: b.wsPath || '/mqtt',
      mqttVersion: b.mqttVersion ?? 4,
      username: b.username || '',
      password: '',
      clientId: b.clientId || '',
      autoSubscribe: b.autoSubscribe !== false,
      subscribeFilter: b.subscribeFilter || '#',
      subscribeQos: b.subscribeQos ?? 1,
      maxReconnect: b.maxReconnect || 0,
      keepalive: c.keepalive ?? BLANK.keepalive,
      timeout: c.timeout ?? BLANK.timeout,
      reconnect: c.reconnect !== false,
      reconnectPeriod: c.reconnectPeriod ?? BLANK.reconnectPeriod,
      cleanSession: c.cleanSession !== false,
      rejectUnauthorized: c.rejectUnauthorized !== false,
      ...canaryFormFromBroker(b)
    });
    setEditingId(b.id);
    setEditingRev(b.rev ?? c.rev);
    setDuplicate(null);
    setShowForm(true);
  };

  // Load a broker's known config into the form. Fields the server doesn't echo
  // (password, timeouts) fall back to blanks/defaults.
  const edit = async (b) => {
    try {
      loadForm(await api.getBroker(b.id));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const disconnect = async (broker) => {
    // This both drops the live connection AND deletes the saved profile
    // (including any stored password) server-side — confirm before a misclick
    // throws away credentials with no undo.
    const label = broker.name || broker.host || broker.id;
    const ok = await confirm({
      title: `Disconnect "${label}"?`,
      message: 'This drops the connection and deletes the saved profile, including its stored password. This cannot be undone.',
      confirmLabel: 'Disconnect and remove',
      danger: true
    });
    if (!ok) return;
    try {
      await api.disconnectBroker(broker.id);
      toast.success('Disconnected and removed');
    } catch (e) {
      // 409: routes, mappings, recordings, alert rules, models, contracts or Sparkplug host sessions still use it.
      if (e.status === 409 && e.code === 'in-use') setRefused({ broker, usedBy: e.usedBy || [] });
      else toast.error(e.message);
    }
  };

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="MQTT Brokers"
        subtitle={brokers.length ? `${connected} of ${brokers.length} connected` : 'Connect to brokers and stream their topic namespaces'}
        actions={
          <Button onClick={openNew}>
            <Plus size={14} aria-hidden="true" /> Connect a broker
          </Button>
        }
      />

      <PageBody>
        {error && brokers.length === 0 && (
          <Banner variant="error" title="Could not load brokers" onRetry={reload}>
            {error.message}
          </Banner>
        )}

        {loading && brokers.length === 0 && !error ? (
          <LoadingState label="brokers" rows={2} />
        ) : brokers.length === 0 ? (
          !error && (
            <div className="rounded-lg border border-line bg-panel">
              <EmptyState
                title="No brokers yet"
                hint="Connect an MQTT broker (Mosquitto, EMQX, HiveMQ, a Sparkplug host) and Manifold subscribes to it and maps its topic namespace."
                action={
                  <Button onClick={openNew}>
                    <Plus size={14} aria-hidden="true" /> Connect a broker
                  </Button>
                }
              />
            </div>
          )
        ) : (
          <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
            <Table caption="MQTT broker connections" className="min-w-[64rem]">
              <THead>
                <Th sortKey="name">Broker</Th>
                <Th sortKey="status">State</Th>
                <Th>Subscription</Th>
                <Th sortKey="security">Security</Th>
                <Th sortKey="messages" align="right">Messages</Th>
                <Th sortKey="topics" align="right">Topics</Th>
                <Th sortKey="activity" align="right">Last activity</Th>
                <Th sortKey="errors" align="right">Errors</Th>
                <Th srOnly align="right">Actions</Th>
              </THead>
              <tbody>
                {rows.map((b) => {
                  const errors = b.metrics?.errors ?? 0;
                  const up = b.status === 'connected';
                  return (
                    <Tr key={b.id} highlight={editingId === b.id}>
                      <Td header className="max-w-[18rem]">
                        <button
                          type="button"
                          onClick={() => setDetailId(b.id)}
                          aria-label={`Details for ${b.name}`}
                          className="block max-w-full truncate rounded text-left font-medium text-fg hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {b.name}
                        </button>
                        <span className="mono block truncate text-xs text-muted">
                          {b.protocol}://{b.host}:{b.port}
                        </span>
                      </Td>
                      <Td className="max-w-[16rem]">
                        <StatusText status={b.status} tone={!up && b.lastError && b.status !== 'connecting' && b.status !== 'reconnecting' ? 'bad' : undefined} />
                        {!up && b.lastError && (
                          <span className="mono block truncate text-xs text-subtle" title={b.lastError}>
                            {b.lastError}
                          </span>
                        )}
                        {up && b.connectedAt && (
                          <span className="block text-xs text-subtle">
                            since <Timestamp value={b.connectedAt} />
                          </span>
                        )}
                        {canaryLine(b.canaryState) && (
                          <span className="block text-xs text-subtle" data-testid={`canary-line-${b.id}`}>
                            <StatusText tone={canaryTone(b.canaryState.state)} className="text-xs">
                              Canary: {canaryLine(b.canaryState)}
                            </StatusText>
                          </span>
                        )}
                      </Td>
                      <Td className="mono whitespace-nowrap text-xs text-muted">
                        {b.autoSubscribe === false ? (
                          <span className="font-sans text-subtle">Off</span>
                        ) : b.intake?.via === 'fallback' ? (
                          <span title={`The broker refused ${b.intake.requested}`}>
                            {b.intake.granted} · QoS {b.intake.qos} <span className="font-sans text-warn">(fallback)</span>
                          </span>
                        ) : (
                          `${b.subscribeFilter || '#'} · QoS ${b.subscribeQos ?? 1}`
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs" data-testid={`posture-${b.id}`}>
                        {b.posture ? (
                          <button
                            type="button"
                            onClick={() => setDetailId(b.id)}
                            aria-label={`Security: ${postureText(b.posture)}. Open details for ${b.name}`}
                            className="rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            <StatusText tone={postureTone(b.posture)} className="text-xs">
                              {postureText(b.posture)}
                            </StatusText>
                          </button>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </Td>
                      <Td align="right" className="mono tabular-nums">{(b.metrics?.messagesReceived ?? 0).toLocaleString()}</Td>
                      <Td align="right" className="mono tabular-nums">{(b.metrics?.topicCount ?? 0).toLocaleString()}</Td>
                      <Td align="right" className="text-xs text-muted">
                        {b.lastActivity ? <Timestamp value={b.lastActivity} /> : '—'}
                      </Td>
                      <Td align="right">
                        {errors > 0 ? (
                          <button
                            type="button"
                            onClick={() => openLog(b.id)}
                            aria-label={`${errors} errors for ${b.name}, open log`}
                            className="mono rounded px-1 tabular-nums text-bad underline decoration-dotted underline-offset-2 hover:bg-bad/10"
                          >
                            {errors.toLocaleString()}
                          </button>
                        ) : (
                          <span className="mono tabular-nums text-subtle">0</span>
                        )}
                      </Td>
                      <Td align="right" className="w-28">
                        <span className="inline-flex items-center gap-0.5">
                          <IconButton icon={PanelRight} label={`Details for ${b.name}`} size={14} onClick={() => setDetailId(b.id)} />
                          <IconButton icon={Pencil} label={`Edit ${b.name}`} size={14} onClick={() => edit(b)} />
                          <IconButton icon={Trash2} label={`Disconnect and remove ${b.name}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={() => disconnect(b)} />
                        </span>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableSort>
        )}
      </PageBody>

      {showForm && (
        <Dialog
          title={editingId ? `Edit ${form.name || form.host}` : 'Connect a broker'}
          description={editingId ? 'Saving reconnects the broker with the new settings.' : 'Manifold subscribes on connect and maps the topic namespace.'}
          size="lg"
          onClose={closeForm}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                {editingId ? 'Save changes' : 'Connect'}
              </Button>
            </>
          }
        >
          <div className="space-y-5">
            {duplicate && (
              <Banner variant="error" title="This broker is already connected">
                <span data-testid="broker-duplicate">
                  &ldquo;{duplicate.name}&rdquo; uses the same protocol, host, port, user and subscribe filter. A second identical connection would count every
                  message twice. Edit &ldquo;{duplicate.name}&rdquo; instead, or change the user or the subscribe filter here.
                </span>
              </Banner>
            )}
            {!editingId && presets.length > 0 && (
              <fieldset className="space-y-2" data-testid="broker-presets">
                <legend className="mb-1 text-sm font-medium text-fg">Public test brokers</legend>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <Button key={p.id} variant="secondary" size="sm" aria-pressed={form.presetId === p.id} onClick={() => setForm(presetToForm(p, { ...BLANK, presetId: p.id }))} data-testid={`preset-${p.id}`}>
                      {p.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted">
                  These are shared, public brokers: anything you publish is visible to everyone, and anyone can publish to them. Do not use them with plant data. A preset only fills in this form.
                </p>
                {form.presetId && (
                  <Banner variant="warn" title={`${presets.find((p) => p.id === form.presetId)?.name}: public broker`}>
                    <span data-testid="preset-note">
                      {presets.find((p) => p.id === form.presetId)?.transport}. Subscribing to <span className="mono">{form.subscribeFilter}</span>, not <span className="mono">#</span>: a root
                      subscription on a public broker is a firehose of strangers&apos; data. If the broker refuses a filter, the subscription column and the details show what it granted.
                    </span>
                  </Banner>
                )}
              </fieldset>
            )}
            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Connection</legend>
              <Field label="Name" className="sm:col-span-2">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Production broker" data-autofocus />
              </Field>
              <Select
                label="Protocol"
                value={form.protocol}
                onChange={(e) => {
                  const protocol = e.target.value;
                  // No standard WebSocket MQTT port (EMQX 8083/8084, Mosquitto
                  // 9001, proxies 443…) — leave it blank for an explicit choice.
                  const port = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : '';
                  set({ protocol, port });
                }}
              >
                <option value="mqtt">mqtt (TCP)</option>
                <option value="mqtts">mqtts (TLS)</option>
                <option value="ws">ws (WebSocket)</option>
                <option value="wss">wss (WebSocket TLS)</option>
              </Select>
              <Select label="MQTT version" value={form.mqttVersion} onChange={(e) => set({ mqttVersion: Number(e.target.value) })}>
                <option value={4}>MQTT 3.1.1 (v4)</option>
                <option value={5}>MQTT 5</option>
              </Select>
              <Field label="Host">
                <Input className="mono" value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="broker.example.com" />
              </Field>
              <Field label="Port">
                <Input className="mono" type="number" value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder={isWs ? 'required — e.g. 8083' : undefined} />
              </Field>
              {isWs && (
                <Field label="WebSocket path">
                  <Input className="mono" value={form.wsPath} onChange={(e) => set({ wsPath: e.target.value })} placeholder="/mqtt" />
                </Field>
              )}
            </fieldset>

            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Authentication</legend>
              <Field label="Username (optional)">
                <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Password (optional)">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => set({ password: e.target.value })}
                  autoComplete="new-password"
                  placeholder={editingId ? 'unchanged' : undefined}
                />
              </Field>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-medium text-fg">Canary (optional)</legend>
              <Checkbox
                label="Probe this broker with a canary message"
                description="Off by default. When on, Manifold publishes a small message to your broker every few seconds, receives it back through its own subscription and measures the time. It never retains the message and keeps it out of topics, the UNS, recordings, pipelines and mappings."
                checked={form.canaryEnabled}
                onChange={(v) => set({ canaryEnabled: v })}
              />
              {form.canaryEnabled && (
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 border-l-2 border-line pl-4 sm:grid-cols-2" data-testid="canary-fields">
                  <Field label="Canary topic" help="Leave empty for the default. A custom topic must start with manifold/canary/ or contain a level named canary. Give the broker's access rules a rule for it.">
                    <Input className="mono" value={form.canaryTopic} onChange={(e) => set({ canaryTopic: e.target.value })} placeholder={defaultCanaryTopic(editingId || 'id')} />
                  </Field>
                  <Select label="Canary QoS" value={form.canaryQos} onChange={(e) => set({ canaryQos: Number(e.target.value) })}>
                    <option value={0}>QoS 0: at most once</option>
                    <option value={1}>QoS 1: at least once</option>
                    <option value={2}>QoS 2: exactly once</option>
                  </Select>
                  <Field label="Probe every (seconds)">
                    <Input type="number" min={5} max={3600} value={form.canaryIntervalSec} onChange={(e) => set({ canaryIntervalSec: e.target.value })} />
                  </Field>
                  <Field label="Slow above (ms)" help="The state is Slow when the 95th percentile latency is above this.">
                    <Input type="number" min={50} max={3000} value={form.canarySlowMs} onChange={(e) => set({ canarySlowMs: e.target.value })} />
                  </Field>
                </div>
              )}
            </fieldset>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                aria-controls="broker-advanced"
                className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-fg transition-colors hover:text-accent-text"
              >
                <ChevronRight size={14} aria-hidden="true" className={clsx('text-subtle transition-transform duration-150', showAdvanced && 'rotate-90')} />
                Connection settings
                <span className="hidden font-normal text-subtle sm:inline">retries, timeouts, keep-alive, intake</span>
              </button>

              {showAdvanced && (
                <div id="broker-advanced" className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 border-l-2 border-line pl-4 sm:grid-cols-2">
                  <Field label="Client ID (optional)">
                    <Input className="mono" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} placeholder="auto-generated" />
                  </Field>
                  <Field label="Keep-alive (seconds)">
                    <Input type="number" value={form.keepalive} onChange={(e) => set({ keepalive: e.target.value })} />
                  </Field>
                  <Field label="Connect timeout (ms)">
                    <Input type="number" value={form.timeout} onChange={(e) => set({ timeout: e.target.value })} />
                  </Field>
                  <Field label="Reconnect delay (ms)">
                    <Input type="number" value={form.reconnectPeriod} disabled={!form.reconnect} onChange={(e) => set({ reconnectPeriod: e.target.value })} />
                  </Field>
                  <Field
                    label="Subscription filter (intake)"
                    help={
                      <>
                        Topic filter subscribed on connect. Use <span className="mono">$share/&lt;group&gt;/#</span> to load-balance intake across instances;
                        messages still arrive on their real topics.
                      </>
                    }
                  >
                    <Input className="mono" value={form.subscribeFilter} onChange={(e) => set({ subscribeFilter: e.target.value })} placeholder="#" />
                  </Field>
                  <Select
                    label="Subscribe QoS (intake durability)"
                    value={form.subscribeQos}
                    onChange={(e) => set({ subscribeQos: e.target.value })}
                    help={
                      <>
                        If the broker refuses the wildcard grant, intake retries at QoS 0. Stock EMQX <em>silently</em> denies &apos;#&apos; at QoS 1+ (default ACL with
                        deny_action=ignore): allow it in the broker ACL, or pick QoS 0 if no data appears.
                      </>
                    }
                  >
                    <option value={0}>QoS 0 — at most once</option>
                    <option value={1}>QoS 1 — at least once (default)</option>
                    <option value={2}>QoS 2 — exactly once</option>
                  </Select>
                  <Field label="Max reconnect attempts (0 = unlimited)">
                    <Input type="number" value={form.maxReconnect} disabled={!form.reconnect} onChange={(e) => set({ maxReconnect: e.target.value })} />
                  </Field>
                  <div className="flex flex-col justify-center gap-2">
                    <Checkbox label="Auto-reconnect" checked={form.reconnect} onChange={(v) => set({ reconnect: v })} />
                    <Checkbox label="Clean session" checked={form.cleanSession} onChange={(v) => set({ cleanSession: v })} />
                    <Checkbox label={`Subscribe to ${form.subscribeFilter || '#'} on connect`} checked={form.autoSubscribe} onChange={(v) => set({ autoSubscribe: v })} />
                    {(form.protocol === 'mqtts' || form.protocol === 'wss') && (
                      <Checkbox label="Verify TLS certificate" checked={form.rejectUnauthorized} onChange={(v) => set({ rejectUnauthorized: v })} />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Dialog>
      )}
      {detail && (
        <BrokerDetail
          broker={detail}
          onClose={() => setDetailId(null)}
          onEdit={(b) => {
            setDetailId(null);
            edit(b);
          }}
        />
      )}
      {refused && (
        <Dialog
          title={`Can't remove "${refused.broker.name || refused.broker.host}"`}
          description="Something still uses this broker. Removing it now would leave that running against a connection that no longer exists."
          onClose={() => setRefused(null)}
          footer={<Button onClick={() => setRefused(null)}>Close</Button>}
        >
          <div data-testid="broker-in-use">
            <p className="mb-2 text-sm text-muted">Point these at another broker, or delete them first:</p>
            <ul className="space-y-1 text-sm">
              {refused.usedBy.map((u) => (
                <li key={`${u.type}:${u.id}`} className="flex items-baseline gap-2">
                  <span className="w-40 shrink-0 text-xs text-subtle">{u.type}</span>
                  <span className="text-fg">{u.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </Dialog>
      )}
      {conflictDialog}
      {confirmDialog}
    </div>
  );
}
