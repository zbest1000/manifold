import { useEffect, useMemo, useState } from 'react';
import { Send, Copy, GitCompareArrows, Maximize2, Minimize2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { useDataTick } from '@/store/selectors';
import { Sparkline, fmtNum } from '@/components/charts';
import { diffPayloads, formatDiffValue } from '@/lib/payloadDiff';
import { Badge, Banner, Button, Checkbox, IconButton, Input, KeyValue, Modal, Path, Select, Timestamp, useConfirm } from '@/components/ui';
import { PanelSection, SidePanel } from '@/components/CanvasChrome';
import { numericFromPayload, endId } from './topicUtils';
import HistoryChartModal from './HistoryChartModal';
import PayloadTree from './PayloadTree';

// A jump-to-node chip for a neighbouring topic.
function RelChip({ node, onJump }) {
  return (
    <button
      type="button"
      onClick={() => onJump?.(node.id)}
      title={`Select ${node.meta?.fullTopic || node.label}`}
      className="inline-flex h-6 max-w-full items-center rounded border border-line bg-raised px-1.5 font-mono text-xs text-fg transition-colors hover:border-line-strong"
    >
      <span className="truncate">{node.label}</span>
    </button>
  );
}

function RelRow({ label, count, children }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-start gap-2 py-1">
      <span className="pt-0.5 text-xs text-muted">
        {label}
        {count != null && <span className="ml-1 tabular-nums text-subtle">{count}</span>}
      </span>
      <div className="flex min-w-0 flex-wrap gap-1">{children}</div>
    </div>
  );
}

const unitOf = (payload) => (payload && typeof payload === 'object' && typeof payload.unit === 'string' ? payload.unit : '');

