import { useRef, useState } from 'react';
import { SlidersHorizontal, AlertTriangle, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { IconButton, Tooltip } from '@/components/ui';
import { MiniSwitch } from './parts';
import { renameRow, setOv, overrideCount, rawName, RULE_LABEL, parseGrid, applyPaste } from '../mappingModel';

export const ROW_H = 36;
const VIEW_H = 640; // rendered window (px) beyond the scroll position; generous so fast scrolling never shows blanks
const OVERSCAN = 6;

/** How the published name was chosen, for the "Name from" column. */
export function nameBasis(row) {
  if (row.explicit && !row.fromSuggestion && !row.alwaysName) return { label: 'mapping', tone: 'accent', hint: 'Set in this mapping.' };
  if (row.fromSuggestion) return { label: 'cleaned key', tone: 'muted', hint: `Suggested from the tag key ${row.address} (prefix stripped, camelCase).` };
  if (rawName(row.name) || (row.suggestion?.rawAddress && !row.explicit)) return { label: 'raw address', tone: 'warn', hint: 'Looks like a raw device address. Give the tag a meaningful name so the namespace does not depend on PLC addressing.' };
  if (row.def.property && !row.explicit) return { label: 'property', tone: 'muted', hint: 'The tag property set on the device.' };
  if (row.alwaysName) return row.address.includes('/') && !row.address.startsWith('ns=') ? { label: 'topic', tone: 'muted', hint: 'From the topic levels.' } : { label: 'browse name', tone: 'muted', hint: 'The OPC UA browse name.' };
  return { label: 'tag key', tone: 'muted', hint: 'The device has no property for this tag, so its key is used.' };
}

const COLS = ['name', 'unit', 'description'];

/**
 * The per-tag table: one row per tag, inline name / unit / description, a publish switch, bulk
 * selection, and the active row (its details open under the table). Rows are windowed: only the
 * visible slice is in the DOM, so 500 tags stay as fast as 20.
 *
 * Keyboard: arrows up/down move between rows in the same column, Enter moves down, paste a
 * block from a spreadsheet into name / unit / description to fill several rows at once.
 */
export default function TagTable({ rows, verdicts, selected, onSelect, activeKey, onActivate, onRows, problems, flags, readOnly, caption, onPasted }) {
  const scroller = useRef(null);
  const anchor = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const n = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(n, Math.ceil((scrollTop + VIEW_H) / ROW_H) + OVERSCAN);
  const slice = rows.slice(start, end);
  const keys = rows.map((r) => r.key);
  const allSelected = n > 0 && rows.every((r) => selected.has(r.key));
  const someSelected = !allSelected && rows.some((r) => selected.has(r.key));

  const update = (key, fn) => onRows((rs) => rs.map((r) => (r.key === key ? fn(r) : r)));

  const focusCell = (index, col) => {
    const el = scroller.current;
    if (!el || index < 0 || index >= n) return;
    const top = index * ROW_H;
    const header = 33;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - header) el.scrollTop = top + ROW_H - el.clientHeight + header;
    setScrollTop(el.scrollTop);
    onActivate(rows[index].key, { scroll: false });
    requestAnimationFrame(() => el.querySelector(`[data-cell="${index}:${col}"]`)?.focus());
  };

  const onKey = (e, index, col) => {
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      focusCell(index + 1, col);
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
      e.preventDefault();
      focusCell(index - 1, col);
    }
  };

  const onPaste = (e, key, col) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/[\t\n]/.test(text.replace(/\n$/, ''))) return; // a single value pastes normally
    e.preventDefault();
    const grid = parseGrid(text);
    let pasted = 0;
    onRows((rs) => {
      const out = applyPaste(rs, keys, key, col, grid);
      pasted = out.count;
      return out.rows;
    });
    onPasted?.(grid.length, pasted);
  };

  const toggleSelect = (index, shift) => {
    const key = rows[index].key;
    const next = new Set(selected);
    if (shift && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      const on = !selected.has(key);
      for (let i = a; i <= b; i++) {
        if (on) next.add(rows[i].key);
        else next.delete(rows[i].key);
      }
    } else if (next.has(key)) next.delete(key);
    else next.add(key);
    anchor.current = index;
    onSelect(next);
  };

  const cols = flags.renameable ? 8 : 4;
  return (
    <div
      ref={scroller}
      role="region"
      aria-label={caption}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative overflow-auto rounded-lg border border-line bg-panel"
      style={{ maxHeight: 'min(60vh, 560px)' }}
    >
      <table className={clsx('w-full border-collapse text-left text-sm', flags.renameable ? 'min-w-[52rem]' : 'min-w-[28rem]')} aria-rowcount={n + 1}>
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-panel shadow-[inset_0_-1px_0_rgb(var(--border))]">
          <tr aria-rowindex={1} className="h-8">
            <th scope="col" className="w-9 px-3">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent align-middle"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={() => onSelect(allSelected ? new Set([...selected].filter((k) => !keys.includes(k))) : new Set([...selected, ...keys]))}
                aria-label={allSelected ? 'Clear the selection' : `Select all ${n} shown tags`}
                disabled={readOnly || n === 0}
              />
            </th>
            <th scope="col" className="w-14 px-2 text-xs font-medium text-muted">
              Publish
            </th>
            <th scope="col" className="w-[13rem] px-2 text-xs font-medium text-muted">
              Source tag
            </th>
            <th scope="col" className={clsx('px-2 text-xs font-medium text-muted', flags.renameable ? 'w-[14rem]' : '')}>
              Published name
            </th>
            {flags.renameable && (
              <>
                <th scope="col" className="w-24 px-2 text-xs font-medium text-muted">
                  Name from
                </th>
                <th scope="col" className="w-24 px-2 text-xs font-medium text-muted">
                  Unit
                </th>
                <th scope="col" className="px-2 text-xs font-medium text-muted">
                  Description
                </th>
                <th scope="col" className="w-[4.5rem] px-2 text-right text-xs font-medium text-muted">
                  <span className="sr-only">Status and details</span>
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr aria-hidden="true" style={{ height: start * ROW_H }}>
              <td colSpan={cols} />
            </tr>
          )}
          {slice.map((row, i) => {
            const index = start + i;
            const verdict = verdicts.get(row.key) || { matched: true };
            const excluded = !verdict.matched;
            const active = row.key === activeKey;
            const probs = problems.get(row.key) || [];
            const nameErr = probs.find((p) => p.field === 'name');
            const basis = nameBasis(row);
            const count = overrideCount(row);
            const unitDev = row.def.unit || '';
            const descDev = row.def.description || '';
            const label = row.name || row.address;
            return (
              <tr
                key={row.key}
                aria-rowindex={index + 2}
                data-row={row.key}
                style={{ height: ROW_H }}
                onClick={(e) => {
                  if (e.target.closest('input,button,select,label')) return;
                  onActivate(row.key, { scroll: false });
                }}
                className={clsx(
                  'border-t border-line transition-colors duration-100 first:border-t-0 hover:bg-[rgb(var(--tint)/0.035)]',
                  active && 'bg-accent/[0.07] shadow-[inset_2px_0_0_rgb(var(--accent))] hover:bg-accent/[0.09]',
                  (excluded || !row.enabled) && 'text-muted'
                )}
              >
                <td className="px-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent align-middle"
                    checked={selected.has(row.key)}
                    onChange={() => {}}
                    onClick={(e) => toggleSelect(index, e.shiftKey)}
                    aria-label={`Select ${label}`}
                    disabled={readOnly}
                  />
                </td>
                <td className="px-2">
                  <MiniSwitch
                    checked={row.enabled && !excluded}
                    disabled={readOnly || excluded}
                    title={excluded ? `Excluded by the rules: ${RULE_LABEL[verdict.rule] || verdict.rule}${verdict.pattern ? ` ${verdict.pattern}` : ''}` : undefined}
                    label={`Publish ${row.address}`}
                    onChange={(on) => update(row.key, (r) => ({ ...r, enabled: on }))}
                  />
                </td>
                <td className="max-w-[13rem] px-2">
                  <span className="flex min-w-0 items-baseline gap-2">
                    {/* Shortened from the start so the distinguishing end of a long path stays visible. */}
                    <span dir="rtl" className="min-w-0 truncate text-left font-mono text-xs text-fg" title={row.def.address ? `${row.address} (${row.def.address})` : row.address}>
                      <bdi>{row.address}</bdi>
                    </span>
                    {row.def.type && <span className="shrink-0 font-mono text-2xs text-subtle">{row.def.type}</span>}
                  </span>
                </td>
                <td className="px-2">
                  {flags.renameable ? (
                    <input
                      data-cell={`${index}:name`}
                      value={row.name}
                      disabled={readOnly}
                      onChange={(e) => update(row.key, (r) => renameRow(r, e.target.value))}
                      onKeyDown={(e) => onKey(e, index, 'name')}
                      onPaste={(e) => onPaste(e, row.key, 'name')}
                      onFocus={() => onActivate(row.key, { scroll: false })}
                      aria-label={`Published name for ${row.address}`}
                      aria-invalid={Boolean(nameErr) || undefined}
                      className={clsx(cellInput, 'font-mono text-xs', nameErr && 'border-bad')}
                    />
                  ) : (
                    <span className="font-mono text-xs">{row.name}</span>
                  )}
                </td>
                {flags.renameable && (
                  <>
                    <td className="px-2">
                      <Tooltip label={basis.hint} side="top">
                        <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap text-xs', basis.tone === 'warn' ? 'text-warn' : basis.tone === 'accent' ? 'text-accent-text' : 'text-subtle')}>
                          {basis.tone === 'warn' && <AlertTriangle size={12} aria-hidden="true" />}
                          {basis.label}
                        </span>
                      </Tooltip>
                    </td>
                    <td className="px-2">
                      <input
                        data-cell={`${index}:unit`}
                        value={row.ov.unit ?? ''}
                        placeholder={unitDev}
                        disabled={readOnly || !flags.overrides}
                        onChange={(e) => update(row.key, (r) => setOv(r, 'unit', e.target.value))}
                        onKeyDown={(e) => onKey(e, index, 'unit')}
                        onPaste={(e) => onPaste(e, row.key, 'unit')}
                        onFocus={() => onActivate(row.key, { scroll: false })}
                        aria-label={`Unit for ${label}${unitDev ? ` (device: ${unitDev})` : ''}`}
                        className={clsx(cellInput, 'text-xs')}
                      />
                    </td>
                    <td className="px-2">
                      <input
                        data-cell={`${index}:description`}
                        value={row.ov.description ?? ''}
                        placeholder={descDev}
                        disabled={readOnly || !flags.overrides}
                        onChange={(e) => update(row.key, (r) => setOv(r, 'description', e.target.value))}
                        onKeyDown={(e) => onKey(e, index, 'description')}
                        onPaste={(e) => onPaste(e, row.key, 'description')}
                        onFocus={() => onActivate(row.key, { scroll: false })}
                        aria-label={`Description for ${label}${descDev ? ` (device: ${descDev})` : ''}`}
                        className={clsx(cellInput, 'text-xs')}
                      />
                    </td>
                    <td className="px-1 text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        {probs.length > 0 ? (
                          <Tooltip label={probs[0].message} side="left">
                            <span role="img" className="inline-flex items-center text-bad" aria-label={`${probs.length} problem${probs.length === 1 ? '' : 's'}: ${probs[0].message}`}>
                              <XCircle size={14} aria-hidden="true" />
                            </span>
                          </Tooltip>
                        ) : count > 0 ? (
                          <Tooltip label={`${count} setting${count === 1 ? '' : 's'} set by this mapping`} side="left">
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-raised px-1 font-mono text-2xs text-muted">
                              {count}
                              <span className="sr-only"> settings set by this mapping</span>
                            </span>
                          </Tooltip>
                        ) : null}
                        {flags.overrides && (
                          <IconButton
                            icon={SlidersHorizontal}
                            size={14}
                            side="left"
                            label={`Details of ${label}`}
                            active={active}
                            className="h-7 w-7"
                            onClick={() => onActivate(row.key, { scroll: true, open: true })}
                          />
                        )}
                      </span>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
          {end < n && (
            <tr aria-hidden="true" style={{ height: (n - end) * ROW_H }}>
              <td colSpan={cols} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const cellInput =
  'h-7 w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 text-fg placeholder:text-faint transition-colors duration-150 ' +
  'hover:border-line-strong focus:border-accent focus:bg-field focus:outline-hidden focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-bad';

export { COLS };
