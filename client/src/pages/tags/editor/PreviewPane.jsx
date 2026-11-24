import { useMemo, useState } from 'react';
import { ArrowRight, CornerDownRight } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl, StatusText, Banner, Spinner, Button, Path, Meter, Select } from '@/components/ui';
import { pretty, fmtBytes } from '../previewModel';
import { slug } from '../helpers';

const WARNING_LABEL = {
  'raw-address': 'Raw address',
  collision: 'Collision',
  'asset-path': 'Asset path',
  'no-quality': 'No quality',
  'fields-ignored': 'Fields ignored',
  'credential-like-context': 'Looks like a credential',
  'unknown-override': 'Unknown tag',
  'disabled-missing': 'Missing tag',
  'device-context': 'Device context',
  'no-tags': 'Nothing published',
  'duplicate-name': 'Duplicate name',
  'sparkplug-context-collision': 'Sparkplug property'
};
const MAX_LEAVES = 400;

function Json({ value, label }) {
  return (
    <pre tabIndex={0} role="region" aria-label={label} className="max-h-80 overflow-auto rounded-md border border-line bg-app px-3 py-2 font-mono text-xs leading-5 text-fg">
      {typeof value === 'string' ? value : pretty(value)}
    </pre>
  );
}

/** Topics grouped by their parent path, leaves linked to their rows. */
function TopicTree({ groups: all, activeKey, onActivate, total }) {
  // Cap what is rendered: the first MAX_LEAVES leaves across the groups.
  const groups = [];
  let budget = MAX_LEAVES;
  for (const g of all) {
    if (budget <= 0) break;
    groups.push({ ...g, leaves: g.leaves.slice(0, budget) });
    budget -= g.leaves.length;
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.parent} className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <Path value={`${g.parent}/`} className="min-w-0" />
            {g.unitName && <span className="shrink-0 text-2xs text-subtle">{g.unitName}</span>}
          </div>
          <ul className="mt-1 border-l border-line pl-2">
            {g.leaves.map((l) => {
              const active = l.key && l.key === activeKey;
              return (
                <li key={`${l.topic}|${l.key || ''}`}>
                  {l.key ? (
                    <button
                      type="button"
                      onClick={() => onActivate(l.key, { scroll: true })}
                      className={clsx(
                        'flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left font-mono text-xs transition-colors',
                        active ? 'bg-accent/[0.1] text-fg' : 'text-fg hover:bg-raised',
                        l.clash && 'text-bad'
                      )}
                      aria-current={active || undefined}
                    >
                      <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-faint" />
                      <span className="truncate">{l.leaf}</span>
                      {l.clash && <span className="ml-auto shrink-0 font-sans text-2xs text-bad">taken</span>}
                    </button>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5 px-1.5 py-0.5 font-mono text-xs text-subtle">
                      <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-faint" />
                      <span className="truncate">{l.leaf}</span>
                      {l.note && <span className="ml-auto shrink-0 font-sans text-2xs">{l.note}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {total > MAX_LEAVES && <p className="helper">Showing {MAX_LEAVES} of {total.toLocaleString()} topics.</p>}
    </div>
  );
}

function buildGroups({ state, topics, data, clashTopics, mqttTopics }) {
  const groups = new Map();
  const put = (topic, leaf) => {
    const i = topic.lastIndexOf('/');
    const parent = i > 0 ? topic.slice(0, i) : '';
    if (!groups.has(parent)) groups.set(parent, { parent, unitName: leaf.unitName, leaves: [] });
    groups.get(parent).leaves.push({ ...leaf, topic, leaf: i > 0 ? topic.slice(i + 1) : topic });
  };
  if (state.srcType === 'mqtt') {
    for (const t of mqttTopics) put(t.topic, { key: t.key });
    return [...groups.values()];
  }
  if (state.mode === 'sparkplug') {
    const f = state.form;
    const base = `spBv1.0/${f.group || '?'}/DDATA/${f.edge || '?'}/${f.device || '?'}`;
    for (const r of state.rows.filter((x) => x.enabled)) put(`${base}/${slug(r.name)}`, { key: r.key });
    return [...groups.values()];
  }
  for (const t of topics) {
    if (t.object) put(`${t.topic}/(object: ${t.members.length} members)`, { note: 'one message', unitName: t.unitName });
    else put(t.topic, { key: t.key, clash: clashTopics.has(t.topic), unitName: t.unitName });
  }
  const f = state.form;
  for (const s of data?.status || []) put(s, { note: 'retained' });
  for (const m of data?.meta || []) put(m.topic, { note: 'retained' });
  if (!data) {
    // Before the server answers, show the documents the form implies.
    const parents = [...groups.keys()];
    for (const p of parents) {
      if (f.statusTopic) put(`${p}/_status`, { note: 'retained' });
      if (f.metaTopic) put(`${p}/_meta`, { note: 'retained' });
    }
  }
  return [...groups.values()];
}

/**
 * Live preview beside the editor: the server's verdict and problems first, then the topic tree,
 * an example payload for the active tag (latest value, exact and worst-case bytes), the _meta
 * document, and what an edit changes.
 */
export default function PreviewPane({ state, topics, mqttTopics, preview, focus, activeRow, onActivate, errors, warnings, diff, editing }) {
  const [view, setView] = useState('topics');
  const [metaIdx, setMetaIdx] = useState(0);
  const data = preview.data?.valid ? preview.data : null;
  const rejected = preview.data && preview.data.valid === false ? preview.data : null;
  const clash = errors.filter((e) => e.collision);
  const clashTopics = useMemo(() => new Set(clash.map((c) => c.topic)), [clash]);
  const groups = useMemo(() => buildGroups({ state, topics, data, clashTopics, mqttTopics }), [state, topics, data, clashTopics, mqttTopics]);
  const totalLeaves = groups.reduce((n, g) => n + g.leaves.length, 0);
  const valueTopics = state.srcType === 'mqtt' ? mqttTopics.length : state.mode === 'sparkplug' ? state.rows.filter((r) => r.enabled).length : topics.filter((t) => !t.object).length || topics.length;
  const object = state.form.layout === 'object-per-asset' && state.mode === 'mqtt';
  const focusData = focus?.data?.valid ? focus.data : null;
  const focusEntry = focusData ? (object ? focusData.members?.[0] : focusData.tags?.[0]) : null;
  const serverEntry = activeRow && data ? (object ? data.members : data.tags)?.find((t) => t.address === activeRow.address) : null;
  const entry = focusEntry || serverEntry;
  const sizes = data?.sizes;
  const obj = data?.objects?.[0];
  const metas = data?.meta || [];
  const meta = metas[Math.min(metaIdx, metas.length - 1)];
  const other = warnings.filter((w) => w.type !== 'collision');
  const changes = diff ? diff.renamed.length + diff.removed.length + diff.added.length : 0;
  const views = [
    { value: 'topics', label: 'Topics' },
    { value: 'payload', label: 'Payload' },
    ...(state.mode === 'mqtt' && state.srcType !== 'mqtt' ? [{ value: 'meta', label: '_meta' }] : []),
    ...(editing ? [{ value: 'changes', label: changes ? `Changes ${changes}` : 'Changes' }] : [])
  ];
  const current = views.some((v) => v.value === view) ? view : 'topics';

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-3 border-b border-line px-4 py-3">
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-2" aria-live="polite">
          {state.srcType === 'mqtt' ? (
            <span className="text-sm text-muted">Pipeline route: computed here, checked when it is created.</span>
          ) : preview.status === 'loading' ? (
            <span className="inline-flex items-center gap-2 text-sm text-muted">
              <Spinner size={12} /> Checking with the server…
            </span>
          ) : preview.status === 'ok' && data ? (
            <StatusText tone={clash.length ? 'bad' : 'good'}>{clash.length ? 'Blocked by the server' : 'Checked by the server'}</StatusText>
          ) : preview.status === 'idle' ? (
            <span className="text-sm text-muted">The server checks the mapping once it has a broker, tags and a destination.</span>
          ) : null}
          {data && (
            <span className="font-mono text-xs tabular-nums text-subtle">
              {data.totalTags.toLocaleString()} tag{data.totalTags === 1 ? '' : 's'}
              {data.units > 1 ? ` × ${data.units} instances` : ''}
            </span>
          )}
        </div>
        {preview.status === 'error' && (
          <Banner variant="error" title="The preview failed" onRetry={preview.retry}>
            {preview.error}
          </Banner>
        )}
        {rejected && (
          <Banner variant="error" title="The server would refuse this mapping" action={errors.find((e) => e.section === 'server' && e.rowKey) && <Button size="sm" variant="secondary" onClick={() => onActivate(errors.find((e) => e.section === 'server' && e.rowKey).rowKey, { scroll: true, open: true })}>Go to tag</Button>}>
            {rejected.error}
          </Banner>
        )}
        {clash.length > 0 && (
          <Banner variant="error" title={`${clash.length} topic${clash.length === 1 ? ' is' : 's are'} already published by another mapping`}>
            <ul className="space-y-1">
              {clash.slice(0, 5).map((c) => (
                <li key={c.topic} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <Path value={c.topic} className="text-fg" />
                    <span className="block truncate text-xs">by {c.owner}</span>
                  </span>
                  {c.rowKey && (
                    <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5" onClick={() => onActivate(c.rowKey, { scroll: true, focusName: true })}>
                      Go to tag <ArrowRight size={12} aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {other.length > 0 && (
          <details className="group rounded-md border border-l-2 border-line border-l-warn bg-warn/[0.06] px-3 py-2 text-sm">
            <summary className="cursor-pointer select-none font-medium text-fg">
              {other.length} warning{other.length === 1 ? '' : 's'} <span className="font-normal text-muted">(saving is allowed)</span>
            </summary>
            <ul className="mt-1.5 space-y-1">
              {other.slice(0, 12).map((w, i) => (
                <li key={`${w.type}-${i}`} className="text-xs text-muted">
                  <span className="font-medium text-fg">{WARNING_LABEL[w.type] || w.type}:</span> {w.message}
                </li>
              ))}
              {other.length > 12 && <li className="text-xs text-subtle">and {other.length - 12} more</li>}
            </ul>
          </details>
        )}
        {data && sizes && (
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-subtle">Value topics</dt>
              <dd className="font-mono tabular-nums text-fg">{valueTopics.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-subtle">Largest payload</dt>
              <dd className="font-mono tabular-nums text-fg">{fmtBytes(sizes.worstCasePayloadBytes)}</dd>
            </div>
            <div>
              <dt className="text-subtle">Full publish</dt>
              <dd className="font-mono tabular-nums text-fg">{fmtBytes(sizes.worstCaseCycleBytes)}</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="px-4 pt-3">
        <SegmentedControl size="sm" label="Preview" value={current} onChange={setView} options={views} />
      </div>
      <div className="min-h-0 flex-1 px-4 py-3">
        {current === 'topics' && (totalLeaves ? <TopicTree groups={groups} activeKey={activeRow?.key} onActivate={onActivate} total={totalLeaves} /> : <p className="text-sm text-muted">Nothing would be published yet.</p>)}

        {current === 'payload' && (
          <div className="space-y-3">
            {object && obj && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted">
                  One object on <span className="font-mono text-fg">{obj.topic}</span>
                </p>
                <Json value={obj.payload} label="Example object payload" />
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-muted">
                    {fmtBytes(obj.bytes)} now, worst case {fmtBytes(obj.worstCaseBytes)}
                  </span>
                  <span className="font-mono text-subtle">cap {fmtBytes(obj.capBytes)}</span>
                </div>
                <Meter value={obj.worstCaseBytes} max={obj.capBytes} warnAt={0.8} badAt={1} label="Worst-case object size against the cap" />
              </div>
            )}
            {activeRow ? (
              <div className="space-y-1.5">
                <p className="flex min-w-0 items-baseline gap-2 text-xs text-muted">
                  <span className="shrink-0">{object ? 'Member' : state.mode === 'sparkplug' ? 'Metric' : 'Topic'}</span>
                  <span className="min-w-0 truncate font-mono text-fg" title={entry?.topic}>
                    {object ? entry?.member || slug(activeRow.name) : entry?.metric || entry?.topic || '…'}
                  </span>
                </p>
                {focus?.status === 'loading' && !entry ? (
                  <p className="inline-flex items-center gap-2 text-sm text-muted">
                    <Spinner size={12} /> Loading the example…
                  </p>
                ) : entry ? (
                  <>
                    <Json value={entry.payload} label={`Example payload for ${activeRow.name}`} />
                    <p className="text-xs text-muted">
                      {entry.hasValue ? 'Built from the latest value read.' : 'No value read yet: the payload shows a null placeholder.'}
                      {entry.bytes !== undefined && ` ${entry.bytes} B exactly${entry.worstCaseBytes ? `, ${entry.worstCaseBytes} B worst case` : ''}.`}
                    </p>
                    {(entry.warnings || []).map((w, i) => (
                      <p key={i} className="text-xs text-warn">
                        {WARNING_LABEL[w.type] || w.type}: {w.message}
                      </p>
                    ))}
                  </>
                ) : focus?.data && focus.data.valid === false ? (
                  <p className="text-xs text-bad">{focus.data.error}</p>
                ) : (
                  <p className="text-sm text-muted">The example appears once the server has checked the mapping.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">Select a tag in the table to see its payload.</p>
            )}
          </div>
        )}

        {current === 'meta' &&
          (meta ? (
            <div className="space-y-1.5">
              {metas.length > 1 ? (
                <Select aria-label="Instance" value={String(Math.min(metaIdx, metas.length - 1))} onChange={(e) => setMetaIdx(Number(e.target.value))} options={metas.map((m, i) => ({ value: String(i), label: m.topic }))} />
              ) : (
                <p className="truncate font-mono text-xs text-muted" title={meta.topic}>
                  {meta.topic}
                </p>
              )}
              <Json value={meta.payload} label="The _meta document" />
            </div>
          ) : (
            <p className="text-sm text-muted">{state.form.metaTopic ? 'The _meta document appears once the server has checked the mapping.' : '_meta is switched off under Payload.'}</p>
          ))}

        {current === 'changes' && diff && (
          <div className="space-y-4 text-sm">
            {!changes && <p className="text-muted">No topic changes. Saving keeps every topic where it is.</p>}
            {diff.renamed.length > 0 && (
              <div>
                <p className="font-medium text-fg">
                  {diff.renamed.length} topic{diff.renamed.length === 1 ? '' : 's'} renamed
                </p>
                <p className="helper">The old topics&apos; retained messages are cleared when you save.</p>
                <ul className="mt-1.5 space-y-1">
                  {diff.renamed.slice(0, 50).map((r) => (
                    <li key={`${r.unitName || ''}${r.address}`} className="min-w-0 font-mono text-xs">
                      <span className="block truncate text-subtle line-through" title={r.from}>
                        {r.from}
                      </span>
                      <span className="block truncate text-fg" title={r.to}>
                        {r.to}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {diff.removed.length > 0 && (
              <div>
                <p className="font-medium text-fg">
                  {diff.removed.length} topic{diff.removed.length === 1 ? '' : 's'} removed
                </p>
                <p className="helper">No longer published; retained values are cleared.</p>
                <ul className="mt-1.5 space-y-0.5">
                  {diff.removed.slice(0, 50).map((r) => (
                    <li key={r.topic} className="truncate font-mono text-xs text-subtle" title={r.topic}>
                      {r.topic}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {diff.added.length > 0 && (
              <div>
                <p className="font-medium text-fg">
                  {diff.added.length} topic{diff.added.length === 1 ? '' : 's'} added
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {diff.added.slice(0, 50).map((r) => (
                    <li key={r.topic} className="truncate font-mono text-xs text-fg" title={r.topic}>
                      {r.topic}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