export default function TopicPanel({ node, brokerId, graph, onJump, onClose }) {
  // Live buffer snapshot at the throttled tick; only this panel re-renders on it.
  const tick = useDataTick(true);
  const messages = useMemo(
    () => useStore.getState().getLiveMessages(brokerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick signals new messages; the buffer is read from the non-reactive store
    [brokerId, tick]
  );
  const meta = node.meta || {};
  const fullTopic = meta.fullTopic;
  const [history, setHistory] = useState([]);
  const [publishValue, setPublishValue] = useState('');
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [diffSel, setDiffSel] = useState([]); // up to two message ids for payload diff
  const [historyOpen, setHistoryOpen] = useState(false); // full history-chart dialog
  const [expanded, setExpanded] = useState(false); // the same content in a large dialog
  const [confirm, confirmDialog] = useConfirm();

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
    setPublishing(true);
    try {
      await api.publish(brokerId, fullTopic, publishValue, { qos, retain });
      toast.success(retain ? 'Published (retained)' : 'Published');
      setPublishValue('');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const deleteRetained = async () => {
    // This publishes an empty retained message to the LIVE broker: every other
    // consumer of this topic loses its retained value. Confirm the exact topic.
    const ok = await confirm({
      title: 'Clear the retained message?',
      message: `This publishes an empty retained payload to ${fullTopic}. Every client subscribed to this topic loses its retained value.`,
      confirmLabel: 'Clear retained message',
      danger: true
    });
    if (!ok) return;
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

  // Numeric value history (oldest → newest), with timestamps for the chart.
  const numericPoints = merged
    .slice()
    .reverse()
    .map((m) => ({ ts: new Date(m.timestamp).getTime(), v: numericFromPayload(m.payload) }))
    .filter((p) => p.v != null && Number.isFinite(p.ts));
  const numericSeries = numericPoints.map((p) => p.v);
  const unit = latest ? unitOf(latest.payload) : '';

  // Neighbours in the topic tree, from the graph's parent→child links.
  const links = graph?.links || [];
  const nodeById = (id) => graph?.nodes.find((n) => n.id === id) || null;
  const parentLink = links.find((l) => endId(l.target) === node.id);
  const parentId = parentLink ? endId(parentLink.source) : null;
  const parentNode = parentId ? nodeById(parentId) : null;
  const siblings = parentId
    ? links.filter((l) => endId(l.source) === parentId).map((l) => endId(l.target)).filter((id) => id !== node.id).map(nodeById).filter(Boolean)
    : [];
  const children = links.filter((l) => endId(l.source) === node.id).map((l) => endId(l.target)).map(nodeById).filter(Boolean);
  const segments = fullTopic ? fullTopic.split('/') : [];
  const kind = meta.isLeaf ? 'Topic' : node.kind === 'broker' ? 'Broker' : 'Topic branch';

  const headerActions = (
    <>
      {fullTopic && <IconButton icon={Copy} size={14} label="Copy topic" side="left" onClick={() => copy(fullTopic)} />}
      <IconButton icon={expanded ? Minimize2 : Maximize2} size={14} label={expanded ? 'Restore panel' : 'Expand panel'} side="left" onClick={() => setExpanded((v) => !v)} />
    </>
  );

  const content = (
    <>
      {historyError && (
        <div className="px-4 pt-3">
          <Banner variant="error" title="Could not load message history" onRetry={() => setHistoryTry((v) => v + 1)}>
            {historyError}
          </Banner>
        </div>
      )}
      <PanelSection>
        {fullTopic && <Path value={fullTopic} className="mb-3 text-fg" />}
        {meta.isLeaf ? (
          <KeyValue
            items={[
              ['Messages', <span key="m" className="tabular-nums">{meta.messageCount != null ? Number(meta.messageCount).toLocaleString() : '—'}</span>],
              ['Payload type', meta.type ? <Badge key="t">{meta.type}</Badge> : '—'],
              ['Last message', meta.lastActivity ? <Timestamp key="l" value={meta.lastActivity} /> : '—']
            ]}
          />
        ) : (
          <KeyValue items={[['Children', <span key="c" className="tabular-nums">{children.length.toLocaleString()}</span>]]} />
        )}
      </PanelSection>

      {fullTopic && (parentNode || siblings.length > 0 || children.length > 0 || segments.length > 1) && (
        <PanelSection title="Location">
          <nav aria-label="Topic path" className="mb-2 flex flex-wrap items-center font-mono text-xs">
            {segments.map((seg, i) => {
              const last = i === segments.length - 1;
              const path = segments.slice(0, i + 1).join('/');
              return (
                <span key={i} className="flex items-center">
                  {i > 0 && <span className="px-0.5 text-subtle">/</span>}
                  {last ? (
                    <span className="font-medium text-fg" aria-current="location">
                      {seg}
                    </span>
                  ) : (
                    <button type="button" onClick={() => onJump?.(`topic:${brokerId}:${path}`)} title={`Select ${path}`} className="rounded px-0.5 text-accent-text hover:underline">
                      {seg}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          {parentNode && (
            <RelRow label="Parent">
              <RelChip node={parentNode} onJump={onJump} />
            </RelRow>
          )}
          {siblings.length > 0 && (
            <RelRow label="Siblings" count={siblings.length}>
              {siblings.slice(0, 30).map((s) => (
                <RelChip key={s.id} node={s} onJump={onJump} />
              ))}
              {siblings.length > 30 && <span className="self-center text-xs text-subtle">{siblings.length - 30} more</span>}
            </RelRow>
          )}
          {children.length > 0 && (
            <RelRow label="Children" count={children.length}>
              {children.slice(0, 30).map((c) => (
                <RelChip key={c.id} node={c} onJump={onJump} />
              ))}
              {children.length > 30 && <span className="self-center text-xs text-subtle">{children.length - 30} more</span>}
            </RelRow>
          )}
        </PanelSection>
      )}

      {latest && (
        <PanelSection
          title="Latest payload"
          aside={<IconButton icon={Copy} size={14} label="Copy latest value" className="h-7 w-7" onClick={() => copy(typeof latest.payload === 'object' ? JSON.stringify(latest.payload) : String(latest.payload))} />}
        >
          <div className="max-h-64 overflow-auto rounded border border-line bg-app px-2 py-1.5 font-mono text-xs leading-relaxed">
            {latest.sparkplug ? <PayloadTree data={latest.sparkplug} name="sparkplug" /> : typeof latest.payload === 'object' ? <PayloadTree data={latest.payload} /> : <span className="whitespace-pre-wrap break-all text-fg">{String(latest.payload)}</span>}
          </div>
          {numericSeries.length >= 2 && <PanelPlot series={numericSeries} unit={unit} onExpand={() => setHistoryOpen(true)} />}
        </PanelSection>
      )}

      {meta.isLeaf && (
        <PanelSection title="Publish">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (publishValue) publish();
            }}
          >
            <div className="flex gap-2">
              <Input aria-label="Payload to publish" value={publishValue} onChange={(e) => setPublishValue(e.target.value)} placeholder="Payload" className="font-mono text-xs" />
              <Button type="submit" disabled={!publishValue} loading={publishing}>
                {!publishing && <Send size={14} aria-hidden="true" />} Publish
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Select aria-label="QoS" value={qos} onChange={(e) => setQos(Number(e.target.value))} className="h-7 w-auto py-0 text-xs">
                <option value={0}>QoS 0</option>
                <option value={1}>QoS 1</option>
                <option value={2}>QoS 2</option>
              </Select>
              <Checkbox checked={retain} onChange={setRetain} label="Retain" />
              <Button type="button" size="sm" variant="danger-ghost" className="ml-auto" onClick={deleteRetained}>
                Clear retained
              </Button>
            </div>
          </form>
        </PanelSection>
      )}

      {merged.length > 0 && (
        <PanelSection title={`History · ${merged.length}`} aside={diffSel.length === 0 ? 'Pick two to compare' : diffSel.length === 1 ? 'Pick one more' : null}>
          <PayloadDiff messages={merged} sel={diffSel} onClear={() => setDiffSel([])} />
          <ul className="-mx-4 divide-y divide-line border-y border-line">
            {merged.map((m) => {
              const inDiff = diffSel.includes(m.id);
              return (
                <li key={m.id} className={clsx('px-4 py-1.5', inDiff && 'bg-accent/[0.07] shadow-[inset_2px_0_0_rgb(var(--accent))]')}>
                  <div className="flex items-center justify-between gap-2">
                    <time dateTime={new Date(m.timestamp).toISOString()} className="text-xs tabular-nums text-muted">
                      {new Date(m.timestamp).toLocaleTimeString()}
                    </time>
                    <span className="flex items-center gap-1">
                      <span className="text-xs text-subtle">QoS {m.qos}</span>
                      <IconButton
                        icon={GitCompareArrows}
                        size={13}
                        label={inDiff ? 'Remove message from comparison' : 'Compare this message'}
                        active={inDiff}
                        aria-pressed={inDiff}
                        className="h-6 w-6"
                        onClick={() => setDiffSel((prev) => (prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev.slice(-1), m.id]))}
                      />
                    </span>
                  </div>
                  <p className="truncate font-mono text-xs text-fg" title={typeof m.payload === 'object' ? JSON.stringify(m.payload) : String(m.payload)}>
                    {typeof m.payload === 'object' ? JSON.stringify(m.payload) : String(m.payload)}
                  </p>
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}
      {historyOpen && <HistoryChartModal topic={fullTopic} points={numericPoints} unit={unit} onClose={() => setHistoryOpen(false)} />}
      {confirmDialog}
    </>
  );

  // Expanded: the same content in a large dialog, so decoded Sparkplug metrics
  // and the history list have room.
  if (expanded) {
    return (
      <Modal title={`${kind}: ${fullTopic || node.label}`} onClose={() => setExpanded(false)} className="flex h-[85vh] max-w-4xl flex-col p-0">
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-line py-2 pl-5 pr-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium text-fg">{node.label}</h2>
            <p className="text-xs text-subtle">{kind}</p>
          </div>
          <div className="flex items-center gap-0.5">
            {headerActions}
            <IconButton icon={X} label="Close" side="left" onClick={() => setExpanded(false)} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      </Modal>
    );
  }
  return (
    <SidePanel
      label="Topic details"
      title={node.label}
      subtitle={kind}
      onClose={onClose}
      closeLabel="Close panel"
      actions={headerActions}
      width="md:w-96"
      className="absolute inset-x-0 bottom-0 z-20 shadow-overlay md:static md:shadow-none"
    >
      {content}
    </SidePanel>
  );
}

// Structural diff of two selected history messages (older → newer).
function PayloadDiff({ messages, sel, onClear }) {
  if (sel.length !== 2) return null;
  const pair = messages.filter((m) => sel.includes(m.id));
  if (pair.length !== 2) return null;
  const [older, newer] = pair.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const changes = diffPayloads(older.payload, newer.payload);
  const SIGN = { added: '+', removed: '−', changed: '~' };
  const WORD = { added: 'added', removed: 'removed', changed: 'changed' };
  return (
    <div className="mb-3 rounded-md border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
        <span className="text-xs font-medium text-fg">
          Changes <span className="font-normal tabular-nums text-subtle">{new Date(older.timestamp).toLocaleTimeString()} to {new Date(newer.timestamp).toLocaleTimeString()}</span>
        </span>
        <IconButton icon={X} size={12} label="Clear comparison" className="h-6 w-6" onClick={onClear} />
      </div>
      {changes.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted">The payloads are identical.</p>
      ) : (
        <ul className="max-h-48 overflow-y-auto px-2.5 py-1.5 font-mono text-xs">
          {changes.slice(0, 100).map((c, i) => (
            <li key={i} className="flex items-baseline gap-1.5 py-px">
              <span className={clsx('w-3 shrink-0 text-center', c.kind === 'removed' ? 'text-bad' : c.kind === 'added' ? 'text-good' : 'text-warn')} title={WORD[c.kind]}>
                {SIGN[c.kind]}
                <span className="sr-only">{WORD[c.kind]}</span>
              </span>
              <span className="shrink-0 text-muted">{c.path}</span>
              <span className="truncate text-fg">{c.kind === 'added' ? formatDiffValue(c.to) : c.kind === 'removed' ? formatDiffValue(c.from) : `${formatDiffValue(c.from)} → ${formatDiffValue(c.to)}`}</span>
            </li>
          ))}
          {changes.length > 100 && <li className="text-subtle">{changes.length - 100} more changes</li>}
        </ul>
      )}
    </div>
  );
}

// Compact value-history sparkline for the detail panel, with an expand action.
function PanelPlot({ series, unit, onExpand }) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of series) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-muted">Value history</span>
        <Button size="sm" variant="ghost" onClick={onExpand}>
          <Maximize2 size={12} aria-hidden="true" /> Open chart
        </Button>
      </div>
      <button type="button" onClick={onExpand} aria-label="Open the value history chart" className="block w-full rounded text-left">
        <Sparkline values={series} height={64} />
      </button>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-subtle">
        <span>
          Min {fmtNum(min)}
          {unit && ` ${unit}`}
        </span>
        <span>{series.length} samples</span>
        <span>
          Max {fmtNum(max)}
          {unit && ` ${unit}`}
        </span>
      </div>
    </div>
  );
}
