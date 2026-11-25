import { useMemo, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Dialog, Button, Textarea, Field, Banner } from '@/components/ui';
import { downloadText } from '@/lib/download';
import { applyCsv, csvTemplate, csvColumns } from './csvRows';

/**
 * Import mapping rows from CSV, for any source: paste or open a file, see what would change and
 * every line that cannot be applied (with why), then apply the good lines. A template with the
 * columns this source takes can be downloaded.
 */
export default function CsvImport({ state, tagDefs, onClose, onApply }) {
  const [text, setText] = useState('');
  const result = useMemo(() => (text.trim() ? applyCsv(state, text, { tagDefs }) : null), [state, text, tagDefs]);
  const lineErrors = result ? result.errors.filter((e) => e.line > 0) : [];
  const changes = result ? result.added + result.updated : 0;
  const noun = state.srcType === 'mqtt' ? 'topic' : state.srcType === 'sparkplug' ? 'metric' : 'tag';

  const openFile = async (file) => {
    if (file) setText(await file.text());
  };
  const apply = () => {
    if (!result || !changes) return;
    onApply(result.rows, `Imported ${result.added} new and updated ${result.updated} ${noun}${changes === 1 ? '' : 's'} from CSV${lineErrors.length ? `; ${lineErrors.length} line${lineErrors.length === 1 ? '' : 's'} skipped` : ''}.`);
  };

  return (
    <Dialog
      title="Import mapping rows from CSV"
      description={`One line per ${noun}, matched by address. Columns: ${csvColumns(state.srcType).join(', ')}. Empty cells change nothing.`}
      onClose={onClose}
      onSubmit={apply}
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => downloadText(`mapping-${state.srcType}-template.csv`, csvTemplate(state.srcType), 'text/csv')}>
            <Download size={14} aria-hidden="true" /> Download template
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!changes}>
            Apply {changes || ''} line{changes === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-accent-text">
          <Upload size={14} aria-hidden="true" />
          <span className="underline-offset-2 hover:underline">Open a CSV file</span>
          <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => openFile(e.target.files?.[0])} />
        </label>
        <Field label="CSV" help={state.selectMode === 'rules' ? 'This mapping selects tags by rule: lines update the listed tags only.' : `Lines for ${noun}s not in the mapping add them.`}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} className="mono text-xs" placeholder={csvTemplate(state.srcType)} />
        </Field>
        {result && (
          <p className="text-sm text-fg" aria-live="polite">
            {result.added} to add, {result.updated} to update{lineErrors.length ? `, ${lineErrors.length} with problems` : ''}.
          </p>
        )}
        {result?.errors.length > 0 && (
          <Banner variant={lineErrors.length ? 'warn' : 'info'} title={lineErrors.length ? 'These lines are skipped' : 'Note'}>
            <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
              {result.errors.slice(0, 100).map((e, i) => (
                <li key={`${e.line}-${i}`}>
                  {e.line > 0 && <span className="font-mono text-muted">line {e.line}: </span>}
                  {e.message}
                </li>
              ))}
            </ul>
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
