import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { socket } from '@/lib/socket';
import { useConflict } from '@/components/ConflictDialog';
import { Button, Input, Field, Select, Banner, Dialog, EmptyState, IconButton, LoadingState, StatusText, Timestamp, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { EMPTY_RULE_FORM, RULE_LABEL, SEVERITY, STATUS_LABEL, VALUE_OPS, alertTone, formFromRule, ruleBody, ruleScope, ruleStates, severityView } from './helpers';

/** "12 s", "1 min 5 s": the countdown wording. */
function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** A clock that ticks once a second while `active`, so a countdown moves without refetching. */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** One rule's recent events, loaded when its row is opened. */
function RuleEvents({ ruleId }) {
  const q = usePolled(() => api.alertEvents(25, ruleId), { interval: 8000 });
  const events = q.data?.events || [];
  if (q.error && !q.data) return <p className="text-xs text-bad">Could not load this rule&apos;s events: {q.error.message}</p>;
  if (q.loading && !q.data) return <p className="text-xs text-subtle">Loading events…</p>;
  if (events.length === 0) return <p className="text-xs text-subtle">This rule has no events yet.</p>;
  return (
    <Table caption="Recent events of this rule" wrapperClassName="max-h-56 overflow-y-auto" className="min-w-[32rem]">
      <THead>
        <Th>State</Th>
        <Th>Detail</Th>
        <Th align="right">When</Th>
      </THead>
      <tbody>
        {events.map((e, i) => (
          <Tr key={i}>
            <Td className="py-1.5">
              <StatusText tone={alertTone(e.status)}>{STATUS_LABEL[e.status] || e.status}</StatusText>
            </Td>
            <Td className="max-w-[22rem] truncate py-1.5 text-xs text-muted" title={e.detail}>
              {e.detail}
            </Td>
            <Td align="right" className="py-1.5 text-xs text-muted">
              <Timestamp value={e.ts} />
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Alert rules: watch the namespace actively (a branch going quiet, a topic dying, unexpected topics, a
 * value crossing a limit). Silence rules are evaluated on the server every 15 s, value rules on every
 * message; firings become active alarms (Active tab), are recorded in the history (History tab) and,
 * optionally, reach a webhook. The webhook URL is a credential: no session gets it back, only that one is set and its origin.
 */
export default function AlertRules({ onChange }) {
  const brokers = useStore((s) => s.brokers);
  const [form, setForm] = useState(null); // null = dialog closed
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // id of the rule whose recent events are shown
  const readOnly = useReadOnly();
  const [confirm, confirmDialog] = useConfirm();
  const { resolveConflict, conflictDialog } = useConflict();
  const connected = brokers.filter((b) => b.status === 'connected');

  // 5 s: a breached rule's countdown is anchored to the server's clock, and a state change is also pushed (alert-state).
  const rulesQ = usePolled(async () => ({ ...(await api.listAlertRules()), answeredAt: Date.now() }), { interval: 5_000 });
  const reloadRules = rulesQ.reload;
  useEffect(() => {
    socket.on('alert-state', reloadRules);
    socket.on('alert', reloadRules);
    return () => {
      socket.off('alert-state', reloadRules);
      socket.off('alert', reloadRules);
    };
  }, [reloadRules]);
  const rules = useMemo(() => rulesQ.data?.rules || [], [rulesQ.data]);
  const states = useMemo(() => ruleStates(rules, []), [rules]);
  const firing = rules.filter((r) => states[r.id]?.key === 'firing').length;
  const breached = rules.filter((r) => states[r.id]?.key === 'breached').length;
  // Time left on a breached rule = what the server said when it answered, minus what has passed since.
  const answeredAt = rulesQ.data?.answeredAt ?? 0;
  const now = useNow(breached > 0);
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
      const body = ruleBody(form, connected[0]?.id); // carries `rev`: a save over a newer version is refused (409), never silent
      try {
        await api.saveAlertRule(body);
      } catch (e) {
        const choice = await resolveConflict(e, { what: 'alert rule', mine: body });
        if (choice === null) throw e;
        if (choice === 'cancel') return;
        if (choice === 'theirs') {
          if (e.current) setForm(formFromRule(e.current));
          toast('Showing the saved version');
          return;
        }
        await api.saveAlertRule({ ...body, rev: e.current?.rev });
      }
      closeForm();
      rulesQ.reload();
      onChange?.();
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
      message: 'The rule stops being evaluated immediately and its webhook is no longer called. Its active alarms end, and its past events stay in the history.',
      confirmLabel: 'Delete rule',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteAlertRule(r.id);
      rulesQ.reload();
      onChange?.();
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
              {breached > 0 ? `, ${breached} breached, not firing yet` : ''}
            </p>
            <Button onClick={() => openForm()} disabled={addDisabled} title={addTitle}>
              <Plus size={14} aria-hidden="true" /> Add rule
            </Button>
          </div>
          <Table caption="Alert rules" className="min-w-[48rem]">
            <THead>
              <Th>Rule</Th>
              <Th>Severity</Th>
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
                const wh = st.webhook;
                const isOpen = open === r.id;
                return [
                  <Tr key={r.id} highlight={form?.id === r.id} data-testid={`alert-rule-${r.id}`} className={isOpen ? 'border-b-0' : undefined}>
                    <Td header>
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : r.id)}
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} recent events of ${name}`}
                        className="-ml-1 flex items-center gap-1 rounded px-1 text-left font-medium text-fg hover:text-accent-text"
                      >
                        <ChevronRight size={13} aria-hidden="true" className={clsx('shrink-0 text-subtle transition-transform duration-150', isOpen && 'rotate-90')} />
                        {name}
                      </button>
                      {r.name && <span className="block pl-4 text-xs text-subtle">{RULE_LABEL[r.type]}</span>}
                    </Td>
                    <Td>
                      <StatusText tone={severityView(r.severity).tone}>{severityView(r.severity).label}</StatusText>
                    </Td>
                    <Td>
                      <StatusText tone={st.tone}>{st.label}</StatusText>
                      {st.key === 'breached' && (
                        <span className="block text-xs text-subtle" data-testid="alert-breached">
                          {st.topic && st.value !== null && st.value !== undefined ? <span className="mono">{st.value}</span> : null} past the limit; fires in{' '}
                          <span className="mono tabular-nums text-warn" data-testid="alert-countdown">
                            {countdown((st.remainingMs ?? 0) - (now - answeredAt))}
                          </span>{' '}
                          if it holds
                        </span>
                      )}
                      {st.key === 'firing' && (
                        <span className="block text-xs text-subtle">
                          since <Timestamp value={st.since} />
                          {st.value !== null && st.value !== undefined && <> · <span className="mono">{st.value}</span></>}
                          {st.firingTopics > 1 && <> · {st.firingTopics} topics</>}
                        </span>
                      )}
                      {st.key === 'ok' && st.value !== null && st.value !== undefined && (
                        <span className="block text-xs text-subtle">
                          last value <span className="mono">{st.value}</span>
                        </span>
                      )}
                      {st.key === 'broken' && (
                        <span className="block text-xs text-subtle" data-testid="alert-broken">
                          {(st.broken || []).map((b) => `${b.kind} "${b.id}" is missing`).join(', ')}.{' '}
                          <button type="button" className="text-accent-text underline underline-offset-2" onClick={() => openForm(r)}>
                            Fix
                          </button>
                        </span>
                      )}
                    </Td>
                    <Td className="max-w-[24rem] text-xs text-muted">
                      <span className="block truncate" title={`${brokerName(r.brokerId)} · ${ruleScope(r)}`}>
                        <span className="text-subtle">{brokerName(r.brokerId)}</span> <span className="mono">{ruleScope(r)}</span>
                      </span>
                    </Td>
                    <Td className="text-xs">
                      {!hasHook ? (
                        <span className="text-subtle">None</span>
                      ) : wh?.failures > 0 && wh.lastError ? (
                        <>
                          <StatusText tone="bad">Failing</StatusText>
                          <span className="mono block max-w-[14rem] truncate text-subtle" title={wh.lastError}>
                            {wh.failures}× · {wh.lastError}
                          </span>
                        </>
                      ) : wh?.lastOkAt ? (
                        <>
                          <StatusText tone="good">Delivering</StatusText>
                          <span className="block text-subtle">
                            last <Timestamp value={wh.lastOkAt} />
                          </span>
                        </>
                      ) : (
                        <span className="text-fg">Configured</span>
                      )}
                    </Td>
                    <Td align="right" className="w-24">
                      <span className="inline-flex items-center justify-end gap-0.5">
                        <IconButton icon={Pencil} size={14} label={`${readOnly ? 'View' : 'Edit'} alert rule ${name}`} onClick={() => openForm(r)} />
                        <IconButton icon={Trash2} size={14} label={`Delete alert rule ${name}`} className="hover:bg-bad/10 hover:text-bad" onClick={() => remove(r)} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} />
                      </span>
                    </Td>
                  </Tr>,
                  isOpen && (
                    <tr key={`${r.id}-events`}>
                      <td colSpan={6} className="px-3 pb-3 pt-0" data-testid={`alert-events-${r.id}`}>
                        <RuleEvents ruleId={r.id} />
                      </td>
                    </tr>
                  )
                ];
              })}
            </tbody>
          </Table>
        </>
      )}

      {form && (
        <Dialog
          title={form.id ? (readOnly ? 'View alert rule' : 'Edit alert rule') : 'Add alert rule'}
          description="Silence rules are checked every 15 seconds, value rules on every message."
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
              <Field label="Name (optional)">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={RULE_LABEL[form.type]} />
              </Field>
              <Select label="Severity" help="Critical alarms are counted on the Alerts menu item until acknowledged." value={form.severity || 'warning'} onChange={(e) => set({ severity: e.target.value })}>
                {Object.entries(SEVERITY).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
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

            {form.hasWebhook && form.webhookMode !== 'replace' ? (
              // A stored webhook is a credential: never shown, only which service it calls. Kept unless replaced or removed.
              <div className="space-y-1.5" data-testid="webhook-stored">
                <span className="block text-xs font-medium text-muted">Webhook URL</span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-fg">
                    {form.webhookMode === 'remove' ? (
                      'Removed when you save'
                    ) : (
                      <>
                        Set, calls <span className="mono">{form.webhookOrigin || 'a stored address'}</span>
                      </>
                    )}
                  </span>
                  {!readOnly && form.webhookMode === 'keep' && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => set({ webhookMode: 'replace', webhookUrl: '' })}>
                        Replace
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => set({ webhookMode: 'remove' })}>
                        Remove
                      </Button>
                    </>
                  )}
                  {!readOnly && form.webhookMode === 'remove' && (
                    <Button size="sm" variant="secondary" onClick={() => set({ webhookMode: 'keep' })}>
                      Keep it
                    </Button>
                  )}
                </div>
                <span className="helper block">The URL is a credential and is not shown again. Saving keeps it unless you replace or remove it.</span>
              </div>
            ) : (
              <Field
                label="Webhook URL (optional)"
                help={form.hasWebhook ? 'Leave blank to keep the stored webhook.' : 'Called with the alert as JSON when the rule fires or resolves. Not shown again after saving.'}
              >
                <Input
                  className="mono"
                  placeholder={form.hasWebhook ? 'stored, leave blank to keep' : 'https://hooks.example.com/…'}
                  value={form.webhookUrl}
                  onChange={(e) => set({ webhookUrl: e.target.value })}
                  autoComplete="off"
                />
              </Field>
            )}
          </fieldset>
        </Dialog>
      )}
      {conflictDialog}
      {confirmDialog}
    </div>
  );
}
