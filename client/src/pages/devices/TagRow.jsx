import { memo } from 'react';
import { Trash2, AlertCircle, AlertTriangle, Clock } from 'lucide-react';
import clsx from 'clsx';
import { IconButton } from '@/components/ui';
import { cellCls } from './FormControls';
import { summarizeNormalized } from './model';
import { qualityInfo, formatValue } from '@/lib/deviceStatus';

const QUALITY_STYLE = { good: 'text-emerald-300', uncertain: 'text-amber-300', bad: 'text-rose-300' };
const ORDER_OPTIONS = [['', 'device default'], ['big', 'big'], ['little', 'little']];

function LiveCell({ sample, stale, quarantined }) {
  if (!sample) return <span className="text-slate-600">—</span>;
  const q = qualityInfo(sample.q);
  const title = [
    `Quality: ${q.label}`,
    sample.qReason && `Reason: ${sample.qReason}`,
    quarantined && 'Quarantined: the device rejected this tag, it is retried periodically',
    stale && 'Stale: no update for more than 3x the poll interval',
    sample.tRead && `Read ${new Date(sample.tRead).toLocaleTimeString()}`
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span title={title} className={clsx('flex flex-wrap items-center gap-x-1.5', stale && 'opacity-70')} data-quality={q.key} data-stale={stale ? 'true' : undefined}>
      <span className={clsx('mono truncate text-xs', q.key === 'bad' ? 'text-slate-500 line-through decoration-rose-400/60' : 'text-slate-100')}>{formatValue(sample.v)}</span>
      <span className={clsx('shrink-0 rounded px-1 text-[10px] font-semibold uppercase', QUALITY_STYLE[q.key], q.key === 'bad' && 'bg-rose-500/15')}>{q.key === 'good' ? 'OK' : q.label}</span>
      {stale && (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-semibold uppercase text-amber-300">
          <Clock size={9} aria-hidden="true" /> Stale
        </span>
      )}
      {q.key !== 'good' && sample.qReason && <span className="truncate text-2xs text-slate-500">{sample.qReason}</span>}
    </span>
  );
}

/**
 * One editable row. Memoised: typing in one row, or a live-value batch for one tag,
 * only re-renders the rows whose props actually changed.
 */
function TagRowImpl({ tag, index, protocol, types, typeOptional, placeholder, groupIds, validation, localError, sample, stale, quarantined, showLive, cols, advancedOpen, selected, onSelect, onChange, onDelete, onPaste }) {
  const n = index + 1;
  const err = localError || (validation && validation.ok === false ? validation.error || 'Invalid' : '');
  const wire = validation && validation.ok ? summarizeNormalized(protocol, validation.normalized) : '';
  const errId = `tag-${tag._id}-err`;
  const cell = (col, label, props = {}) => (
    <input className={cellCls} aria-label={`${label}, row ${n}`} value={tag[col] ?? ''} onChange={(e) => onChange(tag._id, { [col]: e.target.value })} onPaste={(e) => onPaste(e, index, col)} {...props} />
  );
  // Keep the raw text while typing ("0." must stay "0."); cleanTag converts on send.
  const num = (col, label) => cell(col, label, { inputMode: 'decimal', onChange: (e) => onChange(tag._id, { [col]: e.target.value === '' ? undefined : e.target.value }) });
  const orderSel = (col, label) => (
    <select className={cellCls} aria-label={`${label}, row ${n}`} value={tag[col] ?? ''} onChange={(e) => onChange(tag._id, { [col]: e.target.value || undefined })}>
      {ORDER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const extra = {
    length: () => num('length', 'Length'),
    bit: () => num('bit', 'Bit'),
    byteOrder: () => orderSel('byteOrder', 'Byte order override'),
    wordOrder: () => orderSel('wordOrder', 'Word order override')
  };
  const extraCols = [...cols.always, ...(advancedOpen ? cols.advanced : [])];
  const bad = showLive && sample && qualityInfo(sample.q).key === 'bad';
  return (
    <tr className={clsx('align-top', selected && 'bg-accent-500/5', err && 'bg-rose-500/5', bad && !err && 'bg-rose-500/[0.06]')} data-tag-key={tag.key}>
      <td className="px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-2xs text-slate-500">
          <input type="radio" name="tag-select" checked={selected} onChange={() => onSelect(tag._id)} aria-label={`Select row ${n} (${tag.key || 'unnamed'}) as probe target`} className="accent-sky-500" />
          {n}
        </label>
      </td>
      <td className="px-1 py-1.5">
        {cell('key', 'Key', { placeholder: 'tag key', 'aria-invalid': err ? true : undefined })}
        {quarantined && (
          <p className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1 text-2xs font-semibold text-amber-300" title="The device rejected this tag; it is retried periodically">
            <AlertTriangle size={10} aria-hidden="true" /> Quarantined
          </p>
        )}
      </td>
      <td className="px-1 py-1.5">
        {cell('address', 'Address', { placeholder, className: clsx(cellCls, 'mono'), 'aria-invalid': err ? true : undefined, 'aria-describedby': err || wire ? errId : undefined })}
        {(err || wire) && (
          <p id={errId} className={clsx('mt-1 flex items-start gap-1 text-2xs', err ? 'text-rose-300' : 'text-emerald-300/90')} role={err ? 'alert' : undefined}>
            {err && <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />}
            <span className="mono min-w-0 break-words">{err || wire}</span>
          </p>
        )}
      </td>
      {showLive && (
        <td className="px-2 py-2" aria-label={`Live value, row ${n}`}>
          <LiveCell sample={sample} stale={stale} quarantined={quarantined} />
        </td>
      )}
      <td className="px-1 py-1.5">
        <select className={cellCls} aria-label={`Type, row ${n}`} value={tag.type ?? ''} onChange={(e) => onChange(tag._id, { type: e.target.value })}>
          {typeOptional && <option value="">auto</option>}
          {tag.type && !types.includes(tag.type) && <option value={tag.type}>{tag.type}</option>}
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td className="px-1 py-1.5">
        <select className={cellCls} aria-label={`Poll group, row ${n}`} value={tag.pollGroup ?? ''} onChange={(e) => onChange(tag._id, { pollGroup: e.target.value })}>
          {tag.pollGroup && !groupIds.includes(tag.pollGroup) && <option value={tag.pollGroup}>{tag.pollGroup} (missing)</option>}
          {groupIds.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </td>
      <td className="px-1 py-1.5">{num('scale', 'Scale')}</td>
      <td className="px-1 py-1.5">{num('offset', 'Offset')}</td>
      <td className="px-1 py-1.5">{cell('unit', 'Unit')}</td>
      <td className="px-1 py-1.5">{cell('property', 'UNS property name', { placeholder: 'e.g. temperature' })}</td>
      <td className="px-1 py-1.5">{cell('description', 'Description')}</td>
      {extraCols.map((c) => <td key={c} className="px-1 py-1.5">{extra[c]()}</td>)}
      <td className="px-1 py-1">
        <IconButton icon={Trash2} side="left" label={`Delete row ${n}`} onClick={() => onDelete(tag._id)} />
      </td>
    </tr>
  );
}

export default memo(TagRowImpl);
