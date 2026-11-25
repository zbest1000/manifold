import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { buildSparkplugGraph } from '@/graph/buildGraph';
import { topicMatches } from '@/lib/mqtt';
import ForceGraph from '@/graph/ForceGraph';
import { useCanvasTokens } from '@/graph/canvasTokens';
import { Banner, Button, ButtonLink, EmptyState, KeyValue, Stat, StatGroup, StatusText, Timestamp } from '@/components/ui';
import { FloatingBar, PanelSection, SidePanel } from '@/components/CanvasChrome';

/**
 * Producers: who is actually publishing on this broker, and broker health.
 *
 * - Sparkplug B device topology (Group → Edge Node → Device) built from observed
 *   BIRTH/DEATH certificates — REAL publishing endpoints with live online state
 *   and each endpoint's metric set.
 * - Broker `$SYS` health / throughput / client + subscription counts.
 * - When a broker admin API is configured (Consumers tab), each endpoint also
 *   shows WHO CONSUMES its data: the client subscriptions reverse-matched
 *   against the endpoint's actual Sparkplug topics.
 */
export default function ProducerFlows({ broker }) {
  const graphStyle = useStore((s) => s.graphStyle);
  const tokens = useCanvasTokens();
  const [topology, setTopology] = useState(null);
  const [sys, setSys] = useState(null);
  const [pubsub, setPubsub] = useState(null); // for reverse "consumed by" lookups
  const [selected, setSelected] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [pollTry, setPollTry] = useState(0);
  const graphRef = useRef(null);

  useEffect(() => {
    if (!broker?.id) return undefined;
    let alive = true;
    const poll = async () => {
      try {
        const [sp, sy] = await Promise.all([api.brokerSparkplug(broker.id), api.brokerSys(broker.id)]);
        if (!alive) return;
        setTopology(sp);
        setSys(sy);
        setPollError(null);
      } catch (e) {
        // Keep the last snapshot, but say so: a stale view must not look live.
        if (alive) setPollError(e?.message || 'Could not read the Sparkplug topology');
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    // Subscriptions for reverse-matching (once; cheap, no resolution needed).
    api
      .brokerAdminPubSub(broker.id)
      .then((r) => alive && setPubsub(r))
      .catch(() => alive && setPubsub(null)); // optional: only powers "consumed by"
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [broker?.id, pollTry]);

  // "Consumed by": which clients' filters match this endpoint's data topics?
  const consumersOf = (node) => {
    if (!pubsub?.configured || !pubsub.subscriptions?.length) return null;
    // Node ids: sp:{broker}:e:{group}/{edge} | sp:{broker}:d:{group}/{edge}/{device...}
    const m = /^sp:[^:]+:(e|d):(.+)$/.exec(node.id);
    if (!m) return null;
    const segs = m[2].split('/');
    const topics =
      m[1] === 'e'
        ? [`spBv1.0/${segs[0]}/NDATA/${segs[1]}`, `spBv1.0/${segs[0]}/NBIRTH/${segs[1]}`]
        : [`spBv1.0/${segs[0]}/DDATA/${segs[1]}/${segs.slice(2).join('/')}`, `spBv1.0/${segs[0]}/DBIRTH/${segs[1]}/${segs.slice(2).join('/')}`];
    const clients = new Set();
    for (const s of pubsub.subscriptions) {
      if (topics.some((t2) => topicMatches(s.topic, t2))) clients.add(s.clientId);
    }
    return [...clients];
  };

  const graph = useMemo(
    () => (topology && broker ? buildSparkplugGraph(broker, topology) : { nodes: [], links: [] }),
    [topology, broker]
  );
  const selectedNode = selected ? graph.nodes.find((n) => n.id === selected) : null;
  const hasSparkplug = topology && topology.summary?.edgeNodes > 0;
  // Online counts per kind: the registry's summary.online adds edge nodes and
  // devices together, which read as "8 online of 5 devices".
  const counts = useMemo(() => {
    const c = { edges: 0, edgesOnline: 0, devices: 0, devicesOnline: 0 };
    for (const g of topology?.groups || []) {
      for (const e of g.edgeNodes || []) {
        c.edges += 1;
        if (e.online) c.edgesOnline += 1;
        for (const d of e.devices || []) {
          c.devices += 1;
          if (d.online) c.devicesOnline += 1;
        }
      }
    }
    if (!topology?.groups && topology?.summary) {
      c.edges = topology.summary.edgeNodes || 0;
      c.devices = topology.summary.devices || 0;
    }
    return c;
  }, [topology]);

  return (
    <div className="flex h-full w-full flex-col md:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        {hasSparkplug ? (
          <ForceGraph ref={graphRef} data={graph} styleId={graphStyle} layoutId="radial" selectedId={selected} onSelect={(n) => setSelected(n?.id ?? null)} fitInset={{ top: 56, right: 40, bottom: 64, left: 40 }} />
        ) : (
          <EmptyState
            icon={Cpu}
            title="No Sparkplug devices seen yet"
            hint="This view maps publishing endpoints from Sparkplug B birth and death certificates (spBv1.0/…). Devices appear here as they announce themselves on the broker."
            action={
              <ButtonLink to="/brokers" size="sm">
                Open MQTT Brokers
              </ButtonLink>
            }
          />
        )}
        {pollError && (
          <div className="absolute inset-x-4 top-3 z-10">
            <Banner variant="warn" title="The topology may be stale" onRetry={() => setPollTry((v) => v + 1)} className="bg-panel shadow-overlay">
              {pollError}
            </Banner>
          </div>
        )}
        {hasSparkplug && (
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex">
            <FloatingBar role="group" label="Map key" className="min-w-0 flex-wrap gap-x-3 gap-y-1 px-2.5 py-1.5 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" aria-hidden="true">
                  <circle cx="5" cy="5" r="4" fill={tokens.good} />
                </svg>
                Online
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" aria-hidden="true">
                  <circle cx="5" cy="5" r="3.5" fill="none" stroke={tokens.bad} strokeWidth="1.5" />
                </svg>
                Offline (death)
              </span>
              <span className="hidden text-subtle sm:inline">Select a device for its metrics</span>
            </FloatingBar>
          </div>
        )}
      </div>

      <SidePanel label="Producer details" title={selectedNode?.meta?.kind ? selectedNode.label : 'Producers'} subtitle={selectedNode?.meta?.kind ? KIND_LABEL[selectedNode.meta.kind] || selectedNode.meta.kind : 'Sparkplug devices and broker health'}>
        {selectedNode && selectedNode.meta?.kind ? (
          <PanelSection>
            {'online' in selectedNode.meta && (
              <StatusText tone={selectedNode.meta.online ? 'good' : 'bad'} className="mb-3">
                {selectedNode.meta.online ? 'Online' : 'Offline'}
              </StatusText>
            )}
            <KeyValue
              items={[
                selectedNode.meta.msgCount != null && ['Messages', <span key="m" className="tabular-nums">{selectedNode.meta.msgCount.toLocaleString()}</span>],
                selectedNode.meta.lastSeen && ['Last message', <Timestamp key="l" value={selectedNode.meta.lastSeen} />],
                selectedNode.meta.lastBirth && ['Birth', <Timestamp key="b" value={selectedNode.meta.lastBirth} />],
                selectedNode.meta.lastDeath && ['Death', <Timestamp key="d" value={selectedNode.meta.lastDeath} />]
              ]}
            />
            {selectedNode.meta.metrics?.length > 0 && (
              <>
                <h4 className="mb-1 mt-3 text-xs font-medium text-muted">
                  Publishes {selectedNode.meta.metrics.length} {selectedNode.meta.metrics.length === 1 ? 'metric' : 'metrics'}
                </h4>
                <ul className="max-h-40 overflow-y-auto rounded border border-line bg-app px-2 py-1 font-mono text-xs text-fg">
                  {selectedNode.meta.metrics.map((m) => (
                    <li key={m} className="truncate py-px">
                      {m}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(() => {
              const consumers = consumersOf(selectedNode);
              if (consumers === null) return null;
              return (
                <>
                  <h4 className="mb-1 mt-3 text-xs font-medium text-muted">
                    Consumed by {consumers.length} {consumers.length === 1 ? 'client' : 'clients'}
                  </h4>
                  {consumers.length ? (
                    <ul className="max-h-32 overflow-y-auto rounded border border-line bg-app px-2 py-1 font-mono text-xs text-fg">
                      {consumers.map((c) => (
                        <li key={c} className="truncate py-px">
                          {c}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">No subscription covers this endpoint&apos;s topics.</p>
                  )}
                </>
              );
            })()}
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setSelected(null)}>
              Back to the summary
            </Button>
          </PanelSection>
        ) : (
          <>
            <PanelSection title="Sparkplug devices">
              {topology?.summary ? (
                <StatGroup className="grid-cols-3" label="Sparkplug devices">
                  <Stat label="Groups" value={fmt(topology.summary.groups)} />
                  <Stat label="Edge nodes" value={fmt(counts.edges)} sub={`${fmt(counts.edgesOnline)} online`} tone={counts.edgesOnline < counts.edges ? 'warn' : undefined} />
                  <Stat label="Devices" value={fmt(counts.devices)} sub={`${fmt(counts.devicesOnline)} online`} tone={counts.devicesOnline < counts.devices ? 'warn' : undefined} />
                </StatGroup>
              ) : (
                <p className="text-sm text-muted">Waiting for Sparkplug traffic…</p>
              )}
            </PanelSection>
            <PanelSection title="Broker health" aside={<span className="font-mono">$SYS</span>}>
              {sys?.available ? (
                <KeyValue
                  items={[
                    ['Clients', <span key="c" className="tabular-nums">{fmt(sys.summary.clientsConnected)}</span>],
                    ['Subscriptions', <span key="s" className="tabular-nums">{fmt(sys.summary.subscriptionsCount)}</span>],
                    ['Messages received', <span key="r" className="tabular-nums">{fmt(sys.summary.messagesReceived)}</span>],
                    ['Messages sent', <span key="t" className="tabular-nums">{fmt(sys.summary.messagesSent)}</span>],
                    ['Retained', <span key="ret" className="tabular-nums">{fmt(sys.summary.retainedMessages)}</span>],
                    ['Uptime', sys.summary.uptimeSeconds != null ? uptime(sys.summary.uptimeSeconds) : '—'],
                    sys.summary.version && ['Version', <span key="v" className="font-mono text-xs">{sys.summary.version}</span>]
                  ]}
                />
              ) : (
                <p className="text-sm text-muted">
                  This broker does not publish a <code className="font-mono text-xs">$SYS</code> tree (or has not yet). Mosquitto, EMQX and others do; their health appears here.
                </p>
              )}
            </PanelSection>
            <PanelSection title="Who subscribes to what?">
              <p className="text-sm text-muted">
                MQTT and <code className="font-mono text-xs">$SYS</code> only expose subscription counts, not who subscribes to what. This view shows who publishes. For who receives, open Consumers and connect
                the broker&apos;s admin API.
              </p>
            </PanelSection>
          </>
        )}
      </SidePanel>
    </div>
  );
}

const KIND_LABEL = { edgeNode: 'Edge node', device: 'Device', group: 'Sparkplug group' };

function fmt(v) {
  return v == null ? '—' : Number(v).toLocaleString();
}

function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
