import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { SegmentedControl, Checkbox, Toggle, Banner, Select, Field, Input, Button, Radio } from '@/components/ui';
import { EditorSection, SubHeading, NumberInput } from './parts';
import { fmtBytes } from '../previewModel';
import { historianReason } from '../bindingView';
import { DEADBAND_HELP } from '../bindingForm';
import FieldOrder from './FieldOrder';

const FORMAT_HELP = {
  envelope: 'Value with its time, quality and unit, so consumers can tell a bad or stale reading from a good one.',
  plain: 'The bare value. It cannot carry quality or context: when the source drops, only the _status topic changes.'
};
const MODE_LABEL = { meta: 'Only in _meta', payload: 'In every payload', none: 'Nowhere' };
const MODE_HELP = {
  meta: 'Asset and tag context appear in the retained _meta document only. Payloads stay small.',
  payload: 'Also rides in every payload as ctx (asset, then device tag, then mapping), at most 1024 bytes per tag.',
  none: 'No context anywhere, not even in _meta.'
};
const META_LABEL = {
  type: 'Type and transform',
  unit: 'Unit',
  description: 'Description',
  range: 'Range',
  source: 'Source address',
  context: 'Context',
  displayName: 'Display name',
  limits: 'Limits',
  states: 'States'
};
const META_HELP = { source: 'Device id and tag address. Untick to keep PLC addressing off the broker.' };
const TYPE_LABEL = { timebase: 'Timebase', timescaledb: 'TimescaleDB', influxdb: 'InfluxDB' };

/** Payload: format, which fields a payload carries, where context goes, what _meta lists, the retained documents. */
export function PayloadSection({ state, set, schema, preview, readOnly }) {
  const f = set.form;
  const object = f.layout === 'object-per-asset';
  const fieldsSchema = schema?.target?.fields;
  const options = fieldsSchema?.options || [];
  const defaults = object ? fieldsSchema?.objectMemberDefault || [] : fieldsSchema?.default || [];
  const current = f.fields || defaults;
  const fieldsApply = state.mode === 'mqtt' && (object || f.format === 'envelope');
  const metaOptions = schema?.target?.metaFields?.options || [];
  const metaCurrent = f.metaFields || schema?.target?.metaFields?.default || metaOptions;
  const modes = schema?.target?.contextMode?.values || schema?.contextModes || ['meta', 'payload', 'none'];
  const sizes = preview?.sizes;
  const ctxSample = (preview?.tags || []).find((t) => t.payload && typeof t.payload === 'object' && t.payload.ctx) || (preview?.members || []).find((m) => m.payload?.ctx);
  const ctxBytes = ctxSample ? new TextEncoder().encode(`,"ctx":${JSON.stringify(ctxSample.payload.ctx)}`).length : 0;
  const toggleMeta = (k, on) => set.patch({ metaFields: metaOptions.filter((o) => (o === k ? on : metaCurrent.includes(o))) });
  const isDefaultFields = !f.fields;
  const noQuality = fieldsApply && !current.includes('q');
  return (
    <EditorSection id="map-payload" title="Payload" description="What each message carries and what the retained documents list.">
      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        {state.mode === 'mqtt' && (
          <div className="min-w-0 space-y-4">
            {!object && (
              <div>
                <SubHeading>Format</SubHeading>
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  <SegmentedControl size="sm" label="Payload format" value={f.format} onChange={(v) => !readOnly && set.patch({ format: v })} options={[{ value: 'envelope', label: 'Envelope' }, { value: 'plain', label: 'Plain value' }]} />
                </div>
                <p className="helper mt-1">{FORMAT_HELP[f.format]}</p>
              </div>
            )}
            <fieldset disabled={readOnly || !fieldsApply}>
              <legend className="flex w-full items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted">{object ? 'Fields of each member' : 'Fields of each payload'}</span>
                {!isDefaultFields && (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => set.patch({ fields: null })}>
                    Use defaults
                  </Button>
                )}
              </legend>
              {!fieldsApply ? (
                <p className="helper mt-1">A plain payload is the bare value; switch to the envelope format to choose fields.</p>
              ) : (
                <FieldOrder
                  options={options}
                  current={current}
                  required={fieldsSchema?.required || ['v']}
                  disabledKeys={f.contextMode === 'none' ? ['ctx'] : []}
                  descriptions={fieldsSchema?.descriptions || {}}
                  onChange={(next) => set.patch({ fields: next })}
                  readOnly={readOnly}
                />
              )}
              {fieldsApply && <p className="helper mt-1.5">Default: {defaults.join(', ')}. Fields are published in the order listed; reorder with the arrow buttons, the arrow keys on a handle, or drag.</p>}
            </fieldset>
            {noQuality && (
              <Banner variant="warn" title="Quality is not published">
                Without q, {fieldsSchema?.warnWithout?.q || 'consumers cannot tell a dead value from a live one'}. A failed cast still publishes a null value with its reason.
              </Banner>
            )}
          </div>
        )}

        <div className="min-w-0 space-y-4">
          <div>
            <SubHeading>Context</SubHeading>
            <div className="mt-1.5">
              <SegmentedControl size="sm" label="Where context goes" value={f.contextMode} onChange={(v) => !readOnly && set.patch({ contextMode: v, ...(v === 'none' && f.fields?.includes('ctx') ? { fields: f.fields.filter((x) => x !== 'ctx') } : {}) })} options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] || m }))} />
            </div>
            <p className="helper mt-1">{MODE_HELP[f.contextMode]}</p>
            {f.contextMode === 'payload' && state.mode === 'mqtt' && (
              <p className="mt-1 text-xs text-muted">
                {ctxBytes ? `ctx adds about ${fmtBytes(ctxBytes)} to each payload` : 'ctx size is shown once the server has checked the mapping'}
                {sizes ? ` · worst case ${fmtBytes(sizes.worstCasePayloadBytes)} per payload, ${fmtBytes(sizes.worstCaseCycleBytes)} per full publish` : ''}.
              </p>
            )}
            {f.contextMode === 'payload' && !object && f.format === 'plain' && <p className="mt-1 text-xs text-warn">Plain payloads cannot carry ctx; switch to the envelope format.</p>}
          </div>

          {state.mode === 'mqtt' && (
            <>
              <fieldset disabled={readOnly || !f.metaTopic}>
                <legend className="flex w-full items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted">What _meta lists per tag</span>
                  {f.metaFields && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => set.patch({ metaFields: null })}>
                      Use defaults
                    </Button>
                  )}
                </legend>
                <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {metaOptions.map((o) => (
                    <Checkbox key={o} checked={metaCurrent.includes(o)} onChange={(on) => toggleMeta(o, on)} label={o === 'source' ? <span title={META_HELP.source}>{META_LABEL[o]}</span> : META_LABEL[o] || o} />
                  ))}
                </div>
                <p className="helper mt-1">{metaCurrent.includes('source') ? META_HELP.source : 'Source addresses are kept off the broker.'}</p>
              </fieldset>
              <div className="space-y-2">
                <SubHeading>Retained documents</SubHeading>
                <Toggle checked={f.statusTopic} onChange={(v) => !readOnly && set.patch({ statusTopic: v })} label="_status" description="Online or offline, since when and why, so consumers can tell a quiet source from a dead one." disabled={readOnly} />
                <Toggle checked={f.metaTopic} onChange={(v) => !readOnly && set.patch({ metaTopic: v })} label="_meta" description="Each tag's type, unit, range, context and where it comes from, for discovery tools." disabled={readOnly} />
              </div>
            </>
          )}
        </div>
      </div>
    </EditorSection>
  );
}

