import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Input, IconButton } from '@/components/ui';
import { TRANSFORM_META, formatRenameMap, parseCsv, parseJsonObject, parseRenameMap } from './helpers';

const mono = 'mono text-xs';

/**
 * One step of a route's transform chain: its position, a plain-language name and hint, the compact form
 * for its settings, and move / remove controls. Rendered inside an <ol> that supplies the hairlines.
 */
export default function TransformRow({ t, index, count, onChange, onRemove, onMove, readOnly = false }) {
  const n = index + 1;
  const meta = TRANSFORM_META[t.type] || { label: t.type, hint: '' };
  const field = (label, props) => <Input aria-label={`Transform ${n}: ${label}`} disabled={readOnly} {...props} className={`${mono} ${props.className || ''}`} />;
  return (
    <li className="flex items-start gap-3 px-3 py-3">
      <span aria-hidden="true" className="mt-1 w-5 shrink-0 text-right text-sm tabular-nums text-subtle">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">
          <span className="sr-only">Transform {n}: </span>
          {meta.label}
        </p>
        <p className="text-xs text-subtle">{meta.hint}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {t.type === 'repath' && field('new topic', { value: t.to, className: 'w-full sm:w-80', placeholder: 'uns/{1}/{3-}', onChange: (e) => onChange({ ...t, to: e.target.value }) })}
          {t.type === 'pick' && field('fields to keep', { value: (t.fields || []).join(','), className: 'w-full sm:w-72', placeholder: 'field1,field2', onChange: (e) => onChange({ ...t, fields: parseCsv(e.target.value) }) })}
          {t.type === 'rename' && field('rename map', { value: formatRenameMap(t.map), className: 'w-full sm:w-72', placeholder: 'old:new,old2:new2', onChange: (e) => onChange({ ...t, map: parseRenameMap(e.target.value) }) })}
          {t.type === 'set' &&
            field('values to set (JSON)', {
              defaultValue: JSON.stringify(t.values || {}),
              className: 'w-full sm:w-72',
              placeholder: '{"site":"emmeloord"}',
              onChange: (e) => {
                const v = parseJsonObject(e.target.value);
                if (v) onChange({ ...t, values: v }); // keep typing while the JSON is incomplete
              }
            })}
          {t.type === 'scale' && (
            <>
              {field('field (optional)', { value: t.field || '', className: 'w-32', placeholder: 'field (optional)', onChange: (e) => onChange({ ...t, field: e.target.value }) })}
              <span aria-hidden="true" className="text-sm text-subtle">
                ×
              </span>
              {field('multiply by', { value: t.mul, className: 'w-20', onChange: (e) => onChange({ ...t, mul: e.target.value }) })}
              <span aria-hidden="true" className="text-sm text-subtle">
                +
              </span>
              {field('add', { value: t.add, className: 'w-20', onChange: (e) => onChange({ ...t, add: e.target.value }) })}
            </>
          )}
          {t.type === 'numeric' && field('field (optional)', { value: t.field || '', className: 'w-40', placeholder: 'field (optional)', onChange: (e) => onChange({ ...t, field: e.target.value }) })}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <IconButton icon={ArrowUp} label={`Move transform ${n} up`} size={14} disabled={readOnly || index === 0} onClick={() => onMove(index, index - 1)} />
        <IconButton icon={ArrowDown} label={`Move transform ${n} down`} size={14} disabled={readOnly || index === count - 1} onClick={() => onMove(index, index + 1)} />
        <IconButton icon={Trash2} label={`Remove transform ${n} (${meta.label})`} size={14} className="hover:bg-bad/10 hover:text-bad" disabled={readOnly} onClick={onRemove} />
      </div>
    </li>
  );
}
