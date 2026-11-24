import { memo } from 'react';
import { Trash2, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { IconButton } from '@/components/ui';
import { cellCls } from './FormControls';
import { describeWireAddress } from '@/lib/deviceTags';
import { qualityInfo, formatValue } from '@/lib/deviceStatus';

const QUALITY_STYLE = {
  good: 'text-emerald-300',
  uncertain: 'text-amber-300',
  bad: 'text-rose-300'
};

function LiveCell({ sample }) {
  if (!sample) return <span className="text-slate-600">—</span>;
  const q = qualityInfo(sample.q);
  const title = [`Quality: ${q.label}`, sample.qReason && `Reason: ${sample.qReason}`, sample.tRead && `Read ${new Date(sample.tRead).toLocaleTimeString()}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <span title={title} className="flex items-center gap-1.5">
      <span className={clsx('mono truncate text-xs', q.key === 'bad' ? 'text-slate-500 line-through decoration-rose-400/60' : 'text-slate-100')}>{formatValue(sample.v)}</span>
      <span className={clsx('shrink-0 rounded px-1 text-[10px] font-semibold uppercase', QUALITY_STYLE[q.key], q.key === 'bad' && 'bg-rose-500/15')}>
        {q.key === 'good' ? 'OK' : q.label}
      </span>
      {q.key !== 'good' && sample.qReason && <span className="truncate text-2xs text-slate-500">{sample.qReason}</span>}
    </span>
  );
}

/**
 * One editable row. Memoised: typing in one row, or a live-value batch for one tag,
 * only re-renders the rows whose props actually changed.
 */
function TagRowImpl({ tag, index, types, groupIds, validation, localError, sample, showLive, advanced, selected, onSelect, onChange, onDelete, onPaste }) {
  const n = index + 1;
  const err = localError || (validation && validation.ok === false ? validation.error || 'Invalid' : '');
  const wire = validation && validation.ok ? describeWireAddress(validation.normalized) : '';
  const errId = `tag-${tag._id}-err`;
  const cell = (col, label, props = {}) => (
    <input
      className={cellCls}
      aria-label={`${label}, row ${n}`}
      value={tag[col] ?? ''}
      onChange={(e) => onChange(tag._id, { [col]: e.target.value })}
      onPaste={(e) => onPaste(e, index, col)}
      {...props}
    />
  );
  const num = (col, label, w) =>
    cell(col, label, {
      inputMode: 'decimal',
      className: clsx(cellCls, w),
      // Keep the raw text while typing ("0." must stay "0."); cleanTag converts on send.
      onChange: (e) => onChange(tag._id, { [col]: e.target.value === '' ? undefined : e.target.value })
    });
  const bad = showLive && sample && qualityInfo(sample.q).key === 'bad';
  return (
    <tr className={clsx('align-top', selected && 'bg-accent-500/5', err && 'bg-rose-500/5', bad && !err && 'bg-rose-500/[0.04]')}>
      <td className="px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-2xs text-slate-500">
          <input
            type="radio"
            name="tag-select"
            checked={selected}
            onChange={() => onSelect(tag._id)}
            aria-label={`Select row ${n} (${tag.key || 'unnamed'}) as probe target`}
            className="accent-sky-500"
          />
          {n}
        </label>
      </td>
      <td className="px-1 py-1.5">{cell('key', 'Key', { placeholder: 'tag key', 'aria-invalid': err ? true : undefined })}</td>
      <td className="px-1 py-1.5">
        {cell('address', 'Address', { placeholder: 'holding:100', className: clsx(cellCls, 'mono'), 'aria-invalid': err ? true : undefined, 'aria-describedby': err || wire ? errId : undefined })}
        {(err || wire) && (
          <p id={errId} className={clsx('mt-1 flex items-start gap-1 text-2xs', err ? 'text-rose-300' : 'mono text-emerald-300/90')}>
            {err && <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 break-words">{err || wire}</span>
          </p>
        )}
      </td>
      {showLive && (
        <td className="px-2 py-2" aria-label={`Live value, row ${n}`}>
          <LiveCell sample={sample} />
        </td>
      )}
      <td className="px-1 py-1.5">
        <select className={cellCls} aria-label={`Type, row ${n}`} value={tag.type ?? ''} onChange={(e) => onChange(tag._id, { type: e.target.value })}>
          {tag.type && !types.includes(tag.type) && <option value={tag.type}>{tag.type}</option>}
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1 py-1.5">
        <select className={cellCls} aria-label={`Poll group, row ${n}`} value={tag.pollGroup ?? ''} onChange={(e) => onChange(tag._id, { pollGroup: e.target.value })}>
          {tag.pollGroup && !groupIds.includes(tag.pollGroup) && <option value={tag.pollGroup}>{tag.pollGroup} (missing)</option>}
          {groupIds.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1 py-1.5">{num('scale', 'Scale')}</td>
      <td className="px-1 py-1.5">{num('offset', 'Offset')}</td>
      <td className="px-1 py-1.5">{cell('unit', 'Unit')}</td>
      <td className="px-1 py-1.5">{cell('property', 'UNS property name', { placeholder: 'e.g. Temperature' })}</td>
      <td className="px-1 py-1.5">{cell('description', 'Description')}</td>
      {advanced && (
        <>
          <td className="px-1 py-1.5">{num('length', 'Length (registers)')}</td>
          <td className="px-1 py-1.5">{num('bit', 'Bit')}</td>
          <td className="px-1 py-1.5">
            <select className={cellCls} aria-label={`Byte order override, row ${n}`} value={tag.byteOrder ?? ''} onChange={(e) => onChange(tag._id, { byteOrder: e.target.value || undefined })}>
              <option value="">device default</option>
              <option value="big">big</option>
              <option value="little">little</option>
            </select>
          </td>
          <td className="px-1 py-1.5">
            <select className={cellCls} aria-label={`Word order override, row ${n}`} value={tag.wordOrder ?? ''} onChange={(e) => onChange(tag._id, { wordOrder: e.target.value || undefined })}>
              <option value="">device default</option>
              <option value="big">big</option>
              <option value="little">little</option>
            </select>
          </td>
        </>
      )}
      <td className="px-1 py-1">
        <IconButton icon={Trash2} label={`Delete row ${n}`} onClick={() => onDelete(tag._id)} />
      </td>
    </tr>
  );
}

export default memo(TagRowImpl);
