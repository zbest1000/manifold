import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { X, Loader2, RefreshCw } from 'lucide-react';
import { Modal, Button, IconButton, Input } from '@/components/ui';
import { api } from '@/lib/api';
import RowStatus, { runSummary } from '@/pages/devices/RowStatus';
import { blankDevice, toPayload } from '@/pages/devices/model';
import { SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

/**
 * Review list for "Add all". Nothing is created until the user confirms; devices
 * that already exist (same host and port) start unticked. Creation is sequential
 * and every row ends as created or failed with the server's message.
 */
export default function AddAllDialog({ drafts, onClose, onCreated }) {
  const titleId = useId();
  const [info, setInfo] = useState(null); // { protocols, devices }
  const [loadError, setLoadError] = useState('');
  const [rows, setRows] = useState(() => drafts.map((d, i) => ({ id: i, draft: d, name: d.name })));
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const r = await api.devices();
      setInfo({ protocols: r.protocols || [], devices: r.devices || [] });
    } catch (e) {
      setLoadError(e.message || 'Could not load the existing devices');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const existing = useMemo(() => new Set((info?.devices || []).map((d) => `${d.host}:${d.port}`)), [info]);
  const dupOf = (r) => existing.has(`${r.draft.host}:${r.draft.port}`);
  const isOn = (r) => r.on ?? !dupOf(r); // an existing address starts unticked until the user decides
  const chosen = rows.filter((r) => isOn(r) && results[r.id]?.status !== 'created');
  const label = (id) => SCAN_PROTOCOLS.find((p) => p.id === id)?.label || id;

  const run = async () => {
    setRunning(true);
    setFinished(false);
    for (const r of chosen) {
      const descriptor = info.protocols.find((p) => p.id === r.draft.protocol);
      if (!descriptor) {
        setResults((s) => ({ ...s, [r.id]: { status: 'error', message: `the server has no ${r.draft.protocol} driver` } }));
        continue;
      }
      setResults((s) => ({ ...s, [r.id]: { status: 'running' } }));
      try {
        const saved = await api.createDevice(toPayload({ ...blankDevice(descriptor), ...r.draft, name: r.name.trim() || r.draft.name }, descriptor));
        setResults((s) => ({ ...s, [r.id]: { status: 'created', message: saved.name } }));
      } catch (err) {
        setResults((s) => ({ ...s, [r.id]: { status: 'error', message: err.message } }));
      }
    }
    setRunning(false);
    setFinished(true);
    onCreated();
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
        {finished && <p role="status" className={`text-sm font-medium ${summary.failed ? 'text-amber-300' : 'text-emerald-300'}`}>Done: {summary.text}</p>}
      </div>
      <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
        <Button type="button" variant="ghost" data-autofocus onClick={onClose} disabled={running}>{finished ? 'Close' : 'Cancel'}</Button>
        <Button type="button" onClick={run} disabled={running || !info || chosen.length === 0}>
          {running && <Loader2 size={14} className="animate-spin" />} Create {chosen.length} device{chosen.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Modal>
  );
}
