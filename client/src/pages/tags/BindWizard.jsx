import { useMemo, useState } from 'react';
import { X, AlertTriangle, Check, ArrowLeft, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Modal, Button, Input, Field } from '@/components/ui';
import { saveBinding, savePipeline } from './tagsApi';
import { statusTopic, examplePayload, TEMPLATE_VARIABLES } from './helpers';
import {
  SELECT_CLS, initialRows, validateWizard, buildTarget, buildRbe, sparkplugSource, mqttSourceTopics
} from './wizardModel';

const STEPS = ['Target', 'Naming', 'Options'];
const PREVIEW_LIMIT = 20;
const help = 'text-xs leading-snug text-slate-400';

/**
 * Three-step bind wizard inside the shared Modal: target -> naming (live topic preview) -> options.
 * Edit mode (editing) seeds every field from the saved binding and upserts by id.
 */
export default function BindWizard({ source, selection, brokers, editing = null, onClose, onDone }) {
  const srcType = editing ? editing.source.type : source.type;
  const t0 = editing?.target || {};
  const [step, setStep] = useState(0);
  const [name, setName] = useState(editing?.name || '');
  const [mode, setMode] = useState(t0.mode || 'mqtt');
  const [form, setForm] = useState({
    brokerId: t0.brokerId || brokers[0]?.id || '',
    pathTemplate: t0.pathTemplate || 'uns/imported/{name}',
    format: t0.format || 'envelope',
    retain: editing ? t0.retain === true : false,
    qos: t0.qos ?? 0,
    deadband: t0.deadband ?? '',
    heartbeatMs: editing?.rbe?.heartbeatMs ?? '',
    statusTopic: t0.statusTopic !== false,
    samplingInterval: editing?.source?.samplingInterval ?? 1000,
    group: t0.group || 'Manifold',
    edge: t0.edge || 'edge1',
    device: t0.device || 'imported'
  });
  const [rows, setRows] = useState(() => initialRows(editing, selection));
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const renameable = srcType === 'opcua' || srcType === 'device';
  const rename = (key, value) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, name: value } : r)));

  const { errors, resolved, collisions } = useMemo(
    () => validateWizard({ srcType, mode, form, rows, brokers }),
    [srcType, mode, form, rows, brokers]
  );
  const stepErrors = errors.filter((e) => e.step === step);
  const firstError = errors[0];
  const lastStep = step === STEPS.length - 1;
  const nextDisabledReason = stepErrors[0]?.message;
  const submitDisabledReason = firstError ? `Step ${firstError.step + 1} (${STEPS[firstError.step]}): ${firstError.message}` : null;

  const submit = async () => {
    setBusy(true);
    try {
      const rbe = srcType === 'mqtt' ? undefined : buildRbe(form);
      if (srcType === 'mqtt' && !editing) {
        const m = mqttSourceTopics(rows, form.pathTemplate);
        const segCount = m.prefix ? m.prefix.split('/').filter(Boolean).length : 0;
        await savePipeline({
          name: name || `tags -> ${m.base}`,
          source: { brokerId: source.id, filter: rows.length === 1 ? rows[0].address : `${m.prefix}#` },
          transforms: [
            { type: 'repath', to: `${m.base}/{${segCount + 1}-}` },
            ...(form.format === 'envelope' ? [{ type: 'envelope' }] : [])
          ],
          target: { type: 'mqtt', brokerId: form.brokerId, retain: form.retain, qos: Number(form.qos) || 0 }
        });
        toast.success('Created a pipeline route (see Pipelines, Routes)');
        onDone();
        return;
      }
      const tags = rows.map((r) => ({ address: r.address, name: r.name.trim() }));
      let src;
      if (editing) {
        src = Array.isArray(editing.source.tags) ? { ...editing.source, tags } : editing.source;
        if (srcType === 'opcua') src = { ...src, samplingInterval: Number(form.samplingInterval) || 1000 };
      } else if (srcType === 'opcua') {
        src = { type: 'opcua', connectionId: source.id, tags, samplingInterval: Number(form.samplingInterval) || 1000 };
      } else if (srcType === 'sparkplug') {
        src = sparkplugSource(source.id, rows);
      } else {
        src = { type: srcType, deviceId: source.id, tags };
      }
      await saveBinding({
        ...(editing ? { id: editing.id, enabled: editing.enabled !== false } : {}),
        name: name || null,
        source: src,
        target: buildTarget(mode, form),
        ...(rbe ? { rbe } : {})
      });
      toast.success(editing ? 'Binding saved' : 'Binding created');
      onDone();
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };

  const title = editing
    ? `Edit binding ${editing.name || editing.id.slice(0, 8)}`
    : `Add ${rows.length} ${srcType === 'sparkplug' ? 'Sparkplug metric' : 'tag'}${rows.length === 1 ? '' : 's'} to the UNS`;

  return (
    <Modal title={title} onClose={onClose} className="max-w-3xl p-4 sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <ol className="mb-4 flex flex-wrap gap-2" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}>
            <button
              type="button"
              onClick={() => i <= step && setStep(i)}
              className={clsx(
                'flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
                i === step ? 'bg-accent-500/20 text-accent-200 ring-accent-500/40' : i < step ? 'text-slate-200 ring-white/15 hover:bg-white/5' : 'cursor-default text-slate-400 ring-white/10'
              )}
            >
              <span className="grid h-4 w-4 place-items-center rounded-full bg-white/10 text-xs">{i < step ? <Check size={10} aria-hidden="true" /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && <TargetStep {...{ name, setName, mode, setMode, form, set, brokers, srcType, rows, errors: stepErrors }} />}
      {step === 1 && <NamingStep {...{ mode, srcType, form, set, resolved, collisions, rows, rename, renameable, errors: stepErrors }} />}
      {step === 2 && <OptionsStep {...{ mode, srcType, form, set, errors: stepErrors }} />}

      <p className={clsx(help, 'mt-4')}>
        Bindings are read-only: Manifold monitors the source and republishes. It never writes to a device.
      </p>

      <div className="sticky -bottom-4 z-10 -mx-4 mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-white/5 bg-surface-900 px-4 py-3 sm:-bottom-5 sm:-mx-5 sm:px-5">
        {lastStep && submitDisabledReason && (
          <p role="status" className="mr-auto flex min-w-0 items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{submitDisabledReason}</span>
          </p>
        )}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {step > 0 && (
          <Button variant="outline" onClick={() => setStep(step - 1)}>
            <ArrowLeft size={14} aria-hidden="true" /> Back
          </Button>
        )}
        {!lastStep ? (
          <Button onClick={() => setStep(step + 1)} disabled={Boolean(nextDisabledReason)} title={nextDisabledReason || undefined}>
            Next <ArrowRight size={14} aria-hidden="true" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={busy || Boolean(firstError)}>
            {editing ? 'Save changes' : 'Create binding'}
          </Button>
        )}
      </div>
    </Modal>
  );
}