/** Delivery: QoS, retain, report by exception, sampling, object size, direct history. */
export function DeliverySection({ state, set, errors, schema, historians, readOnly }) {
  const f = set.form;
  const err = (k) => errors.find((e) => e.section === 'delivery' && e.field === k)?.message;
  const mqttTarget = state.mode === 'mqtt';
  const eligible = (historians.data || []).filter((h) => !historianReason(h));
  const lim = schema?.limits?.maxObjectBytes;
  return (
    <EditorSection id="map-delivery" title="Delivery">
      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        <fieldset className="min-w-0 space-y-3" disabled={readOnly}>
          <legend className="sr-only">Broker delivery</legend>
          {mqttTarget && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select label="QoS" value={f.qos} onChange={(e) => set.patch({ qos: e.target.value })}>
                <option value={0}>0, at most once</option>
                <option value={1}>1, at least once</option>
                <option value={2}>2, exactly once</option>
              </Select>
              {state.srcType === 'opcua' && (
                <Field label="Sampling interval (ms)" error={err('sampling')}>
                  <Input type="number" min={50} value={f.samplingInterval} onChange={(e) => set.patch({ samplingInterval: e.target.value })} aria-invalid={Boolean(err('sampling')) || undefined} />
                </Field>
              )}
            </div>
          )}
          {mqttTarget && (
            <Toggle
              checked={f.retain}
              onChange={(v) => set.patch({ retain: v })}
              disabled={readOnly}
              label="Retain values"
              description="Off by default: a retained value outlives a dead device, so a new subscriber would read an old value as current. Turn it on for slow-changing values, and keep _status on."
            />
          )}
          {mqttTarget && f.layout === 'object-per-asset' && (
            <Field label="Maximum object size (bytes)" error={err('maxObjectBytes')} help={lim ? `Default ${lim.default.toLocaleString()}, allowed ${lim.min.toLocaleString()} to ${lim.max.toLocaleString()}. The server refuses a mapping whose worst-case object is larger.` : undefined}>
              <Input inputMode="numeric" value={f.maxObjectBytes} onChange={(e) => set.patch({ maxObjectBytes: e.target.value })} placeholder={lim ? String(lim.default) : '65536'} className="mono" aria-invalid={Boolean(err('maxObjectBytes')) || undefined} />
            </Field>
          )}
        </fieldset>

        {state.srcType === 'mqtt' && <MqttSourceFields form={f} patch={set.patch} err={err} readOnly={readOnly} />}

        <fieldset className="min-w-0 space-y-2" disabled={readOnly}>
          <legend className="text-xs font-medium text-muted">Report by exception</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Select label="Deadband" value={f.dbType} onChange={(e) => set.patch({ dbType: e.target.value })} options={[{ value: 'absolute', label: 'Absolute' }, { value: 'percent', label: 'Percent' }]} />
            <Field label={f.dbType === 'percent' ? 'Value (%)' : 'Value (units)'} error={err('deadband')}>
              <Input inputMode="decimal" value={f.dbValue} onChange={(e) => set.patch({ dbValue: e.target.value })} placeholder="none" className="mono" aria-invalid={Boolean(err('deadband')) || undefined} />
            </Field>
            <Field label="Heartbeat (ms)" error={err('heartbeat')} className="col-span-2 sm:col-span-1">
              <Input inputMode="numeric" value={f.heartbeatMs} onChange={(e) => set.patch({ heartbeatMs: e.target.value })} placeholder="off" className="mono" aria-invalid={Boolean(err('heartbeat')) || undefined} />
            </Field>
          </div>
          <p className="helper">{DEADBAND_HELP[f.dbType]} A tag can set its own band in its details.</p>
          <p className="helper">The heartbeat republishes an unchanged value at least this often (1000 ms or more), so consumers can tell unchanged from dead.</p>
        </fieldset>

        <fieldset className="min-w-0 space-y-2 lg:col-span-2" disabled={readOnly}>
          <legend className="text-xs font-medium text-muted">Direct history</legend>
          {historians.status === 'error' ? (
            <Banner variant="error" title="Could not load historians" onRetry={historians.retry}>
              {historians.error}
            </Banner>
          ) : historians.status === 'loading' ? (
            <p className="helper">Loading historians…</p>
          ) : !eligible.length ? (
            <p className="helper">
              Not available: no Timebase or TimescaleDB historian is configured.{' '}
              <Link to="/pipelines" className="text-accent-text underline">
                Configure historians under Pipelines
              </Link>
              .
            </p>
          ) : (
            <>
              <Checkbox
                checked={Boolean(f.historianId)}
                onChange={(on) => set.patch({ historianId: on ? eligible[0].id : '' })}
                label="Also write every published sample to a historian"
                description="The broker publish always happens. This adds store-and-forward history that survives a broker outage. Timebase and TimescaleDB only: they store quality."
              />
              {f.historianId && (
                <div role="radiogroup" aria-label="Historian" className="space-y-1.5 pl-6">
                  {(historians.data || []).map((h) => {
                    const reason = historianReason(h);
                    return (
                      <Radio
                        key={h.id}
                        name="historian"
                        value={h.id}
                        checked={f.historianId === h.id}
                        disabled={Boolean(reason)}
                        onChange={(v) => set.patch({ historianId: v })}
                        label={
                          <span className={clsx(reason && 'text-subtle')}>
                            {h.name || h.id} <span className="text-xs text-muted">({TYPE_LABEL[h.type] || h.type})</span>
                          </span>
                        }
                        description={reason || undefined}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </fieldset>
      </div>
    </EditorSection>
  );
}

/** MQTT-topic source: where the value is in each payload, and when a quiet topic counts as stale. */
function MqttSourceFields({ form, patch, err, readOnly }) {
  return (
    <fieldset className="min-w-0 space-y-2" disabled={readOnly}>
      <legend className="text-xs font-medium text-muted">Reading the topics</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Value field" error={err('srcField')} help="Dot path into a JSON payload, for example data.value. Empty: the payload itself; {v,t,q,u} and {value,timestamp,quality,unit} envelopes are read automatically.">
          <Input value={form.srcField} onChange={(e) => patch({ srcField: e.target.value })} placeholder="payload" className="mono" aria-invalid={Boolean(err('srcField')) || undefined} />
        </Field>
        <Field label="Mark stale after (ms)" error={err('staleAfterMs')} help="MQTT has no per-topic liveness: a topic silent for this long is published once as Bad (reason stale); its next message is Good again. Empty: never.">
          <Input inputMode="numeric" value={form.staleAfterMs} onChange={(e) => patch({ staleAfterMs: e.target.value })} placeholder="never" className="mono" aria-invalid={Boolean(err('staleAfterMs')) || undefined} />
        </Field>
      </div>
      <p className="helper">A tag can set its own field and staleness in its details.</p>
    </fieldset>
  );
}

export { NumberInput };
