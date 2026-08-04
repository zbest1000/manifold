import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Radio, Plus, Trash2, Server, ChevronRight, Pencil, ShieldCheck, Users, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Badge, Input, Field, EmptyState, Modal } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';
import PageHeader from '@/components/PageHeader';

// Well-known free public test brokers (see EMQX's "popular online public MQTT
// brokers" roundup). One click pre-fills the form — deliberately NOT
// auto-connect: the user should see (and can adjust) the topic filter first,
// because subscribing `#` on a public broker is a firehose of strangers' data.
// test.mosquitto.org is deliberately absent: it is best-effort and drops
// connections so often that it makes a terrible first experience.
const PUBLIC_BROKERS = [
  { label: 'EMQX public', name: 'EMQX public', host: 'broker.emqx.io', port: 1883, protocol: 'mqtt', subscribeFilter: 'testtopic/#' },
  { label: 'EMQX public (TLS)', name: 'EMQX public TLS', host: 'broker.emqx.io', port: 8883, protocol: 'mqtts', subscribeFilter: 'testtopic/#' },
  { label: 'HiveMQ public', name: 'HiveMQ public', host: 'broker.hivemq.com', port: 1883, protocol: 'mqtt', subscribeFilter: 'testtopic/#' }
];

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
  rejectUnauthorized: true
};

