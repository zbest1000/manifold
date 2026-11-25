import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Input, Field, Select, Checkbox, Banner, IconButton, Dialog, StatusText, Path, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { BrokerSelect, Count, ListState, RowButtons, TabToolbar, useRo } from './shared';
import { blankModel, brokenSummary, brokerName, cleanModel, cloneModel, modelSaveable } from './helpers';
import { useConflict } from '@/components/ConflictDialog';

/** Models: several raw topics merged into one object published at a clean UNS path. */
export default function ModelsTab({ brokers }) {
  const [draft, setDraft] = useState(null);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const { resolveConflict, conflictDialog } = useConflict();
  const [saving, setSaving] = useState(false);
  const ro = useRo();
  const readOnly = Boolean(ro.disabled);
  const { data, error, loading, reload } = usePolled(() => api.listModels(), { interval: 5000 });
  const models = data?.models || [];
  const status = data?.status || {};

  const open = (m) => {
    setAttempted(false);
    setFormError(null);
    setDraft(m);
  };
  const close = () => {
    setDraft(null);
    setFormError(null);
  };

  const problems = {};
  if (draft) {
    if (!draft.target.topic.trim()) problems.topic = 'Enter the topic the merged object is published to, for example site/area/line/pump7.';
    if (!draft.attributes.some((a) => a.name && a.source.topic)) problems.attributes = 'Add at least one attribute with a name and a source topic.';
  }
  const shown = attempted ? problems : {};

  const save = async () => {
    if (saving || readOnly) return;
    setAttempted(true);
    if (Object.keys(problems).length || !modelSaveable(draft)) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = cleanModel(draft); // carries `rev`: a save over a newer version is refused (409), never silent
      try {
        await api.saveModel(payload);
      } catch (e) {
        const choice = await resolveConflict(e, { what: 'model', mine: payload });
        if (choice === null) throw e;
        if (choice === 'cancel') return;
        if (choice === 'theirs') {
          if (e.current) setDraft(cloneModel(e.current));
          toast('Showing the saved version');
          return;
        }
        await api.saveModel({ ...payload, rev: e.current?.rev });
      }
      close();
      reload();
      toast.success('Model saved');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (m) => {
    const ok = await confirm({
      title: `Delete model "${m.name || m.target.topic}"?`,
      message: `It stops publishing the merged object to ${m.target.topic}. The last retained message on the broker is not cleared.`,
      confirmLabel: 'Delete model',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteModel(m.id);
      reload();
      toast.success('Model deleted');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const patchAttr = (i, fn) => setDraft({ ...draft, attributes: draft.attributes.map((x, j) => (j === i ? fn(x) : x)) });
  const newModel = () => open(blankModel(brokers));
  const live = models.filter((m) => m.enabled && !status[m.id]?.lastError).length;

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={models.length}
        label="models"
        empty={{
          title: 'No models yet',
          hint: 'A model binds attributes from many raw topics, even across brokers, and publishes them as one merged object at a clean UNS path. Ten raw topics become one Pump-7.',
          action: (
            <Button onClick={newModel} {...ro}>
              <Plus size={14} aria-hidden="true" /> Create the first model
            </Button>
          )
        }}
      >
        <TabToolbar summary={`${live} of ${models.length} publishing`}>
          <Button onClick={newModel} {...ro}>
            <Plus size={14} aria-hidden="true" /> New model
          </Button>
        </TabToolbar>
        <Table caption="Models" className="min-w-[52rem]">
          <THead>
            <Th>Model</Th>
            <Th>State</Th>
            <Th>Publishes</Th>
            <Th align="right">Bound</Th>
            <Th align="right">Published</Th>
            <Th align="right">Errors</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {models.map((m) => {
              const s = status[m.id] || {};
              const name = m.name || m.target.topic;
              const failing = m.enabled && s.lastError;
              return (
                <Tr key={m.id} highlight={draft?.id === m.id}>
                  <Td header className="max-w-[22rem]">
                    <span className="block truncate font-medium text-fg">{name}</span>
                    <Path value={`${brokerName(brokers, m.target.brokerId)}: ${m.target.topic}`} className="text-muted" />
                  </Td>
                  <Td className="max-w-[16rem]">
                    {m.broken?.length ? (
                      <>
                        <StatusText tone="bad">Broken reference</StatusText>
                        <span className="block text-xs text-subtle" data-testid="model-broken">
                          {brokenSummary(m)}. <button type="button" className="text-accent-text underline underline-offset-2" onClick={() => open(cloneModel(m))}>Fix</button>
                        </span>
                      </>
                    ) : (
                      <StatusText tone={!m.enabled ? 'neutral' : failing ? 'bad' : 'good'}>{!m.enabled ? 'Paused' : failing ? 'Failing' : 'Publishing'}</StatusText>
                    )}
                    {s.lastError && (
                      <span className="mono block truncate text-xs text-subtle" title={s.lastError}>
                        {s.lastError}
                      </span>
                    )}
                  </Td>
                  <Td className="text-xs text-muted">{m.publishMode === 'interval' ? `Every ${Number(m.intervalMs).toLocaleString()} ms` : 'On change'}</Td>
                  <Td align="right" className="mono tabular-nums">
                    {s.boundAttributes ?? 0} / {m.attributes.length}
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={s.publishes} />
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={s.errors} tone="bad" />
                  </Td>
                  <Td align="right" className="w-24">
                    <RowButtons what={`model ${name}`} onEdit={() => open(cloneModel(m))} onDelete={() => remove(m)} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      {draft && (
        <Dialog
          title={draft.id ? (readOnly ? 'View model' : 'Edit model') : 'New model'}
          description="Merges the attributes below into one object and publishes it to the target topic."
          size="xl"
          onClose={close}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                {draft.id ? 'Save changes' : 'Save model'}
              </Button>
            </>
          }
        >
          <div className="space-y-6">
            {formError && (
              <Banner variant="error" title="Could not save the model">
                {formError}
              </Banner>
            )}
            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Target</legend>
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Pump-7" data-autofocus />
              </Field>
              <BrokerSelect label="Target broker" brokers={brokers} value={draft.target.brokerId} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, brokerId: v } })} />
              <Field label="Target topic (UNS path)" error={shown.topic} className="sm:col-span-2">
                <Input
                  className="mono"
                  aria-invalid={shown.topic ? 'true' : undefined}
                  value={draft.target.topic}
                  onChange={(e) => setDraft({ ...draft, target: { ...draft.target, topic: e.target.value } })}
                  placeholder="site/area/line/pump7"
                />
              </Field>
              <Select label="Publish" value={draft.publishMode} onChange={(e) => setDraft({ ...draft, publishMode: e.target.value })}>
                <option value="on-change">When a value changes (debounced)</option>
                <option value="interval">On a fixed interval</option>
              </Select>
              {draft.publishMode === 'interval' && (
                <Field label="Interval (ms)">
                  <Input className="mono" type="number" value={draft.intervalMs} onChange={(e) => setDraft({ ...draft, intervalMs: e.target.value })} />
                </Field>
              )}
              <Checkbox
                className="sm:col-span-2"
                label="Value/time/quality envelope"
                description="Publish each attribute as {v, t, q} so consumers can tell fresh, stale and never-seen values apart."
                checked={Boolean(draft.envelope)}
                onChange={(v) => setDraft({ ...draft, envelope: v })}
              />
              {draft.envelope && (
                <Field label="Stale after (ms)" help="An attribute older than this is published with quality 64 (uncertain); one never seen has quality 0.">
                  <Input className="mono" type="number" min="1" value={draft.staleMs ?? 60000} onChange={(e) => setDraft({ ...draft, staleMs: e.target.value })} />
                </Field>
              )}
              <Checkbox className="sm:col-span-2" label="Enabled" checked={draft.enabled !== false} onChange={(v) => setDraft({ ...draft, enabled: v })} />
            </fieldset>

            <fieldset>
              <legend className="mb-1 text-sm font-medium text-fg">Attributes</legend>
              <p className="mb-2 text-xs text-subtle">Each attribute becomes one field of the published object, read from a source topic.</p>
              <div className="rounded-md border border-line bg-app">
              <div aria-hidden="true" className="hidden gap-2 px-3 pt-2 text-xs text-muted sm:flex">
                <span className="w-28">Name</span>
                <span className="w-44">Source broker</span>
                <span className="min-w-56 flex-1">Source topic</span>
                <span className="w-32">Field</span>
                <span className="w-8" />
              </div>
              <ul className="divide-y divide-line" aria-label="Attributes">
                {draft.attributes.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <Input aria-label={`Attribute ${i + 1} name`} value={a.name} onChange={(e) => patchAttr(i, (x) => ({ ...x, name: e.target.value }))} placeholder="rpm" className="mono w-28" />
                    <BrokerSelect aria-label={`Attribute ${i + 1} broker`} brokers={brokers} value={a.source.brokerId} wrapperClassName="w-44 max-w-full" onChange={(v) => patchAttr(i, (x) => ({ ...x, source: { ...x.source, brokerId: v } }))} />
                    <Input
                      aria-label={`Attribute ${i + 1} source topic`}
                      value={a.source.topic}
                      onChange={(e) => patchAttr(i, (x) => ({ ...x, source: { ...x.source, topic: e.target.value } }))}
                      placeholder="raw/pump7/rpm"
                      className="mono min-w-56 flex-1"
                    />
                    <Input
                      aria-label={`Attribute ${i + 1} source field (optional)`}
                      value={a.source.field}
                      onChange={(e) => patchAttr(i, (x) => ({ ...x, source: { ...x.source, field: e.target.value } }))}
                      placeholder="field (optional)"
                      className="mono w-32"
                    />
                    <IconButton icon={Trash2} label={`Remove attribute ${i + 1}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={() => setDraft({ ...draft, attributes: draft.attributes.filter((_, j) => j !== i) })} />
                  </li>
                ))}
              </ul>
              </div>
              {shown.attributes && (
                <p role="alert" className="mt-1.5 text-xs text-bad">
                  {shown.attributes}
                </p>
              )}
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setDraft({ ...draft, attributes: [...draft.attributes, { name: '', source: { brokerId: brokers[0]?.id || '', topic: '', field: '' } }] })}>
                <Plus size={12} aria-hidden="true" /> Add attribute
              </Button>
            </fieldset>
          </div>
        </Dialog>
      )}
      {conflictDialog}
      {confirmDialog}
    </>
  );
}