function FieldError({ errors }) {
  if (!errors.length) return null;
  return (
    <ul role="alert" className="mt-2 space-y-1">
      {errors.map((e) => (
        <li key={e.message} className="text-xs text-rose-300">{e.message}</li>
      ))}
    </ul>
  );
}

// ---- step 1: target ---------------------------------------------------------------

function TargetStep({ name, setName, mode, setMode, form, set, brokers, srcType, rows, errors }) {
  return (
    <section aria-label="Target" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Binding name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="line1 motor tags" />
        </Field>
        <Field label="Target broker">
          <select value={form.brokerId} onChange={(e) => set({ brokerId: e.target.value })} className={SELECT_CLS}>
            {brokers.length === 0 && <option value="">no connected brokers</option>}
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Publish as" className="sm:col-span-2">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={SELECT_CLS} disabled={srcType === 'mqtt'}>
            <option value="mqtt">Plain MQTT topics (UNS)</option>
            {srcType !== 'mqtt' && <option value="sparkplug">Sparkplug B device (NBIRTH/DDATA)</option>}
          </select>
        </Field>
      </div>

      {mode === 'mqtt' && (
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Layout</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 p-3">
              <input type="radio" name="layout" checked readOnly className="mt-0.5 accent-accent-500" />
              <span className="text-sm text-slate-100">
                One topic per tag
                <span className={clsx(help, 'block')}>Each tag publishes to its own topic. Best for subscribers that want a single value.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-xl border border-white/10 p-3 opacity-60">
              <input type="radio" name="layout" disabled className="mt-0.5" />
              <span className="text-sm text-slate-300">
                One object per asset
                <span className={clsx(help, 'block')}>Not available yet.</span>
              </span>
            </label>
          </div>
        </fieldset>
      )}
      {mode === 'sparkplug' && (
        <p className={help}>Sparkplug output uses a dedicated session with a proper NBIRTH/NDEATH lifecycle. Group, edge node and device are set in the next step.</p>
      )}
      {srcType === 'mqtt' && (
        <p className={help}>MQTT-source tags compile into a pipeline route (re-pathed under your base path), not a binding. Deadband and heartbeat do not apply.</p>
      )}
      <p className={help}>{rows.length} selected.</p>
      <FieldError errors={errors} />
    </section>
  );
}

