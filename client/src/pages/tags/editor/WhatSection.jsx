import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { SegmentedControl, Select, Checkbox, Button, Input, Banner, Field } from '@/components/ui';
import { EditorSection, PatternInput } from './parts';
import { makeRow, defOf, supportsRules, RULE_LABEL } from '../mappingModel';

const PROPERTY_FILTER = [
  { value: 'any', label: 'Any tag' },
  { value: 'with', label: 'Only tags with a UNS name (property)' },
  { value: 'without', label: 'Only tags without a property' }
];

/** Inline picker of device / profile tags that are not in the mapping yet. */
function AddTags({ srcType, tagDefs, present, onAdd, onClose, suggestions }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const rest = useMemo(() => (tagDefs || []).filter((t) => !present.has(t.key)), [tagDefs, present]);
  const shown = rest.filter((t) => !q || `${t.key} ${t.property || ''} ${t.description || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const all = shown.length > 0 && shown.every((t) => picked.has(t.key));
  return (
    <div className="mt-3 rounded-md border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tags" aria-label="Filter tags to add" className="pl-8" />
        </div>
        <Checkbox label={`All shown (${shown.length})`} checked={all} onChange={() => setPicked(all ? new Set() : new Set(shown.map((t) => t.key)))} />
      </div>
      {rest.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted">Every tag of this {srcType === 'device-profile' ? 'profile' : 'device'} is already in the mapping.</p>
      ) : (
        <ul className="max-h-56 divide-y divide-line overflow-y-auto" aria-label="Tags not in this mapping">
          {shown.map((t) => (
            <li key={t.key} className="px-3 py-1.5">
              <Checkbox
                checked={picked.has(t.key)}
                onChange={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (n.has(t.key)) n.delete(t.key);
                    else n.add(t.key);
                    return n;
                  })
                }
                label={
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-mono text-xs">{t.key}</span>
                    {t.property && <span className="truncate text-xs text-muted">{t.property}</span>}
                    <span className="ml-auto font-mono text-2xs text-subtle">{[t.type, t.unit].filter(Boolean).join(' · ')}</span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2 border-t border-line px-3 py-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!picked.size}
          onClick={() => {
            onAdd(rest.filter((t) => picked.has(t.key)).map((t) => makeRow({ srcType, address: t.key, def: defOf(t), suggestion: suggestions?.get(t.key), apply: true })));
            setPicked(new Set());
          }}
        >
          <Plus size={12} aria-hidden="true" /> Add {picked.size || ''} tag{picked.size === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

/**
 * What to map: an explicit pick list with per-tag on/off, or (devices and profiles) every tag
 * that matches rules, which also picks up tags added to the device later.
 */
export default function WhatSection({ state, setState, onSwitchMode, tagDefs, device, profiles, profile, onPickProfile, verdicts, selection, schema, suggestions, readOnly, onShowExcluded, errors = [], topicsLoading = false }) {
  const [adding, setAdding] = useState(false);
  const rules = state.rules;
  const rulesOn = state.selectMode === 'rules';
  const setRules = (patch) => setState((s) => ({ ...s, rules: { ...s.rules, ...patch } }));
  const total = state.rows.length;
  const matched = state.rows.filter((r) => verdicts.get(r.key)?.matched !== false);
  const publishing = matched.filter((r) => r.enabled).length;
  const off = matched.length - publishing;
  const excluded = total - matched.length;
  const pollGroups = useMemo(() => {
    const ids = new Set((device?.pollGroups || []).map((g) => g.id));
    for (const t of tagDefs || []) ids.add(t.pollGroup || 'default');
    return [...ids];
  }, [device, tagDefs]);
  const types = useMemo(() => [...new Set((tagDefs || []).map((t) => t.type).filter(Boolean))].sort(), [tagDefs]);
  // Why tags are excluded: the server's selection rows when the preview has them (first instance
  // of a profile), else this page's mirror of the same rules while the server is still checking.
  const serverRows = useMemo(() => {
    if (!selection?.rows?.length || selection.truncated) return null;
    const unit = selection.rows[0].unitId;
    return selection.rows.filter((r) => r.unitId === unit);
  }, [selection]);
  const breakdown = useMemo(() => {
    const m = new Map();
    const reasons = serverRows ? serverRows.filter((r) => !r.matched && r.rule !== 'disabled') : state.rows.map((r) => verdicts.get(r.key)).filter((v) => v && !v.matched);
    for (const v of reasons) {
      const k = `${v.rule}${v.pattern ? ` ${v.pattern}` : ''}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m];
  }, [serverRows, state.rows, verdicts]);
  const present = useMemo(() => new Set(state.rows.map((r) => r.address)), [state.rows]);
  const selectHelp = schema?.select?.glob;
  const isProfile = state.srcType === 'device-profile';
  const mqtt = state.srcType === 'mqtt';
  const noun = mqtt ? 'topic' : 'tag';
  const filterErr = errors.find((e) => e.section === 'what' && e.field === 'filter')?.message;
  const serverMatched = serverRows ? serverRows.filter((r) => r.matched || r.rule === 'disabled').length : null;
  const serverDisagrees = rulesOn && serverMatched !== null && serverMatched !== matched.length;

  return (
    <EditorSection
      id="map-what"
      title="What to map"
      description={
        mqtt
          ? rulesOn
            ? 'Every topic under the filter that matches the rules is published, one value per topic. Topics that appear later are picked up automatically (at most 2000).'
            : 'Only the topics listed below are published, one value per topic. Switch a topic off to stop publishing it but keep its settings.'
          : rulesOn
            ? 'Every tag that matches the rules is published. Tags added to the device later are picked up automatically when they match.'
            : 'Only the tags listed below are published. Switch a tag off to stop publishing it but keep its settings; tags added to the device later are not picked up.'
      }
      actions={
        supportsRules(state.srcType) && (
          <SegmentedControl
            size="sm"
            label="How tags are chosen"
            value={state.selectMode}
            onChange={(m) => !readOnly && onSwitchMode(m)}
            options={[
              { value: 'list', label: mqtt ? 'Pick topics' : 'Pick tags' },
              { value: 'rules', label: mqtt ? 'All topics under a filter' : 'All tags by rule' }
            ]}
          />
        )
      }
    >
      {isProfile && (
        <div className="mb-4 max-w-md">
          <Select label="Device profile" value={profile?.id || ''} onChange={(e) => onPickProfile(e.target.value)} disabled={Boolean(state.original) || readOnly} help={state.original ? 'The profile of a saved mapping cannot change.' : undefined}>
            {!profile && <option value="">Choose a profile</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.instances?.length || 0} instance{p.instances?.length === 1 ? '' : 's'})
              </option>
            ))}
          </Select>
        </div>
      )}

      {rulesOn ? (
        <div className="space-y-4">
          <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2" disabled={readOnly}>
            <legend className="sr-only">Selection rules</legend>
            {mqtt && (
              <Field className="sm:col-span-2" label="Topic filter" error={filterErr} help="MQTT wildcards: + is one level, # the rest. Names keep the levels below the filter's fixed part.">
                <Input id="mqtt-filter" value={state.ref.filter || ''} onChange={(e) => setState((s) => ({ ...s, ref: { ...s.ref, filter: e.target.value } }))} placeholder="plant1/line1/#" className="mono" aria-invalid={Boolean(filterErr) || undefined} />
              </Field>
            )}
            <PatternInput label={mqtt ? 'Include (topic or name)' : 'Include (key or property)'} values={rules.include} onChange={(v) => setRules({ include: v })} placeholder="* (every tag)" help={selectHelp ? `Glob: ${selectHelp}.` : undefined} max={schema?.select?.fields?.include?.maxItems} />
            <PatternInput label="Exclude" values={rules.exclude} onChange={(v) => setRules({ exclude: v })} placeholder="*spare*, *_raw" max={schema?.select?.fields?.exclude?.maxItems} />
            {pollGroups.length > 1 && (
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-muted">Poll groups</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {pollGroups.map((g) => (
                    <Checkbox key={g} label={<span className="font-mono text-xs">{g}</span>} checked={rules.pollGroups.includes(g)} onChange={(on) => setRules({ pollGroups: on ? [...rules.pollGroups, g] : rules.pollGroups.filter((x) => x !== g) })} />
                  ))}
                </div>
                <p className="helper">None ticked: every poll group.</p>
              </div>
            )}
            {types.length > 1 && (
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-muted">Types</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {types.map((t) => (
                    <Checkbox key={t} label={<span className="font-mono text-xs">{t}</span>} checked={rules.types.map((x) => x.toLowerCase()).includes(t.toLowerCase())} onChange={(on) => setRules({ types: on ? [...rules.types, t] : rules.types.filter((x) => x.toLowerCase() !== t.toLowerCase()) })} />
                  ))}
                </div>
                <p className="helper">None ticked: every type.</p>
              </div>
            )}
            {!mqtt && (
              <Select
                label="Property"
                fieldClassName="sm:col-span-1"
                value={rules.withProperty === true ? 'with' : rules.withProperty === false ? 'without' : 'any'}
                onChange={(e) => setRules({ withProperty: e.target.value === 'with' ? true : e.target.value === 'without' ? false : null })}
                options={PROPERTY_FILTER}
              />
            )}
          </fieldset>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-l-2 border-line pl-3 text-sm" aria-live="polite">
            <span className="text-fg">
              <span className="font-medium tabular-nums">{matched.length.toLocaleString()}</span> of {total.toLocaleString()} {noun}s match
              {mqtt && topicsLoading && <span className="text-muted"> (checking the broker…)</span>}
              {off > 0 && <span className="text-muted">, {off} switched off</span>}
            </span>
            {excluded > 0 && (
              <button type="button" onClick={onShowExcluded} className="text-sm text-accent-text underline-offset-2 hover:underline">
                {excluded.toLocaleString()} excluded
              </button>
            )}
            {breakdown.length > 0 && (
              <span className="text-xs text-subtle">
                {breakdown
                  .slice(0, 4)
                  .map(([k, c]) => {
                    const [rule, ...pat] = k.split(' ');
                    return `${c} ${RULE_LABEL[rule] || rule}${pat.length ? ` ${pat.join(' ')}` : ''}`;
                  })
                  .join(' · ')}
                {serverRows ? ' (checked by the server)' : ''}
              </span>
            )}
          </div>
          {serverDisagrees && (
            <Banner variant="warn" title="The server counts a different selection">
              The server matches {serverMatched} tags, this page {matched.length}. Save uses the server&apos;s result; reload the device list if tags changed.
            </Banner>
          )}
        </div>
      ) : (
        <div>
          <p className="text-sm text-fg" aria-live="polite">
            <span className="font-medium tabular-nums">{publishing.toLocaleString()}</span> of {total.toLocaleString()} {noun}{total === 1 ? '' : 's'} published
            {off > 0 && <span className="text-muted"> · {off} switched off (kept with their settings)</span>}
          </p>
          {(state.srcType === 'device' || isProfile) && !readOnly && (
            <>
              {!adding && (
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAdding(true)} disabled={!tagDefs}>
                  <Plus size={12} aria-hidden="true" /> Add tags
                </Button>
              )}
              {adding && <AddTags srcType={state.srcType} tagDefs={tagDefs} present={present} suggestions={suggestions} onClose={() => setAdding(false)} onAdd={(rows) => setState((s) => ({ ...s, rows: [...s.rows, ...rows] }))} />}
            </>
          )}
        </div>
      )}
    </EditorSection>
  );
}
