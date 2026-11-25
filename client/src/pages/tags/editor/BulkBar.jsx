import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button, Input, Select, Checkbox, IconButton, Field } from '@/components/ui';
import { NumberInput } from './parts';
import { bulkEnable, bulkSet, bulkContextKey, bulkRename, bulkCopy, bulkReset } from '../mappingModel';

const ACTIONS = [
  { value: '', label: 'More actions…' },
  { value: 'unit', label: 'Set unit' },
  { value: 'description', label: 'Set description' },
  { value: 'deadband', label: 'Set deadband' },
  { value: 'context', label: 'Set a context key' },
  { value: 'replace', label: 'Find and replace in names' },
  { value: 'camel', label: 'Names to camelCase' },
  { value: 'snake', label: 'Names to snake_case' },
  { value: 'strip', label: 'Strip a prefix from names' },
  { value: 'copy', label: 'Copy settings from a tag' },
  { value: 'reset', label: 'Reset to device values' }
];

/**
 * Actions over the selected rows. Simple ones apply at once; the others open an inline form under
 * the bar (no popovers), so everything stays keyboard reachable.
 */
export default function BulkBar({ selected, rows, onRows, onClear, flags, onDone }) {
  const [action, setAction] = useState('');
  const [text, setText] = useState('');
  const [text2, setText2] = useState('');
  const [num, setNum] = useState(undefined);
  const [dbType, setDbType] = useState('absolute');
  const [regex, setRegex] = useState(false);
  const [from, setFrom] = useState('');
  const formRef = useRef(null);
  // Opening an inline form moves focus to its first field.
  useEffect(() => {
    if (action) formRef.current?.querySelector('input:not([type=checkbox]),select')?.focus();
  }, [action]);
  const n = selected.size;
  const keys = [...selected];
  const done = (msg) => {
    onDone?.(msg);
    setAction('');
    setText('');
    setText2('');
    setNum(undefined);
  };
  const apply = () => {
    if (action === 'unit' || action === 'description') {
      onRows((rs) => bulkSet(rs, keys, action, text));
      done(`${action === 'unit' ? 'Unit' : 'Description'} set on ${n} tag${n === 1 ? '' : 's'}.`);
    } else if (action === 'deadband') {
      onRows((rs) => bulkSet(rs, keys, 'deadband', num === undefined ? undefined : { type: dbType, value: num }));
      done(`Deadband set on ${n} tags.`);
    } else if (action === 'context') {
      if (!text.trim()) return;
      onRows((rs) => bulkContextKey(rs, keys, text.trim(), text2));
      done(`Context key ${text.trim()} set on ${n} tags.`);
    } else if (action === 'replace') {
      onRows((rs) => bulkRename(rs, keys, { kind: 'replace', find: text, replace: text2, regex }));
      done(`Replaced in ${n} names.`);
    } else if (action === 'strip') {
      onRows((rs) => bulkRename(rs, keys, { kind: 'strip', prefix: text }));
      done(`Prefix stripped from ${n} names.`);
    } else if (action === 'copy') {
      if (!from) return;
      onRows((rs) => bulkCopy(rs, from, keys));
      done(`Settings copied to ${n} tags.`);
    }
  };
  const pick = (v) => {
    if (v === 'camel' || v === 'snake') {
      onRows((rs) => bulkRename(rs, keys, { kind: v }));
      done(`${n} names converted to ${v === 'camel' ? 'camelCase' : 'snake_case'}.`);
      return;
    }
    if (v === 'reset') {
      onRows((rs) => bulkReset(rs, keys));
      done(`${n} tags reset to their device values.`);
      return;
    }
    setAction(v);
  };
  const actions = ACTIONS.filter((a) => flags.overrides || !['unit', 'description', 'deadband', 'context', 'copy', 'reset'].includes(a.value));
  const regexError = action === 'replace' && regex && text ? (() => {
    try {
      new RegExp(text);
      return null;
    } catch (e) {
      return e.message;
    }
  })() : null;

  return (
    <div role="toolbar" aria-label="Actions for the selected tags" className="mb-2 rounded-md border border-line bg-raised">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <span className="px-1 text-sm font-medium tabular-nums text-fg" aria-live="polite">
          {n} selected
        </span>
        <Button size="sm" variant="secondary" onClick={() => onRows((rs) => bulkEnable(rs, keys, true))}>
          Publish
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onRows((rs) => bulkEnable(rs, keys, false))}>
          Don&apos;t publish
        </Button>
        {flags.renameable && (
          <Select aria-label="More actions for the selected tags" value={action} onChange={(e) => pick(e.target.value)} className="h-7 py-0 text-xs" wrapperClassName="w-56">
            {actions.map((a) => (
              <option key={a.value} value={a.value} disabled={a.value === ''}>
                {a.label}
              </option>
            ))}
          </Select>
        )}
        <span className="flex-1" />
        <IconButton icon={X} label="Clear the selection" onClick={onClear} className="h-7 w-7" />
      </div>
      {action && (
        <form
          ref={formRef}
          className="flex flex-wrap items-end gap-2 border-t border-line px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {(action === 'unit' || action === 'description') && (
            <Field className="min-w-0 flex-1 basis-56" label={<>{action === 'unit' ? 'Unit' : 'Description'} for {n} tags (empty = use the device value)</>}>
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          {action === 'deadband' && (
            <>
              <Select label="Type" value={dbType} onChange={(e) => setDbType(e.target.value)} fieldClassName="w-36" options={[{ value: 'absolute', label: 'Absolute' }, { value: 'percent', label: 'Percent' }]} />
              <Field className="w-36" label="Value (empty = default)">
              <NumberInput value={num} onChange={setNum} />
            </Field>
            </>
          )}
          {action === 'context' && (
            <>
              <Field className="w-48" label="Key">
              <Input className="mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="measurementType" />
            </Field>
              <Field className="min-w-0 flex-1 basis-48" label="Value">
              <Input className="mono text-xs" value={text2} onChange={(e) => setText2(e.target.value)} placeholder="temperature" />
            </Field>
            </>
          )}
          {action === 'replace' && (
            <>
              <Field className="min-w-0 flex-1 basis-40" label="Find">
              <Input className="mono text-xs" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={Boolean(regexError) || undefined} />
            </Field>
              <Field className="min-w-0 flex-1 basis-40" label="Replace with">
              <Input className="mono text-xs" value={text2} onChange={(e) => setText2(e.target.value)} placeholder={regex ? '$1 refers to a group' : ''} />
            </Field>
              <Checkbox className="mb-1.5" label="Regular expression" checked={regex} onChange={setRegex} />
            </>
          )}
          {action === 'strip' && (
            <Field className="min-w-0 flex-1 basis-48" label="Prefix (case-insensitive)">
              <Input className="mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="DB10_" />
            </Field>
          )}
          {action === 'copy' && (
            <Select label="Copy unit, range, transform, states, limits, deadband and context from" value={from} onChange={(e) => setFrom(e.target.value)} fieldClassName="min-w-0 flex-1 basis-64">
              <option value="">Choose a tag</option>
              {rows.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name} ({r.address})
                </option>
              ))}
            </Select>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAction('')}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" type="submit" disabled={Boolean(regexError) || (action === 'copy' && !from) || (action === 'context' && !text.trim())}>
              Apply to {n}
            </Button>
          </div>
          {regexError && <p role="alert" className="w-full text-xs text-bad">{regexError}</p>}
        </form>
      )}
    </div>
  );
}