// ---- step 2: naming + live preview -------------------------------------------------

function NamingStep({ mode, srcType, form, set, resolved, collisions, rows, rename, renameable, errors }) {
  const shown = resolved.slice(0, PREVIEW_LIMIT);
  const collidingKeys = new Set([...collisions.values()].flat());
  const flagged = resolved.filter((r) => r.warnings.length).length;
  const hasAddr = resolved.some((r) => r.warnings.some((w) => w.kind === 'address'));
  const editableNames = renameable && srcType !== 'mqtt';

  return (
    <section aria-label="Naming" className="space-y-3">
      {mode === 'mqtt' ? (
        <div>
          <Field label="UNS path template">
            <Input
              value={form.pathTemplate}
              onChange={(e) => set({ pathTemplate: e.target.value })}
              placeholder="site/area/line/{name}"
              aria-invalid={errors.some((e) => e.message.includes('template') || e.message.includes('path') || e.message.includes('variable') || e.message.includes('wildcards')) || undefined}
              className="font-mono"
            />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={help}>Variables (click to insert):</span>
            {TEMPLATE_VARIABLES.map((v) => (
              <button
                key={v.token}
                type="button"
                title={v.help}
                onClick={() => set({ pathTemplate: form.pathTemplate.includes(v.token) ? form.pathTemplate : `${form.pathTemplate.replace(/\/+$/, '')}/${v.token}` })}
                className="rounded-full bg-white/5 px-2.5 py-0.5 font-mono text-xs text-accent-200 ring-1 ring-inset ring-white/10 hover:bg-white/10"
              >
                {v.token}
              </button>
            ))}
            <span className={help}>{'{name}'} is the tag name, with spaces and / + # replaced by _. Without {'{name}'} the tag name is appended.</span>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Group"><Input value={form.group} onChange={(e) => set({ group: e.target.value })} /></Field>
          <Field label="Edge node"><Input value={form.edge} onChange={(e) => set({ edge: e.target.value })} /></Field>
          <Field label="Device"><Input value={form.device} onChange={(e) => set({ device: e.target.value })} /></Field>
          <p className={clsx(help, 'sm:col-span-3')}>
            Publishes to <span className="font-mono">spBv1.0/{form.group || '?'}/DDATA/{form.edge || '?'}/{form.device || '?'}</span>; the metric names are below.
          </p>
        </div>
      )}
      <FieldError errors={errors} />

      {hasAddr && (
        <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Some names look like raw device addresses (for example DB10.DBD4, 40012 or ns=2;s=...). Topics should name the
            property (speed, temperature), not the PLC address.
            {editableNames ? ' Edit the name directly in the preview table below.' : ''}
          </span>
        </div>
      )}

      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">
          Live preview {resolved.length > PREVIEW_LIMIT ? `(first ${PREVIEW_LIMIT} of ${resolved.length})` : `(${resolved.length})`}
          {flagged > 0 && <span className="ml-2 normal-case text-amber-300">{flagged} need attention</span>}
        </h4>
        <div className="max-h-64 overflow-auto rounded-xl border border-white/5">
          <table className="w-full text-left text-xs sm:min-w-[34rem]">
            <thead className="sticky top-0 bg-surface-900 text-slate-400">
              <tr>
                <th scope="col" className="hidden px-2.5 py-1.5 font-medium sm:table-cell">Tag</th>
                {editableNames && <th scope="col" className="px-2.5 py-1.5 font-medium">Name</th>}
                <th scope="col" className="px-2.5 py-1.5 font-medium">{mode === 'mqtt' ? 'Resolved topic' : 'Metric'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {shown.map((r) => {
                const clash = collidingKeys.has(r.key);
                const warn = r.warnings[0];
                return (
                  <tr key={r.key} className={clsx(clash && 'bg-rose-500/10')}>
                    <td className="hidden max-w-[12rem] truncate px-2.5 py-1.5 font-mono text-slate-300 sm:table-cell" title={r.address}>{r.address}</td>
                    {editableNames && (
                      <td className="px-2.5 py-1">
                        <input
                          value={rows.find((x) => x.key === r.key)?.name ?? ''}
                          onChange={(e) => rename(r.key, e.target.value)}
                          aria-label={`Name for ${r.address}`}
                          aria-invalid={clash || warn?.kind === 'address' || undefined}
                          className={clsx(
                            'w-full min-w-[8rem] rounded-lg border bg-surface-950/60 px-2 py-1 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent-500/30',
                            clash || warn?.kind === 'address' ? 'border-amber-500/50' : 'border-white/10'
                          )}
                        />
                      </td>
                    )}
                    <td className="px-2.5 py-1.5">
                      <span className={clsx('break-all font-mono', clash ? 'text-rose-300' : 'text-slate-100')}>{mode === 'mqtt' ? r.topic : r.name}</span>
                      {clash && <span className="mt-0.5 block text-rose-300">Same topic as another selected tag.</span>}
                      {!clash && warn && (
                        <span className="mt-0.5 flex items-start gap-1 text-amber-300">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" /> {warn.message}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {resolved.length > PREVIEW_LIMIT && (
          <p className={clsx(help, 'mt-1')}>
            {resolved.length - PREVIEW_LIMIT} more not shown. Collisions and warnings are checked across all {resolved.length}.
          </p>
        )}
      </div>

      {mode === 'mqtt' && srcType !== 'mqtt' && (
        <p className={help}>
          Status document: <span className="font-mono">{statusTopic(form.pathTemplate)}</span>
        </p>
      )}
    </section>
  );
}

// ---- step 3: options ----------------------------------------------------------------

function OptionsStep({ mode, srcType, form, set, errors }) {
  const isMqttTarget = mode === 'mqtt';
  return (
    <section aria-label="Options" className="space-y-4">
      {isMqttTarget && (
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Payload format</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { v: 'envelope', t: 'Envelope (recommended)', d: 'Carries value, timestamp and quality so consumers can tell a bad or stale reading from a good one.' },
              { v: 'plain', t: 'Plain value', d: 'Just the raw value. Plain cannot carry quality: when the source drops, only the status topic changes.' }
            ].map((o) => (
              <label key={o.v} className={clsx('flex cursor-pointer items-start gap-2 rounded-xl border p-3', form.format === o.v ? 'border-accent-500/40 bg-accent-500/10' : 'border-white/10 hover:bg-white/5')}>
                <input type="radio" name="format" value={o.v} checked={form.format === o.v} onChange={() => set({ format: o.v })} className="mt-0.5 accent-accent-500" />
                <span className="text-sm text-slate-100">
                  {o.t}
                  <span className={clsx(help, 'block')}>{o.d}</span>
                </span>
              </label>
            ))}
          </div>
          <p className={clsx(help, 'mt-2')}>
            Example payload: <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-slate-200">{examplePayload(form.format)}</code>
          </p>
        </fieldset>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {isMqttTarget && (
          <Field label="QoS">
            <select value={form.qos} onChange={(e) => set({ qos: e.target.value })} className={SELECT_CLS}>
              <option value={0}>0 - at most once (default)</option>
              <option value={1}>1 - at least once</option>
              <option value={2}>2 - exactly once</option>
            </select>
          </Field>
        )}
        {srcType !== 'mqtt' && (
          <>
            <Field label="Deadband (absolute, optional)">
              <Input inputMode="decimal" value={form.deadband} onChange={(e) => set({ deadband: e.target.value })} placeholder="0.5" />
            </Field>
            <Field label="Heartbeat (ms, 0 = off)">
              <Input inputMode="numeric" value={form.heartbeatMs} onChange={(e) => set({ heartbeatMs: e.target.value })} placeholder="60000" />
            </Field>
          </>
        )}
        {srcType === 'opcua' && (
          <Field label="Sampling interval (ms)">
            <Input type="number" min={50} value={form.samplingInterval} onChange={(e) => set({ samplingInterval: e.target.value })} />
          </Field>
        )}
      </div>
      {srcType !== 'mqtt' && (
        <p className={help}>
          Deadband suppresses numeric changes smaller than the band. The heartbeat republishes an unchanged value at least this often, so
          consumers can tell &quot;unchanged&quot; from &quot;dead&quot;.
        </p>
      )}

      {isMqttTarget && (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm text-slate-100">
            <input type="checkbox" checked={form.retain} onChange={(e) => set({ retain: e.target.checked })} className="mt-1 accent-accent-500" />
            <span>
              Retain values
              <span className={clsx(help, 'block')}>
                Off by default. A retained message outlives a dead device, so new subscribers would see an old value as current. Turn it on
                only for slow-changing values, and keep the status topic on.
              </span>
            </span>
          </label>
          {srcType !== 'mqtt' && (
            <label className="flex items-start gap-2 text-sm text-slate-100">
              <input type="checkbox" checked={form.statusTopic} onChange={(e) => set({ statusTopic: e.target.checked })} className="mt-1 accent-accent-500" />
              <span>
                Publish a retained status topic
                <span className={clsx(help, 'block')}>
                  Writes <span className="font-mono">{statusTopic(form.pathTemplate)}</span> with online/offline, since and reason, so
                  consumers can see when the source is down.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
      <FieldError errors={errors} />
    </section>
  );
}
