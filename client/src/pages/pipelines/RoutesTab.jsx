import { useCallback, useMemo, useState } from 'react';
import { Plus, Power, Play, Pencil, Trash2, ArrowRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { nextSort, sortRows } from '@/lib/sortRows';
import { Button, Input, Field, Select, Checkbox, IconButton, StatusDot, StatusText, Banner, Dialog, Mono, Table, TableSort, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { useEngineMetrics, useTvqSample } from './hooks';
import { BrokerSelect, Count, HeadHint, ListState, TabToolbar } from './shared';
import { useConflict } from '@/components/ConflictDialog';
import TransformRow from './TransformRow';
import { COUNTER_HELP, TRANSFORM_META, blankRoute, brokenSummary, brokerName, cloneRoute, hasTvqNumeric, moveItem, newTransform, routeFlow, routeSaveable, routeState, stripTransformIds, withTransformIds } from './helpers';

/** Routes: source filter, transform chain, target; one row per route with its state and counters. */
export default function RoutesTab({ brokers }) {
  const [metrics, setMetrics] = useState({});
  const [draft, setDraft] = useState(null); // null = editor closed
  const [attempted, setAttempted] = useState(false); // errors for untouched fields appear only after a submit
  const [formError, setFormError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [confirm, confirmDialog] = useConfirm();
  const { resolveConflict, conflictDialog } = useConflict();
  const readOnly = useReadOnly();
  const ro = readOnly ? { disabled: true, title: READ_ONLY_REASON } : {};

  const { data, error, loading, reload } = usePolled(
    async () => {
      const [routes, hist] = await Promise.all([api.listPipelines(), api.listHistorians()]);
      setMetrics(routes.metrics || {});
      return { routes: routes.routes || [], historians: hist.historians || [] };
    },
    { interval: 15000 } // config only: the counters stream in below
  );
  useEngineMetrics(useCallback((m) => setMetrics((prev) => m.pipelines || prev), []));

  const routes = useMemo(() => data?.routes || [], [data]);
  const historians = data?.historians || [];
  const rows = useMemo(() => sortRows(routes, sort, { name: (r) => r.name || r.source.filter, in: (r) => metrics[r.id]?.matched || 0, out: (r) => metrics[r.id]?.routed ?? metrics[r.id]?.published ?? 0, delivered: (r) => metrics[r.id]?.delivered || 0, pending: (r) => metrics[r.id]?.pending || 0, rejected: (r) => metrics[r.id]?.rejected || 0, errors: (r) => metrics[r.id]?.errors || 0, state: (r) => routeState(r, metrics[r.id]).key }), [routes, sort, metrics]);
  const running = routes.filter((r) => routeState(r, metrics[r.id]).key === 'running').length;

  const openEditor = (route) => {
    setAttempted(false);
    setFormError(null);
    setPreview(null);
    setDraft(withTransformIds(route));
  };
  const closeEditor = () => {
    setDraft(null);
    setPreview(null);
    setFormError(null);
  };

  const toHistorian = draft?.target.type === 'historian';
  const tvqTopic = useTvqSample({ brokerId: draft?.source.brokerId, filter: draft?.source.filter, enabled: Boolean(toHistorian) });
  const offerTvq = Boolean(tvqTopic) && !hasTvqNumeric(draft?.transforms);

  const problems = {};
  if (draft) {
    if (!draft.source.filter.trim()) problems.filter = 'Enter the topic filter this route listens to, for example raw/plant1/#.';
    if (toHistorian && !draft.target.historianId) problems.historian = historians.length ? 'Choose the historian to write to.' : 'No historian exists yet. Add one on the Historians tab first.';
    if (!draft.source.brokerId) problems.broker = 'Connect an MQTT broker first.';
  }
  const shown = attempted ? problems : {};

  const save = async () => {
    if (saving || readOnly) return;
    setAttempted(true);
    if (Object.keys(problems).length || !routeSaveable(draft)) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = stripTransformIds(draft); // carries `rev`: a save over a newer version is refused (409), never silent
      try {
        await api.savePipeline(payload);
      } catch (e) {
        const choice = await resolveConflict(e, { what: 'route', mine: payload });
        if (choice === null) throw e;
        if (choice === 'cancel') return;
        if (choice === 'theirs') {
          if (e.current) setDraft(withTransformIds(cloneRoute(e.current)));
          toast('Showing the saved version');
          return;
        }
        await api.savePipeline({ ...payload, rev: e.current?.rev });
      }
      closeEditor();
      reload();
      toast.success('Route saved');
    } catch (e) {
      setFormError(e.message); // the editor stays open with everything typed
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await api.previewPipeline(stripTransformIds(draft)));
      setFormError(null);
    } catch (e) {
      setPreview(null);
      setFormError(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const toggle = async (route) => {
    try {
      await api.savePipeline({ ...route, enabled: !route.enabled });
      reload();
    } catch (e) {
      toast.error(`Could not ${route.enabled ? 'pause' : 'resume'} the route: ${e.message}`);
    }
  };

  const remove = async (route) => {
    const ok = await confirm({
      title: `Delete route "${route.name || route.source.filter}"?`,
      message: `Messages on ${route.source.filter} stop being forwarded immediately. Data already delivered is not removed.`,
      confirmLabel: 'Delete route',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deletePipeline(route.id);
      reload();
      toast.success('Route deleted');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const setTransforms = (transforms) => setDraft((d) => ({ ...d, transforms }));
  const newRoute = () => openEditor(blankRoute(brokers));

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={routes.length}
        label="pipeline routes"
        empty={{
          title: 'No routes yet',
          hint: 'A route listens to a topic filter, runs each message through a chain of transforms (re-path, reshape, scale, flatten) and publishes the result to a broker or writes it to a historian.',
          action: (
            <Button onClick={newRoute} {...ro}>
              <Plus size={14} aria-hidden="true" /> Create the first route
            </Button>
          )
        }}
      >
        <TabToolbar summary={`${running} of ${routes.length} running`}>
          <Button onClick={newRoute} {...ro}>
            <Plus size={14} aria-hidden="true" /> New route
          </Button>
        </TabToolbar>
        <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
          <Table caption="Pipeline routes" className="min-w-[68rem]">
            <THead>
              <Th sortKey="name">Route</Th>
              <Th sortKey="state">State</Th>
              <Th sortKey="in" align="right"><HeadHint hint={COUNTER_HELP.in}>In</HeadHint></Th>
              <Th sortKey="out" align="right"><HeadHint hint={COUNTER_HELP.routed}>Routed</HeadHint></Th>
              <Th sortKey="delivered" align="right"><HeadHint hint={COUNTER_HELP.delivered}>Delivered</HeadHint></Th>
              <Th sortKey="pending" align="right"><HeadHint hint={COUNTER_HELP.pending}>Pending</HeadHint></Th>
              <Th sortKey="rejected" align="right"><HeadHint hint={COUNTER_HELP.rejected}>Rejected</HeadHint></Th>
              <Th align="right"><HeadHint hint={COUNTER_HELP.blocked}>Blocked</HeadHint></Th>
              <Th sortKey="errors" align="right"><HeadHint hint={COUNTER_HELP.errors}>Errors</HeadHint></Th>
              <Th srOnly align="right">Actions</Th>
            </THead>
            <tbody>
              {rows.map((route) => {
                const m = metrics[route.id] || {};
                const st = routeState(route, m);
                const name = route.name || route.source.filter;
                const flow = routeFlow(route, brokers, historians);
                const summary = `${brokerName(brokers, route.source.brokerId)}: ${flow.source} → ${flow.transforms.length ? `${flow.transforms.join(', ')} → ` : ''}${flow.target}`;
                return (
                  <Tr key={route.id} highlight={draft?.id === route.id}>
                    <Td header className="max-w-[18rem]">
                      <span className="flex items-center gap-2">
                        <StatusDot tone={st.tone} className="md:hidden" />
                        <span className="truncate font-medium text-fg">{name}</span>
                      </span>
                      <span className="mono flex items-center gap-1.5 text-xs text-muted" title={summary}>
                        <span className="min-w-0 truncate">{flow.source}</span>
                        <ArrowRight size={11} aria-hidden="true" className="shrink-0 text-faint" />
                        {flow.transforms.length > 0 && (
                          <>
                            <span className="shrink-0 font-sans text-subtle">{flow.transforms.length === 1 ? flow.transforms[0] : `${flow.transforms.length} transforms`}</span>
                            <ArrowRight size={11} aria-hidden="true" className="shrink-0 text-faint" />
                          </>
                        )}
                        <span className="min-w-0 truncate">{flow.target}</span>
                      </span>
                    </Td>
                    <Td className="max-w-[16rem]">
                      <StatusText tone={st.tone}>{st.label}</StatusText>
                      {st.key === 'broken' && (
                        <span className="block text-xs text-subtle" data-testid="route-broken">
                          {brokenSummary(route)}. <button type="button" className="text-accent-text underline underline-offset-2" onClick={() => openEditor(cloneRoute(route))}>Fix</button>
                        </span>
                      )}
                      {st.key === 'rejected' && (
                        <span className="block text-xs text-subtle">The historian refuses every point. Routed is only the local buffer.</span>
                      )}
                      {m.lastError && st.key !== 'paused' && (
                        <span className="mono block truncate text-xs text-subtle" title={m.lastError}>
                          {m.lastError}
                        </span>
                      )}
                    </Td>
                    <Td align="right" className="mono">
                      <Count value={m.matched} />
                    </Td>
                    <Td align="right" className="mono" data-testid="route-routed">
                      <Count value={m.routed ?? m.published} />
                    </Td>
                    <Td align="right" className="mono" data-testid="route-delivered">
                      <Count value={m.delivered ?? m.published} />
                    </Td>
                    <Td align="right" className="mono" data-testid="route-pending">
                      <Count value={m.pending} tone="warn" />
                    </Td>
                    <Td align="right" className="mono" data-testid="route-rejected">
                      <Count value={m.rejected} tone="bad" />
                    </Td>
                    <Td align="right" className="mono">
                      <Count value={m.loopBlocked} tone="warn" />
                    </Td>
                    <Td align="right" className="mono">
                      <Count value={m.errors} tone="bad" />
                    </Td>
                    <Td align="right" className="w-24 whitespace-nowrap">
                      <span className="inline-flex items-center justify-end gap-0.5">
                        <IconButton icon={route.enabled ? Power : Play} label={route.enabled ? `Pause route ${name}` : `Resume route ${name}`} size={14} onClick={() => toggle(route)} {...ro} />
                        <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} route ${name}`} size={14} onClick={() => openEditor(cloneRoute(route))} />
                        <IconButton icon={Trash2} label={`Delete route ${name}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={() => remove(route)} {...ro} />
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableSort>
      </ListState>

      {draft && (
        <Dialog
          title={draft.id ? (readOnly ? 'View route' : 'Edit route') : 'New route'}
          description="Each message matching the source filter passes through the transforms in order, then goes to the target."
          size="xl"
          onClose={closeEditor}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={closeEditor}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                {draft.id ? 'Save changes' : 'Save route'}
              </Button>
            </>
          }
        >
          <div className="space-y-6">
            {formError && (
              <Banner variant="error" title="Could not save the route">
                {formError}
              </Banner>
            )}

            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Source</legend>
              <Field label="Name" className="sm:col-span-2">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Normalize line 1" data-autofocus />
              </Field>
              <BrokerSelect label="Source broker" brokers={brokers} value={draft.source.brokerId} onChange={(v) => setDraft({ ...draft, source: { ...draft.source, brokerId: v } })} error={shown.broker} />
              <Field label="Source filter" error={shown.filter} help="MQTT wildcards: + for one level, # for the rest.">
                <Input
                  className="mono"
                  aria-invalid={shown.filter ? 'true' : undefined}
                  value={draft.source.filter}
                  onChange={(e) => setDraft({ ...draft, source: { ...draft.source, filter: e.target.value } })}
                  placeholder="raw/plant1/#"
                />
              </Field>
            </fieldset>

            <fieldset>
              <legend className="mb-1 text-sm font-medium text-fg">Transforms</legend>
              <p className="mb-2 text-xs text-subtle">Applied in order, top to bottom. With none, the message is forwarded unchanged.</p>
              {draft.transforms.length > 0 && (
                <ol className="divide-y divide-line rounded-md border border-line bg-app" aria-label="Transform chain">
                  {draft.transforms.map((t, i) => (
                    <TransformRow
                      key={t._uid}
                      t={t}
                      index={i}
                      count={draft.transforms.length}
                      readOnly={readOnly}
                      onChange={(next) => setTransforms(draft.transforms.map((x, j) => (j === i ? next : x)))}
                      onRemove={() => setTransforms(draft.transforms.filter((_, j) => j !== i))}
                      onMove={(from, to) => setTransforms(moveItem(draft.transforms, from, to))}
                    />
                  ))}
                </ol>
              )}
              <div className="mt-2 w-60 max-w-full">
                <Select aria-label="Add a transform" value="" disabled={readOnly} onChange={(e) => e.target.value && setTransforms([...draft.transforms, newTransform(e.target.value)])}>
                  <option value="">Add a transform…</option>
                  {Object.entries(TRANSFORM_META).map(([k, meta]) => (
                    <option key={k} value={k}>
                      {meta.label}
                    </option>
                  ))}
                </Select>
              </div>
            </fieldset>

            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Target</legend>
              <Select
                label="Type"
                value={draft.target.type}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    target: e.target.value === 'mqtt' ? { type: 'mqtt', brokerId: brokers[0]?.id || '', retain: false } : { type: 'historian', historianId: historians[0]?.id || '' }
                  })
                }
              >
                <option value="mqtt">Publish to a broker</option>
                <option value="historian">Write to a historian</option>
              </Select>
              {draft.target.type === 'mqtt' ? (
                <>
                  <BrokerSelect label="Broker" brokers={brokers} value={draft.target.brokerId} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, brokerId: v } })} />
                  <Checkbox className="sm:col-span-2" label="Publish as retained messages" checked={draft.target.retain} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, retain: v } })} />
                </>
              ) : (
                <Select label="Historian" value={draft.target.historianId} error={shown.historian} onChange={(e) => setDraft({ ...draft, target: { ...draft.target, historianId: e.target.value } })}>
                  {historians.length === 0 && <option value="">Add one on the Historians tab</option>}
                  {historians.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name || h.url} ({h.type})
                    </option>
                  ))}
                </Select>
              )}
            </fieldset>

            {offerTvq && (
              <Banner
                variant="warn"
                title="This topic carries a value/time/quality envelope"
                action={
                  <Button size="sm" variant="secondary" onClick={() => setTransforms([...draft.transforms, { ...newTransform('numeric'), field: 'v' }])}>
                    <Plus size={12} aria-hidden="true" /> Add numeric transform on v
                  </Button>
                }
              >
                <Mono>{tvqTopic}</Mono> looks like <Mono>{'{ v, t, q }'}</Mono>. A historian stores a JSON object as <b className="font-medium text-fg">text</b>, not a number, so the history could not be trended. A
                numeric transform on field <Mono>v</Mono> writes the value itself (a message whose v is not a number is dropped).
              </Banner>
            )}

            <section aria-labelledby="route-preview-heading" className="border-t border-line pt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 id="route-preview-heading" className="text-sm font-medium text-fg">
                    Dry run
                  </h3>
                  <p className="text-xs text-subtle">Runs the current settings on recent messages. Nothing is published.</p>
                </div>
                <Button variant="secondary" onClick={runPreview} loading={previewing} disabled={!draft.source.filter.trim()}>
                  Run dry run
                </Button>
              </div>
              {preview && <PreviewTable preview={preview} />}
            </section>
          </div>
        </Dialog>
      )}
      {conflictDialog}
      {confirmDialog}
    </>
  );
}

