import { useState } from 'react';
import { CircleDot, Play, Square, Eye, Pause } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Input, Field, Select, Checkbox, Badge, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { BrokerSelect, ListState, RowButtons, useRo } from './shared';
import { brokerName, formatKb, recordingBody, recordingStatusLabel } from './helpers';

export default function RecorderTab({ brokers }) {
  const [form, setForm] = useState({ name: '', brokerId: '', filter: '', targetType: 'file', historianId: '' });
  const [peek, setPeek] = useState(null); // { id, points }
  const [replayForm, setReplayForm] = useState({ speed: 1, loop: false, topicPrefix: 'replay/' });
  const [confirm, confirmDialog] = useConfirm();
  const [saving, setSaving] = useState(false);
  const ro = useRo();

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

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveRecording(recordingBody(form, brokers));
      setForm((f) => ({ ...f, name: '', filter: '' }));
      reload();
      toast.success('Recording started');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Pause keeps everything captured so far; Resume continues appending to the same recording.
  const togglePaused = async (rec) => {
    try {
      await api.saveRecording({ id: rec.id, name: rec.name, brokerId: rec.brokerId, filter: rec.filter, target: rec.target, maxBytes: rec.maxBytes, enabled: !rec.enabled });
      reload();
      toast.success(rec.enabled ? 'Recording paused: captured data is kept' : 'Recording resumed');
    } catch (e) {
      toast.error(`Could not ${rec.enabled ? 'pause' : 'resume'} the recording: ${e.message}`);
    }
  };

  const replay = async (rec) => {
    try {
      await api.startReplay({ recordingId: rec.id, brokerId: rec.brokerId, ...replayForm, speed: Number(replayForm.speed) || 1 });
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
      setPeek({ id: rec.id, ...d });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const remove = async (rec) => {
    const ok = await confirm({
      title: `Delete recording "${rec.name || rec.filter}"?`,
      message: 'The captured data file is discarded and cannot be recovered.',
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

  return (
    <>
      {replayState.running && (
        <Card className="border-accent-500/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2" role="status">
            <span className="flex items-center gap-2 text-sm text-slate-200">
              <Play size={14} aria-hidden="true" className="text-accent-300" /> Replaying · {replayState.index}/{replayState.total} · {replayState.published} published
              {replayState.errors > 0 && <span className="text-rose-300">· {replayState.errors} errors</span>}
            </span>
            <Button size="sm" variant="outline" onClick={stopReplay} {...ro}>
              <Square size={12} aria-hidden="true" /> Stop
            </Button>
          </div>
        </Card>
      )}

      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={recordings.length}
        label="recordings"
        empty={{
          icon: CircleDot,
          title: 'No recordings',
          hint: 'A recording captures every message under a filter as a time series — to a local file (replayable) or straight into a historian. Start one below.'
        }}
      >
        <Table caption="Recordings">
          <THead>
            <Th>Recording</Th>
            <Th>Capture</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {recordings.map((rec) => {
              const name = rec.name || rec.filter;
              const toHistorian = rec.target?.type === 'historian';
              return (
                <Tr key={rec.id}>
                  <Td header>
                    <span className="block max-w-[14rem] truncate text-slate-100">{name}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Badge status={rec.enabled && !rec.status.full ? 'connected' : 'disconnected'}>{recordingStatusLabel(rec)}</Badge>
                      <Badge>{toHistorian ? 'historian' : 'file'}</Badge>
                    </span>
                  </Td>
                  <Td className="max-w-[26rem]">
                    <p className="truncate font-mono text-xs text-muted">
                      {brokerName(brokers, rec.brokerId)} · {rec.filter} · {rec.status.points.toLocaleString()} pts
                      {!toHistorian && ` · ${formatKb(rec.status.bytes)}`}
                      {rec.status.lastTs ? ` · last ${formatDistanceToNow(rec.status.lastTs, { addSuffix: true })}` : ''}
                    </p>
                    {rec.status.lastError && <p className="mt-1 text-xs text-amber-300">{rec.status.lastError}</p>}
                    {peek?.id === rec.id && (
                      <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-xs text-slate-300">
                        {peek.points.map((p, i) => (
                          <div key={i} className="truncate">
                            {new Date(p.t).toLocaleTimeString()} · {p.topic} · {typeof p.v === 'object' ? JSON.stringify(p.v) : String(p.v)}
                          </div>
                        ))}
                        {peek.points.length === 0 && <span className="text-muted">no points yet</span>}
                      </div>
                    )}
                  </Td>
                  <Td align="right">
                    <RowButtons what={`recording ${name}`} onDelete={() => remove(rec)}>
                      <Button size="sm" variant="ghost" onClick={() => togglePaused(rec)} aria-label={`${rec.enabled ? 'Pause' : 'Resume'} recording ${name}`} {...ro}>
                        {rec.enabled ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />} {rec.enabled ? 'Pause' : 'Resume'}
                      </Button>
                      {!toHistorian && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => showPeek(rec)} aria-label={`Peek at ${name}`}>
                            <Eye size={12} aria-hidden="true" /> Peek
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => replay(rec)} disabled={replayState.running || !rec.status.points || Boolean(ro.disabled)} title={ro.title || (replayState.running ? 'A replay is already running' : !rec.status.points ? 'Nothing captured yet' : 'Publishes the captured messages back to the broker under the topic prefix')} aria-label={`Replay ${name}`}>
                            <Play size={12} aria-hidden="true" /> Replay
                          </Button>
                        </>
                      )}
                    </RowButtons>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-100">New recording</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="line1 capture" />
          </Field>
          <BrokerSelect label="Broker" brokers={brokers} value={form.brokerId || brokers[0]?.id || ''} onChange={(v) => setForm({ ...form, brokerId: v })} />
          <Field label="Filter">
            <Input value={form.filter} onChange={(e) => setForm({ ...form, filter: e.target.value })} placeholder="plant/line1/#" />
          </Field>
          <Select label="Target" value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value })}>
            <option value="file">Local file (replayable)</option>
            <option value="historian">Historian</option>
          </Select>
          {form.targetType === 'historian' && (
            <Select label="Historian" value={form.historianId} onChange={(e) => setForm({ ...form, historianId: e.target.value })}>
              <option value="">select…</option>
              {historians.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name || h.url} ({h.type})
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
          <Button onClick={save} disabled={!form.filter || (form.targetType === 'historian' && !form.historianId) || saving || Boolean(ro.disabled)} title={ro.title}>
            <CircleDot size={14} aria-hidden="true" /> Start recording
          </Button>
          <fieldset className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <legend className="sr-only">Replay options</legend>
            <span className="helper self-center" aria-hidden="true">
              Replay options:
            </span>
            <Field label="Speed ×" className="w-20">
              <Input value={replayForm.speed} onChange={(e) => setReplayForm({ ...replayForm, speed: e.target.value })} className="px-2 py-1 font-mono text-xs" />
            </Field>
            <Field label="Topic prefix" className="w-32">
              <Input value={replayForm.topicPrefix} onChange={(e) => setReplayForm({ ...replayForm, topicPrefix: e.target.value })} className="px-2 py-1 font-mono text-xs" />
            </Field>
            <div className="pb-1.5">
              <Checkbox label="Loop" checked={replayForm.loop} onChange={(v) => setReplayForm({ ...replayForm, loop: v })} />
            </div>
          </fieldset>
        </div>
      </Card>
      {confirmDialog}
    </>
  );
}
