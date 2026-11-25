import { useState } from 'react';
import { Plus, Play, Square, Eye, Pause, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Input, Field, Select, Checkbox, Badge, Banner, IconButton, Dialog, Drawer, StatusDot, StatusText, Timestamp, Path, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { BrokerSelect, Count, ListState, TabToolbar, useRo } from './shared';
import { brokenSummary, brokerName, formatBytes, recordingBody } from './helpers';

const BLANK = { name: '', brokerId: '', filter: '', targetType: 'file', historianId: '' };

const recState = (rec) => (rec.broken?.length ? { label: 'Broken reference', tone: 'bad' } : rec.status.full ? { label: 'Full', tone: 'warn' } : rec.enabled ? { label: 'Recording', tone: 'good' } : { label: 'Paused', tone: 'neutral' });

/** Recorder: capture a topic filter to a file (replayable) or a historian; pause, resume, peek, replay. */
export default function RecorderTab({ brokers }) {
  const [form, setForm] = useState(null); // null = dialog closed
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState(null);
  const [peek, setPeek] = useState(null); // { rec, points, total, truncated }
  const [replaying, setReplaying] = useState(null); // { rec, speed, topicPrefix, loop }
  const [saving, setSaving] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const ro = useRo();
  const readOnly = Boolean(ro.disabled);

  const { data, error, loading, reload } = usePolled(
    async () => {
      const [rec, hist] = await Promise.all([api.listRecordings(), api.listHistorians()]);
      return { recordings: rec.recordings || [], replay: rec.replay || { running: false }, historians: hist.historians || [] };
    },
    { interval: 4000 }
  );
  const recordings = data?.recordings || [];
  const replayState = data?.replay || { running: false };
  const historians = data?.historians || [];
  const active = recordings.filter((r) => r.enabled && !r.status.full).length;

  const problems = {};
  if (form) {
    if (!form.filter.trim()) problems.filter = 'Enter the topic filter to record, for example plant/line1/#.';
    if (form.targetType === 'historian' && !form.historianId) problems.historian = historians.length ? 'Choose the historian to write to.' : 'No historian exists yet. Add one on the Historians tab first.';
  }
  const shown = attempted ? problems : {};

  const openNew = () => {
    setAttempted(false);
    setFormError(null);
    setForm({ ...BLANK, brokerId: brokers[0]?.id || '' });
  };

  const save = async () => {
    if (saving || readOnly) return;
    setAttempted(true);
    if (Object.keys(problems).length) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.saveRecording(recordingBody(form, brokers));
      setForm(null);
      reload();
      toast.success('Recording started');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Pause keeps everything captured so far; Resume continues appending to the same recording.
  const togglePaused = async (rec) => {
    try {
      await api.saveRecording({ id: rec.id, rev: rec.rev, name: rec.name, brokerId: rec.brokerId, filter: rec.filter, target: rec.target, maxBytes: rec.maxBytes, enabled: !rec.enabled });
      reload();
      toast.success(rec.enabled ? 'Recording paused: captured data is kept' : 'Recording resumed');
    } catch (e) {
      // Changed elsewhere since this list loaded: nothing was overwritten, show what is saved now.
      if (e.status === 409 && e.code === 'stale') reload();
      toast.error(`Could not ${rec.enabled ? 'pause' : 'resume'} the recording: ${e.message}`);
    }
  };

  const startReplay = async () => {
    const { rec, speed, topicPrefix, loop } = replaying;
    try {
      await api.startReplay({ recordingId: rec.id, brokerId: rec.brokerId, speed: Number(speed) || 1, topicPrefix, loop });
      setReplaying(null);
      reload();
      toast.success('Replay started');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const stopReplay = async () => {
    try {
      await api.stopReplay();
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const showPeek = async (rec) => {
    try {
      const d = await api.recordingData(rec.id, { limit: 20 });
      setPeek({ rec, ...d });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const remove = async (rec) => {
    const ok = await confirm({
      title: `Delete recording "${rec.name || rec.filter}"?`,
      message: rec.target?.type === 'historian' ? 'The recording stops. Points already written to the historian stay there.' : `The captured data file (${rec.status.points.toLocaleString()} points, ${formatBytes(rec.status.bytes)}) is discarded and cannot be recovered.`,
      confirmLabel: 'Delete recording',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteRecording(rec.id);
      reload();
      toast.success('Recording deleted');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const historianName = (id) => historians.find((h) => h.id === id)?.name || 'historian';

  return (
    <>
      {replayState.running && (
        <Banner
          variant="info"
          title="Replay in progress"
          action={
            <Button size="sm" variant="secondary" onClick={stopReplay} {...ro}>
              <Square size={12} aria-hidden="true" /> Stop replay
            </Button>
          }
        >
          <span className="tabular-nums">
            {replayState.index?.toLocaleString()} of {replayState.total?.toLocaleString()} points sent, {replayState.published?.toLocaleString()} published
            {replayState.errors > 0 && <span className="text-bad"> · {replayState.errors.toLocaleString()} errors</span>}
          </span>
        </Banner>
      )}

      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={recordings.length}
        label="recordings"
        empty={{
          title: 'No recordings yet',
          hint: 'A recording captures every message under a topic filter as a time series, either to a local file you can replay or straight into a historian.',
          action: (
            <Button onClick={openNew} {...ro}>
              <Plus size={14} aria-hidden="true" /> New recording
            </Button>
          )
        }}
      >
        <TabToolbar summary={`${active} of ${recordings.length} active`}>
          <Button onClick={openNew} {...ro}>
            <Plus size={14} aria-hidden="true" /> New recording
          </Button>
        </TabToolbar>
        <Table caption="Recordings" className="min-w-[60rem]">
          <THead>
            <Th>Recording</Th>
            <Th>State</Th>
            <Th>Target</Th>
            <Th align="right">Points</Th>
            <Th align="right">Size</Th>
            <Th align="right">Last point</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {recordings.map((rec) => {
              const name = rec.name || rec.filter;
              const toHistorian = rec.target?.type === 'historian';
              const st = recState(rec);
              return (
                <Tr key={rec.id}>
                  <Td header className="max-w-[22rem]">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={st.tone} className="md:hidden" />
                      <span className="truncate font-medium text-fg">{name}</span>
                    </span>
                    <Path value={`${brokerName(brokers, rec.brokerId)}: ${rec.filter}`} className="text-muted" />
                  </Td>
                  <Td className="max-w-[16rem]">
                    <StatusText tone={st.tone}>{st.label}</StatusText>
                    {rec.broken?.length > 0 && (
                      <span className="block text-xs text-subtle" data-testid="recording-broken">
                        {brokenSummary(rec)}. Delete this recording and create it again on an existing broker.
                      </span>
                    )}
                    {rec.status.lastError && (
                      <span className="block truncate text-xs text-warn" title={rec.status.lastError}>
                        {rec.status.lastError}
                      </span>
                    )}
                  </Td>
                  <Td className="text-xs text-muted">{toHistorian ? <Badge>{historianName(rec.target.historianId)}</Badge> : <Badge>Local file</Badge>}</Td>
                  <Td align="right" className="mono">
                    <Count value={rec.status.points} />
                  </Td>
                  <Td align="right" className="mono tabular-nums text-muted">
                    {toHistorian ? <span className="text-subtle">n/a</span> : formatBytes(rec.status.bytes)}
                  </Td>
                  <Td align="right" className="text-xs text-muted">
                    {rec.status.lastTs ? <Timestamp value={rec.status.lastTs} /> : <span className="text-subtle">none yet</span>}
                  </Td>
                  <Td align="right" className="w-56">
                    <span className="inline-flex items-center justify-end gap-0.5">
                      <Button size="sm" variant="ghost" onClick={() => togglePaused(rec)} aria-label={`${rec.enabled ? 'Pause' : 'Resume'} recording ${name}`} {...ro}>
                        {rec.enabled ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />} {rec.enabled ? 'Pause' : 'Resume'}
                      </Button>
                      {toHistorian && <span aria-hidden="true" className="w-16" />}
                      {!toHistorian && (
                        <>
                          <IconButton icon={Eye} label={`Peek at ${name}`} size={14} onClick={() => showPeek(rec)} />
                          <IconButton
                            icon={Play}
                            label={`Replay ${name}`}
                            size={14}
                            disabled={replayState.running || !rec.status.points || readOnly}
                            title={ro.title || (replayState.running ? 'A replay is already running' : !rec.status.points ? 'Nothing captured yet' : undefined)}
                            onClick={() => setReplaying({ rec, speed: 1, topicPrefix: 'replay/', loop: false })}
                          />
                        </>
                      )}
                      <IconButton icon={Trash2} label={`Delete recording ${name}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={() => remove(rec)} {...ro} />
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      {form && (
        <Dialog
          title="New recording"
          description="Captures every message matching the filter, from now on."
          size="md"
          onClose={() => setForm(null)}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                Start recording
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            {formError && (
              <Banner variant="error" title="Could not start the recording">
                {formError}
              </Banner>
            )}
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Line 1 capture" data-autofocus />
            </Field>
            <BrokerSelect label="Broker" brokers={brokers} value={form.brokerId || brokers[0]?.id || ''} onChange={(v) => setForm({ ...form, brokerId: v })} />
            <Field label="Filter" error={shown.filter} help="MQTT wildcards: + for one level, # for the rest.">
              <Input className="mono" aria-invalid={shown.filter ? 'true' : undefined} value={form.filter} onChange={(e) => setForm({ ...form, filter: e.target.value })} placeholder="plant/line1/#" />
            </Field>
            <Select label="Record to" value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value })}>
              <option value="file">A local file (can be replayed)</option>
              <option value="historian">A historian</option>
            </Select>
            {form.targetType === 'historian' && (
              <Select label="Historian" value={form.historianId} error={shown.historian} onChange={(e) => setForm({ ...form, historianId: e.target.value })}>
                <option value="">Choose a historian…</option>
                {historians.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name || h.url} ({h.type})
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Dialog>
      )}

      {replaying && (
        <Dialog
          title={`Replay "${replaying.rec.name || replaying.rec.filter}"`}
          description="Publishes the captured messages back to the broker, in their original order."
          size="md"
          onClose={() => setReplaying(null)}
          onSubmit={startReplay}
          footer={
            <>
              <Button variant="secondary" onClick={() => setReplaying(null)}>
                Cancel
              </Button>
              <Button type="submit">Start replay</Button>
            </>
          }
        >
          <div className="space-y-4">
            <Banner variant="info">
              Messages are published to {brokerName(brokers, replaying.rec.brokerId)} under the topic prefix, so live topics are not overwritten. Anything subscribed to that prefix will receive them.
            </Banner>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Speed (×)" help="1 is real time, 10 is ten times faster.">
                <Input className="mono" value={replaying.speed} onChange={(e) => setReplaying({ ...replaying, speed: e.target.value })} data-autofocus />
              </Field>
              <Field label="Topic prefix">
                <Input className="mono" value={replaying.topicPrefix} onChange={(e) => setReplaying({ ...replaying, topicPrefix: e.target.value })} />
              </Field>
            </div>
            <Checkbox label="Loop until stopped" checked={replaying.loop} onChange={(v) => setReplaying({ ...replaying, loop: v })} />
          </div>
        </Dialog>
      )}

      {peek && (
        <Drawer title={`First points of "${peek.rec.name || peek.rec.filter}"`} onClose={() => setPeek(null)} width="max-w-xl">
          {peek.points.length === 0 ? (
            <p className="p-4 text-sm text-muted">No points captured yet.</p>
          ) : (
            <Table caption="Captured points" wrapperClassName="rounded-none border-0" className="!min-w-0">
              <THead>
                <Th>Time</Th>
                <Th>Topic</Th>
                <Th>Value</Th>
              </THead>
              <tbody>
                {peek.points.map((p, i) => (
                  <Tr key={i}>
                    <Td className="mono whitespace-nowrap text-xs text-muted">{new Date(p.t).toLocaleTimeString()}</Td>
                    <Td className="mono max-w-[12rem] truncate text-xs" title={p.topic}>
                      {p.topic}
                    </Td>
                    <Td className="mono max-w-[10rem] truncate text-xs" title={typeof p.v === 'object' ? JSON.stringify(p.v) : String(p.v)}>
                      {typeof p.v === 'object' ? JSON.stringify(p.v) : String(p.v)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Drawer>
      )}
      {confirmDialog}
    </>
  );
}
