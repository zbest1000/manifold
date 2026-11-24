import { useState } from 'react';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Input, Field, Select, Badge, IconButton, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { BrokerSelect, ListState } from './shared';
import { RowActions } from '@/components/ui';
import { blankModel, brokerName, cleanModel, cloneModel, modelSaveable } from './helpers';

export default function ModelsTab({ brokers }) {
  const [draft, setDraft] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const { data, error, loading, reload } = usePolled(() => api.listModels(), { interval: 5000 });
  const models = data?.models || [];
  const status = data?.status || {};

  const save = async () => {
    try {
      await api.saveModel(cleanModel(draft));
      setDraft(null);
      reload();
      toast.success('Model saved');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const remove = async (m) => {
    const ok = await confirm({ title: `Delete model "${m.name || m.target.topic}"?`, message: 'It stops publishing its merged object immediately.', confirmLabel: 'Delete model', danger: true });
    if (!ok) return;
    try {
      await api.deleteModel(m.id);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const patchAttr = (i, fn) => setDraft({ ...draft, attributes: draft.attributes.map((x, j) => (j === i ? fn(x) : x)) });
  const newModel = () => setDraft(blankModel(brokers));

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={models.length}
        label="models"
        empty={
          draft
            ? null
            : {
                icon: Boxes,
                title: 'No models yet',
                hint: 'A model binds attributes from many raw topics (even across brokers) and publishes them as one merged object at a clean UNS path — ten raw topics become one Pump-7.',
                action: (
                  <Button onClick={newModel}>
                    <Plus size={15} aria-hidden="true" /> Create the first model
                  </Button>
                )
              }
        }
      >
        <Table caption="Models">
          <THead>
            <Th>Model</Th>
            <Th>Target</Th>
            <Th align="right">Status</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {models.map((m) => {
              const s = status[m.id] || {};
              const name = m.name || m.target.topic;
              return (
                <Tr key={m.id} highlight={draft?.id === m.id}>
                  <Td header>
                    <span className="block max-w-[14rem] truncate text-slate-100">{name}</span>
                    <Badge status={m.enabled ? 'connected' : 'disconnected'} className="mt-1">
                      {m.publishMode}
                    </Badge>
                  </Td>
                  <Td className="max-w-[24rem]">
                    <p className="truncate font-mono text-xs text-muted">
                      {m.attributes.length} attribute(s) → {brokerName(brokers, m.target.brokerId)} · {m.target.topic}
                    </p>
                    {s.lastError && <p className="mt-1 text-xs text-rose-300">{s.lastError}</p>}
                  </Td>
                  <Td align="right" className="whitespace-nowrap font-mono text-xs text-muted">
                    {s.boundAttributes ?? 0}/{m.attributes.length} bound · {s.publishes || 0} pub
                    {s.errors ? <span className="text-rose-300"> · {s.errors} err</span> : null}
                  </Td>
                  <Td align="right">
                    <RowActions what={`model ${name}`} onEdit={() => setDraft(cloneModel(m))} onDelete={() => remove(m)} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      {!draft && models.length > 0 && (
        <Button variant="outline" onClick={newModel}>
          <Plus size={14} aria-hidden="true" /> New model
        </Button>
      )}
      {draft && (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-100">{draft.id ? 'Edit model' : 'New model'}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Pump-7" />
            </Field>
            <BrokerSelect label="Target broker" brokers={brokers} value={draft.target.brokerId} onChange={(v) => setDraft({ ...draft, target: { ...draft.target, brokerId: v } })} />
            <Field label="Target topic (UNS path)">
              <Input value={draft.target.topic} onChange={(e) => setDraft({ ...draft, target: { ...draft.target, topic: e.target.value } })} placeholder="site/area/line/pump7" />
            </Field>
            <Select label="Publish" value={draft.publishMode} onChange={(e) => setDraft({ ...draft, publishMode: e.target.value })}>
              <option value="on-change">on change (debounced)</option>
              <option value="interval">on interval</option>
            </Select>
            {draft.publishMode === 'interval' && (
              <Field label="Interval (ms)">
                <Input type="number" value={draft.intervalMs} onChange={(e) => setDraft({ ...draft, intervalMs: e.target.value })} />
              </Field>
            )}
          </div>
          <h3 className="label-xs mb-1.5 mt-4">Attributes</h3>
          <div className="space-y-2">
            {draft.attributes.map((a, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5">
                <Input aria-label={`Attribute ${i + 1} name`} value={a.name} onChange={(e) => patchAttr(i, (x) => ({ ...x, name: e.target.value }))} placeholder="rpm" className="w-28" />
                <BrokerSelect aria-label={`Attribute ${i + 1} broker`} brokers={brokers} value={a.source.brokerId} wrapperClassName="w-44 max-w-full" onChange={(v) => patchAttr(i, (x) => ({ ...x, source: { ...x.source, brokerId: v } }))} />
                <Input
                  aria-label={`Attribute ${i + 1} source topic`}
                  value={a.source.topic}
                  onChange={(e) => patchAttr(i, (x) => ({ ...x, source: { ...x.source, topic: e.target.value } }))}
                  placeholder="raw/pump7/rpm"
                  className="min-w-56 flex-1"
                />
                <Input
                  aria-label={`Attribute ${i + 1} source field (optional)`}
                  value={a.source.field}
                  onChange={(e) => patchAttr(i, (x) => ({ ...x, source: { ...x.source, field: e.target.value } }))}
                  placeholder="field (opt)"
                  className="w-28"
                />
                <IconButton
                  icon={Trash2}
                  label={`Remove attribute ${i + 1}`}
                  size={14}
                  className="hover:bg-rose-500/10 hover:text-rose-300"
                  onClick={() => setDraft({ ...draft, attributes: draft.attributes.filter((_, j) => j !== i) })}
                />
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, attributes: [...draft.attributes, { name: '', source: { brokerId: brokers[0]?.id || '', topic: '', field: '' } }] })}>
              <Plus size={12} aria-hidden="true" /> Add attribute
            </Button>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={save} disabled={!modelSaveable(draft)}>
              {draft.id ? 'Save changes' : 'Save model'}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {confirmDialog}
    </>
  );
}
