import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { Modal, Button, IconButton } from '@/components/ui';
import { parseTags, TAG_COLUMNS } from '@/lib/deviceTags';

/**
 * Import tags from CSV / TSV text (pasted, or loaded from a file). Parsing is
 * client-side. Header names are matched in any order; without a header the
 * columns are the table's column order.
 */
export default function TagImportDialog({ onClose, onApply, makeRow, existingCount }) {
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const taId = useId();

  const loadFile = async (file) => {
    if (!file) return;
    try {
      setText(await file.text());
      setError('');
    } catch (e) {
      setError(`Could not read ${file.name}: ${e.message}`);
    }
  };

  const apply = () => {
    const { tags } = parseTags(text);
    if (!tags.length) {
      setError('No tag rows found. Expect a header row (key, address, type, …) or columns in table order.');
      return;
    }
    onApply(tags.map((t) => ({ ...makeRow(), ...t })), replace);
  };

  return (
    <Modal title="Import tags" labelledBy={titleId} onClose={onClose} className="max-w-2xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 id={titleId} className="text-base font-semibold text-slate-100">Import tags (CSV or spreadsheet paste)</h3>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      <p className="mb-2 text-xs text-slate-400">
        Paste rows copied from a spreadsheet (tab separated) or a CSV. With a header row, columns are matched by name; without one they are read in
        table order: <span className="mono text-slate-300">{TAG_COLUMNS.join(', ')}</span>.
      </p>
      <label htmlFor={taId} className="sr-only">Tag rows</label>
      <textarea
        id={taId}
        data-autofocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError('');
        }}
        rows={10}
        spellCheck={false}
        placeholder={'key,address,type,pollGroup,scale\nSupplyTemp,holding:100,int16,fast,0.1\nRunning,coil:5,bool,fast,'}
        className="mono w-full rounded-lg border border-white/10 bg-surface-950/60 p-2 text-xs text-slate-200 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <label className="inline-flex items-center gap-2">
          <span className="text-slate-400">Or load a file</span>
          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => loadFile(e.target.files?.[0])} className="max-w-[14rem] text-xs file:mr-2 file:rounded-lg file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-slate-200" />
        </label>
        <label className="ml-auto inline-flex items-center gap-2">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="accent-sky-500" />
          Replace the {existingCount} existing tag{existingCount === 1 ? '' : 's'}
        </label>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={apply} disabled={!text.trim()}>{replace ? 'Replace tags' : 'Add tags'}</Button>
      </div>
    </Modal>
  );
}
