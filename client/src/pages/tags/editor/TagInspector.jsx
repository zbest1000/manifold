import { useState } from 'react';
import { ChevronUp, ChevronDown, RotateCcw, X } from 'lucide-react';
import { Input, Select, SegmentedControl, Button, IconButton } from '@/components/ui';
import { OverrideField, KeyValueEditor, NumberInput, SubHeading, OriginLabel, ErrorText } from './parts';
import { setOv, contextRows, contextObject, contextErrors, LIMIT_KEYS, rowVerdict, RULE_LABEL } from '../mappingModel';
import { nameBasis } from './TagTable';
import { inheritedValue } from '../mappingRows';

const STATES_LABEL = { 'label-field': 'Value plus label', replace: 'Label replaces value' };
const STATES_HELP = {
  'label-field': 'Publishes the raw value with its label beside it ("label": "Running").',
  replace: 'Publishes the label instead of the number. Works in plain payloads too.'
};
const LIMIT_LABEL = { lolo: 'Low low', lo: 'Low', hi: 'High', hihi: 'High high' };

/** Editable list seeded from an object, re-seeded when `seed` changes (another row, a reset). */
function useListFrom(obj, seed, toRows) {
  const [state, setState] = useState(() => ({ seed, rows: toRows(obj) }));
  if (state.seed !== seed) {
    const next = { seed, rows: toRows(obj) };
    setState(next);
    return [next.rows, (rows) => setState({ seed, rows })];
  }
  return [state.rows, (rows) => setState({ seed, rows })];
}

const statesToRows = (o) => Object.entries(o || {}).map(([key, value], i) => ({ id: `s${i}`, key, value: String(value), type: 'string' }));
const rowsToStates = (rows) => {
  const out = {};
  for (const r of rows) if (String(r.key).trim() !== '' || String(r.value).trim() !== '') out[String(r.key).trim()] = r.value;
  return Object.keys(out).length ? out : undefined;
};

function describeDeadband(db) {
  if (db === undefined) return 'inherit';
  if (db === 0) return 'off';
  if (typeof db === 'number') return 'absolute';
  return db?.type === 'percent' ? 'percent' : 'absolute';
}

/**
 * Everything about the active row beyond name / unit / description: display name, transform,
 * range and limits, states, per-tag deadband and context. Each value shows where it comes from
 * (device or mapping) with a one-click reset to the device value. Where a value comes from is
 * the server's answer (`serverTag`: the preview's origins, metadata and contextOrigins for this
 * row); a value set in this row is "mapping" at once, without waiting for the server.
 */