const compact = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** Input and output of the chain side by side, one row per observed topic. */
function PreviewTable({ preview }) {
  const rows = preview.rows || [];
  return (
    <div role="region" aria-label="Dry-run preview">
      <p className="mb-2 text-xs text-muted">
        <span className="tabular-nums text-fg">{(preview.matchCount ?? 0).toLocaleString()}</span> observed topics match
        {preview.error && <span className="text-bad"> · {preview.error}</span>}
        {rows.length > 0 && rows.length < (preview.matchCount ?? 0) && ` · showing ${rows.length}`}
      </p>
      {rows.length > 0 && (
        <Table caption="Dry-run: input and output per topic" wrapperClassName="max-h-64 overflow-y-auto" className="min-w-[40rem]">
          <THead>
            <Th>Input</Th>
            <Th>Output</Th>
            <Th>Result</Th>
          </THead>
          <tbody>
            {rows.map((r, i) => (
              <Tr key={i}>
                <Td className="max-w-[18rem] align-top">
                  <span className="mono block truncate text-xs text-fg" title={r.inTopic}>
                    {r.inTopic}
                  </span>
                  <span className="mono block truncate text-xs text-subtle" title={compact(r.inPayload)}>
                    {compact(r.inPayload)}
                  </span>
                </Td>
                <Td className="max-w-[18rem] align-top">
                  {r.dropped ? (
                    <span className="text-xs text-subtle">No output</span>
                  ) : (
                    <>
                      <span className="mono block truncate text-xs text-fg" title={r.outTopic}>
                        {r.outTopic}
                      </span>
                      <span className="mono block truncate text-xs text-subtle" title={compact(r.outPayload)}>
                        {compact(r.outPayload)}
                      </span>
                    </>
                  )}
                </Td>
                <Td className="align-top">{r.loop ? <StatusText tone="bad">Would loop, blocked</StatusText> : r.dropped ? <StatusText tone="warn">Dropped by a transform</StatusText> : <StatusText tone="good">Delivered</StatusText>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
