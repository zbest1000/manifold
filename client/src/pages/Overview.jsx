import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radar, ArrowRight } from 'lucide-react';
import { useStore } from '@/store/store';
import { useConnections, useDataTick, useTopicVersionSum } from '@/store/selectors';
import { totalTopicCount } from '@/graph/topicCount';
import useIngestRate from '@/graph/useIngestRate';
import { socket } from '@/lib/socket';
import { api } from '@/lib/api';
import { deviceBadge } from '@/lib/deviceStatus';
import { ButtonLink, Banner, Panel, Stat, StatGroup, StatusDot, StatusText, Skeleton, Timestamp, Path, Table, THead, Th, Tr, Td, PageBody, toneOf, sentenceCase } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { engineAttention, recordPending, storageAttention } from '@/lib/attention';
import { canaryAttention } from '@/lib/brokerHealth';

/**
 * Overview: the dashboard pattern (docs/design/ui-design-system.md, Page patterns).
 * Top to bottom: what needs attention, the numbers that describe the estate,
 * then the connection list and the latest values. No decoration.
 */

const sum = (obj, field) => Object.values(obj || {}).reduce((acc, v) => acc + (Number(v?.[field]) || 0), 0);
const fmt = (n) => Number(n || 0).toLocaleString();

/** A broker that is offline AND failing to connect is a fault, not an idle connection. */
const brokerTone = (b) => (b.status === 'connected' ? 'good' : toneOf(b.status) === 'neutral' ? (b.lastError ? 'bad' : 'neutral') : toneOf(b.status));

const num = (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v));

