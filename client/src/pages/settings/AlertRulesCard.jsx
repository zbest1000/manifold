import { useRef, useState } from 'react';
import { BellRing, Plus, Check, Pencil, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Input, Field, Select, Banner, LoadingState, IconButton, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { EMPTY_RULE_FORM, RULE_LABEL, VALUE_OPS, alertStatusClass, formFromRule, ruleBody, ruleScope } from './helpers';

// Alert rules: watch the namespace actively — a branch going quiet, a specific
// topic dying, or unexpected topics appearing. Rules are evaluated server-side
// every 15s; firings hit the socket, the events feed here, and (optionally) a
// webhook.
export default function AlertRulesCard() {
  const brokers = useStore((s) => s.brokers);
  const [form, setForm] = useState(EMPTY_RULE_FORM);
  const [busy, setBusy] = useState(false);
  const readOnly = useReadOnly();
  const formRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();
  const connected = brokers.filter((b) => b.status === 'connected');

  const rulesQ = usePolled(() => api.listAlertRules());
  const eventsQ = usePolled(() => api.alertEvents(50), { interval: 10_000 });
  const rules = rulesQ.data?.rules || [];
  const events = eventsQ.data?.events || [];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e) => {
    e.preventDefault();
    if (busy || readOnly) return;
    setBusy(true);
    try {
      await api.saveAlertRule(ruleBody(form, connected[0]?.id));
      setForm((f) => ({ ...EMPTY_RULE_FORM, type: f.type, brokerId: f.brokerId, thresholdSec: f.thresholdSec }));
      rulesQ.reload();
      toast.success('Alert rule saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    const ok = await confirm({ title: `Delete alert rule "${r.name || RULE_LABEL[r.type]}"?`, message: 'It stops being evaluated immediately.', confirmLabel: 'Delete rule', danger: true });
    if (!ok) return;
    try {
      await api.deleteAlertRule(r.id);
      if (form.id === r.id) setForm(EMPTY_RULE_FORM);
      rulesQ.reload();
      toast.success('Alert rule deleted');
    } catch (err) {
      toast.error(err.message);
    }
  };

  // The editor sits below the table: bring it into view and focus it, or "Edit" appears to do nothing.
  const editRule = (r) => {
    setForm(formFromRule(r));
    setTimeout(() => {
      formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      formRef.current?.querySelector('select, input')?.focus();
    }, 0);
  };

  const brokerName = (id) => brokers.find((b) => b.id === id)?.name || id?.slice(0, 8) || '—';

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <BellRing size={16} className="text-accent-400" aria-hidden="true" /> Alert rules
      </h2>
      <p className="mb-3 text-sm text-muted">
        Watch the namespace actively: get notified when a branch goes silent, a topic stops publishing, or new topics appear where they shouldn&apos;t.
        Evaluated server-side; optional webhook per rule.
      </p>

      {rulesQ.error && (
        <Banner variant="error" title="Could not load alert rules" onRetry={rulesQ.reload} className="mb-3">
          {rulesQ.error.message}
        </Banner>
      )}
      {rulesQ.loading && !rulesQ.data && !rulesQ.error && <LoadingState label="alert rules" rows={1} className="mb-3" />}

      {rules.length > 0 && (
        <Table caption="Alert rules" wrapperClassName="mb-4">
          <THead>
            <Th>Rule</Th>
            <Th>Watches</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {rules.map((r) => (
              <Tr key={r.id} highlight={form.id === r.id}>
                <Td header>
                  <span className="block text-slate-100">{r.name || RULE_LABEL[r.type]}</span>
                  <span className="helper block">{RULE_LABEL[r.type]}</span>
                </Td>
                <Td className="max-w-[22rem] text-xs text-muted">
                  {brokerName(r.brokerId)} · {ruleScope(r)}
                  {r.webhookUrl && ' · webhook'}
                </Td>
                <Td align="right">
                  <span className="inline-flex items-center justify-end gap-1">
                    <IconButton icon={Pencil} size={14} label={`${readOnly ? 'View' : 'Edit'} alert rule ${r.name || RULE_LABEL[r.type]}`} onClick={() => editRule(r)} />
                    <IconButton icon={Trash2} size={14} label={`Delete alert rule ${r.name || RULE_LABEL[r.type]}`} className="hover:bg-rose-500/10 hover:text-rose-300" onClick={() => remove(r)} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} />
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <form ref={formRef} onSubmit={save} aria-label={form.id ? 'Edit alert rule' : 'Add alert rule'} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select label="Type" value={form.type} onChange={(e) => set({ type: e.target.value })}>
          {Object.entries(RULE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select label="Broker" value={form.brokerId || connected[0]?.id || ''} onChange={(e) => set({ brokerId: e.target.value })}>
          {connected.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          {connected.length === 0 && <option value="">no connected brokers</option>}
        </Select>
        {form.type === 'branch-silent' && (
          <Field label="Branch path">
            <Input placeholder="plant/line1 (empty = whole namespace)" value={form.path} onChange={(e) => set({ path: e.target.value })} />
          </Field>
        )}
        {form.type === 'topic-silent' && (
          <Field label="Topic">
            <Input placeholder="plant/line1/temp" value={form.topic} onChange={(e) => set({ topic: e.target.value })} required />
          </Field>
        )}
        {form.type === 'new-topic' && (
          <Field label="Prefix (optional)">
            <Input placeholder="plant/" value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} />
          </Field>
        )}
        {(form.type === 'branch-silent' || form.type === 'topic-silent') && (
          <Field label="Threshold (s)">
            <Input type="number" min="5" value={form.thresholdSec} onChange={(e) => set({ thresholdSec: e.target.value })} />
          </Field>
        )}
        {form.type === 'value-threshold' && (
          <>
            <Field label="Topic (exact or +/# filter)">
              <Input placeholder="plant/+/temp" value={form.topic} onChange={(e) => set({ topic: e.target.value })} required />
            </Field>
            <Field label="Field (optional dot-path)">
              <Input placeholder="v or data.temp (empty = payload)" value={form.field} onChange={(e) => set({ field: e.target.value })} />
            </Field>
            <Select label="Operator" value={form.op} onChange={(e) => set({ op: e.target.value })} options={VALUE_OPS} />
            <Field label="Value">
              <Input type="number" step="any" placeholder="80" value={form.value} onChange={(e) => set({ value: e.target.value })} required />
            </Field>
            <Field label="Sustain (s, optional)">
              <Input type="number" min="0" step="any" placeholder="0 = immediate" value={form.sustainSec} onChange={(e) => set({ sustainSec: e.target.value })} />
            </Field>
            <Field label="Clear value (optional)">
              <Input type="number" step="any" placeholder="hysteresis clear level" value={form.clearValue} onChange={(e) => set({ clearValue: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="Webhook URL (optional)" className="sm:col-span-2">
          <Input placeholder="https://hooks.example.com/…" value={form.webhookUrl} onChange={(e) => set({ webhookUrl: e.target.value })} />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={busy || connected.length === 0 || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
            {form.id ? (
              <>
                <Check size={14} aria-hidden="true" /> Save rule
              </>
            ) : (
              <>
                <Plus size={14} aria-hidden="true" /> Add rule
              </>
            )}
          </Button>
          {form.id && (
            <Button type="button" variant="ghost" onClick={() => setForm(EMPTY_RULE_FORM)}>
              Cancel
            </Button>
          )}
        </div>
      </form>
      {connected.length === 0 && <p className="helper mt-2">Connect an MQTT broker first — rules watch a live broker.</p>}

      {eventsQ.error && (
        <Banner variant="error" title="Could not load recent alerts" onRetry={eventsQ.reload} className="mt-4">
          {eventsQ.error.message}
        </Banner>
      )}
      {events.length > 0 && (
        <div className="mt-4">
          <h3 className="label-xs mb-2">Recent alerts</h3>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {events.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-1.5 text-xs">
                <span className="min-w-0 truncate">
                  <span className={clsx('mr-2 font-semibold', alertStatusClass(e.status))}>{e.status}</span>
                  <span className="text-slate-300">{e.ruleName}</span>
                  <span className="ml-2 text-muted">{e.detail}</span>
                </span>
                <span className="shrink-0 text-subtle" title={`${new Date(e.ts).toLocaleString()} (local) · ${new Date(e.ts).toISOString()}`}>{formatDistanceToNow(e.ts, { addSuffix: true })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {confirmDialog}
    </Card>
  );
}
