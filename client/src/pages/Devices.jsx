import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { HardDrive, Plus, RefreshCw, OctagonAlert, Loader2, FilePlus2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { Button, EmptyState, Modal } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import DeviceCard from './devices/DeviceCard';
import DeviceForm from './devices/DeviceForm';
import DevicesTabs from './devices/DevicesTabs';
import ProfilesTab from './devices/ProfilesTab';
import PickProfileDialog from './devices/PickProfileDialog';
import InstantiateDialog from './devices/InstantiateDialog';
import { useDevicesData } from './devices/useDevicesData';
import { blankDevice } from './devices/model';
import { hostIssues, hostFor } from '@/lib/deviceStatus';

const NO_PROTOCOLS = [];

function ConfirmDelete({ device, busy, onCancel, onConfirm }) {
  const id = useId();
  return (
    <Modal title="Delete device" labelledBy={id} onClose={onCancel}>
      <h3 id={id} className="text-base font-semibold text-slate-100">Delete {device.name}?</h3>
      <p className="mt-2 text-sm text-slate-400">
        Polling stops and its {device.profileId ? `${device.ownTags?.length || 0} own tag definitions` : `${device.tags?.length || 0} tag definitions`} are removed
        {device.profileId ? ' (the profile stays)' : ''}. UNS mappings that use this device will stop publishing.
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
  const { data, profiles, error, profilesError, loading, load } = useDevicesData();
  const [editing, setEditing] = useState(null); // null | 'new' | device | draft (no id)
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [picking, setPicking] = useState(false);
  const [instantiating, setInstantiating] = useState(null);
  const deviceStates = useStore((s) => s.deviceStates);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = params.get('tab') === 'profiles' ? 'profiles' : 'devices';

  const protocols = data?.protocols ?? NO_PROTOCOLS;
  const labels = useMemo(() => Object.fromEntries(protocols.map((p) => [p.id, p.label])), [protocols]);
  const profileById = useMemo(() => Object.fromEntries((profiles || []).map((p) => [p.id, p])), [profiles]);
  const issues = useMemo(() => hostIssues(data?.hosts, data?.devices), [data]);
  const experimental = useMemo(() => new Set(protocols.filter((p) => p.experimental).map((p) => p.id)), [protocols]);
  const editingLive = useMemo(() => {
    if (!editing || editing === 'new' || !editing.id) return null;
    const cur = data?.devices.find((d) => d.id === editing.id);
    return { ...(cur?.status || {}), ...(deviceStates[editing.id] || {}) };
  }, [editing, data, deviceStates]);
  const setTab = (t) => setParams(t === 'profiles' ? { tab: 'profiles' } : {}, { replace: true });

  // Deep links: /devices?device=ID opens that device; a discovery draft arrives in router state.
  // The editor state is adjusted while rendering (once per link/draft, remembered in state); the
  // URL clean-up and the toast are side effects and run afterwards.
  const deepId = params.get('device');
  const draft = location.state?.draft;
  const [handledDevice, setHandledDevice] = useState(null);
  const [handledDraft, setHandledDraft] = useState(null);
  if (deepId && data && handledDevice !== deepId) {
    setHandledDevice(deepId);
    const d = data.devices.find((x) => x.id === deepId);
    if (d) setEditing(d);
  }
  if (draft && data && protocols.length && handledDraft !== draft) {
    setHandledDraft(draft);
    const desc = protocols.find((p) => p.id === draft.protocol) || protocols[0];
    setEditing({ ...blankDevice(desc), ...draft });
    setNotice(location.state?.notice || 'Prefilled from discovery. Check the details, test the connection and create the device.');
  }
  useEffect(() => {
    if (!deepId || !data || handledDevice !== deepId) return;
    if (!data.devices.some((x) => x.id === deepId)) toast.error('That device no longer exists');
    const next = new URLSearchParams(params);
    next.delete('device');
    setParams(next, { replace: true });
  }, [deepId, handledDevice, data, params, setParams]);
  useEffect(() => {
    if (draft && handledDraft === draft) navigate(location.pathname + location.search, { replace: true, state: null });
  }, [draft, handledDraft, location.pathname, location.search, navigate]);

  const toggle = useCallback(
    async (device) => {
      setBusyId(device.id);
      try {
        const { status, ownTags, profileErrors: _pe, ...cfg } = device;
        void status;
        await api.updateDevice(device.id, { ...cfg, ...(device.profileId ? { tags: ownTags || [] } : {}), enabled: !device.enabled });
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
  const closeForm = () => {
    setEditing(null);
    setNotice('');
  };

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
            <Button variant="outline" className="whitespace-nowrap" onClick={() => setPicking(true)} disabled={!canAdd}>
              <FilePlus2 size={14} /> <span className="hidden sm:inline">From profile</span><span className="sm:hidden">Profile</span>
            </Button>
            <Button className="whitespace-nowrap" onClick={() => setEditing('new')} disabled={!canAdd} title={canAdd ? '' : 'No device protocols available from the server'}>
              <Plus size={14} /> Add device
            </Button>
          </>
        }
      />
      <DevicesTabs tab={tab} onChange={setTab} counts={{ devices: data?.devices.length, profiles: profiles?.length }} />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
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

        {tab === 'profiles' && data && (
          <ProfilesTab profiles={profiles} error={profilesError} loading={loading} onRetry={load} protocols={protocols} devices={data.devices} labels={labels} focusId={params.get('profile')} onChanged={load} />
        )}

        {tab === 'devices' && data && data.devices.length === 0 && (
          <div className="py-10">
            <EmptyState
              icon={HardDrive}
              title="Add your first device"
              hint="Connect a PLC, meter or gateway over Modbus TCP, Siemens S7 or EtherNet/IP, test the connection, list its tags, then map them into the UNS. Many identical devices? Define a profile once and create devices from it."
              action={
                <Button onClick={() => setEditing('new')} disabled={!canAdd}>
                  <Plus size={14} /> Add device
                </Button>
              }
            />
          </div>
        )}

        {tab === 'devices' && data && data.devices.length > 0 && (
          <ul className="mx-auto max-w-5xl space-y-3">
            {data.devices.map((d) => (
              <li key={d.id}>
                <DeviceCard
                  device={d}
                  live={deviceStates[d.id]}
                  host={hostFor(d, data.hosts)}
                  profile={profileById[d.profileId]}
                  protocolLabel={labels[d.protocol] || d.protocol}
                  experimental={experimental.has(d.protocol)}
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
          key={editing === 'new' ? 'new' : editing.id || `draft-${editing.host}-${editing.port}`}
          device={editing === 'new' ? null : editing}
          protocols={protocols}
          profiles={profiles || []}
          live={editingLive}
          notice={notice}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            load();
          }}
        />
      )}
      {picking && <PickProfileDialog profiles={profiles || []} labels={labels} onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); setInstantiating(p); }} />}
      {instantiating && <InstantiateDialog profile={instantiating} protocols={protocols} onClose={() => setInstantiating(null)} onCreated={() => { setInstantiating(null); load(); }} />}
      {deleting && <ConfirmDelete device={deleting} busy={busyId === deleting.id} onCancel={() => setDeleting(null)} onConfirm={remove} />}
    </div>
  );
}