/** Raw payload as one line (tooltip) and a readable value for the list. */
function raw(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
function readable(payload, msg) {
  // Sparkplug payloads are protobuf: summarise the decoded metrics, never show base64.
  if (msg?.sparkplug || msg?.type === 'sparkplug') {
    const metrics = msg.sparkplug?.metrics;
    if (Array.isArray(metrics)) {
      if (metrics.length === 1 && metrics[0]?.name != null) return `${metrics[0].name}: ${num(metrics[0].value)}`;
      return `Sparkplug · ${metrics.length} metric${metrics.length === 1 ? '' : 's'}`;
    }
    return 'Sparkplug payload';
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const keys = Object.keys(payload);
    // A value envelope: Manifold's own {v,t,q,u} (plus label/reason/name) or the long-hand {value,…}.
    const ENVELOPE = ['v', 'value', 'unit', 'u', 'quality', 'q', 'timestamp', 't', 'ts', 'label', 'reason', 'name', 'src', 'ctx'];
    if (('v' in payload || 'value' in payload) && keys.every((k) => ENVELOPE.includes(k))) {
      const value = 'v' in payload ? payload.v : payload.value;
      const unit = payload.unit ?? payload.u;
      const quality = payload.q ?? payload.quality;
      const shown = value === null || value === undefined ? '—' : typeof value === 'object' ? raw(value) : num(value);
      const text = `${shown}${payload.label ? ` (${payload.label})` : ''}${unit ? ` ${unit}` : ''}`;
      // OPC-style quality: 192 good, 64 uncertain, 0 bad. Only non-good is worth the space.
      return quality === 0 ? `${text} · bad` : quality === 64 ? `${text} · uncertain` : text;
    }
    if (keys.length === 1) return `${keys[0]}: ${num(payload[keys[0]])}`;
  }
  if (typeof payload === 'number') return num(payload);
  return raw(payload);
}

export default function Overview() {
  const { brokers, opcua } = useConnections();
  const setTopics = useStore((s) => s.setTopics);
  const dataTick = useDataTick(true);
  const connectedIds = brokers.filter((b) => b.status === 'connected').map((b) => b.id);
  const connectedKey = connectedIds.join('|');
  const topicVersion = useTopicVersionSum(brokers.map((b) => b.id));
  const ingestRate = useIngestRate(null);
  const [seedError, setSeedError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [engine, setEngine] = useState(null); // pushed every 2s while anything is connected
  const [alerts, setAlerts] = useState(null); // { rules, recent } — config, polled slowly
  const [alertsError, setAlertsError] = useState(null);
  const [devices, setDevices] = useState([]); // southbound devices (Modbus, S7, EtherNet/IP)
  const devicesVersion = useStore((s) => s.devicesVersion);
  const deviceStates = useStore((s) => s.deviceStates);

  useEffect(() => {
    let live = true;
    api
      .devices()
      .then((r) => live && setDevices(r.devices || []))
      .catch(() => live && setDevices([])); // the count shows 0; the Devices page reports the error
    return () => {
      live = false;
    };
  }, [devicesVersion]);

  // Pending counts across pushes: a route or historian whose backlog rises push after push is not keeping up.
  const [pendingHist, setPendingHist] = useState({ routes: {}, historians: {} });
  useEffect(() => {
    const onMetrics = (m) => {
      setEngine(m);
      setPendingHist((h) => ({
        routes: recordPending(h.routes, Object.fromEntries(Object.entries(m?.pipelines || {}).map(([id, r]) => [id, r.pending]))),
        historians: recordPending(h.historians, Object.fromEntries(Object.entries(m?.outbox || {}).map(([id, o]) => [id, o.pending])))
      }));
    };
    socket.on('engine-metrics', onMetrics);
    return () => socket.off('engine-metrics', onMetrics);
  }, []);

  // Configuration the engine numbers refer to (names, alert state, mapping health, broken references),
  // polled slowly; each source is optional (a failure leaves its items out, the page says so in the banner).
  const [config, setConfig] = useState({ routes: [], historians: [], alertRules: [], mappings: [], health: {}, broken: [], status: null });
  useEffect(() => {
    let stop = false;
    const load = () =>
      Promise.allSettled([api.listPipelines(), api.listHistorians(), api.listAlertRules(), api.listBindings(), api.brokenReferences(), api.systemStatus()]).then(([p, h, a, b, x, st]) => {
        if (stop) return;
        const ok = (r, f, d) => (r.status === 'fulfilled' ? f(r.value) : d);
        setConfig((c) => ({
          routes: ok(p, (v) => v.routes || [], c.routes),
          historians: ok(h, (v) => v.historians || [], c.historians),
          alertRules: ok(a, (v) => v.rules || [], c.alertRules),
          mappings: ok(b, (v) => v.bindings || [], c.mappings),
          health: ok(b, (v) => v.health || {}, c.health),
          broken: ok(x, (v) => v.broken || [], c.broken),
          status: ok(st, (v) => v, c.status) // storage degraded: the configuration or the alert history cannot be written
        }));
      });
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 10_000);
    const onAlert = () => load();
    socket.on('alert-state', onAlert);
    return () => {
      stop = true;
      clearInterval(t);
      socket.off('alert-state', onAlert);
    };
  }, [retry]);

  useEffect(() => {
    let stop = false;
    const load = () =>
      Promise.all([api.listAlertRules(), api.alertEvents(50)])
        .then(([r, e]) => !stop && setAlerts({ rules: r.rules.length, recent: e.events.length, latest: e.events[0] || null }))
        .then(() => !stop && setAlertsError(null))
        .catch((e) => !stop && setAlertsError(e?.message || 'Could not load alert rules'));
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [retry]);

  // Seed the topic index from the server exactly like the Topics and UNS pages
  // do, so all three count from the same source.
  useEffect(() => {
    let alive = true;
    for (const id of connectedIds) {
      api
        .brokerTopics(id)
        .then((res) => alive && setTopics(id, res.topics))
        .catch((e) => alive && setSeedError(e?.message || 'Could not load topics'));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectedKey is the stable string form of the connected broker set
  }, [connectedKey, retry]);

  // Latest value per topic, most recently updated first. Read from the
  // non-reactive store snapshot; refreshes on the throttled tick.
  const latest = useMemo(() => {
    const state = useStore.getState();
    const names = new Map(brokers.map((b) => [b.id, b.name]));
    const byTopic = new Map();
    for (const b of brokers) {
      for (const m of state.getLiveMessages(b.id)) {
        const key = `${b.id}\u0000${m.topic}`;
        const prev = byTopic.get(key);
        if (!prev || new Date(m.timestamp) > new Date(prev.timestamp)) byTopic.set(key, { ...m, brokerName: names.get(b.id) });
      }
    }
    return [...byTopic.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataTick signals new messages; they are read from the non-reactive store
  }, [brokers, dataTick]);

  const topicCount = useMemo(
    () => totalTopicCount(brokers, (id) => useStore.getState().getTopics(id).length),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- topicVersion signals topic-set changes; counts come from the non-reactive index
    [brokers, topicVersion]
  );

  // ---- derived state ----------------------------------------------------------------------
  const deviceRows = devices.map((d) => {
    const badge = deviceBadge(d, d.status, deviceStates[d.id]);
    return { d, badge };
  });
  const brokersUp = brokers.filter((b) => b.status === 'connected').length;
  const opcuaUp = opcua.filter((c) => c.status === 'connected').length;
  const devicesUp = deviceRows.filter((r) => r.badge.key === 'online').length;
  const devicesEnabled = deviceRows.filter((r) => r.d.enabled !== false).length;

  const p = engine?.pipelines;
  const o = engine?.outbox;
  const bnd = engine?.bindings;
  const pipelineErrors = sum(p, 'errors');
  const loopBlocked = sum(p, 'loopBlocked');
  const spilled = sum(o, 'spillBytes');
  const dropped = sum(o, 'dropped');
  const bindingErrors = sum(bnd, 'errors');
  const recentAlerts = alerts?.recent ?? 0;

  // What needs a human, worst first.
  const issues = [...storageAttention(config.status)];
  for (const b of brokers) {
    if (b.status !== 'connected') issues.push({ key: `b-${b.id}`, tone: brokerTone(b) === 'neutral' ? 'warn' : brokerTone(b), what: b.name, detail: `MQTT broker ${b.status}${b.lastError ? `: ${b.lastError}` : ''}`, to: '/brokers' });
  }
  issues.push(...canaryAttention(brokers));
  for (const c of opcua) {
    if (c.status !== 'connected') issues.push({ key: `o-${c.id}`, tone: toneOf(c.status) === 'warn' ? 'warn' : 'bad', what: c.name, detail: `OPC UA server ${c.status}`, to: '/opcua' });
  }
  for (const { d, badge } of deviceRows) {
    if (d.enabled !== false && badge.key !== 'online') issues.push({ key: `d-${d.id}`, tone: toneOf(badge.status) === 'warn' ? 'warn' : 'bad', what: d.name, detail: `Device ${badge.label.toLowerCase()}`, to: '/devices' });
  }
  if (pipelineErrors > 0) issues.push({ key: 'p-err', tone: 'bad', what: 'Pipelines', detail: `${fmt(pipelineErrors)} delivery errors`, to: '/pipelines' });
  if (loopBlocked > 0) issues.push({ key: 'p-loop', tone: 'warn', what: 'Pipelines', detail: `${fmt(loopBlocked)} messages blocked as loops`, to: '/pipelines' });
  if (dropped > 0) issues.push({ key: 'h-drop', tone: 'bad', what: 'Historians', detail: `${fmt(dropped)} points dropped`, to: '/pipelines' });
  if (spilled > 0) issues.push({ key: 'h-spill', tone: 'warn', what: 'Historians', detail: `${(spilled / 1024).toFixed(1)} KB spilled to disk`, to: '/pipelines' });
  if (bindingErrors > 0) issues.push({ key: 't-err', tone: 'bad', what: 'Tag bindings', detail: `${fmt(bindingErrors)} publish errors`, to: '/tags' });
  issues.push(
    ...engineAttention({
      // only what still exists: counters of a deleted route or historian are history, not a problem
      routes: Object.fromEntries(Object.entries(p || {}).filter(([id]) => config.routes.some((r) => r.id === id))),
      historians: Object.fromEntries(Object.entries(o || {}).filter(([id]) => config.historians.some((x) => x.id === id))),
      routePending: pendingHist.routes,
      historianPending: pendingHist.historians,
      names: { routes: Object.fromEntries(config.routes.map((r) => [r.id, r.name || r.id])), historians: Object.fromEntries(config.historians.map((x) => [x.id, x.name || x.id])) },
      alertRules: config.alertRules,
      mappings: config.mappings,
      health: config.health,
      broken: config.broken
    })
  );
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));

  const nothingConfigured = brokers.length === 0 && opcua.length === 0 && devices.length === 0;
  const engineLoading = !engine && !alerts && brokers.length + opcua.length > 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Overview"
        actions={
          <ButtonLink to="/discovery" variant="secondary">
            <Radar size={14} aria-hidden="true" /> Discover network
          </ButtonLink>
        }
      />

      <PageBody className="space-y-5">
        {(seedError || alertsError) && (
          <Banner
            variant="error"
            title={seedError ? 'Topic list unavailable' : 'Alerts unavailable'}
            onRetry={() => {
              setSeedError(null);
              setAlertsError(null);
              setRetry((v) => v + 1);
            }}
          >
            {seedError || alertsError}
          </Banner>
        )}

        {nothingConfigured ? (
          <Panel title="Get started">
            <p className="text-sm text-muted">Nothing is connected yet. Add an MQTT broker to see its topics, or a PLC to poll its tags.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ButtonLink to="/brokers" variant="primary">
                Connect a broker
              </ButtonLink>
              <ButtonLink to="/devices">Add a device</ButtonLink>
              <ButtonLink to="/discovery">Scan the network</ButtonLink>
            </div>
          </Panel>
        ) : (
          <AttentionList issues={issues} total={brokers.length + opcua.length + devicesEnabled} />
        )}

        <section aria-labelledby="ov-sources" className="space-y-2">
          <h2 id="ov-sources" className="text-sm font-medium text-fg">
            Sources
          </h2>
          <StatGroup className="grid-cols-2 lg:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1">
            <Stat to="/brokers" label="MQTT brokers" value={`${brokersUp} / ${brokers.length}`} sub="connected" tone={brokers.length ? (brokersUp === brokers.length ? 'good' : 'warn') : undefined} data-testid="tile-MQTT Brokers" />
            <Stat to="/devices" label="Devices" value={`${devicesUp} / ${devicesEnabled}`} sub={devices.length > devicesEnabled ? `online · ${devices.length - devicesEnabled} disabled` : 'online'} tone={devicesEnabled ? (devicesUp === devicesEnabled ? 'good' : 'warn') : undefined} data-testid="tile-Devices" />
            <Stat to="/opcua" label="OPC UA servers" value={`${opcuaUp} / ${opcua.length}`} sub="connected" tone={opcua.length ? (opcuaUp === opcua.length ? 'good' : 'warn') : undefined} data-testid="tile-OPC UA Servers" />
            <Stat to="/topics" label="Topics" value={fmt(topicCount)} sub="across all brokers" data-testid="tile-Topics Tracked" />
            <Stat to="/trends" label="Ingest" value={ingestRate < 10 ? ingestRate.toFixed(1) : fmt(Math.round(ingestRate))} unit="msg/s" sub="10 s average" />
          </StatGroup>
        </section>

        <section aria-labelledby="ov-engine" className="space-y-2">
          <h2 id="ov-engine" className="text-sm font-medium text-fg">
            Data flow
          </h2>
          {engineLoading ? (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line xl:grid-cols-4" aria-busy="true" aria-label="Loading engine health">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2 bg-panel px-4 py-3">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-14" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          ) : (
            <StatGroup className="grid-cols-2 xl:grid-cols-4">
              <Stat
                to="/pipelines"
                label="Pipeline routes"
                value={fmt(Object.keys(p || {}).length)}
                sub={`${fmt(sum(p, 'published'))} delivered${pipelineErrors ? ` · ${fmt(pipelineErrors)} errors` : ''}`}
                tone={pipelineErrors ? 'bad' : undefined}
              />
              <Stat
                to="/pipelines"
                label="Historian points"
                value={fmt(sum(o, 'written'))}
                sub={`${fmt(sum(o, 'queued'))} queued${dropped ? ` · ${fmt(dropped)} dropped` : ''}`}
                tone={dropped ? 'bad' : spilled ? 'warn' : undefined}
              />
              <Stat
                to="/tags"
                label="Tag values published"
                value={fmt(sum(bnd, 'published'))}
                sub={`${fmt(sum(bnd, 'suppressed'))} held back by deadband`}
                tone={bindingErrors ? 'bad' : undefined}
              />
              <Stat
                to="/alerts?tab=history"
                label="Alert events"
                value={recentAlerts >= 50 ? '50+' : fmt(recentAlerts)}
                sub={`${alerts?.rules ?? 0} ${alerts?.rules === 1 ? 'rule' : 'rules'} configured`}
                tone={recentAlerts ? 'warn' : undefined}
              />
            </StatGroup>
          )}
        </section>

        {!nothingConfigured && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <ConnectionsPanel brokers={brokers} opcua={opcua} deviceRows={deviceRows} />
            <LatestPanel latest={latest} hasBrokers={brokers.length > 0} />
          </div>
        )}
      </PageBody>
    </div>
  );
}

