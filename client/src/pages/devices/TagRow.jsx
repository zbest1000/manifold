import { memo } from 'react';
import { Trash2, AlertCircle, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { IconButton, StatusText } from '@/components/ui';
import { cellCls, FromProfileBadge } from './FormControls';
import { summarizeNormalized, lengthDefault } from './model';
import { qualityInfo, formatReading, formatValue, quarantineReasonText } from '@/lib/deviceStatus';

const ORDER_OPTIONS = [['', 'device default'], ['big', 'big'], ['little', 'little']];
const QUALITY_TONE = { good: 'good', uncertain: 'warn', bad: 'bad' };

/** The live value of a row in the editor: the reading, then the quality word, with the details in the tooltip. */
function LiveCell({ sample, stale, quarantined }) {
  if (!sample) return <span className="text-faint">—</span>;
  const q = qualityInfo(sample.q);
  const title = [
    `Quality: ${q.label}`,
    sample.qReason && `Reason: ${sample.qReason}`,
    quarantined && 'Quarantined: the device rejected this tag, it is retried periodically',
    stale && 'Stale: no update for more than 3x the poll interval',
    sample.tRead && `Read ${new Date(sample.tRead).toLocaleTimeString()}`,
    typeof sample.v === 'number' && `Raw ${formatValue(sample.v)}`
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span title={title} className={clsx('flex flex-wrap items-center gap-x-2', stale && 'opacity-70')} data-quality={q.key} data-stale={stale ? 'true' : undefined}>
      <span className={clsx('mono truncate text-xs tabular-nums', q.key === 'bad' ? 'text-subtle line-through decoration-bad/60' : 'text-fg')}>{formatReading(sample.v)}</span>
      <StatusText tone={stale && q.key === 'good' ? 'warn' : QUALITY_TONE[q.key]} className="text-xs">
        {stale && q.key === 'good' ? 'Stale' : q.label}
      </StatusText>
    </span>
  );
}

const TD = 'px-1.5 py-1.5 align-top';

/**
 * One editable row. Memoised: typing in one row, or a live-value batch for one tag,
 * only re-renders the rows whose props actually changed.
 */
function TagRowImpl({ tag, index, protocol, types, typeOptional, typeInfo, placeholder, groupIds, validation, localError, sample, stale, quarantined, quarantineReason, showLive, cols, advancedOpen, selected, onSelect, onChange, onDelete, onPaste, readOnly }) {
  const n = index + 1;
  const err = localError || (validation && validation.ok === false ? validation.error || 'Invalid' : '');
  const wire = validation && validation.ok ? summarizeNormalized(protocol, validation.normalized) : '';
  const errId = `tag-${tag._id}-err`;
  const cell = (col, label, props = {}) => (
    <input className={cellCls} aria-label={`${label}, row ${n}`} value={tag[col] ?? ''} disabled={readOnly} onChange={(e) => onChange(tag._id, { [col]: e.target.value })} onPaste={(e) => onPaste(e, index, col)} {...props} />
  );
  // Keep the raw text while typing ("0." must stay "0."); cleanTag converts on send.
  const num = (col, label, props = {}) => cell(col, label, { inputMode: 'decimal', onChange: (e) => onChange(tag._id, { [col]: e.target.value === '' ? undefined : e.target.value }), ...props });
  const orderSel = (col, label) => (
    <select className={cellCls} aria-label={`${label}, row ${n}`} value={tag[col] ?? ''} disabled={readOnly} onChange={(e) => onChange(tag._id, { [col]: e.target.value || undefined })}>
      {ORDER_OPTIONS.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  const lengthInfo = typeInfo?.[tag.type] || typeInfo?.[String(tag.type || '').toUpperCase()];
  const extra = {
    // Optional: a blank length is not an error, the driver applies its own default (stated, not "required").
    length: () => {
      const dflt = lengthInfo?.needsLength ? lengthDefault(lengthInfo) : null;
      return num('length', 'Length', dflt === null ? {} : { placeholder: `default ${dflt}`, title: `Maximum characters. Defaults to ${dflt} when blank.` });
    },
    bit: () => num('bit', 'Bit'),
    byteOrder: () => orderSel('byteOrder', 'Byte order override'),
    wordOrder: () => orderSel('wordOrder', 'Word order override'),
    description: () => cell('description', 'Description'),
    encoding: () => (
      <select className={cellCls} aria-label={`Text encoding, row ${n}`} value={tag.encoding ?? ''} disabled={readOnly} onChange={(e) => onChange(tag._id, { encoding: e.target.value || undefined })}>
        <option value="">auto</option>
        <option value="text">text</option>
        <option value="hex">hex</option>
      </select>
    ),
    rate: () => (
      <span className="grid h-7 place-items-center" title="Publish the counter as a per-second rate">
        <input type="checkbox" aria-label={`Rate per second, row ${n}`} checked={tag.rate === true || tag.rate === 'true'} disabled={readOnly} onChange={(e) => onChange(tag._id, { rate: e.target.checked || undefined })} className="h-3.5 w-3.5 accent-accent" />
      </span>
    )
  };
  const extraCols = [...cols.always, ...(advancedOpen ? cols.advanced : [])];
  const bad = showLive && sample && qualityInfo(sample.q).key === 'bad';
  return (
    <tr
      className={clsx('border-t border-line align-top', selected && 'bg-accent/[0.07]', !selected && err && 'bg-bad/[0.05]', !selected && bad && !err && 'bg-bad/[0.06]')}
      data-tag-key={tag.key}
    >
      <td className={clsx(TD, 'border-l-2 pl-2', selected ? 'border-l-accent' : err || bad ? 'border-l-bad' : 'border-l-transparent')}>
        <button
          type="button"
          onClick={() => onSelect(selected ? null : tag._id)}
          aria-pressed={selected}
          aria-label={`Select row ${n} (${tag.key || 'unnamed'})`}
          title="Select this row as the target for the probe"
          className={clsx('grid h-7 min-w-7 place-items-center rounded px-1 text-xs tabular-nums transition-colors', selected ? 'bg-accent/15 text-accent-text' : 'text-subtle hover:bg-raised hover:text-fg')}
        >
          {n}
        </button>
      </td>
      <td className={TD}>
        {cell('key', 'Key', { placeholder: 'tag key', 'aria-invalid': err ? true : undefined })}
        {quarantined && (
          <p className="mt-1 flex w-0 min-w-full items-start gap-1 text-xs text-warn" title="The device rejected this tag; it is retried periodically">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate" title={quarantineReasonText(quarantineReason)}>Quarantined{quarantineReason ? `: ${quarantineReasonText(quarantineReason)}` : ''}</span>
          </p>
        )}
      </td>
      <td className={TD}>
        {cell('address', 'Address', { placeholder, className: clsx(cellCls, 'mono'), 'aria-invalid': err ? true : undefined, 'aria-describedby': err || wire ? errId : undefined })}
        {(err || wire) && (
          <p id={errId} className={clsx('mt-1 flex w-0 min-w-full items-start gap-1 text-xs', err ? 'text-bad' : 'text-subtle')} role={err ? 'alert' : undefined}>
            {err && <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />}
            <span className="mono min-w-0 break-words">{err || wire}</span>
          </p>
        )}
      </td>
      {showLive && (
        <td className="px-2 py-2 align-top" aria-label={`Live value, row ${n}`}>
          <LiveCell sample={sample} stale={stale} quarantined={quarantined} />
        </td>
      )}
      <td className={TD}>
        <select className={cellCls} aria-label={`Type, row ${n}`} value={tag.type ?? ''} disabled={readOnly} onChange={(e) => onChange(tag._id, { type: e.target.value })}>
          {typeOptional && <option value="">auto</option>}
          {tag.type && !types.includes(tag.type) && <option value={tag.type}>{tag.type}</option>}
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td className={TD}>
        <select className={cellCls} aria-label={`Poll group, row ${n}`} value={tag.pollGroup ?? ''} disabled={readOnly} onChange={(e) => onChange(tag._id, { pollGroup: e.target.value })}>
          {tag.pollGroup && !groupIds.includes(tag.pollGroup) && <option value={tag.pollGroup}>{tag.pollGroup} (missing)</option>}
          {groupIds.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </td>
      <td className={TD}>{num('scale', 'Scale')}</td>
      <td className={TD}>{num('offset', 'Offset')}</td>
      <td className={TD}>{cell('unit', 'Unit')}</td>
      <td className={TD}>{cell('property', 'UNS property name', { placeholder: 'e.g. temperature' })}</td>
      {extraCols.map((c) => (
        <td key={c} className={TD}>
          {extra[c]()}
        </td>
      ))}
      <td className="px-1 py-1.5 align-top">
        <IconButton icon={Trash2} side="left" size={14} className="h-7 w-7 hover:bg-bad/10 hover:text-bad" label={`Delete row ${n}`} disabled={readOnly} onClick={() => onDelete(tag._id)} />
      </td>
    </tr>
  );
}

export default memo(TagRowImpl);

/** A tag that comes from the device's profile: read-only, with its origin marked. */
export const ProfileTagRow = memo(function ProfileTagRow({ tag, sample, stale, quarantined, quarantineReason, error, showLive, extraCols = [] }) {
  const mutedCell = 'px-1.5 py-2 align-top text-xs text-muted';
  return (
    <tr className={clsx('border-t border-line align-top', error && 'bg-bad/[0.05]')} data-tag-key={tag.key} data-origin="profile">
      <td className="py-2 pl-2 pr-1.5 align-top">
        <FromProfileBadge />
      </td>
      <td className={clsx(mutedCell, 'mono text-fg')}>{tag.key}</td>
      <td className={clsx(mutedCell, 'mono')}>
        {tag.address}
        {error && (
          <p role="alert" className="mt-1 flex items-start gap-1 font-sans text-xs text-bad">
            <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
        {quarantined && (
          <p className="mt-1 flex items-start gap-1 font-sans text-xs text-warn">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Quarantined{quarantineReason ? `: ${quarantineReasonText(quarantineReason)}` : ''}</span>
          </p>
        )}
      </td>
      {showLive && (
        <td className="px-2 py-2 align-top">
          <LiveCell sample={sample} stale={stale} quarantined={quarantined} />
        </td>
      )}
      <td className={mutedCell}>{tag.type || 'auto'}</td>
      <td className={mutedCell}>{tag.pollGroup || '—'}</td>
      <td className={mutedCell}>{tag.scale ?? ''}</td>
      <td className={mutedCell}>{tag.offset ?? ''}</td>
      <td className={mutedCell}>{tag.unit || ''}</td>
      <td className={mutedCell}>{tag.property || '—'}</td>
      {extraCols.map((c) => (
        <td key={c} className={mutedCell}>
          {c === 'byteOrder' || c === 'wordOrder' ? tag[c] || 'device default' : c === 'rate' ? (tag.rate ? 'yes' : '') : tag[c] ?? ''}
        </td>
      ))}
      <td />
    </tr>
  );
});
