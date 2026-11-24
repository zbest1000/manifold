import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, Button, Input, Checkbox, Banner, Table, THead, Th, Tr, Td } from '@/components/ui';
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
      setFailure('Some rows cannot be created. Untick them and try again.');
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
      setFailure(rejected.size ? `${rejected.size} row${rejected.size === 1 ? ' was' : 's were'} rejected. Rename or untick ${rejected.size === 1 ? 'it' : 'them'} and try again.` : err.message);
    } finally {
      setRunning(false);
      setFinished(true);
    }
  };

  const summary = runSummary(rows.filter((r) => results[r.id]).map((r) => results[r.id].status));
  const patch = (id, p) => setRows((rs) => rs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  return (
    <Dialog
      title={`Add ${drafts.length} discovered device${drafts.length === 1 ? '' : 's'}`}
      description="Review the list. Nothing is created until you press the button. Each device is added without tags: open it afterwards to test the connection and add tags."
      size="xl"
      onClose={running ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={onClose} disabled={running}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
          <span title={readOnly ? READ_ONLY_REASON : undefined}>
            <Button onClick={run} loading={running} disabled={!info || chosen.length === 0 || readOnly}>
              Create {chosen.length} device{chosen.length === 1 ? '' : 's'}
            </Button>
          </span>
        </>
      }
    >
      <div className="space-y-3">
        {loadError && (
          <Banner variant="error" title="Could not load the existing devices" onRetry={load}>
            {loadError}
          </Banner>
        )}
        <Table caption="Discovered devices to add" className="min-w-[40rem]">
          <THead>
            <Th srOnly>Add</Th>
            <Th>Name</Th>
            <Th>Protocol</Th>
            <Th>Host:port</Th>
            <Th>Result</Th>
          </THead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id} className="align-top">
                <Td className="w-10">
                  <Checkbox
                    label={<span className="sr-only">{`Add ${r.draft.host}:${r.draft.port}`}</span>}
                    checked={isOn(r)}
                    disabled={running || results[r.id]?.status === 'created'}
                    onChange={(on) => patch(r.id, { on })}
                  />
                </Td>
                <Td className="py-1.5">
                  <Input aria-label={`Name for ${r.draft.host}:${r.draft.port}`} value={r.name} disabled={running} onChange={(e) => patch(r.id, { name: e.target.value })} />
                </Td>
                <Td className="whitespace-nowrap text-muted">{label(r.draft.protocol)}</Td>
                <Td className="mono whitespace-nowrap text-xs text-fg">
                  {r.draft.host}:{r.draft.port}
                </Td>
                <Td>
                  {results[r.id] ? (
                    <RowStatus status={results[r.id].status} message={results[r.id].message} />
                  ) : dupOf(r) ? (
                    <span className="text-sm text-warn">Already a device at this address</span>
                  ) : (
                    <span className="text-sm text-subtle">{isOn(r) ? 'Will be created' : 'Skipped'}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {finished && (failure ? <Banner variant="warn" title="Nothing was created">{failure}</Banner> : <Banner variant="success" title={`Created ${summary.created} device${summary.created === 1 ? '' : 's'}`} />)}
      </div>
    </Dialog>
  );
}
