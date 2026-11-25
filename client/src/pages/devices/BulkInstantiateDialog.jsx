import { useId, useMemo, useRef, useState } from 'react';
import { Upload, FileText } from 'lucide-react';
import { Dialog, Button, Textarea, Banner, Code, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import RowStatus, { runSummary } from './RowStatus';
import { bulkCreateDevices } from './devicesApi';
import { parseBulkDevices, rowToInstance, bulkTemplate } from '@/lib/bulkDevices';

/**
 * Bulk create devices from a pasted table or CSV. All-or-nothing: the table is checked here, then
 * sent as ONE request (POST /api/devices/bulk) that the server validates completely before it stores
 * anything. A rejected row is shown with the server's message and nothing is created.
 */
export default function BulkInstantiateDialog({ profile, descriptor, onClose, onDone }) {
  const textId = useId();
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState({}); // line -> { status, message }
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirm, confirmDialog] = useConfirm();
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
      setFailure(rejected.size ? `${rejected.size} row${rejected.size === 1 ? ' was' : 's were'} rejected by the server. Fix them and create again.` : err.message);
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
  const created = rows.length > 0 && rows.every((r) => state(r).status === 'created');
  // A pasted table is work: Esc or a click outside must not throw it away unasked.
  const requestClose = async () => {
    if (running) return;
    if (!text.trim() || created) return onClose();
    const ok = await confirm({ title: 'Discard the table you pasted?', message: 'Nothing has been created.', confirmLabel: 'Discard table', cancelLabel: 'Keep editing', danger: true });
    if (ok) onClose();
  };
  const summary = runSummary(rows.map((r) => state(r).status));

  return (
    <>
      <Dialog
        title={`Create several devices from "${profile.name}"`}
        description="Paste a table or load a CSV. Devices are created all together or not at all."
        size="xl"
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose} disabled={running}>
              {created ? 'Close' : 'Cancel'}
            </Button>
            <span title={invalid.length ? 'Fix the rows marked "Problem" first: nothing is created unless every row is valid' : undefined}>
              <Button onClick={run} loading={running} disabled={created || invalid.length > 0 || todo.length === 0}>
                Create {todo.length} device{todo.length === 1 ? '' : 's'}
              </Button>
            </span>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The first row is the header: <Code>name</Code>, <Code>host</Code>, optional <Code>port</Code>
            {profile.params?.length ? (
              <>
                , then one column per parameter (
                {profile.params.map((p) => (
                  <Code key={p.name} className="mr-1">
                    {p.name}
                  </Code>
                ))}
                )
              </>
            ) : null}
            . Device fields such as unitId, rack or slot are also accepted as columns.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => changeText(bulkTemplate(profile))}>
              <FileText size={14} aria-hidden="true" /> Insert example
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              <Upload size={14} aria-hidden="true" /> Load CSV file
            </Button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" tabIndex={-1} aria-label="CSV file" onChange={loadFile} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={textId} className="block text-xs font-medium text-muted">
              Devices (CSV or pasted table)
            </label>
            <Textarea id={textId} data-autofocus rows={6} className="mono text-xs" value={text} onChange={(e) => changeText(e.target.value)} placeholder={'name,host,port\nPump 1,192.168.1.21,502'} disabled={running} />
          </div>
          {parsed?.problems.length > 0 && (
            <Banner variant="warn">
              <ul className="list-disc space-y-0.5 pl-4">
                {parsed.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Banner>
          )}
          {rows.length > 0 && (
            <Table caption="Devices to create and the result of each" className="min-w-[40rem]">
              <THead>
                <Th align="right">Line</Th>
                <Th>Name</Th>
                <Th>Host:port</Th>
                <Th>Parameters</Th>
                <Th>Result</Th>
              </THead>
              <tbody>
                {rows.map((r) => {
                  const s = state(r);
                  return (
                    <Tr key={r.line} className="align-top" data-line={r.line}>
                      <Td align="right" className="tabular-nums text-subtle">{r.line}</Td>
                      <Td header className="font-medium text-fg">{r.name || '—'}</Td>
                      <Td className="mono text-xs">{r.host || '—'}{r.port ? `:${r.port}` : ''}</Td>
                      <Td className="mono text-xs text-muted">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}</Td>
                      <Td>
                        <RowStatus status={s.status} message={s.message} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {invalid.length > 0 && !finished && (
            <Banner variant="warn">
              {invalid.length} row{invalid.length === 1 ? ' has' : 's have'} problems (see Result). Devices are created all together or not at all, so fix or remove {invalid.length === 1 ? 'it' : 'those rows'} first.
            </Banner>
          )}
          {finished && (created ? <Banner variant="success" title={`Created ${summary.created} device${summary.created === 1 ? '' : 's'}`} /> : <Banner variant="warn" title="Nothing was created">{failure}</Banner>)}
        </div>
      </Dialog>
      {confirmDialog}
    </>
  );
}
