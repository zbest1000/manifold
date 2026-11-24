import { useState } from 'react';
import { FileDown, FileUp } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { Button, Banner, buttonClass, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { importSummary } from './helpers';
import Section from './Section';

/**
 * Configuration as code: the DataOps configuration (routes, models, historians, recordings, contracts,
 * tag bindings, UNS mounts, alert rules) as one reviewable JSON file. Credentials are stripped on
 * export and the stored ones are kept on re-import.
 */
export default function Configuration() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const readOnly = useReadOnly();

  const doExport = async () => {
    try {
      const cfg = await api.exportConfig();
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'manifold-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(`Export failed: ${e.message}`);
    }
  };

  const doImport = async (file) => {
    // Import merges into the live config by id (overwriting existing entries): confirm first.
    let cfg;
    try {
      cfg = JSON.parse(await file.text());
    } catch (e) {
      setResult({ error: `Not valid JSON: ${e.message}` });
      return;
    }
    const ok = await confirm({
      title: 'Import this configuration?',
      message: `${importSummary(cfg) || 'No recognizable items found'}.\n\nEntries with a matching id are overwritten in the running instance. Stored credentials are kept where the file has none. This cannot be undone.`,
      confirmLabel: 'Import and overwrite',
      danger: true
    });
    if (!ok) return;
    setImporting(true);
    setResult(null);
    try {
      const res = await api.importConfig(cfg);
      setResult(res.imported);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <Section title="Export" description="One JSON file you can review in git and promote between environments.">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Included: routes, models, historians, recordings, contracts, tag bindings, UNS mounts and alert rules.</li>
          <li>Redacted: tokens, passwords, API keys, passwords inside URLs and alert webhook URLs. Nothing secret leaves the server.</li>
        </ul>
        <Button variant="secondary" onClick={doExport}>
          <FileDown size={14} aria-hidden="true" /> Export config
        </Button>
      </Section>

      <Section title="Danger zone" tone="danger" description="Importing changes the running instance and cannot be undone.">
        <p className="text-sm text-muted">
          Import merges a config file into this instance by id. Anything with a matching id is overwritten, so routes, historians and alert rules start behaving as the file says as soon as it is imported.
          Credentials the file does not carry (it should not) keep their stored values.
        </p>
        <label
          title={readOnly ? READ_ONLY_REASON : undefined}
          className={clsx(
            buttonClass('secondary'),
            'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[rgb(var(--focus))]',
            readOnly || importing ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
          )}
        >
          <FileUp size={14} aria-hidden="true" /> {importing ? 'Importing…' : 'Import config'}
          <input
            type="file"
            accept=".json"
            className="sr-only"
            disabled={readOnly || importing}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ''; // picking the same file again must fire onChange again
              if (f) doImport(f);
            }}
          />
        </label>
        {result && (
          <Banner variant={result.error ? 'error' : 'success'} onDismiss={() => setResult(null)}>
            {result.error || `Imported: ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(', ')}`}
          </Banner>
        )}
      </Section>
      {confirmDialog}
    </div>
  );
}
