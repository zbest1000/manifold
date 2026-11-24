import { useCallback, useState } from 'react';
import { Workflow, Plus, Eye, Power } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Input, Field, Select, Badge, Checkbox, IconButton, Table, THead, Th, Tr, Td, Banner, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { useEngineMetrics, useTvqSample } from './hooks';
import { BrokerSelect, ListState } from './shared';
import TransformRow from './TransformRow';
import { Pencil, Trash2 } from 'lucide-react';
import { TRANSFORM_DEFAULTS, blankRoute, brokerName, cloneRoute, hasTvqNumeric, routeSaveable, routeTargetLabel } from './helpers';

export default function RoutesTab({ brokers }) {
  const [metrics, setMetrics] = useState({});
  const [draft, setDraft] = useState(null); // null = closed editor
  const [preview, setPreview] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const [saving, setSaving] = useState(false);
  const readOnly = useReadOnly();
  const ro = readOnly ? { disabled: true, title: READ_ONLY_REASON } : {};

  const { data, error, loading, reload } = usePolled(
    async () => {
      const [routes, hist] = await Promise.all([api.listPipelines(), api.listHistorians()]);
      setMetrics(routes.metrics || {});
      return { routes: routes.routes || [], historians: hist.historians || [] };
    },
    { interval: 15000 } // config only — numbers stream in below
  );
  useEngineMetrics(useCallback((m) => setMetrics((prev) => m.pipelines || prev), []));

  const routes = data?.routes || [];
  const historians = data?.historians || [];

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.savePipeline(draft);
      setDraft(null);
      setPreview(null);
      reload();
      toast.success('Route saved');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    try {
      setPreview(await api.previewPipeline(draft));
    } catch (e) {
      toast.error(e.message);
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
      message: 'It stops routing immediately.',
      confirmLabel: 'Delete route',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deletePipeline(route.id);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const edit = (route) => {
    setPreview(null);
    setDraft(cloneRoute(route));
  };

  const newRoute = () => setDraft(blankRoute(brokers));
  const toHistorian = draft?.target.type === 'historian';
  const tvqTopic = useTvqSample({ brokerId: draft?.source.brokerId, filter: draft?.source.filter, enabled: Boolean(toHistorian) });
  const offerTvq = Boolean(tvqTopic) && !hasTvqNumeric(draft?.transforms);

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={routes.length}
        label="pipeline routes"
        empty={
          draft
            ? null
            : {
                icon: Workflow,
                title: 'No pipeline routes yet',
                hint: 'A route consumes a topic filter, runs it through transforms (re-path, reshape, scale, flatten), and publishes to a broker or writes to a historian.',
                action: (
                  <Button onClick={newRoute} {...ro}>
                    <Plus size={15} aria-hidden="true" /> Create the first route
                  </Button>
                )
              }
        }
      >
        <Table caption="Pipeline routes">
          <THead>
            <Th>Route</Th>
            <Th>Flow</Th>
            <Th align="right">Traffic</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {routes.map((route) => {
              const m = metrics[route.id] || {};
              const name = route.name || route.source.filter;
              return (
                <Tr key={route.id} highlight={draft?.id === route.id}>
                  <Td header>
                    <span className="block max-w-[14rem] truncate text-slate-100">{name}</span>
                    <Badge status={route.enabled ? 'connected' : 'disconnected'} className="mt-1">
                      {route.enabled ? 'running' : 'paused'}
                    </Badge>
                  </Td>
                  <Td className="max-w-[24rem]">
                    <p className="truncate font-mono text-xs text-muted" title={`${route.source.filter} → ${routeTargetLabel(route, brokers, historians)}`}>
                      {brokerName(brokers, route.source.brokerId)} · {route.source.filter} → {routeTargetLabel(route, brokers, historians)}
                      {route.transforms?.length ? ` · ${route.transforms.map((t) => t.type).join(' → ')}` : ''}
                    </p>
                    {m.lastError && <p className="mt-1 truncate text-xs text-rose-300">{m.lastError}</p>}
                  </Td>
                  <Td align="right" className="whitespace-nowrap font-mono text-xs text-muted">
                    <span title="matched / delivered / errors / loop-blocked">
                      {m.matched || 0} in · {m.published || 0} out · <span className={m.errors ? 'text-rose-300' : ''}>{m.errors || 0} err</span>
                      {m.loopBlocked ? <span className="text-amber-300"> · {m.loopBlocked} loop</span> : null}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="inline-flex items-center justify-end gap-1">
                      <IconButton icon={Power} label={route.enabled ? `Pause route ${name}` : `Resume route ${name}`} size={14} onClick={() => toggle(route)} {...ro} />
                      <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} route ${name}`} size={14} onClick={() => edit(route)} />
                      <IconButton icon={Trash2} label={`Delete route ${name}`} size={14} className="hover:bg-rose-500/10 hover:text-rose-300" onClick={() => remove(route)} {...ro} />
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      {!draft && routes.length > 0 && (
        <Button variant="outline" onClick={newRoute} {...ro}>
          <Plus size={14} aria-hidden="true" /> New route
        </Button>
      )}

      {draft && (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-100">{draft.id ? 'Edit route' : 'New route'}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="normalize line1" />
            </Field>
            <BrokerSelect label="Source broker" brokers={brokers} value={draft.source.brokerId} onChange={(v) => setDraft({ ...draft, source: { ...draft.source, brokerId: v } })} />
            <Field label="Source filter" className="sm:col-span-2">
              <Input value={draft.source.filter} onChange={(e) => setDraft({ ...draft, source: { ...draft.source, filter: e.target.value } })} placeholder="raw/plant1/#" />
            </Field>
          </div>

          <h3 className="label-xs mb-1.5 mt-4">Transforms (in order)</h3>
          <div className="space-y-2">
            {draft.transforms.map((t, i) => (
              <TransformRow
                key={i}
                t={t}
                index={i}
                onChange={(next) => setDraft({ ...draft, transforms: draft.transforms.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => setDraft({ ...draft, transforms: draft.transforms.filter((_, j) => j !== i) })}
              />
            ))}
            <Select
              aria-label="Add a transform"
              value=""
              wrapperClassName="block w-56 max-w-full" className="py-1.5 text-xs"
              onChange={(e) => e.target.value && setDraft({ ...draft, transforms: [...draft.transforms, { ...TRANSFORM_DEFAULTS[e.target.value] }] })}
            >
              <option value="">+ add transform…</option>
              {Object.keys(TRANSFORM_DEFAULTS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>

          <h3 className="label-xs mb-1.5 mt-4">Target</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              <option value="mqtt">Publish to broker</option>
              <option value="historian">Write to historian</option>
            </Select>
            {draft.target.type === 'mqtt' ? (
              <>
                <BrokerSelect label="Broker" brokers={brokers} value={draft.target.brokerId} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, brokerId: v } })} />
                <div className="flex items-end pb-2">
                  <Checkbox label="Retain" checked={draft.target.retain} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, retain: v } })} />
                </div>
              </>
            ) : (
              <Select label="Historian" value={draft.target.historianId} onChange={(e) => setDraft({ ...draft, target: { ...draft.target, historianId: e.target.value } })}>
                {historians.length === 0 && <option value="">configure one in the Historians tab</option>}
                {historians.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name || h.url} ({h.type})
                  </option>
                ))}
              </Select>
            )}
          </div>

          {offerTvq && (
            <Banner
              variant="warn"
              title="This topic carries a value/time/quality envelope"
              className="mt-3"
              action={
                <Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, transforms: [...draft.transforms, { type: 'numeric', field: 'v' }] })}>
                  <Plus size={12} aria-hidden="true" /> Add numeric transform on v
                </Button>
              }
            >
              <span className="mono">{tvqTopic}</span> looks like <span className="mono">{'{ v, t, q }'}</span>. A historian stores a JSON object as <b>text</b>, not a number,
              so the history could not be trended. A <span className="mono">numeric</span> transform on field <span className="mono">v</span> writes the value itself (a message whose v is not a
              number is dropped).
            </Banner>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={runPreview} disabled={!draft.source.filter}>
              <Eye size={14} aria-hidden="true" /> Dry-run preview
            </Button>
            <Button onClick={save} disabled={!routeSaveable(draft) || saving || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
              {draft.id ? 'Save changes' : 'Save route'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setPreview(null);
              }}
            >
              Cancel
            </Button>
          </div>

          {preview && (
            <div className="mt-3 rounded-xl border border-white/10 bg-surface-950/60 p-3" role="region" aria-label="Dry-run preview">
              <p className="mb-2 text-xs text-muted">
                Matches <span className="font-semibold text-slate-200">{preview.matchCount?.toLocaleString?.() ?? 0}</span> observed topics
                {preview.error && <span className="text-rose-300"> · {preview.error}</span>}
              </p>
              <div className="max-h-56 space-y-1 overflow-y-auto font-mono text-xs">
                {(preview.rows || []).map((r, i) => (
                  <div key={i} className={clsx('rounded-lg px-2 py-1', r.loop ? 'bg-rose-500/10' : 'bg-black/20')}>
                    <span className="break-all text-muted">{r.inTopic}</span>
                    <span className="mx-1 text-faint" aria-label="becomes">
                      →
                    </span>
                    {r.dropped ? (
                      <span className="text-amber-300">dropped by transform</span>
                    ) : (
                      <span className={clsx('break-all', r.loop ? 'text-rose-300' : 'text-emerald-300')}>
                        {r.outTopic}
                        {r.loop ? ' (would loop — blocked)' : ''}
                      </span>
                    )}
                    {!r.dropped && <div className="truncate text-subtle">{JSON.stringify(r.outPayload)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
      {confirmDialog}
    </>
  );
}
