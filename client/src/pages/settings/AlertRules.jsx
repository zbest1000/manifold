import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Input, Field, Select, Banner, Dialog, EmptyState, IconButton, LoadingState, Panel, StatusText, Timestamp, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { EMPTY_RULE_FORM, RULE_LABEL, VALUE_OPS, alertTone, formFromRule, ruleBody, ruleScope, ruleStates } from './helpers';

const STATUS_LABEL = { firing: 'Firing', resolved: 'Resolved', event: 'Event' };

/**
 * Alert rules: watch the namespace actively (a branch going quiet, a topic dying, unexpected topics, a
 * value crossing a limit). Rules are evaluated on the server every 15 s; firings reach the events list
 * here and, optionally, a webhook. The webhook URL is a credential: a viewer session only learns that one is set.
 */
export default function AlertRules() {
  const brokers = useStore((s) => s.brokers);
  const [form, setForm] = useState(null); // null = dialog closed
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const readOnly = useReadOnly();
  const [confirm, confirmDialog] = useConfirm();
  const connected = brokers.filter((b) => b.status === 'connected');

  const rulesQ = usePolled(() => api.listAlertRules(), { interval: 15_000 });
  const eventsQ = usePolled(() => api.alertEvents(200), { interval: 10_000 });
  const rules = useMemo(() => rulesQ.data?.rules || [], [rulesQ.data]);
  const events = useMemo(() => eventsQ.data?.events || [], [eventsQ.data]);
  const states = useMemo(() => ruleStates(rules, events), [rules, events]);
  const firing = rules.filter((r) => states[r.id]?.key === 'firing').length;
  const webhookFailures = rulesQ.data?.webhookFailures || 0;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const brokerName = (id) => brokers.find((b) => b.id === id)?.name || id?.slice(0, 8) || '—';
  const addDisabled = readOnly || connected.length === 0;
  const addTitle = readOnly ? READ_ONLY_REASON : connected.length === 0 ? 'Rules watch a live broker: connect an MQTT broker first.' : undefined;

  const problems = {};
  if (form) {
    if ((form.type === 'topic-silent' || form.type === 'value-threshold') && !form.topic.trim()) problems.topic = form.type === 'topic-silent' ? 'Enter the topic to watch.' : 'Enter the topic or filter to watch.';
    if ((form.type === 'branch-silent' || form.type === 'topic-silent') && !(Number(form.thresholdSec) >= 5)) problems.thresholdSec = 'Use 5 seconds or more.';
    if (form.type === 'value-threshold' && !Number.isFinite(Number(form.value === '' ? NaN : form.value))) problems.value = 'Enter the limit as a number.';
  }
  const shown = attempted ? problems : {};

  const openForm = (rule) => {
    setAttempted(false);
    setFormError(null);
    setForm(rule ? formFromRule(rule) : { ...EMPTY_RULE_FORM, brokerId: connected[0]?.id || '' });
  };
  const closeForm = () => {
    setForm(null);
    setFormError(null);
  };

  const save = async () => {
    if (busy || readOnly) return;
    setAttempted(true);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.saveAlertRule(ruleBody(form, connected[0]?.id));
      closeForm();
      rulesQ.reload();
      toast.success('Alert rule saved');
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    const ok = await confirm({
      title: `Delete alert rule "${r.name || RULE_LABEL[r.type]}"?`,
      message: 'The rule stops being evaluated immediately and its webhook is no longer called. Past alerts stay in the list below.',
      confirmLabel: 'Delete rule',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteAlertRule(r.id);
      rulesQ.reload();
      toast.success('Alert rule deleted');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="space-y-4">
      {rulesQ.error && (
        <Banner variant="error" title="Could not load alert rules" onRetry={rulesQ.reload}>
          {rulesQ.error.message}
        </Banner>
      )}
      {webhookFailures > 0 && (
        <Banner variant="warn" title={`${webhookFailures.toLocaleString()} webhook ${webhookFailures === 1 ? 'delivery' : 'deliveries'} failed`}>
          Alerts fired but could not be delivered to a webhook. {rulesQ.data?.lastWebhookError && <span className="mono text-xs">Last error: {rulesQ.data.lastWebhookError}</span>}
        </Banner>
      )}
      {rulesQ.loading && !rulesQ.data && !rulesQ.error && <LoadingState label="alert rules" rows={2} />}

      {rulesQ.data && rules.length === 0 && (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState
            title="No alert rules yet"
            hint="Get told when a branch of the namespace goes silent, a topic stops publishing, a new topic appears where it should not, or a value crosses a limit."
            action={
              <Button onClick={() => openForm()} disabled={addDisabled} title={addTitle}>
                <Plus size={14} aria-hidden="true" /> Add rule
              </Button>
            }
          />
        </div>
      )}

      {rules.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-sm text-muted">
              {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
              {firing > 0 ? `, ${firing} firing` : ', none firing'}
            </p>
            <Button onClick={() => openForm()} disabled={addDisabled} title={addTitle}>
              <Plus size={14} aria-hidden="true" /> Add rule
            </Button>
          </div>
          <Table caption="Alert rules" className="min-w-[48rem]">
            <THead>
              <Th>Rule</Th>
              <Th>State</Th>
              <Th>Watches</Th>
              <Th>Webhook</Th>
              <Th srOnly align="right">Actions</Th>
            </THead>
            <tbody>
              {rules.map((r) => {
                const st = states[r.id];
                const name = r.name || RULE_LABEL[r.type];
                const hasHook = Boolean(r.webhookUrl || r.hasWebhook);
                return (
                  <Tr key={r.id} highlight={form?.id === r.id}>
                    <Td header>
                      <span className="block font-medium text-fg">{name}</span>
                      {r.name && <span className="block text-xs text-subtle">{RULE_LABEL[r.type]}</span>}
                    </Td>
                    <Td>
                      <StatusText tone={st.tone}>{st.label}</StatusText>
                      {st.key === 'firing' && (
                        <span className="block text-xs text-subtle">
                          since <Timestamp value={st.since} />
                        </span>
                      )}
                    </Td>
                    <Td className="max-w-[24rem] text-xs text-muted">
                      <span className="block truncate" title={`${brokerName(r.brokerId)} · ${ruleScope(r)}`}>
                        <span className="text-subtle">{brokerName(r.brokerId)}</span> <span className="mono">{ruleScope(r)}</span>
                      </span>
                    </Td>
                    <Td className="text-xs">{hasHook ? <span className="text-fg">Configured</span> : <span className="text-subtle">None</span>}</Td>
                    <Td align="right" className="w-24">
                      <span className="inline-flex items-center justify-end gap-0.5">
                        <IconButton icon={Pencil} size={14} label={`${readOnly ? 'View' : 'Edit'} alert rule ${name}`} onClick={() => openForm(r)} />
                        <IconButton icon={Trash2} size={14} label={`Delete alert rule ${name}`} className="hover:bg-bad/10 hover:text-bad" onClick={() => remove(r)} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} />
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </>
      )}

      {eventsQ.error && (
        <Banner variant="error" title="Could not load recent alerts" onRetry={eventsQ.reload}>
          {eventsQ.error.message}
        </Banner>
      )}
      {events.length > 0 && (
        <Panel title="Recent alerts" count={events.length} flush>
          <Table caption="Recent alerts, newest first" wrapperClassName="max-h-72 overflow-y-auto rounded-none border-0" className="min-w-[36rem]">
            <THead>
              <Th>State</Th>
              <Th>Rule</Th>
              <Th>Detail</Th>
              <Th align="right">When</Th>
            </THead>
            <tbody>
              {events.map((e, i) => (
                <Tr key={i}>
                  <Td className="py-1.5">
                    <StatusText tone={alertTone(e.status)}>{STATUS_LABEL[e.status] || e.status}</StatusText>
                  </Td>
                  <Td className="py-1.5 text-fg">{e.ruleName}</Td>
                  <Td className="max-w-[20rem] truncate py-1.5 text-xs text-muted" title={e.detail}>
                    {e.detail}
                  </Td>
                  <Td align="right" className="py-1.5 text-xs text-muted">
                    <span title={`${new Date(e.ts).toLocaleString()} (local) · ${new Date(e.ts).toISOString()}`}>
                      <Timestamp value={e.ts} />
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}

      {form && (
        <Dialog
          title={form.id ? (readOnly ? 'View alert rule' : 'Edit alert rule') : 'Add alert rule'}
          description="Evaluated on the server every 15 seconds."
          size="lg"
          onClose={closeForm}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={readOnly || connected.length === 0} title={readOnly ? READ_ONLY_REASON : undefined}>
                {form.id ? 'Save rule' : 'Add rule'}
              </Button>
            </>
          }
        >
          <fieldset disabled={readOnly} className="min-w-0 space-y-6">
            {formError && (
              <Banner variant="error" title="Could not save the rule">
                {formError}
              </Banner>
            )}
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <Select label="Type" value={form.type} onChange={(e) => set({ type: e.target.value })} data-autofocus>
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
                {connected.length === 0 && <option value="">No connected brokers</option>}
              </Select>
              <Field label="Name (optional)" className="sm:col-span-2">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={RULE_LABEL[form.type]} />
              </Field>
            </div>

            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-fg">Condition</legend>
              {form.type === 'branch-silent' && (
                <Field label="Branch path" help="Empty watches the whole namespace.">
                  <Input className="mono" placeholder="plant/line1" value={form.path} onChange={(e) => set({ path: e.target.value })} />
                </Field>
              )}
              {form.type === 'topic-silent' && (
                <Field label="Topic" error={shown.topic}>
                  <Input className="mono" aria-invalid={shown.topic ? 'true' : undefined} placeholder="plant/line1/temp" value={form.topic} onChange={(e) => set({ topic: e.target.value })} />
                </Field>
              )}
              {form.type === 'new-topic' && (
                <Field label="Prefix (optional)">
                  <Input className="mono" placeholder="plant/" value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} />
                </Field>
              )}
              {(form.type === 'branch-silent' || form.type === 'topic-silent') && (
                <Field label="Threshold (s)" error={shown.thresholdSec} help="Fires when nothing arrives for this long.">
                  <Input className="mono" type="number" min="5" aria-invalid={shown.thresholdSec ? 'true' : undefined} value={form.thresholdSec} onChange={(e) => set({ thresholdSec: e.target.value })} />
                </Field>
              )}
              {form.type === 'value-threshold' && (
                <>
                  <Field label="Topic (exact or +/# filter)" error={shown.topic}>
                    <Input className="mono" aria-invalid={shown.topic ? 'true' : undefined} placeholder="plant/+/temp" value={form.topic} onChange={(e) => set({ topic: e.target.value })} />
                  </Field>
                  <Field label="Field (optional dot-path)" help="Empty uses the whole payload.">
                    <Input className="mono" placeholder="v or data.temp" value={form.field} onChange={(e) => set({ field: e.target.value })} />
                  </Field>
                  <Select label="Operator" value={form.op} onChange={(e) => set({ op: e.target.value })} options={VALUE_OPS} />
                  <Field label="Value" error={shown.value}>
                    <Input className="mono" type="number" step="any" aria-invalid={shown.value ? 'true' : undefined} placeholder="80" value={form.value} onChange={(e) => set({ value: e.target.value })} />
                  </Field>
                  <Field label="Sustain (s, optional)" help="Must hold this long before firing. 0 fires at once.">
                    <Input className="mono" type="number" min="0" step="any" placeholder="0" value={form.sustainSec} onChange={(e) => set({ sustainSec: e.target.value })} />
                  </Field>
                  <Field label="Clear value (optional)" help="Resolves only past this level, to avoid flapping.">
                    <Input className="mono" type="number" step="any" placeholder="75" value={form.clearValue} onChange={(e) => set({ clearValue: e.target.value })} />
                  </Field>
                </>
              )}
            </fieldset>

            <Field label="Webhook URL (optional)" help={readOnly ? 'Hidden for viewer sessions: the URL is a credential.' : 'Called with the alert as JSON when the rule fires or resolves.'}>
              <Input
                className="mono"
                placeholder={readOnly && form.id ? 'Not shown to viewers' : 'https://hooks.example.com/…'}
                value={form.webhookUrl}
                onChange={(e) => set({ webhookUrl: e.target.value })}
              />
            </Field>
          </fieldset>
        </Dialog>
      )}
      {confirmDialog}
    </div>
  );
}