/** Problems first; one quiet line when there are none. */
function AttentionList({ issues, total }) {
  if (issues.length === 0) {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-4 py-3 text-sm">
        <StatusDot tone="good" />
        <span className="text-fg">All {total} connections are healthy</span>
        <span className="text-muted">· no engine errors, no alert firing, every mapping publishing</span>
      </div>
    );
  }
  return (
    <Panel title="Needs attention" count={issues.length} flush>
      <ul className="divide-y divide-line">
        {issues.map((i) => (
          <li key={i.key}>
            <Link to={i.to} className="group flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-raised">
              <StatusDot tone={i.tone} />
              <span className="min-w-0 shrink-0 font-medium text-fg">{i.what}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{i.detail}</span>
              <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-faint transition-colors group-hover:text-fg" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const RANK = { bad: 0, warn: 1, neutral: 2, info: 3, good: 4 };

function ConnectionsPanel({ brokers, opcua, deviceRows }) {
  const rows = [
    ...brokers.map((b) => ({ key: `b-${b.id}`, name: b.name, kind: 'MQTT', endpoint: `${b.host}:${b.port}`, status: b.status, tone: brokerTone(b), label: sentenceCase(b.status) })),
    ...opcua.map((c) => ({ key: `o-${c.id}`, name: c.name, kind: 'OPC UA', endpoint: c.endpointUrl, status: c.status, label: sentenceCase(c.status) })),
    ...deviceRows.map(({ d, badge }) => ({
      key: `d-${d.id}`,
      name: d.name,
      kind: d.protocol,
      endpoint: `${d.host}:${d.port}`,
      status: badge.status,
      label: badge.label
    }))
  ].sort((a, b) => RANK[a.tone || toneOf(a.status)] - RANK[b.tone || toneOf(b.status)] || a.name.localeCompare(b.name));

  return (
    <section aria-labelledby="ov-conn" className="min-w-0 space-y-2">
      <h2 id="ov-conn" className="text-sm font-medium text-fg">
        Connections <span className="ml-1 text-xs font-normal tabular-nums text-subtle">{rows.length}</span>
      </h2>
      <Table caption="Connections" className="min-w-[28rem] table-fixed">
        <THead>
          <Th className="w-[32%]">Name</Th>
          <Th className="w-[17%]">Type</Th>
          <Th>Endpoint</Th>
          <Th className="w-[7.5rem]">State</Th>
        </THead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.key}>
              <Td header className="truncate font-medium text-fg" title={r.name}>
                {r.name}
              </Td>
              <Td className="truncate text-muted">{r.kind}</Td>
              <Td className="mono truncate text-xs text-muted" title={r.endpoint}>
                {r.endpoint}
              </Td>
              <Td className="whitespace-nowrap">
                <StatusText status={r.status} tone={r.tone}>
                  {r.label}
                </StatusText>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function LatestPanel({ latest, hasBrokers }) {
  return (
    <section aria-labelledby="ov-latest" className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="ov-latest" className="text-sm font-medium text-fg">
          Latest values
        </h2>
        <Link to="/topics" className="text-xs text-accent-text hover:underline">
          All topics
        </Link>
      </div>
      {latest.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-sm text-muted">
          {hasBrokers ? 'Values appear here as soon as a connected broker publishes. If nothing arrives, check the broker’s subscription filter.' : 'Connect a broker to see live values.'}
        </div>
      ) : (
        <Table caption="Latest values" className="min-w-[28rem] table-fixed">
          <THead>
            <Th className="w-[45%]">Topic</Th>
            <Th>Value</Th>
            <Th align="right" className="w-24">
              Updated
            </Th>
          </THead>
          <tbody>
            {latest.map((m) => (
              <Tr key={`${m.brokerId}:${m.topic}`}>
                <Td header className="text-fg">
                  <Path value={m.topic} />
                </Td>
                <Td className="mono truncate text-xs tabular-nums text-fg" title={m.sparkplug || m.type === 'sparkplug' ? readable(m.payload, m) : raw(m.payload)}>
                  {readable(m.payload, m)}
                </Td>
                <Td align="right" className="text-xs text-subtle">
                  <Timestamp value={m.timestamp} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
