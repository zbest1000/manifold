import { useId, useMemo, useRef, useState } from 'react';
import { X, Loader2, Upload, FileText } from 'lucide-react';
import { Modal, Button, IconButton, Textarea } from '@/components/ui';
import RowStatus, { runSummary } from './RowStatus';
import { instantiateProfile } from './devicesApi';
import { parseBulkDevices, rowToInstance, bulkTemplate } from '@/lib/bulkDevices';

/**
 * Bulk create devices from a pasted table or CSV. Requests are sequential; every
 * row ends as created, failed (with the server's message) or not sent (invalid),
 * so a partial failure is always visible. Re-running only retries failed rows.
 */
export default function BulkInstantiateDialog({ profile, descriptor, onClose, onDone }) {
  const titleId = useId();
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState({}); // line -> { status, message }
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const parsed = useMemo(() => (text.trim() ? parseBulkDevices(text, profile, descriptor?.deviceFields) : null), [text, profile, descriptor]);
  const rows = parsed?.rows || [];
  const state = (r) => results[r.line] || { status: r.errors.length ? 'invalid' : 'ready', message: r.errors.join('; ') };
  const todo = rows.filter((r) => !r.errors.length && state(r).status !== 'created');
  const changeText = (v) => {
    setText(v);
    setResults({});
    setFinished(false);
  };

  const run = async () => {
    setRunning(true);
    setFinished(false);
    for (const r of todo) {
      setResults((s) => ({ ...s, [r.line]: { status: 'running' } }));
      try {
        const saved = await instantiateProfile(profile.id, rowToInstance(r));
        setResults((s) => ({ ...s, [r.line]: { status: 'created', message: `${saved.name} (${saved.host}:${saved.port})` } }));
      } catch (err) {
        const detail = err.details?.length ? ` (${err.details.slice(0, 3).map((d) => `${d.key ? `${d.key}: ` : ''}${d.error}`).join('; ')})` : '';
        setResults((s) => ({ ...s, [r.line]: { status: 'error', message: `${err.message}${detail}` } }));
      }
    }
    setRunning(false);
    setFinished(true);
    onDone();
  };

  const loadFile = async (e) => {
    const f = e.target.files?.[0];
    if (f) changeText(await f.text());
    e.target.value = '';
  };
  const summary = runSummary(rows.map((r) => state(r).status));

  return (
    <Modal title={`Create devices from ${profile.name}`} labelledBy={titleId} onClose={running ? () => {} : onClose} className="max-w-5xl p-0">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <h3 id={titleId} className="text-base font-semibold text-slate-100">Create several devices from "{profile.name}"</h3>
        <IconButton icon={X} side="left" label="Close" onClick={onClose} disabled={running} />
      </div>
      <div className="space-y-4 px-5 py-4 sm:px-6">
        <p className="text-xs text-slate-400">
          Paste a table copied from a spreadsheet, or a CSV. The first row is the header: <span className="mono">name</span>, <span className="mono">host</span>, optional <span className="mono">port</span>
          {profile.params?.length ? <>, then one column per parameter ({profile.params.map((p) => <span key={p.name} className="mono mr-1">{p.name}</span>)})</> : null}. Device fields such as unitId, rack or slot are also accepted as columns.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => changeText(bulkTemplate(profile))}><FileText size={14} /> Insert example</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Upload size={14} /> Load CSV file</Button>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" tabIndex={-1} aria-label="CSV file" onChange={loadFile} />
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Devices (CSV or pasted table)</span>
          <Textarea data-autofocus rows={6} className="mono text-xs" value={text} onChange={(e) => changeText(e.target.value)} placeholder={'name,host,port\nPump 1,192.168.1.21,502'} disabled={running} />
        </label>
        {parsed?.problems.length > 0 && <ul role="alert" className="list-disc space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 py-2 pl-7 pr-3 text-xs text-amber-100">{parsed.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        {rows.length > 0 && (
          <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label="Devices to create (scrolls horizontally)">
            <table className="w-full border-collapse text-left text-xs">
              <caption className="sr-only">Devices to create and the result of each</caption>
              <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Line</th>
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Host:port</th>
                  <th scope="col" className="px-3 py-2 font-medium">Parameters</th>
                  <th scope="col" className="px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rows.map((r) => {
                  const s = state(r);
                  return (
                    <tr key={r.line} className="align-top" data-line={r.line}>
                      <td className="px-3 py-1.5 text-slate-500">{r.line}</td>
                      <th scope="row" className="px-3 py-1.5 font-medium text-slate-100">{r.name || '—'}</th>
                      <td className="mono px-3 py-1.5 text-slate-300">{r.host || '—'}{r.port ? `:${r.port}` : ''}</td>
                      <td className="mono px-3 py-1.5 text-slate-400">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}</td>
                      <td className="px-3 py-1.5"><RowStatus status={s.status} message={s.message} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {finished && (
          <p role="status" className={`text-sm font-medium ${summary.failed ? 'text-amber-300' : 'text-emerald-300'}`}>Done: {summary.text}{summary.failed ? ' Fix the failed rows and run again; created devices are not repeated.' : ''}</p>
        )}
      </div>
      <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <Button type="button" variant="ghost" onClick={onClose} disabled={running}>{finished ? 'Close' : 'Cancel'}</Button>
        <Button type="button" onClick={run} disabled={running || todo.length === 0}>
          {running && <Loader2 size={14} className="animate-spin" />} {finished && summary.failed ? `Retry ${todo.length} failed` : `Create ${todo.length} device${todo.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Modal>
  );
}
