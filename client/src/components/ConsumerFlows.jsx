import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users, RefreshCw, Unplug, MapPinned } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { buildLineageGraph, coverageToMatchIds } from '@/graph/buildGraph';
import { topicMatches } from '@/lib/mqtt';
import ForceGraph from '@/graph/ForceGraph';
import { Banner, Button, Card, EmptyState, Field, IconButton, Input, KeyValue, Path, Select, Stat, StatGroup, StatusText } from '@/components/ui';
import { FloatingBar, PanelSection, SidePanel } from '@/components/CanvasChrome';

/**
 * Consumers: who RECEIVES what, with wildcards resolved.
 *
 * A subscription filter is a query, not a destination — `spBv1.0/#` from two
 * clients can cover entirely different concrete topics. This view fetches the
 * per-client subscriptions from the broker admin API, resolves every unique
 * filter against the actually-observed topic set (server trie: exact counts,
 * covering roots, topic samples), and renders the lineage
 * Broker → Client → Filter (n matches) → matched subtrees → (drill-down) leaves.
 * Dormant filters (matching nothing) are flagged — dead wiring is a finding.
 */
export default function ConsumerFlows({ broker }) {
  const graphStyle = useStore((s) => s.graphStyle);
  const setCoverage = useStore((s) => s.setCoverage);
  const [admin, setAdmin] = useState(null);
  const [form, setForm] = useState({ type: 'emqx', url: '', apiKey: '', apiSecret: '' });
  const [data, setData] = useState(null); // pubsub + resolution
  const [expanded, setExpanded] = useState(new Map()); // path -> children[]
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const graphRef = useRef(null);
  // Per-client traffic rates, derived by diffing the admin API's cumulative
  // counters between two refreshes (EMQX exposes them; HiveMQ doesn't).
  const countersRef = useRef(new Map()); // clientId -> { msgsIn, msgsOut, ts }
  const [clientRates, setClientRates] = useState(new Map());

  const brokerId = broker?.id;

  // Fetch the per-client subscriptions and resolve them against observed topics.
  const load = useCallback(async () => {
    if (!brokerId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.brokerAdminPubSub(brokerId, { resolve: true, sampleLimit: 50 });
      setData(res);
      setExpanded(new Map());
      // Roll cumulative counters into per-client msg/s across refreshes.
      const now = Date.now();
      const rates = new Map();
      for (const c of res.clients || []) {
        const cur = c.counters;
        if (!cur || cur.msgsIn == null) continue;
        const prev = countersRef.current.get(c.id);
        if (prev && now > prev.ts) {
          const dt = (now - prev.ts) / 1000;
          rates.set(c.id, {
            inRate: Math.max(0, (cur.msgsIn - prev.msgsIn) / dt),
            outRate: Math.max(0, ((cur.msgsOut ?? 0) - (prev.msgsOut ?? 0)) / dt)
          });
        }
        countersRef.current.set(c.id, { msgsIn: cur.msgsIn, msgsOut: cur.msgsOut ?? 0, ts: now });
      }
      setClientRates(rates);
    } catch (e) {
      setError(e.message || 'Failed to reach broker admin API');
    } finally {
      setBusy(false);
    }
  }, [brokerId]);

  // Read the admin config again (after save/reset).
  const refreshConfig = useCallback(async () => {
    if (!brokerId) return;
    try {
      setAdmin(await api.getBrokerAdmin(brokerId));
    } catch (e) {
      setAdmin({ configured: false });
      setError(e?.message || 'Could not read the broker admin configuration');
    }
  }, [brokerId]);

  // Initial read; when an admin API is already configured, fetch the data too.
  // Switching brokers remounts this component (keyed by the parent), so state starts clean.
  useEffect(() => {
    if (!brokerId) return undefined;
    let alive = true;
    api
      .getBrokerAdmin(brokerId)
      .then((cfg) => {
        if (!alive) return;
        setAdmin(cfg);
        if (cfg?.configured) load();
      })
      .catch((e) => {
        if (!alive) return;
        setAdmin({ configured: false });
        setError(e?.message || 'Could not read the broker admin configuration');
      });
    return () => {
      alive = false;
    };
  }, [brokerId, load]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setBrokerAdmin(brokerId, form);
      await refreshConfig();
      await load();
    } catch (err) {
      setError(err.message || 'Could not save admin config');
      setBusy(false);
    }
  };

  const reset = async () => {
    await api.clearBrokerAdmin(brokerId);
    setData(null);
    setForm({ type: 'emqx', url: '', apiKey: '', apiSecret: '' });
    refreshConfig();
  };

  const graph = useMemo(
    () => (data && broker ? buildLineageGraph(broker, data, data.resolution || null, expanded) : { nodes: [], links: [] }),
    [data, broker, expanded]
  );
  const selNode = selected ? graph.nodes.find((n) => n.id === selected) : null;
  const uniqueFilters = useMemo(() => [...new Set((data?.subscriptions || []).map((s) => s.topic))], [data]);

  // Double-click an aggregate → fetch one level of the real topic tree.
  const expand = useCallback(
    async (node) => {
      if (node.kind !== 'topic-agg' || !node.meta?.path) return;
      const path = node.meta.path;
      if (expanded.has(path)) {
        // collapse: drop this path and any expanded descendants
        const next = new Map([...expanded].filter(([p]) => p !== path && !p.startsWith(`${path}/`)));
        setExpanded(next);
        return;
      }
      try {
        const res = await api.topicTree(brokerId, path, 300);
        setExpanded((prev) => new Map(prev).set(path, res.children || []));
      } catch (e) {
        setError(e?.message || 'Could not expand this namespace');
      }
    },
    [brokerId, expanded]
  );

  // Clients receiving a concrete topic = filters that match it, reverse-mapped.
  const subscribersOfTopic = useCallback(
    (topicPath) => {
      const matching = uniqueFilters.filter((f) => topicMatches(f, topicPath));
      const clients = new Set();
      for (const s of data?.subscriptions || []) {
        if (matching.includes(s.topic)) clients.add(s.clientId);
      }
      return { filters: matching, clients: [...clients] };
    },
    [uniqueFilters, data]
  );

  const paintCoverage = useCallback(
    (clientId) => {
      const filters = (data?.subscriptions || []).filter((s) => s.clientId === clientId).map((s) => s.topic);
      const results = filters.map((f) => data?.resolution?.byFilter?.[f]).filter(Boolean);
      const matchIds = coverageToMatchIds(brokerId, results);
      setCoverage({ brokerId, matchIds, label: `Coverage: ${clientId}` });
    },
    [data, brokerId, setCoverage]
  );

  if (!admin?.configured) {
    return (
      <div role="region" aria-label="Broker admin connection" tabIndex={0} className="h-full overflow-y-auto px-4 py-6 sm:px-6">
        <Card className="mx-auto w-full max-w-lg">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-medium text-fg">Connect a broker admin API</h2>
            <p className="mt-1 text-sm text-muted">
              MQTT and <code className="font-mono text-xs">$SYS</code> do not expose who subscribes to what; a broker admin API does. Connect an EMQX v5 or HiveMQ REST endpoint and every subscription
              filter is resolved against the topics observed on this broker, down to the topics each client receives.
            </p>
          </div>
          <form onSubmit={save} className="space-y-3 p-4">
            <Select label="Admin API" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} help={form.type === 'hivemq' ? 'Base URL of the HiveMQ REST API, for example http://broker-host:8888. Put a bearer token in the secret if the API needs one.' : undefined}>
              <option value="emqx">EMQX v5 (REST)</option>
              <option value="hivemq">HiveMQ Enterprise (REST)</option>
            </Select>
            <Field label="API base URL">
              <Input className="font-mono text-xs" placeholder="http://broker-host:18083/api/v5" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="API key">
                <Input value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
              </Field>
              <Field label="API secret" help="Stored on the server only, never sent back to the browser.">
                <Input type="password" value={form.apiSecret} onChange={(e) => setForm((f) => ({ ...f, apiSecret: e.target.value }))} />
              </Field>
            </div>
            {error && (
              <p role="alert" className="text-sm text-bad">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" loading={busy} disabled={!form.url}>
                Connect and resolve
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  const dormant = uniqueFilters.filter((f) => data?.resolution?.byFilter?.[f]?.matchCount === 0).length;

  return (
    <div className="flex h-full w-full flex-col md:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        {graph.nodes.length > 1 ? (
          <ForceGraph ref={graphRef} data={graph} styleId={graphStyle} layoutId="organic" selectedId={selected} onSelect={setSelected} onExpand={expand} fitInset={{ top: 56, right: 40, bottom: 64, left: 40 }} />
        ) : (
          <EmptyState
            icon={Users}
            title={error ? 'Admin API error' : busy ? 'Resolving subscriptions…' : 'No subscriptions reported'}
            hint={error || 'The broker admin API returned no clients or subscriptions yet.'}
          />
        )}
        {data?.resolution && (
          <div className="pointer-events-none absolute left-4 right-4 top-3 z-10 flex">
            <FloatingBar role="status" className="min-w-0 px-2.5 py-1 text-xs text-muted">
              <span className="truncate">
                Resolved against <span className="tabular-nums text-fg">{data.resolution.topicTotal.toLocaleString()}</span> observed topics
                {data.resolution.dropped > 0 && ` · ${data.resolution.dropped.toLocaleString()} dropped at the cap`}
              </span>
            </FloatingBar>
          </div>
        )}
        {graph.nodes.length > 1 && (
          <p className="pointer-events-none absolute bottom-4 left-4 right-4 hidden text-xs text-subtle sm:block">Filters show exact match counts · double-click an aggregate to see its topics · a hollow amber filter matches nothing</p>
        )}
      </div>

      <SidePanel
        label="Consumption details"
        title="Consumption map"
        subtitle={
          <span className="font-mono">
            {admin.type?.toUpperCase()} · {admin.url}
          </span>
        }
        actions={
          <>
            <IconButton icon={RefreshCw} size={14} label="Refresh subscriptions" side="left" disabled={busy} onClick={load} />
            <IconButton icon={Unplug} size={14} label="Disconnect broker admin" side="left" className="hover:bg-bad/10 hover:text-bad" onClick={reset} />
          </>
        }
      >
        {data && (
          <PanelSection>
            <StatGroup className="grid-cols-3" label="Subscriptions">
              <Stat label="Clients" value={(data.clients?.length ?? 0).toLocaleString()} />
              <Stat label="Filters" value={uniqueFilters.length.toLocaleString()} />
              <Stat label="Dormant" value={dormant.toLocaleString()} tone={dormant > 0 ? 'warn' : undefined} />
            </StatGroup>
          </PanelSection>
        )}
        {error && (
          <PanelSection>
            <Banner variant="error" title="Admin API error" onRetry={load}>
              {error}
            </Banner>
          </PanelSection>
        )}

        {selNode?.meta?.kind === 'client' && (
          <PanelSection title={selNode.label} aside={<StatusText tone={selNode.meta.connected ? 'good' : 'bad'} className="text-xs">{selNode.meta.connected ? 'Connected' : 'Offline'}</StatusText>}>
            <KeyValue
              items={[
                selNode.meta.username && ['Username', <span key="u" className="font-mono text-xs">{selNode.meta.username}</span>],
                selNode.meta.ip && ['Address', <span key="i" className="font-mono text-xs">{selNode.meta.ip}</span>],
                ...clientTraffic((data?.clients || []).find((c) => `ps:${broker.id}:c:${c.id}` === selNode.id), clientRates.get(selNode.label))
              ]}
            />
            <h4 className="mb-1 mt-3 text-xs font-medium text-muted">Subscriptions</h4>
            <ul className="divide-y divide-line rounded border border-line">
              {(data?.subscriptions || [])
                .filter((s) => `ps:${broker.id}:c:${s.clientId}` === selNode.id)
                .map((s) => {
                  const r = data?.resolution?.byFilter?.[s.topic];
                  return (
                    <li key={s.topic} className="flex items-center justify-between gap-2 px-2 py-1">
                      <span className="truncate font-mono text-xs text-fg">{s.topic}</span>
                      {r &&
                        (r.matchCount === 0 ? (
                          <StatusText tone="warn" className="shrink-0 text-xs">
                            Dormant
                          </StatusText>
                        ) : (
                          <span className="shrink-0 text-xs tabular-nums text-subtle">{r.matchCount.toLocaleString()} topics</span>
                        ))}
                    </li>
                  );
                })}
            </ul>
            <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={() => paintCoverage(selNode.label)}>
              <MapPinned size={14} aria-hidden="true" /> Show coverage on the topic map
            </Button>
          </PanelSection>
        )}

        {selNode?.meta?.kind === 'filter' && (
          <PanelSection title={<span className="font-mono text-xs">{selNode.meta.topic}</span>} aside={selNode.meta.share ? `$share ${selNode.meta.share}` : 'Filter'}>
            {selNode.meta.dormant ? (
              <Banner variant="warn" title="Dormant subscription">
                This filter matches none of the observed topics.
              </Banner>
            ) : (
              <KeyValue
                items={[
                  ['Matches', <span key="m" className="tabular-nums">{selNode.meta.matchCount?.toLocaleString()} topics</span>],
                  ['Subscribers', <span key="s" className="tabular-nums">{graph.links.filter((l) => l.target === selNode.id && l.kind === 'subscribe').length} clients</span>]
                ]}
              />
            )}
            {selNode.meta.sample?.length > 0 && (
              <>
                <h4 className="mb-1 mt-3 text-xs font-medium text-muted">
                  Topics{selNode.meta.sampleTruncated && ` (${selNode.meta.sample.length} of ${selNode.meta.matchCount?.toLocaleString()})`}
                </h4>
                <ul className="max-h-44 overflow-y-auto rounded border border-line bg-app px-2 py-1 font-mono text-xs text-fg">
                  {selNode.meta.sample.map((s) => (
                    <li key={s.topic} className="truncate py-px">
                      {s.topic}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </PanelSection>
        )}

        {(selNode?.meta?.kind === 'topic' || selNode?.meta?.kind === 'aggregate') && <TopicCard node={selNode} subscribersOfTopic={subscribersOfTopic} />}
        {!selNode && data && <p className="px-4 pb-4 text-sm text-muted">Select a client, filter or topic on the map to see what it receives.</p>}
      </SidePanel>
    </div>
  );
}

// Cumulative counters always; live msg/s appears from the second refresh on
// (rates are the delta between two admin snapshots).
function clientTraffic(client, rate) {
  const c = client?.counters;
  if (!c || c.msgsIn == null) return [];
  return [
    ['Messages in / out', <span key="io" className="tabular-nums">{`${c.msgsIn.toLocaleString()} / ${(c.msgsOut ?? 0).toLocaleString()}`}</span>],
    ['Rate in / out', <span key="r" className="tabular-nums">{rate ? `${rate.inRate.toFixed(1)} / ${rate.outRate.toFixed(1)} msg/s` : 'after the next refresh'}</span>]
  ];
}

function TopicCard({ node, subscribersOfTopic }) {
  const path = node.meta.path;
  const isAgg = node.meta.kind === 'aggregate';
  const { filters, clients } = subscribersOfTopic(path);
  const sp = path.startsWith('spBv1.0/') ? path.split('/') : null;
  return (
    <PanelSection title={<Path value={path} className="text-fg" />} aside={isAgg ? `${node.meta.subtreeCount?.toLocaleString()} topics` : 'Topic'}>
      {isAgg ? (
        <p className="text-sm text-muted">Double-click the node to see the topics in this branch.</p>
      ) : (
        <>
          <h4 className="mb-1 text-xs font-medium text-muted">Received by {clients.length} {clients.length === 1 ? 'client' : 'clients'}</h4>
          <ul className="max-h-32 overflow-y-auto rounded border border-line bg-app px-2 py-1 font-mono text-xs text-fg">
            {clients.length ? clients.map((c) => <li key={c}>{c}</li>) : <li className="text-subtle">No matching subscriptions</li>}
          </ul>
          {filters.length > 0 && <p className="mt-1 text-xs text-subtle">Through {filters.join(' · ')}</p>}
          <p className="mt-2 text-xs text-muted">
            {sp ? (
              <>
                Published by Sparkplug{' '}
                <span className="font-mono text-fg">
                  {sp[3]}
                  {sp[4] ? ` / ${sp.slice(4).join('/')}` : ''}
                </span>{' '}
                in group {sp[1]}. See Producers.
              </>
            ) : (
              'MQTT does not identify publishers of non-Sparkplug topics.'
            )}
          </p>
        </>
      )}
    </PanelSection>
  );
}
