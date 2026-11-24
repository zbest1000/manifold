import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { HardDrive, Plus, RefreshCw, OctagonAlert, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { Button, EmptyState, Modal } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import DeviceCard from './devices/DeviceCard';
import DeviceForm from './devices/DeviceForm';
import { hostIssues, hostFor } from '@/lib/deviceStatus';

const REFRESH_MS = 5000; // cycle statistics only travel over REST; phases arrive live over the socket

function ConfirmDelete({ device, busy, onCancel, onConfirm }) {
  const id = useId();
  return (
    <Modal title="Delete device" labelledBy={id} onClose={onCancel}>
      <h3 id={id} className="text-base font-semibold text-slate-100">Delete {device.name}?</h3>
      <p className="mt-2 text-sm text-slate-400">
        Polling stops and its {device.tags?.length || 0} tag definitions are removed. UNS mappings that use this device will stop publishing.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} data-autofocus>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy && <Loader2 size={14} className="animate-spin" />} Delete device
        </Button>
      </div>
    </Modal>
  );
}

export default function Devices() {
  const [data, setData] = useState(null); // { devices, hosts, protocols }
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'new' | device
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const deviceStates = useStore((s) => s.deviceStates);
  const devicesVersion = useStore((s) => s.devicesVersion);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.devices();
      if (!alive.current) return;
      setData({ devices: res.devices || [], hosts: res.hosts || {}, protocols: res.protocols || [] });
      setError('');
    } catch (e) {
      if (alive.current) setError(e.message || 'Could not load devices');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    load();
  }, [load, devicesVersion]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const protocols = data?.protocols || [];
  const labels = useMemo(() => Object.fromEntries(protocols.map((p) => [p.id, p.label])), [protocols]);
  const issues = hostIssues(data?.hosts);

  const toggle = useCallback(
    async (device) => {
      setBusyId(device.id);
      try {
        const { status, ...cfg } = device;
        await api.updateDevice(device.id, { ...cfg, enabled: !device.enabled });
        await load();
      } catch (e) {
        toast.error(`Could not ${device.enabled ? 'disable' : 'enable'} ${device.name}: ${e.message}`);
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const remove = async () => {
    const d = deleting;
    setBusyId(d.id);
    try {
      await api.deleteDevice(d.id);
      toast.success(`Deleted ${d.name}`);
      setDeleting(null);
      await load();
    } catch (e) {
      toast.error(`Could not delete ${d.name}: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const onEdit = useCallback((d) => setEditing(d), []);
  const onDelete = useCallback((d) => setDeleting(d), []);
  const canAdd = protocols.length > 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Devices"
        subtitle="Poll PLCs and meters directly and map their tags into the UNS."
        actions={
          <>
            <Button variant="outline" onClick={load} aria-label="Refresh device list">
              <RefreshCw size={14} /> <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button className="whitespace-nowrap" onClick={() => setEditing('new')} disabled={!canAdd} title={canAdd ? '' : 'No device protocols available from the server'}>
              <Plus size={14} /> Add device
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        {issues.length > 0 && (
          <div className="mb-4 space-y-2">
            {issues.map((i) => (
              <div
                key={i.id}
                role={i.level === 'error' ? 'alert' : 'status'}
                className={
                  i.level === 'error'
                    ? 'flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100'
                    : 'flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100'
                }
              >
                <OctagonAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {i.text}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            <span>{data ? 'Could not refresh devices' : 'Could not load devices'}: {error}</span>
            <Button size="sm" variant="outline" onClick={load}>
              <RefreshCw size={12} /> Retry
            </Button>
          </div>
        )}

        {loading && !data && <p className="py-12 text-center text-sm text-slate-500">Loading devices…</p>}

        {data && data.devices.length === 0 && (
          <div className="py-10">
            <EmptyState
              icon={HardDrive}
              title="Add your first device"
              hint="Connect a PLC, meter or gateway over Modbus TCP, test the connection, list its registers as tags, then map them into the UNS."
              action={
                <Button onClick={() => setEditing('new')} disabled={!canAdd}>
                  <Plus size={14} /> Add device
                </Button>
              }
            />
          </div>
        )}

        {data && data.devices.length > 0 && (
          <ul className="mx-auto max-w-5xl space-y-3">
            {data.devices.map((d) => (
              <li key={d.id}>
                <DeviceCard
                  device={d}
                  live={deviceStates[d.id]}
                  host={hostFor(d, data.hosts)}
                  protocolLabel={labels[d.protocol] || d.protocol}
                  busy={busyId === d.id}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onToggle={toggle}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <DeviceForm
          device={editing === 'new' ? null : editing}
          protocols={protocols}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {deleting && <ConfirmDelete device={deleting} busy={busyId === deleting.id} onCancel={() => setDeleting(null)} onConfirm={remove} />}
    </div>
  );
}
