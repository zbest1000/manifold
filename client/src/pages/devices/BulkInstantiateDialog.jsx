import { useId, useMemo, useRef, useState } from 'react';
import { X, Loader2, Upload, FileText } from 'lucide-react';
import { Modal, Button, IconButton, Textarea } from '@/components/ui';
import RowStatus, { runSummary } from './RowStatus';
import { bulkCreateDevices } from './devicesApi';
import { parseBulkDevices, rowToInstance, bulkTemplate } from '@/lib/bulkDevices';

/**
 * Bulk create devices from a pasted table or CSV. All-or-nothing: the table is checked here, then
 * sent as ONE request (POST /api/devices/bulk) that the server validates completely before it stores
 * anything. A rejected row is shown with the server's message and nothing is created.
 */
export default function BulkInstantiateDialog({ profile, descriptor, onClose, onDone }) {
  const titleId = useId();
  const textId = useId();
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState({}); // line -> { status, message }
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failure, setFailure] = useState('');
  const parsed = useMemo(() => (text.trim() ? parseBulkDevices(text, profile, descriptor?.deviceFields) : null), [text, profile, descriptor]);
  const rows = parsed?.rows || [];
  const state = (r) => results[r.line] || { status: r.errors.length ? 'invalid' : 'ready', message: r.errors.join('; ') };
  const invalid = rows.filter((r) => r.errors.length);
  const todo = rows.filter((r) => !r.errors.length && state(r).status !== 'created');
  const changeText = (v) => {
    setText(v);
    setResults({});
    setFinished(false);
    setFailure('');
  };

  const run = async () => {
    if (running || invalid.length || !todo.length) return;
    setRunning(true);
    setFinished(false);
    setResults(Object.fromEntries(todo.map((r) => [r.line, { status: 'running' }])));
    try {
      const saved = await bulkCreateDevices(todo.map(rowToInstance), profile.id);
      setResults(Object.fromEntries(todo.map((r, i) => [r.line, { status: 'created', message: saved.created?.[i] ? `${saved.created[i].name} (${saved.created[i].host}:${saved.created[i].port})` : '' }])));
      setFailure('');
      onDone();
    } catch (err) {
      const rejected = new Map((err.rows || []).map((x) => [x.index, x]));
      setResults(
        Object.fromEntries(
          todo.map((r, i) => {
            const x = rejected.get(i);
            if (!x) return [r.line, { status: 'ready', message: 'valid, but not created because another row was rejected' }];
            const detail = x.details?.length ? ` (${x.details.slice(0, 3).map((d) => `${d.key ? `${d.key}: ` : ''}${d.error}`).join('; ')})` : '';
            return [r.line, { status: 'error', message: `${x.error}${detail}` }];
          })
        )
      );
      setFailure(rejected.size ? `Nothing was created: ${rejected.size} row${rejected.size === 1 ? ' was' : 's were'} rejected by the server. Fix them and create again.` : `Nothing was created: ${err.message}`);
    } finally {
      setRunning(false);
      setFinished(true);
    }
  };

  const loadFile = async (e) => {
    const f = e.target.files?.[0];
    if (f) changeText(await f.text());
    e.target.value = '';
  };
  // A pasted table is work: Esc or a click outside must not throw it away unasked.
  const requestClose = () => {
    if (running) return;
    if (!text.trim() || created || window.confirm('Discard the table you pasted? Nothing has been created.')) onClose();
  };
  const summary = runSummary(rows.map((r) => state(r).status));
  const created = rows.length > 0 && rows.every((r) => state(r).status === 'created');

  return (
    <Modal title={`Create devices from ${profile.name}`} labelledBy={titleId} onClose={requestClose} className="max-w-5xl p-0">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <h3 id={titleId} className="text-base font-semibold text-slate-100">Create several devices from "{profile.name}"</h3>
        <IconButton icon={X} side="left" label="Close" onClick={requestClose} disabled={running} />
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
        <div>
          <label htmlFor={textId} className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Devices (CSV or pasted table)</label>
          <Textarea id={textId} data-autofocus rows={6} className="mono text-xs" value={text} onChange={(e) => changeText(e.target.value)} placeholder={'name,host,port\nPump 1,192.168.1.21,502'} disabled={running} />
        </div>
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
        {invalid.length > 0 && !finished && (
          <p role="status" className="text-xs text-amber-200">
            {invalid.length} row{invalid.length === 1 ? ' has' : 's have'} problems (see Result). Devices are created all together or not at all, so fix or remove {invalid.length === 1 ? 'it' : 'those rows'} first.
          </p>
        )}
        {finished && (
          <p role="status" className={`text-sm font-medium ${created ? 'text-emerald-300' : 'text-amber-300'}`}>
            {created ? `Created ${summary.created} device${summary.created === 1 ? '' : 's'}.` : failure}
          </p>
        )}
      </div>
      <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <Button type="button" variant="ghost" onClick={requestClose} disabled={running}>{created ? 'Close' : 'Cancel'}</Button>
        <Button type="button" onClick={run} disabled={running || created || invalid.length > 0 || todo.length === 0} title={invalid.length ? 'Fix the rows marked "Problem" first: nothing is created unless every row is valid' : undefined}>
          {running && <Loader2 size={14} className="animate-spin" />} Create {todo.length} device{todo.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Modal>
  );
}
