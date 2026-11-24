import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { X, Loader2, RefreshCw } from 'lucide-react';
import { Modal, Button, IconButton, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { bulkCreateDevices } from '@/pages/devices/devicesApi';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import RowStatus, { runSummary } from '@/pages/devices/RowStatus';
import { blankDevice, toPayload } from '@/pages/devices/model';
import { SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

/**
 * Review list for "Add all". Nothing is created until the user confirms; devices
 * that already exist (same host and port) start unticked. Creation is all-or-nothing:
 * one request that the server validates completely before it stores anything.
 */
export default function AddAllDialog({ drafts, onClose, onCreated }) {
  const titleId = useId();
  const [info, setInfo] = useState(null); // { protocols, devices }
  const [loadError, setLoadError] = useState('');
  const [rows, setRows] = useState(() => drafts.map((d, i) => ({ id: i, draft: d, name: d.name })));
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failure, setFailure] = useState('');
  const readOnly = useReadOnly();

  const load = useCallback(
    () =>
      api
        .devices()
        .then((r) => {
          setInfo({ protocols: r.protocols || [], devices: r.devices || [] });
          setLoadError('');
        })
        .catch((e) => setLoadError(e.message || 'Could not load the existing devices')),
    []
  );
  useEffect(() => {
    load();
  }, [load]);

  const existing = useMemo(() => new Set((info?.devices || []).map((d) => `${d.host}:${d.port}`)), [info]);
  const dupOf = (r) => existing.has(`${r.draft.host}:${r.draft.port}`);
  const isOn = (r) => r.on ?? !dupOf(r); // an existing address starts unticked until the user decides
  const chosen = rows.filter((r) => isOn(r) && results[r.id]?.status !== 'created');
  const label = (id) => SCAN_PROTOCOLS.find((p) => p.id === id)?.label || id;

  const run = async () => {
    if (running || chosen.length === 0) return;
    setRunning(true);
    setFinished(false);
    setFailure('');
    const payloads = [];
    const todo = [];
    const missing = {};
    for (const r of chosen) {
      const descriptor = info.protocols.find((p) => p.id === r.draft.protocol);
      if (!descriptor) missing[r.id] = { status: 'error', message: `the server has no ${r.draft.protocol} driver` };
      else {
        todo.push(r);
        payloads.push(toPayload({ ...blankDevice(descriptor), ...r.draft, name: r.name.trim() || r.draft.name }, descriptor));
      }
    }
    if (Object.keys(missing).length) {
      setResults(missing);
      setFailure('Nothing was created: some rows cannot be created. Untick them and try again.');
      setRunning(false);
      setFinished(true);
      return;
    }
    setResults(Object.fromEntries(todo.map((r) => [r.id, { status: 'running' }])));
    try {
      // One all-or-nothing request: the server checks every row before it stores any.
      const saved = await bulkCreateDevices(payloads);
      setResults(Object.fromEntries(todo.map((r, i) => [r.id, { status: 'created', message: saved.created?.[i]?.name || r.name }])));
      setFailure('');
      onCreated();
    } catch (err) {
      const rejected = new Map((err.rows || []).map((x) => [x.index, x]));
      setResults(
        Object.fromEntries(
          todo.map((r, i) => {
            const x = rejected.get(i);
            return [r.id, x ? { status: 'error', message: x.error } : { status: 'ready', message: 'valid, but not created because another row was rejected' }];
          })
        )
      );
      setFailure(rejected.size ? `Nothing was created: ${rejected.size} row${rejected.size === 1 ? ' was' : 's were'} rejected. Rename or untick ${rejected.size === 1 ? 'it' : 'them'} and try again.` : `Nothing was created: ${err.message}`);
    } finally {
      setRunning(false);
      setFinished(true);
    }
  };

  const summary = runSummary(rows.filter((r) => results[r.id]).map((r) => results[r.id].status));
  return (
    <Modal title="Add discovered devices" labelledBy={titleId} onClose={running ? () => {} : onClose} className="max-w-4xl p-0">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <h3 id={titleId} className="text-base font-semibold text-slate-100">Add {drafts.length} discovered device{drafts.length === 1 ? '' : 's'}</h3>
        <IconButton icon={X} side="left" label="Close" onClick={onClose} disabled={running} />
      </div>
      <div className="space-y-3 px-5 py-4 sm:px-6">
        <p className="text-xs text-slate-400">Review the list. Nothing is created until you press the button. Each device is added without tags: open it afterwards to test the connection and add tags. Untick the ones you do not want and rename them if you like.</p>
        {loadError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <span>Could not load the existing devices: {loadError}</span>
            <Button size="sm" variant="outline" onClick={load}><RefreshCw size={12} /> Retry</Button>
          </div>
        )}
        <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label="Devices to add (scrolls horizontally)">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">Discovered devices to add</caption>
            <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
              <tr>
                <th scope="col" className="w-10 px-3 py-2 font-medium"><span className="sr-only">Add</span></th>
                <th scope="col" className="min-w-[12rem] px-3 py-2 font-medium">Name</th>
                <th scope="col" className="px-3 py-2 font-medium">Protocol</th>
                <th scope="col" className="px-3 py-2 font-medium">Host:port</th>
                <th scope="col" className="min-w-[10rem] px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-3 py-2">
                    <input type="checkbox" className="h-4 w-4 accent-sky-500" aria-label={`Add ${r.draft.host}:${r.draft.port}`} checked={isOn(r)} disabled={running || results[r.id]?.status === 'created'} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, on: e.target.checked } : x)))} />
                  </td>
                  <td className="px-2 py-1.5"><Input aria-label={`Name for ${r.draft.host}:${r.draft.port}`} value={r.name} disabled={running} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} /></td>
                  <td className="px-3 py-2 text-slate-300">{label(r.draft.protocol)}</td>
                  <td className="mono px-3 py-2 text-slate-200">{r.draft.host}:{r.draft.port}</td>
                  <td className="px-3 py-2">
                    {results[r.id] ? <RowStatus status={results[r.id].status} message={results[r.id].message} /> : dupOf(r) ? <span className="text-amber-300">Already a device at this address</span> : <span className="text-slate-500">{isOn(r) ? 'Will be created' : 'Skipped'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {finished && <p role="status" className={`text-sm font-medium ${failure ? 'text-amber-300' : 'text-emerald-300'}`}>{failure || `Created ${summary.created} device${summary.created === 1 ? '' : 's'}.`}</p>}
      </div>
      <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <Button type="button" variant="ghost" data-autofocus onClick={onClose} disabled={running}>{finished ? 'Close' : 'Cancel'}</Button>
        <Button type="button" onClick={run} disabled={running || !info || chosen.length === 0 || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
          {running && <Loader2 size={14} className="animate-spin" />} Create {chosen.length} device{chosen.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Modal>
  );
}
