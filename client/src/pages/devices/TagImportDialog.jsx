import { useId, useState } from 'react';
import { Dialog, Button, Textarea, Checkbox, Banner, Code } from '@/components/ui';
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
    <Dialog
      title="Import tags"
      description="Paste rows copied from a spreadsheet, or a CSV, or load a file."
      size="lg"
      onClose={onClose}
      onSubmit={apply}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!text.trim()}>
            {replace ? 'Replace tags' : 'Add tags'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          With a header row, columns are matched by name; without one they are read in table order:{' '}
          {TAG_COLUMNS.map((c) => (
            <Code key={c} className="mr-1">
              {c}
            </Code>
          ))}
        </p>
        <label htmlFor={taId} className="sr-only">
          Tag rows
        </label>
        <Textarea
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
          className="mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="inline-flex items-center gap-2 text-sm text-muted">
            Or load a file
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              onChange={(e) => loadFile(e.target.files?.[0])}
              className="max-w-[14rem] text-xs file:mr-2 file:rounded-md file:border file:border-line-strong file:bg-panel file:px-2 file:py-1 file:text-xs file:text-fg"
            />
          </label>
          <Checkbox className="ml-auto" checked={replace} onChange={setReplace} label={`Replace the ${existingCount} existing tag${existingCount === 1 ? '' : 's'}`} />
        </div>
        {error && (
          <Banner variant="error">{error}</Banner>
        )}
      </div>
    </Dialog>
  );
}
