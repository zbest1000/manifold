import { useEffect, useState } from 'react';
import { BellRing, Check, Plus, Pencil, Trash2, Power } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Input, Field, Tooltip } from '@/components/ui';

export const RULE_LABEL = {
  'branch-silent': 'Branch silent',
  'topic-silent': 'Topic silent',
  'new-topic': 'New topic appears',
  'value-threshold': 'Value threshold'
};

// One-sentence explainer per rule type, shown under the Type select so the
// form teaches the model instead of assuming it.
const TYPE_HINT = {
  'branch-silent': 'Fires when nothing under the path publishes for the threshold — a dead line, gateway, or whole site.',
  'topic-silent': 'Fires when this one exact topic stops publishing for the threshold.',
  'new-topic': 'Fires whenever a never-seen topic appears under the prefix — catches misconfigured or rogue publishers.',
  'value-threshold': 'Fires when a numeric value crosses the limit. Sustain requires the breach to hold continuously; clear value adds a deadband so a noisy signal doesn’t flap.'
};

const VALUE_OPS = ['>', '>=', '<', '<=', '==', '!='];

const EMPTY_RULE_FORM = {
  id: null,
  type: 'branch-silent',
  brokerId: '',
  path: '',
  topic: '',
  prefix: '',
  thresholdSec: 60,
  field: '',
  op: '>',
  value: '',
  sustainSec: '',
  clearValue: '',
  webhookUrl: '',
  name: ''
};

// Compact one-line definition of a value rule for the rule list,
// e.g. "plant/+/temp · v > 80 for 30s, clear at 75".
function valueRuleSummary(r) {
  let s = ` · ${r.topic} · ${r.field || 'value'} ${r.op} ${r.value}`;
  if (r.sustainMs > 0) s += ` for ${Math.round(r.sustainMs / 1000)}s`;
  if (r.clearValue !== null && r.clearValue !== undefined) s += `, clear at ${r.clearValue}`;
  return s;
}

/**
 * Alert rule management: list (with enable/disable + firing state), create/edit
 * form, delete. Lives on the Alerts page; extracted from Settings so alarms are
 * a first-class surface instead of a settings card. `onChanged` fires after any
 * mutation so the page can refresh dependent views.
 */