export default function TagInspector({ state, row, index, total, onRow, onMove, onClose, problems, schema, readOnly, serverTag = null }) {
  const [resetNonce, setResetNonce] = useState(0);
  const seed = `${row.key}|${resetNonce}`;
  const serverCtx = serverTag?.metadata?.context || {};
  const ctxInherited = Object.entries(serverCtx)
    .filter(([k]) => !(row.ov.context && Object.hasOwn(row.ov.context, k)))
    .map(([key, value]) => ({ key, value, origin: serverTag?.contextOrigins?.[key] || 'device' }));
  const [statesRows, setStatesRows] = useListFrom(row.ov.states ?? serverTag?.metadata?.states ?? row.def.states, `${seed}|states`, statesToRows);
  const [ctxRows, setCtxRows] = useListFrom(row.ov.context, `${seed}|ctx`, contextRows);
  const set = (field, value) => onRow((r) => setOv(r, field, value));
  const reset = (field) => {
    set(field, undefined);
    setResetNonce((n) => n + 1);
  };
  const err = (field) => problems.find((p) => p.field === field)?.message;
  const dataTypes = schema?.dataTypes || schema?.overrides?.dataType?.values || [];
  const statesModes = schema?.statesModes || ['label-field', 'replace'];
  const maxPrecision = schema?.limits?.maxPrecision ?? 10;
  const o = row.ov;
  const e = (f) => ({ origin: row.ov[f] !== undefined ? 'mapping' : serverTag?.origins?.[f] || null });
  const verdict = rowVerdict(state, row);
  const basis = nameBasis(row);
  const range = o.range || {};
  const inherited = (f) => inheritedValue(row, serverTag, f);
  const inheritedRange = inherited('range');
  const limits = o.limits || {};
  const dbKind = describeDeadband(o.deadband);
  const scale = o.scale;
  const offset = o.offset;
  const formula = [scale !== undefined ? `× ${scale}` : null, offset !== undefined ? `${offset < 0 ? '−' : '+'} ${Math.abs(offset)}` : null].filter(Boolean).join(' ');
  const disabled = readOnly;
  const ctxErrs = contextErrors(ctxRows, schema);

  return (
    <section aria-label={`Details of ${row.name || row.address}`} className="mt-3 rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-fg">
            <span className="truncate font-mono">{row.name || row.address}</span>
            <span className="font-mono text-xs font-normal text-subtle">
              {row.address}
              {row.def.type ? ` · ${row.def.type}` : ''}
              {row.def.pollGroup ? ` · poll group ${row.def.pollGroup}` : ''}
            </span>
          </p>
          <p className="text-xs text-subtle">
            Name from {basis.label}
            {!verdict.matched && ` · not published: ${RULE_LABEL[verdict.rule] || verdict.rule}${verdict.pattern ? ` ${verdict.pattern}` : ''}`}
            {verdict.matched && !row.enabled && ' · switched off'}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <span className="mr-1 font-mono text-xs text-subtle">
            {index + 1} / {total}
          </span>
          <IconButton icon={ChevronUp} label="Previous tag" onClick={() => onMove(-1)} disabled={index <= 0} />
          <IconButton icon={ChevronDown} label="Next tag" onClick={() => onMove(1)} disabled={index >= total - 1} />
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !Object.keys(o).length}
            onClick={() => {
              onRow((r) => ({ ...r, ov: {} }));
              setResetNonce((n) => n + 1);
            }}
          >
            <RotateCcw size={12} aria-hidden="true" /> {state.srcType === 'mqtt' ? 'Reset all' : 'Reset all to device'}
          </Button>
          <IconButton icon={X} label="Close details" side="left" onClick={onClose} />
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-5 p-4 lg:grid-cols-2">
        {state.srcType === 'mqtt' && (
          <fieldset className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-2" disabled={disabled}>
            <legend className="mb-2 text-sm font-medium text-fg">Reading this topic</legend>
            <OverrideField label="Value field" origin={o.field !== undefined ? 'mapping' : null} onReset={() => reset('field')} error={err('field')} help="Dot path into the JSON payload. Empty: the mapping's default.">
              <Input className="mono" value={o.field ?? ''} placeholder={state.form.srcField || 'payload'} onChange={(ev) => set('field', ev.target.value || undefined)} />
            </OverrideField>
            <OverrideField label="Mark stale after (ms)" origin={o.staleAfterMs !== undefined ? 'mapping' : null} onReset={() => reset('staleAfterMs')} error={err('staleAfterMs')} help="Empty: the mapping's default.">
              <NumberInput integer value={o.staleAfterMs} placeholder={state.form.staleAfterMs || 'never'} onChange={(v) => set('staleAfterMs', v)} />
            </OverrideField>
          </fieldset>
        )}
        <fieldset className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium text-fg">Metadata</legend>
          <OverrideField label="Display name" origin={e('displayName').origin} onReset={() => reset('displayName')} deviceValue={row.def.displayName} error={err('displayName')}>
            <Input value={o.displayName ?? ''} placeholder={inherited('displayName') || ''} onChange={(ev) => set('displayName', ev.target.value)} />
          </OverrideField>
          <OverrideField label="Unit" origin={e('unit').origin} onReset={() => reset('unit')} deviceValue={row.def.unit} error={err('unit')}>
            <Input value={o.unit ?? ''} placeholder={inherited('unit') || ''} onChange={(ev) => set('unit', ev.target.value)} />
          </OverrideField>
          <OverrideField className="sm:col-span-2" label="Description" origin={e('description').origin} onReset={() => reset('description')} deviceValue={row.def.description} error={err('description')}>
            <Input value={o.description ?? ''} placeholder={inherited('description') || ''} onChange={(ev) => set('description', ev.target.value)} />
          </OverrideField>
          <div className="min-w-0 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <SubHeading>Range (engineering units, after scaling)</SubHeading>
              <OriginLabel origin={e('range').origin} field="range" deviceValue={row.def.range} onReset={o.range ? () => reset('range') : undefined} />
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-3">
              <NumberInput aria-label="Range minimum" value={range.min} placeholder={inheritedRange ? String(inheritedRange.min) : 'min'} onChange={(v) => set('range', v === undefined && range.max === undefined ? undefined : { ...range, min: v })} />
              <NumberInput aria-label="Range maximum" value={range.max} placeholder={inheritedRange ? String(inheritedRange.max) : 'max'} onChange={(v) => set('range', v === undefined && range.min === undefined ? undefined : { ...range, max: v })} />
            </div>
            <ErrorText>{err('range')}</ErrorText>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <SubHeading>Limits</SubHeading>
              <OriginLabel origin={e('limits').origin} field="limits" deviceValue={row.def.limits} onReset={o.limits ? () => reset('limits') : undefined} />
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {LIMIT_KEYS.map((k) => (
                <label key={k} className="block min-w-0 space-y-1">
                  <span className="text-2xs text-subtle">{LIMIT_LABEL[k]}</span>
                  <NumberInput
                    value={limits[k]}
                    placeholder={row.def.limits?.[k] !== undefined ? String(row.def.limits[k]) : ''}
                    onChange={(v) => {
                      const next = { ...limits };
                      if (v === undefined) delete next[k];
                      else next[k] = v;
                      set('limits', Object.keys(next).length ? next : undefined);
                    }}
                  />
                </label>
              ))}
            </div>
            <p className="helper mt-1">Published as metadata for alarm tools. Manifold raises no alarms itself.</p>
            <ErrorText>{err('limits')}</ErrorText>
          </div>
        </fieldset>

        <fieldset className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium text-fg">Value</legend>
          <OverrideField className="col-span-2" label="Publish as" origin={e('dataType').origin} onReset={() => reset('dataType')} error={err('dataType')}>
            <Select value={o.dataType || ''} onChange={(ev) => set('dataType', ev.target.value || undefined)}>
              <option value="">Device type{row.def.type ? ` (${row.def.type})` : ''}</option>
              {dataTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </OverrideField>
          <OverrideField label="Scale" origin={e('scale').origin} onReset={() => reset('scale')} error={err('scale')}>
            <NumberInput value={scale} placeholder="1" onChange={(v) => set('scale', v)} />
          </OverrideField>
          <OverrideField label="Offset" origin={e('offset').origin} onReset={() => reset('offset')} error={err('offset')}>
            <NumberInput value={offset} placeholder="0" onChange={(v) => set('offset', v)} />
          </OverrideField>
          <OverrideField label="Decimals" origin={e('precision').origin} onReset={() => reset('precision')} error={err('precision')}>
            <NumberInput integer value={o.precision} placeholder="as read" onChange={(v) => set('precision', v)} />
          </OverrideField>
          <div className="col-span-1 min-w-0 self-end pb-2 sm:col-span-3">
            <p className="truncate font-mono text-xs text-muted" title="The value pipeline: read, scale and offset, cast, deadband, then rounding and states for publishing">
              published = raw{formula ? ` ${formula}` : ''}
              {o.dataType ? ` → ${o.dataType}` : ''}
              {o.precision !== undefined ? `, ${o.precision} dp` : ''}
            </p>
          </div>
          <p className="helper col-span-2 -mt-1 sm:col-span-4">
            Decimals 0 to {maxPrecision} round the published value only; change detection uses the exact value.
            {o.dataType ? ' A value that cannot be cast publishes Bad quality with a reason, never a wrong value.' : ''}
          </p>

          <div className="col-span-2 min-w-0 sm:col-span-4">
            <div className="flex items-center justify-between gap-2">
              <SubHeading>Report by exception</SubHeading>
              <OriginLabel origin={o.deadband !== undefined ? 'mapping' : null} field="deadband" onReset={() => reset('deadband')} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <SegmentedControl
                size="sm"
                label="Deadband for this tag"
                value={dbKind}
                onChange={(k) => set('deadband', k === 'inherit' ? undefined : k === 'off' ? 0 : { type: k, value: Number(o.deadband?.value ?? (typeof o.deadband === 'number' ? o.deadband : 0)) || 0 })}
                options={[
                  { value: 'inherit', label: 'Mapping default' },
                  { value: 'off', label: 'Every change' },
                  { value: 'absolute', label: 'Absolute' },
                  { value: 'percent', label: 'Percent' }
                ]}
              />
              {(dbKind === 'absolute' || dbKind === 'percent') && (
                <NumberInput
                  aria-label={dbKind === 'percent' ? 'Deadband percent' : 'Deadband in engineering units'}
                  className="w-28"
                  value={typeof o.deadband === 'number' ? o.deadband : o.deadband?.value}
                  onChange={(v) => set('deadband', { type: dbKind, value: v ?? 0 })}
                />
              )}
            </div>
            <ErrorText>{err('deadband')}</ErrorText>
          </div>

          <div className="col-span-2 min-w-0 sm:col-span-4">
            <div className="flex items-center justify-between gap-2">
              <SubHeading>States</SubHeading>
              <OriginLabel origin={e('states').origin} field="states" deviceValue={row.def.states} onReset={o.states ? () => reset('states') : undefined} />
            </div>
            <div className="mt-1.5 space-y-2">
              <KeyValueEditor
                rows={statesRows}
                keyLabel="Raw value"
                valueLabel="Label"
                keyPlaceholder="1"
                valuePlaceholder="Running"
                addLabel="Add state"
                monoKeys
                onChange={(rows) => {
                  setStatesRows(rows);
                  set('states', rowsToStates(rows));
                }}
              />
              {(o.states || row.def.states) && (
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl size="sm" label="How states are published" value={o.statesMode || 'label-field'} onChange={(m) => set('statesMode', m === 'label-field' && !o.statesMode ? undefined : m)} options={statesModes.map((m) => ({ value: m, label: STATES_LABEL[m] || m }))} />
                  <span className="helper">{STATES_HELP[o.statesMode || 'label-field']}</span>
                </div>
              )}
              <ErrorText>{err('states')}</ErrorText>
            </div>
          </div>
        </fieldset>

        <fieldset className="min-w-0 lg:col-span-2" disabled={disabled}>
          <legend className="mb-2 flex w-full items-center justify-between gap-2 text-sm font-medium text-fg">
            <span>Tag context</span>
            <span className="text-xs font-normal text-subtle">merged over the asset context; mapping wins key by key</span>
          </legend>
          <KeyValueEditor
            rows={ctxRows}
            typed
            inherited={ctxInherited}
            errors={ctxErrs.filter((x) => x.id)}
            addLabel="Add context key"
            keyPlaceholder="measurementType"
            valuePlaceholder="temperature"
            onChange={(rows) => {
              setCtxRows(rows);
              set('context', contextObject(rows) || undefined);
            }}
          />
          {ctxErrs.filter((x) => !x.id).map((x) => (
            <ErrorText key={x.message}>{x.message}</ErrorText>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
