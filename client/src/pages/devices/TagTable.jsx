import { Fragment, useCallback, useMemo, useState } from 'react';
import { Plus, Upload, Download, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import TagRow from './TagRow';
import TagImportDialog from './TagImportDialog';
import { serializeTags, pasteIntoTags } from '@/lib/deviceTags';
import { downloadText } from '@/lib/download';

let seq = 0;
export const newTagId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

const HEAD = [
  ['', 'Select'],
  ['Key', 'min-w-[9rem]'],
  ['Address', 'min-w-[11rem]'],
  ['Type', 'min-w-[6.5rem]'],
  ['Poll group', 'min-w-[6.5rem]'],
  ['Scale', 'min-w-[4.5rem]'],
  ['Offset', 'min-w-[4.5rem]'],
  ['Unit', 'min-w-[4.5rem]'],
  ['UNS property', 'min-w-[9rem]'],
  ['Description', 'min-w-[10rem]']
];
const ADV_HEAD = [
  ['Length', 'min-w-[4.5rem]'],
  ['Bit', 'min-w-[4rem]'],
  ['Byte order', 'min-w-[7.5rem]'],
  ['Word order', 'min-w-[7.5rem]']
];

/**
 * The tag editor: ONE table, one row per tag. Paste a block copied from a
 * spreadsheet into any cell, import/export CSV, add and delete rows. Validation
 * and live values are passed in so rows stay cheap to render.
 */
export default function TagTable({ tags, setTags, descriptor, pollGroups, validation, localErrors, values, showLive, selectedId, onSelect, deviceName }) {
  const [advanced, setAdvanced] = useState(false);
  const [importing, setImporting] = useState(false);
  const types = descriptor?.tagTypes || [];
  const groupIds = useMemo(() => pollGroups.map((g) => g.id), [pollGroups]);

  const makeRow = useCallback(() => ({ _id: newTagId(), key: '', address: '', type: types[0] || '', pollGroup: groupIds[0] || '' }), [types, groupIds]);
  const addRow = () => setTags((t) => [...t, makeRow()]);
  const onChange = useCallback((id, patch) => setTags((ts) => ts.map((t) => (t._id === id ? { ...t, ...patch } : t))), [setTags]);
  const onDelete = useCallback((id) => setTags((ts) => ts.filter((t) => t._id !== id)), [setTags]);

  const onPaste = useCallback(
    (e, rowIdx, col) => {
      const text = e.clipboardData?.getData('text') || '';
      // Single-cell pastes behave normally; anything multi-cell is treated as a spreadsheet block.
      if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
      e.preventDefault();
      setTags((ts) => {
        const r = pasteIntoTags(ts, text, rowIdx, col, makeRow);
        queueMicrotask(() => toast.success(`Pasted ${r.touched + r.added} row${r.touched + r.added === 1 ? '' : 's'}${r.added ? ` (${r.added} new)` : ''}`));
        return r.tags;
      });
    },
    [setTags, makeRow]
  );

  const exportCsv = () => {
    const safe = (deviceName || 'device').replace(/[^\w.-]+/g, '_');
    downloadText(`${safe}-tags.csv`, serializeTags(tags, ','), 'text/csv');
  };

  const dupHint = validation.error;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={addRow}>
          <Plus size={14} /> Add tag
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setImporting(true)}>
          <Upload size={14} /> Import / paste
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={exportCsv} disabled={!tags.length}>
          <Download size={14} /> Export CSV
        </Button>
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          aria-expanded={advanced}
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Advanced columns
        </button>
      </div>

      {dupHint && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <span>Address validation unavailable: {dupHint}</span>
          <Button type="button" size="sm" variant="outline" onClick={validation.retry}>
            <RefreshCw size={12} /> Retry
          </Button>
        </div>
      )}

      <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label="Tag table (scrolls horizontally)">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Tags polled from this device. Paste a block from a spreadsheet into any cell to fill several rows.</caption>
          <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
            <tr>
              {HEAD.map(([h, w], i) => (
                <Fragment key={h || i}>
                  <th scope="col" className={`px-2 py-2 font-medium ${i ? w : ''}`}>
                    {h || <span className="sr-only">Select</span>}
                  </th>
                  {h === 'Address' && showLive && <th scope="col" className="min-w-[9rem] px-2 py-2 font-medium">Live value / quality</th>}
                </Fragment>
              ))}
              {advanced && ADV_HEAD.map(([h, w]) => <th key={h} scope="col" className={`px-2 py-2 font-medium ${w}`}>{h}</th>)}
              <th scope="col" className="w-10 px-1 py-2"><span className="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {tags.map((t, i) => (
              <TagRow
                key={t._id}
                tag={t}
                index={i}
                types={types}
                groupIds={groupIds}
                validation={validation.results[t.key]}
                localError={localErrors[i]}
                sample={showLive ? values[t.key] : undefined}
                showLive={showLive}
                advanced={advanced}
                selected={selectedId === t._id}
                onSelect={onSelect}
                onChange={onChange}
                onDelete={onDelete}
                onPaste={onPaste}
              />
            ))}
            {!tags.length && (
              <tr>
                <td colSpan={20} className="px-4 py-8 text-center text-xs text-slate-500">
                  No tags yet. Add a row, paste a block copied from a spreadsheet, or import a CSV.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-2xs text-slate-500" aria-live="polite">
        {tags.length} tag{tags.length === 1 ? '' : 's'}
        {validation.pending ? ' · checking addresses…' : ''}
      </p>

      {importing && (
        <TagImportDialog
          onClose={() => setImporting(false)}
          existingCount={tags.length}
          makeRow={makeRow}
          onApply={(newTags, replace) => {
            setTags((ts) => (replace ? newTags : [...ts, ...newTags]));
            setImporting(false);
            toast.success(`${replace ? 'Replaced with' : 'Added'} ${newTags.length} tag${newTags.length === 1 ? '' : 's'}`);
          }}
        />
      )}
    </div>
  );
}
