import { useState } from 'react';
import { FileDown, FileUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { Card, Button, Banner, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { importSummary } from './helpers';

// Config as code: the whole DataOps configuration (routes, models, historians,
// recordings, contracts, bindings, mounts, alert rules) as one reviewable JSON
// file. Secrets are stripped on export and preserved server-side on re-import.
export default function ConfigCard() {
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
    // Import merges into the live config by id (overwriting existing entries) —
    // confirm before mutating a running instance's DataOps setup.
    let cfg;
    try {
      cfg = JSON.parse(await file.text());
    } catch (e) {
      setResult({ error: `Not valid JSON: ${e.message}` });
      return;
    }
    const ok = await confirm({
      title: 'Import this configuration?',
      message: `${importSummary(cfg) || 'No recognizable items found'}.\n\nEntries with matching ids will be OVERWRITTEN in the running instance. This cannot be undone.`,
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
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <FileDown size={16} className="text-accent-400" aria-hidden="true" /> Configuration as code
      </h2>
      <p className="mb-3 text-sm text-muted">
        Export pipelines, models, historians, recordings, contracts, tag bindings, mounts, and alert rules as one JSON file — reviewable in git, promotable
        between environments. Credentials are never exported; stored secrets survive a re-import.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={doExport}>
          <FileDown size={14} aria-hidden="true" /> Export config
        </Button>
        <label
          title={readOnly ? READ_ONLY_REASON : undefined}
          className={`inline-flex items-center gap-2 rounded-xl border border-white/10 px-3.5 py-2 text-sm text-slate-200 focus-within:outline focus-within:outline-2 focus-within:outline-accent-400 ${readOnly || importing ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-white/5'}`}
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
      </div>
      {result && (
        <Banner variant={result.error ? 'error' : 'success'} className="mt-3" onDismiss={() => setResult(null)}>
          {result.error || `Imported: ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(', ')}`}
        </Banner>
      )}
      {confirmDialog}
    </Card>
  );
}
