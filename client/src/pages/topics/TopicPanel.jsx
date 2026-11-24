import { useEffect, useMemo, useState } from 'react';
import { X, Gauge, Clock, Hash, Send, Copy, Trash2, GitCompareArrows, Maximize2, Minimize2 } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { useDataTick } from '@/store/selectors';
import { Sparkline, fmtNum } from '@/components/charts';
import JsonView from '@/components/JsonView';
import { diffPayloads, formatDiffValue } from '@/lib/payloadDiff';
import { Card, Button, Badge, Input, Modal } from '@/components/ui';
import { numericFromPayload, endId } from './topicUtils';
import HistoryChartModal from './HistoryChartModal';

// One labelled row in the Location card (Parent / Siblings / Children).
function RelRow({ label, children }) {
  return (
    <div className="mb-2 flex items-start gap-2 last:mb-0">
      <span className="mt-1 w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// A jump-to-node chip for a neighbouring topic.
function RelChip({ node, onJump }) {
  return (
    <button
      onClick={() => onJump?.(node.id)}
      title={`Jump to ${node.meta?.fullTopic || node.label}`}
      className="mono inline-flex max-w-full items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-xs text-slate-300 transition hover:border-accent-500/40 hover:bg-accent-500/10 hover:text-accent-200"
    >
      <span className="truncate">{node.label}</span>
    </button>
  );
}

export default function TopicPanel({ node, brokerId, graph, onJump, onClose }) {
  // Live buffer snapshot at the throttled tick; only this panel re-renders on it.
  const tick = useDataTick(true);
  const messages = useMemo(
    () => useStore.getState().getLiveMessages(brokerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brokerId, tick]
  );
  const meta = node.meta || {};
  const fullTopic = meta.fullTopic;
  const [history, setHistory] = useState([]);
  const [publishValue, setPublishValue] = useState('');
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [diffSel, setDiffSel] = useState([]); // up to two message ids for payload diff
  const [historyOpen, setHistoryOpen] = useState(false); // full history-chart popup
  const [expanded, setExpanded] = useState(false); // blow the panel up to a large modal

  const [historyError, setHistoryError] = useState(null);
  const [historyTry, setHistoryTry] = useState(0);
  useEffect(() => {
    if (!fullTopic) return;
    let alive = true;
    api
      .topicMessages(brokerId, fullTopic, 30)
      .then((res) => {
        if (!alive) return;
        setHistoryError(null);
        setHistory(res.messages.slice().reverse());
      })
      .catch((e) => {
        if (!alive) return;
        setHistory([]);
        setHistoryError(e?.message || 'Could not load message history');
      });
    return () => {
      alive = false;
    };
  }, [brokerId, fullTopic, historyTry]);

  // Merge in live messages for this exact topic
  const live = messages.filter((m) => m.topic === fullTopic);
  const merged = [...live, ...history.filter((h) => !live.some((l) => l.id === h.id))].slice(0, 40);
  const latest = merged[0];

  const publish = async () => {
    try {
      await api.publish(brokerId, fullTopic, publishValue, { qos, retain });
      toast.success(retain ? 'Published (retained)' : 'Published');
      setPublishValue('');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const deleteRetained = async () => {
    // This publishes an empty retained message to the LIVE broker — every other
    // consumer of this topic loses its retained value (device configs, Sparkplug
    // STATE, last-known values). Confirm the exact topic first.
    if (!window.confirm(`Clear the retained message on "${fullTopic}"?\n\nThis publishes an empty retained payload to the broker. Every other client subscribed to this topic will lose its retained value.`)) {
      return;
    }
    try {
      await api.publish(brokerId, fullTopic, '', { retain: true });
      toast.success('Cleared retained message');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed')
    );
  };

  // Numeric value history (oldest → newest), with timestamps for a real time
  // axis in the history popup.
  const numericPoints = merged
    .slice()
    .reverse()
    .map((m) => ({ ts: new Date(m.timestamp).getTime(), v: numericFromPayload(m.payload) }))
    .filter((p) => p.v != null && Number.isFinite(p.ts));
  const numericSeries = numericPoints.map((p) => p.v);

  // Neighbours in the topic tree, from the graph's parent→child links: the
  // parent, the siblings under it, and this node's own children. Each is
  // clickable to jump the selection there.
  const links = graph?.links || [];
  const nodeById = (id) => graph?.nodes.find((n) => n.id === id) || null;
  const parentId = links.find((l) => endId(l.target) === node.id) ? endId(links.find((l) => endId(l.target) === node.id).source) : null;
  const parentNode = parentId ? nodeById(parentId) : null;
  const siblings = parentId
    ? links.filter((l) => endId(l.source) === parentId).map((l) => endId(l.target)).filter((id) => id !== node.id).map(nodeById).filter(Boolean)
    : [];
  const children = links.filter((l) => endId(l.source) === node.id).map((l) => endId(l.target)).map(nodeById).filter(Boolean);
  const segments = fullTopic ? fullTopic.split('/') : [];

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            {meta.isLeaf ? 'Topic' : node.kind === 'broker' ? 'Broker' : 'Topic branch'}
          </p>
          <div className="flex items-center gap-1.5">
            <p className="mono mt-0.5 break-all text-sm font-medium text-slate-100">{fullTopic || node.label}</p>
            {fullTopic && (
              <button onClick={() => copy(fullTopic)} title="Copy topic" aria-label="Copy topic" className="shrink-0 text-slate-400 hover:text-slate-300">
                <Copy size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Restore panel (Esc)' : 'Expand panel to a larger view'}
            aria-label={expanded ? 'Restore panel' : 'Expand panel'}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-300"
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button onClick={onClose} aria-label="Close panel" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-300">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {historyError && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            <span>{historyError}</span>
            <button onClick={() => setHistoryTry((v) => v + 1)} className="shrink-0 rounded border border-rose-400/40 px-2 py-0.5 hover:bg-rose-500/20">
              Retry
            </button>
          </div>
        )}
        {meta.isLeaf && (
          <div className="grid grid-cols-3 gap-2">
            <Stat icon={Hash} label="Messages" value={meta.messageCount ?? '—'} />
            <Stat icon={Gauge} label="Type" value={<Badge>{meta.type}</Badge>} />
            <Stat
              icon={Clock}
              label="Last seen"
              value={meta.lastActivity ? formatDistanceToNow(new Date(meta.lastActivity), { addSuffix: true }) : '—'}
            />
          </div>
        )}

        {/* Location in the topic tree: a clickable breadcrumb plus the parent,
            siblings, and children as jump targets. */}
        {fullTopic && (parentNode || siblings.length > 0 || children.length > 0 || segments.length > 1) && (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Location</p>
            <div className="mb-3 flex flex-wrap items-center text-xs">
              {segments.map((seg, i) => {
                const last = i === segments.length - 1;
                const path = segments.slice(0, i + 1).join('/');
                return (
                  <span key={i} className="flex items-center">
                    {i > 0 && <span className="px-0.5 text-slate-400">/</span>}
                    {last ? (
                      <span className="mono font-medium text-slate-200">{seg}</span>
                    ) : (
                      <button
                        onClick={() => onJump?.(`topic:${brokerId}:${path}`)}
                        title={`Jump to ${path}`}
                        className="mono rounded px-1 py-0.5 text-slate-400 transition hover:bg-white/10 hover:text-accent-300"
                      >
                        {seg}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {parentNode && (
              <RelRow label="Parent">
                <RelChip node={parentNode} onJump={onJump} />
              </RelRow>
            )}
            {siblings.length > 0 && (
              <RelRow label={`Siblings ${siblings.length}`}>
                <div className="flex flex-wrap gap-1">
                  {siblings.slice(0, 30).map((s) => (
                    <RelChip key={s.id} node={s} onJump={onJump} />
                  ))}
                  {siblings.length > 30 && <span className="self-center text-xs text-slate-400">+{siblings.length - 30} more</span>}
                </div>
              </RelRow>
            )}
            {children.length > 0 && (
              <RelRow label={`Children ${children.length}`}>
                <div className="flex flex-wrap gap-1">
                  {children.slice(0, 30).map((c) => (
                    <RelChip key={c.id} node={c} onJump={onJump} />
                  ))}
                  {children.length > 30 && <span className="self-center text-xs text-slate-400">+{children.length - 30} more</span>}
                </div>
              </RelRow>
            )}
          </div>
        )}

        {latest && (
          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Latest payload</p>
              <button
                onClick={() =>
                  copy(typeof latest.payload === 'object' ? JSON.stringify(latest.payload) : String(latest.payload))
                }
                title="Copy value"
                aria-label="Copy latest value"
                className="text-slate-400 hover:text-slate-300"
              >
                <Copy size={13} />
              </button>
            </div>
            {latest.sparkplug ? (
              <JsonView data={latest.sparkplug} name="sparkplug" />
            ) : typeof latest.payload === 'object' ? (
              <JsonView data={latest.payload} />
            ) : (
              <pre className="mono max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-emerald-300">
                {String(latest.payload)}
              </pre>
            )}
            {numericSeries.length >= 2 && <PanelPlot series={numericSeries} onExpand={() => setHistoryOpen(true)} />}
          </Card>
        )}

        {historyOpen && (
          <HistoryChartModal topic={fullTopic} points={numericPoints} onClose={() => setHistoryOpen(false)} />
        )}

        {meta.isLeaf && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Publish</p>
              <div className="flex items-center gap-2">
                <select
                  aria-label="QoS"
                  value={qos}
                  onChange={(e) => setQos(Number(e.target.value))}
                  className="rounded-md border border-white/10 bg-surface-950/60 px-1.5 py-0.5 text-xs text-slate-300"
                  title="QoS"
                >
                  <option value={0}>QoS 0</option>
                  <option value={1}>QoS 1</option>
                  <option value={2}>QoS 2</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} /> retain
                </label>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Payload to publish"
                value={publishValue}
                onChange={(e) => setPublishValue(e.target.value)}
                placeholder="Payload…"
                onKeyDown={(e) => e.key === 'Enter' && publish()}
              />
              <Button onClick={publish} disabled={!publishValue} aria-label="Publish payload">
                <Send size={14} />
              </Button>
            </div>
            <button
              onClick={deleteRetained}
              className="mt-2 flex items-center gap-1.5 text-xs text-slate-400 hover:text-rose-300"
            >
              <Trash2 size={12} /> Clear retained message
            </button>
          </div>
        )}

        {merged.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                History ({merged.length})
              </p>
              <span className="text-xs text-slate-400">
                {diffSel.length === 0 ? 'pick two to diff' : diffSel.length === 1 ? 'pick one more' : ''}
              </span>
            </div>
            <PayloadDiffCard messages={merged} sel={diffSel} onClear={() => setDiffSel([])} />
            <div className="space-y-1">
              {merged.map((m) => {
                const inDiff = diffSel.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className={clsx(
                      'rounded-lg border px-2.5 py-1.5',
                      inDiff ? 'border-accent-500/40 bg-accent-500/10' : 'border-white/5 bg-white/[0.02]'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-400">
                        {new Date(m.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-400">QoS {m.qos}</span>
                        <button
                          title={inDiff ? 'Remove from diff' : 'Select for diff'}
                          aria-label={inDiff ? 'Remove message from diff' : 'Select message for diff'}
                          aria-pressed={inDiff}
                          onClick={() =>
                            setDiffSel((prev) =>
                              prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev.slice(-1), m.id]
                            )
                          }
                          className={clsx('rounded p-0.5', inDiff ? 'text-accent-300' : 'text-slate-400 hover:text-slate-300')}
                        >
                          <GitCompareArrows size={12} />
                        </button>
                      </span>
                    </div>
                    <p className="mono mt-0.5 truncate text-xs text-slate-300">
                      {typeof m.payload === 'object' ? JSON.stringify(m.payload) : String(m.payload)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );

  // Expanded: reflow the same content into a large centered modal so the
  // decoded Sparkplug metrics and the full history list have room to breathe.
  if (expanded) {
    return (
      <Modal title="Topic detail" onClose={() => setExpanded(false)} className="max-w-4xl p-0">
        <div className="flex h-[80vh] flex-col overflow-hidden">{inner}</div>
      </Modal>
    );
  }
  return <aside aria-label="Topic details" className="absolute inset-0 z-20 flex w-full flex-col border-l border-white/5 bg-surface-900 md:static md:z-auto md:w-96 md:shrink-0 md:bg-surface-900/50">{inner}</aside>;
}

// Structural diff of two selected history messages (older → newer). Shows what
// actually changed between publishes — the fastest way to spot a misbehaving
// field in a fat JSON payload.
function PayloadDiffCard({ messages, sel, onClear }) {
  if (sel.length !== 2) return null;
  const pair = messages.filter((m) => sel.includes(m.id));
  if (pair.length !== 2) return null;
  const [older, newer] = pair.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const changes = diffPayloads(older.payload, newer.payload);
  const KIND_CLASS = { added: 'text-emerald-300', removed: 'text-rose-300', changed: 'text-amber-300' };
  return (
    <Card className="mb-2 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <GitCompareArrows size={12} className="text-accent-300" /> Payload diff
        </span>
        <span className="flex items-center gap-2">
          <span className="text-xs text-slate-400">
            {new Date(older.timestamp).toLocaleTimeString()} → {new Date(newer.timestamp).toLocaleTimeString()}
          </span>
          <button onClick={onClear} aria-label="Clear diff selection" className="text-slate-400 hover:text-slate-300">
            <X size={12} />
          </button>
        </span>
      </div>
      {changes.length === 0 ? (
        <p className="text-xs text-slate-400">Payloads are identical.</p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-xs">
          {changes.slice(0, 100).map((c, i) => (
            <div key={i} className="flex items-baseline gap-1.5">
              <span className={`shrink-0 ${KIND_CLASS[c.kind]}`}>{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '±'}</span>
              <span className="shrink-0 text-slate-400">{c.path}</span>
              <span className="truncate text-slate-400">
                {c.kind === 'added'
                  ? formatDiffValue(c.to)
                  : c.kind === 'removed'
                    ? formatDiffValue(c.from)
                    : `${formatDiffValue(c.from)} → ${formatDiffValue(c.to)}`}
              </span>
            </div>
          ))}
          {changes.length > 100 && <p className="text-slate-400">…{changes.length - 100} more changes</p>}
        </div>
      )}
    </Card>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-2.5">
      <Icon size={14} className="text-slate-400" />
      <p className="mt-1.5 text-sm font-medium text-slate-200">{value}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}

// Compact value-history sparkline for the detail panel, with an expand action.
function PanelPlot({ series, onExpand }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  return (
    <div className="mt-3 rounded-lg border border-white/5 bg-surface-950/50 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Value history</span>
        {onExpand && (
          <button onClick={onExpand} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-400 transition hover:bg-white/5 hover:text-accent-300">
            <Maximize2 size={11} /> Expand
          </button>
        )}
      </div>
      <div className="cursor-pointer" onClick={onExpand}>
        <Sparkline values={series} height={72} />
      </div>
      <div className="mono mt-1 flex justify-between text-xs text-slate-400">
        <span>min {fmtNum(min)}</span>
        <span>{series.length} pts</span>
        <span>max {fmtNum(max)}</span>
      </div>
    </div>
  );
}