export default function AlertRules({ onChanged }) {
  const brokers = useStore((s) => s.brokers);
  const activeAlarms = useStore((s) => s.activeAlarms);
  const [rules, setRules] = useState([]);
  const [webhookHealth, setWebhookHealth] = useState(null); // { failures, lastError }
  const [form, setForm] = useState(EMPTY_RULE_FORM);
  const [busy, setBusy] = useState(false);
  const connected = brokers.filter((b) => b.status === 'connected');

  const load = () =>
    api
      .listAlertRules()
      .then((r) => {
        setRules(r.rules);
        setWebhookHealth({ failures: r.webhookFailures || 0, lastError: r.lastWebhookError || null });
      })
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const changed = () => {
    load();
    onChanged?.();
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        id: form.id || undefined, // keeping the id makes POST an upsert (edit)
        name: form.name || null,
        type: form.type,
        brokerId: form.brokerId || connected[0]?.id,
        path: form.path,
        topic: form.topic || null,
        prefix: form.prefix,
        thresholdMs: Number(form.thresholdSec) * 1000,
        webhookUrl: form.webhookUrl || null
      };
      if (form.type === 'value-threshold') {
        body.field = form.field || null;
        body.op = form.op;
        body.value = Number(form.value);
        body.sustainMs = form.sustainSec === '' ? 0 : Number(form.sustainSec) * 1000;
        body.clearValue = form.clearValue === '' ? null : Number(form.clearValue);
      }
      await api.saveAlertRule(body);
      setForm((f) => ({ ...EMPTY_RULE_FORM, type: f.type, brokerId: f.brokerId, thresholdSec: f.thresholdSec }));
      changed();
    } catch {
      // pushLog captured it
    } finally {
      setBusy(false);
    }
  };

  // Load any existing rule (all types) back into the form for editing.
  const edit = (r) => {
    setForm({
      id: r.id,
      type: r.type,
      brokerId: r.brokerId || '',
      path: r.path || '',
      topic: r.topic || '',
      prefix: r.prefix || '',
      thresholdSec: Math.round((r.thresholdMs || 60_000) / 1000),
      field: r.field || '',
      op: r.op || '>',
      value: r.value ?? '',
      sustainSec: r.sustainMs > 0 ? Math.round(r.sustainMs / 1000) : '',
      clearValue: r.clearValue ?? '',
      webhookUrl: r.webhookUrl || '',
      name: r.name || ''
    });
  };

  const remove = async (id) => {
    try {
      await api.deleteAlertRule(id);
      if (form.id === id) setForm(EMPTY_RULE_FORM);
      changed();
    } catch {
      // pushLog captured it
    }
  };

  // The engine skips disabled rules; a paused rule keeps its config so it can
  // be flipped back on during maintenance windows instead of re-created.
  const toggleEnabled = async (r) => {
    try {
      await api.saveAlertRule({ ...r, enabled: r.enabled === false });
      changed();
    } catch {
      // pushLog captured it
    }
  };

  const brokerName = (id) => brokers.find((b) => b.id === id)?.name || id?.slice(0, 8) || '—';
  const isFiring = (r) => Object.values(activeAlarms).some((a) => a.ruleId === r.id);

  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <BellRing size={16} className="text-accent-400" /> Rules
      </h2>

      {/* A silently failing webhook is an alarm that never reaches anyone —
          surface delivery health where the rules are managed. */}
      {webhookHealth?.failures > 0 && (
        <p className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
          <b className="font-semibold">Webhook delivery failing</b> — {webhookHealth.failures} failed{' '}
          {webhookHealth.failures === 1 ? 'delivery' : 'deliveries'} since start
          {webhookHealth.lastError && <span className="mono block truncate text-amber-300/60">last: {webhookHealth.lastError}</span>}
        </p>
      )}

      {rules.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {rules.map((r) => (
            <div
              key={r.id}
              className={clsx(
                'flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-2 text-xs',
                form.id === r.id && 'ring-1 ring-accent-500/50',
                r.enabled === false && 'opacity-50'
              )}
            >
              <span className="min-w-0">
                <span className="font-medium text-slate-200">{r.name || RULE_LABEL[r.type]}</span>
                {isFiring(r) && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300 ring-1 ring-inset ring-rose-500/30">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" /> firing
                  </span>
                )}
                {r.enabled === false && (
                  <span className="ml-2 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 ring-1 ring-inset ring-white/10">
                    paused
                  </span>
                )}
                <span className="ml-2 text-slate-500">
                  {RULE_LABEL[r.type]} · {brokerName(r.brokerId)}
                  {r.type === 'branch-silent' && ` · ${r.path || '(whole namespace)'} > ${Math.round(r.thresholdMs / 1000)}s`}
                  {r.type === 'topic-silent' && ` · ${r.topic} > ${Math.round(r.thresholdMs / 1000)}s`}
                  {r.type === 'new-topic' && (r.prefix ? ` · under ${r.prefix}` : ' · anywhere')}
                  {r.type === 'value-threshold' && valueRuleSummary(r)}
                  {r.webhookUrl && ' · webhook'}
                </span>
              </span>
              <span className="flex shrink-0 items-center">
                <Tooltip label={r.enabled === false ? 'Resume rule' : 'Pause rule'}>
                  <button
                    aria-label={r.enabled === false ? 'Resume rule' : 'Pause rule'}
                    onClick={() => toggleEnabled(r)}
                    className={clsx('rounded p-1 hover:bg-white/10', r.enabled === false ? 'text-slate-600 hover:text-emerald-400' : 'text-emerald-400/70 hover:text-slate-400')}
                  >
                    <Power size={13} />
                  </button>
                </Tooltip>
                <button aria-label="Edit rule" onClick={() => edit(r)} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-accent-400">
                  <Pencil size={13} />
                </button>
                <button aria-label="Delete rule" onClick={() => remove(r.id)} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-red-400">
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {connected.length === 0 && (
        <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
          No connected brokers — connect one under <b>Connect → MQTT Brokers</b> before adding rules.
        </p>
      )}

      <form onSubmit={save} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field label="Type">
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
          >
            <option value="branch-silent">Branch silent</option>
            <option value="topic-silent">Topic silent</option>
            <option value="new-topic">New topic appears</option>
            <option value="value-threshold">Value threshold</option>
          </select>
        </Field>
        <Field label="Broker">
          <select
            value={form.brokerId || connected[0]?.id || ''}
            onChange={(e) => setForm((f) => ({ ...f, brokerId: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
          >
            {connected.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {connected.length === 0 && <option value="">no connected brokers</option>}
          </select>
        </Field>
        <Field label="Name (optional)" className="col-span-2">
          <Input placeholder="Line 4 overheat" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <p className="col-span-2 -mt-1 text-xs leading-relaxed text-slate-500 lg:col-span-4">{TYPE_HINT[form.type]}</p>
        {form.type === 'branch-silent' && (
          <Field label="Branch path">
            <Input placeholder="plant/line1 (empty = whole namespace)" value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} />
          </Field>
        )}
        {form.type === 'topic-silent' && (
          <Field label="Topic">
            <Input placeholder="plant/line1/temp" value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} required />
          </Field>
        )}
        {form.type === 'new-topic' && (
          <Field label="Prefix (optional)">
            <Input placeholder="plant/" value={form.prefix} onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))} />
          </Field>
        )}
        {(form.type === 'branch-silent' || form.type === 'topic-silent') && (
          <Field label="Threshold (s)">
            <Input type="number" min="5" value={form.thresholdSec} onChange={(e) => setForm((f) => ({ ...f, thresholdSec: e.target.value }))} />
          </Field>
        )}
        {form.type === 'value-threshold' && (
          <>
            <Field label="Topic (exact or +/# filter)">
              <Input placeholder="plant/+/temp" value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} required />
            </Field>
            <Field label="Field (optional dot-path)">
              <Input placeholder="v or data.temp (empty = payload)" value={form.field} onChange={(e) => setForm((f) => ({ ...f, field: e.target.value }))} />
            </Field>
            <Field label="Operator">
              <select
                value={form.op}
                onChange={(e) => setForm((f) => ({ ...f, op: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-200"
              >
                {VALUE_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Value">
              <Input type="number" step="any" placeholder="80" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} required />
            </Field>
            <Field label="Sustain (s, optional)">
              <Input type="number" min="0" step="any" placeholder="0 = immediate" value={form.sustainSec} onChange={(e) => setForm((f) => ({ ...f, sustainSec: e.target.value }))} />
            </Field>
            <Field label="Clear value (optional)">
              <Input type="number" step="any" placeholder="hysteresis clear level" value={form.clearValue} onChange={(e) => setForm((f) => ({ ...f, clearValue: e.target.value }))} />
            </Field>
          </>
        )}
        <Field label="Webhook URL (optional)" className="col-span-2">
          <Input placeholder="https://hooks.example.com/…" value={form.webhookUrl} onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))} />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={busy || connected.length === 0}>
            {form.id ? (
              <>
                <Check size={14} className="mr-1" /> Save rule
              </>
            ) : (
              <>
                <Plus size={14} className="mr-1" /> Add rule
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
    </Card>
  );
}