export default function Brokers() {
  const brokers = useStore((s) => s.brokers);
  const openLog = useStore((s) => s.openLog);
  // Discovery hands off auth-required endpoints here with host/port prefilled
  // (location state), landing the user in the form with only credentials to add.
  const prefill = useLocation().state?.prefill;
  const [form, setForm] = useState(prefill ? { ...BLANK, ...prefill } : BLANK);
  const [showForm, setShowForm] = useState(Boolean(prefill));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lifecycleFor, setLifecycleFor] = useState(null); // broker whose client timeline is open

  const isWs = form.protocol === 'ws' || form.protocol === 'wss';

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
    rejectUnauthorized: form.rejectUnauthorized
  });

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(BLANK);
  };

  const save = async () => {
    if (!form.host) return toast.error('Host is required');
    if (isWs && !Number(form.port)) return toast.error('Port is required for WebSocket connections');
    setBusy(true);
    try {
      if (editingId) {
        await api.updateBroker(editingId, buildConfig());
        toast.success('Broker updated — reconnecting…');
      } else {
        await api.connectBroker(buildConfig());
        toast.success('Connecting to broker…');
      }
      closeForm();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Load a broker's known config into the form. Fields the server doesn't echo
  // (password, timeouts) fall back to blanks/defaults.
  const edit = (b) => {
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
      maxReconnect: b.maxReconnect || 0
    });
    setEditingId(b.id);
    setShowForm(true);
  };

  const disconnect = async (broker) => {
    // This both drops the live connection AND deletes the saved profile
    // (including any stored password) server-side — confirm before a misclick
    // throws away credentials with no undo.
    const label = broker.name || broker.host || broker.id;
    if (!window.confirm(`Disconnect and remove broker "${label}"?\n\nThis deletes the saved connection profile (including its stored password). This cannot be undone.`)) {
      return;
    }
    try {
      await api.disconnectBroker(broker.id);
      toast.success('Disconnected and removed');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="MQTT Brokers"
        subtitle="Connect to brokers and stream their topic namespaces"
        helpTopic="guide-first-broker"
        actions={
          <Button onClick={() => (showForm ? closeForm() : setShowForm(true))}>
            <Plus size={15} /> Add broker
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {showForm && (
          <Card className="p-5">
            {!editingId && (
              <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-white/5 pb-4">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Public test brokers</span>
                {PUBLIC_BROKERS.map((p) => (
                  <button
                    key={p.host}
                    type="button"
                    onClick={() =>
                      setForm({ ...BLANK, name: p.name, host: p.host, port: p.port, protocol: p.protocol, subscribeFilter: p.subscribeFilter })
                    }
                    className={clsx(
                      'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition',
                      form.host === p.host
                        ? 'bg-accent-500/15 text-accent-300 ring-accent-500/30'
                        : 'bg-white/[0.03] text-slate-300 ring-white/10 hover:bg-white/5 hover:text-slate-100'
                    )}
                  >
                    {p.label} <span className="mono ml-1 text-slate-500">{p.host}</span>
                  </button>
                ))}
                <span className="basis-full text-2xs text-slate-600">
                  Free community brokers — no auth, shared with the whole internet. Great for a first connection; never
                  publish anything sensitive to them.
                </span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production broker" />
              </Field>
              <Field label="Protocol">
                <select
                  value={form.protocol}
                  onChange={(e) => {
                    const protocol = e.target.value;
                    // No standard WebSocket MQTT port (EMQX 8083/8084, Mosquitto
                    // 9001, proxies 443…) — leave it blank for an explicit choice.
                    const port = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : '';
                    setForm({ ...form, protocol, port });
                  }}
                  className="w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none"
                >
                  <option value="mqtt">mqtt (TCP)</option>
                  <option value="mqtts">mqtts (TLS)</option>
                  <option value="ws">ws (WebSocket)</option>
                  <option value="wss">wss (WebSocket TLS)</option>
                </select>
              </Field>
              <Field label="Host">
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="broker.example.com" />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder={isWs ? 'required — e.g. 8083' : undefined}
                />
              </Field>
              {isWs && (
                <Field label="WebSocket path">
                  <Input value={form.wsPath} onChange={(e) => setForm({ ...form, wsPath: e.target.value })} placeholder="/mqtt" />
                </Field>
              )}
              <Field label="MQTT version">
                <select
                  value={form.mqttVersion}
                  onChange={(e) => setForm({ ...form, mqttVersion: Number(e.target.value) })}
                  className="w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none"
                >
                  <option value={4}>MQTT 3.1.1 (v4)</option>
                  <option value={5}>MQTT 5</option>
                </select>
              </Field>
              <Field label="Username (optional)">
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </Field>
              <Field label="Password (optional)">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={editingId ? 'unchanged' : undefined}
                />
              </Field>
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="mt-4 flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-200"
            >
              <ChevronRight size={14} className={clsx('transition-transform', showAdvanced && 'rotate-90')} />
              Connection config — retries, timeouts, keep-alive
            </button>

            {showAdvanced && (
              <div className="mt-3 grid grid-cols-1 gap-4 rounded-xl border border-white/5 bg-surface-950/40 p-4 sm:grid-cols-2">
                <Field label="Client ID (optional)">
                  <Input
                    value={form.clientId}
                    onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                    placeholder="auto-generated"
                  />
                </Field>
                <Field label="Keep-alive (seconds)">
                  <Input type="number" value={form.keepalive} onChange={(e) => setForm({ ...form, keepalive: e.target.value })} />
                </Field>
                <Field label="Connect timeout (ms)">
                  <Input type="number" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })} />
                </Field>
                <Field label="Reconnect delay (ms)">
                  <Input
                    type="number"
                    value={form.reconnectPeriod}
                    disabled={!form.reconnect}
                    onChange={(e) => setForm({ ...form, reconnectPeriod: e.target.value })}
                  />
                </Field>
                <Field label="Subscription filter (intake)">
                  <Input
                    value={form.subscribeFilter}
                    onChange={(e) => setForm({ ...form, subscribeFilter: e.target.value })}
                    placeholder="#"
                  />
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">
                    Topic filter auto-subscribed on connect. Use <span className="mono">$share/&lt;group&gt;/#</span> for
                    load-balanced intake across instances — messages still arrive on their real topics.
                  </p>
                </Field>
                <Field label="Subscribe QoS (intake durability)">
                  <select
                    value={form.subscribeQos}
                    onChange={(e) => setForm({ ...form, subscribeQos: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
                  >
                    <option value={0}>QoS 0 — fire and forget</option>
                    <option value={1}>QoS 1 — at least once (default)</option>
                    <option value={2}>QoS 2 — exactly once</option>
                  </select>
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">
                    If the broker refuses the wildcard grant, intake retries at QoS 0 automatically. Note: stock EMQX
                    <em> silently</em> denies '#' at QoS 1+ (default ACL + deny_action=ignore) — allow it in the broker
                    ACL, or pick QoS 0 here if no data appears.
                  </p>
                </Field>
                <Field label="Max reconnect attempts (0 = unlimited)">
                  <Input
                    type="number"
                    value={form.maxReconnect}
                    disabled={!form.reconnect}
                    onChange={(e) => setForm({ ...form, maxReconnect: e.target.value })}
                  />
                </Field>
                <div className="flex flex-col justify-center gap-2.5">
                  <Check label="Auto-reconnect" checked={form.reconnect} onChange={(v) => setForm({ ...form, reconnect: v })} />
                  <Check label="Clean session" checked={form.cleanSession} onChange={(v) => setForm({ ...form, cleanSession: v })} />
                  <Check
                    label={`Auto-subscribe to ${form.subscribeFilter || '#'}`}
                    checked={form.autoSubscribe}
                    onChange={(v) => setForm({ ...form, autoSubscribe: v })}
                  />
                  {(form.protocol === 'mqtts' || form.protocol === 'wss') && (
                    <Check
                      label="Verify TLS certificate"
                      checked={form.rejectUnauthorized}
                      onChange={(v) => setForm({ ...form, rejectUnauthorized: v })}
                    />
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
              <Button onClick={save} disabled={busy}>
                <Radio size={15} /> {editingId ? 'Save changes' : 'Connect'}
              </Button>
            </div>
          </Card>
        )}

        {brokers.length === 0 && !showForm ? (
          <EmptyState
            icon={Server}
            title="No brokers yet"
            hint="Add an MQTT broker connection to begin exploring topics."
            action={<Button onClick={() => setShowForm(true)}>Add broker</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {brokers.map((b) => (
              <Card key={b.id} className={clsx('p-4', editingId === b.id && 'ring-1 ring-accent-500/40')}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-sky-600 shadow-lg">
                      <Radio size={18} className="text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-100">{b.name}</p>
                      <p className="mono text-xs text-slate-500">
                        {b.protocol}://{b.host}:{b.port}
                      </p>
                    </div>
                  </div>
                  <Badge status={b.status} />
                </div>
                <Posture brokerId={b.id} status={b.status} />
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Metric label="Messages" value={b.metrics?.messagesReceived ?? 0} />
                  <Metric label="Topics" value={b.metrics?.topicCount ?? 0} />
                  <Metric
                    label="Errors"
                    value={b.metrics?.errors ?? 0}
                    onClick={() => openLog(b.id)}
                    valueClassName={(b.metrics?.errors ?? 0) > 0 ? 'text-rose-300' : undefined}
                  />
                </div>
                <div className="mt-4 flex items-center justify-between gap-1.5">
                  <button
                    onClick={() => setLifecycleFor(b)}
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                  >
                    <Users size={13} /> Client activity
                  </button>
                  <span className="flex items-center gap-1.5">
                    <button
                      aria-label="Edit broker"
                      onClick={() => edit(b)}
                      className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-accent-400"
                    >
                      <Pencil size={13} />
                    </button>
                    <Button variant="danger" size="sm" onClick={() => disconnect(b)}>
                      <Trash2 size={13} /> Disconnect
                    </Button>
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {lifecycleFor && <LifecycleModal broker={lifecycleFor} onClose={() => setLifecycleFor(null)} />}
    </div>
  );
}

// Security posture chip: grade A–D fetched lazily per broker (cheap, pure
// server-side assessment) with a click-to-expand findings list. Grade A stays
// visually quiet — muted colors, no score — so healthy links don't add noise.
const GRADE_STYLES = {
  A: 'bg-emerald-500/10 text-emerald-300/70 ring-emerald-500/15',
  B: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  C: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  D: 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
};

const SEVERITY_STYLES = {
  high: 'text-rose-300',
  medium: 'text-amber-300',
  info: 'text-slate-400'
};

function Posture({ brokerId, status }) {
  const [posture, setPosture] = useState(null);
  const [open, setOpen] = useState(false);

  // Re-fetch when the connection state changes — the TLS peer certificate only
  // becomes readable once the socket is actually up.
  useEffect(() => {
    let cancelled = false;
    api
      .brokerPosture(brokerId)
      .then((p) => {
        if (!cancelled) setPosture(p);
      })
      .catch(() => {
        if (!cancelled) setPosture(null);
      });
    return () => {
      cancelled = true;
    };
  }, [brokerId, status]);

  if (!posture) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Security posture — click for findings"
        className={clsx(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset transition hover:brightness-125',
          GRADE_STYLES[posture.grade] || GRADE_STYLES.D
        )}
      >
        <ShieldCheck size={11} />
        {posture.grade}
        {posture.grade !== 'A' && <span className="font-normal opacity-70">{posture.score}</span>}
      </button>
      {open && (
        <ul className="mt-2 space-y-2 rounded-lg border border-white/5 bg-surface-950/40 p-2.5">
          {posture.findings.length === 0 ? (
            <li className="text-[11px] text-slate-500">No findings — transport and auth look clean.</li>
          ) : (
            posture.findings.map((f) => (
              <li key={f.id} className="text-[11px] leading-snug">
                <span className={clsx('font-semibold', SEVERITY_STYLES[f.severity] || 'text-slate-400')}>{f.title}</span>
                <span className="text-slate-500"> — {f.detail}</span>
                <p className="mt-0.5 text-slate-400">Fix: {f.fix}</p>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function Metric({ label, value, onClick, valueClassName }) {
  const clickable = typeof onClick === 'function';
  const Comp = clickable ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      title={clickable ? 'View in log' : undefined}
      className={clsx(
        'w-full rounded-lg bg-white/[0.03] py-2',
        clickable && 'cursor-pointer transition hover:bg-white/[0.08]'
      )}
    >
      <p className={clsx('text-lg font-semibold text-slate-100', valueClassName)}>{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </Comp>
  );
}

function Check({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-white/20 bg-surface-950 text-accent-500 focus:ring-2 focus:ring-accent-500/40"
      />
      {label}
    </label>
  );
}

// Client lifecycle timeline — what the broker can tell us about ITS clients,
// adapted per capability: EMQX $events JSON, Mosquitto $SYS/broker/log
// notices, and Sparkplug BIRTH/DEATH as the universal passive layer. The
// header names which source is live so the data's provenance is never a
// mystery.
function LifecycleModal({ broker, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => api.brokerLifecycle(broker.id).then((r) => !stop && setData(r)).catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [broker.id]);

  const cap = data?.capability || {};
  const sources = [
    cap.emqxEvents && 'EMQX $events',
    cap.brokerLog && 'broker log',
    cap.sparkplug && 'Sparkplug'
  ].filter(Boolean);

  const typeStyle = {
    connected: 'text-emerald-400',
    birth: 'text-emerald-400',
    disconnected: 'text-rose-400',
    death: 'text-rose-400'
  };

  return (
    <Modal title={`Client activity — ${broker.name}`} onClose={onClose} className="max-w-2xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <Users size={17} className="text-accent-400" /> Client activity — {broker.name}
        </h3>
        <span className="text-xs text-slate-500">
          {sources.length ? `source: ${sources.join(' + ')}` : 'listening for events…'}
        </span>
      </div>

      {!data ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <RefreshCw size={14} className="animate-spin" /> Loading…
        </p>
      ) : data.events.length === 0 ? (
        <p className="py-6 text-sm leading-relaxed text-slate-500">
          No lifecycle events observed yet. Events appear when clients connect or disconnect. EMQX brokers report them
          on <span className="mono">$events/#</span>; Mosquitto needs <span className="mono">log_dest topic</span> in its
          config; Sparkplug BIRTH/DEATH works on any broker. Otherwise this stays quiet — Manifold won't invent data it
          can't observe.
        </p>
      ) : (
        <>
          {data.clients.length > 0 && (
            <div className="mb-4">
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Clients</h4>
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {data.clients.slice(0, 30).map((c) => (
                  <div key={c.clientId} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-1.5 text-xs">
                    <span className="mono min-w-0 truncate text-slate-200">{c.clientId}</span>
                    <span className="flex shrink-0 items-center gap-2 text-slate-500">
                      {c.flapping && (
                        <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-300 ring-1 ring-inset ring-rose-500/30">
                          flapping
                        </span>
                      )}
                      <span>{c.connects}↑ {c.disconnects}↓</span>
                      <span className={typeStyle[c.lastType] || 'text-slate-400'}>{c.lastType}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Timeline</h4>
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {data.events.map((e, i) => (
              <div key={i} className="flex items-baseline justify-between gap-2 rounded bg-black/20 px-2.5 py-1 text-xs">
                <span className="min-w-0 truncate">
                  <span className={clsx('mr-2 font-semibold', typeStyle[e.type] || 'text-slate-300')}>{e.type}</span>
                  <span className="mono text-slate-300">{e.clientId}</span>
                  {e.ip && <span className="mono ml-2 text-slate-600">{e.ip}</span>}
                  {e.reason && <span className="ml-2 text-slate-500">{e.reason}</span>}
                </span>
                <span className="shrink-0 text-[10px] text-slate-500">{formatDistanceToNow(e.ts, { addSuffix: true })}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
