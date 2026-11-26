import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { Button, IconButton, EmptyState, Banner, LoadingState, PageBody, Tabs, TabPanel, Card } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import DeviceList from './devices/DeviceList';
import DeviceDetail from './devices/DeviceDetail';
import DeviceEditor from './devices/DeviceEditor';
import DeleteDeviceDialog from './devices/DeleteDeviceDialog';
import ProfilesTab from './devices/ProfilesTab';
import PickProfileDialog from './devices/PickProfileDialog';
import InstantiateDialog from './devices/InstantiateDialog';
import IotDevicesTab from './devices/IotDevicesTab';
import { useDevicesData } from './devices/useDevicesData';
import { blankDevice } from './devices/model';
import { hostIssues, hostFor, deviceStateView, fleetSummary } from '@/lib/deviceStatus';

const NO_PROTOCOLS = [];
const TABS_ID = 'devices-tabs';

/**
 * Devices: the list-page pattern with a detail drawer (docs/design/ui-design-system.md). The table is
 * the page; a row opens the drawer (?device=ID, so it can be linked); editing is a full-page form
 * because a device carries a tag table that does not fit a dialog.
 */
export default function Devices() {
  const { data, profiles, error, profilesError, loading, load } = useDevicesData();
  const [editing, setEditing] = useState(null); // null | 'new' | device | draft (no id)
  const [editorOpts, setEditorOpts] = useState(null);
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [instantiating, setInstantiating] = useState(null);
  const [detailOpts, setDetailOpts] = useState(null);
  const deviceStates = useStore((s) => s.deviceStates);
  const readOnly = useReadOnly();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = params.get('tab') === 'profiles' ? 'profiles' : params.get('tab') === 'iot' ? 'iot' : 'devices';
  const detailId = params.get('device');

  const protocols = data?.protocols ?? NO_PROTOCOLS;
  const labels = useMemo(() => Object.fromEntries(protocols.map((p) => [p.id, p.label])), [protocols]);
  const profileById = useMemo(() => Object.fromEntries((profiles || []).map((p) => [p.id, p])), [profiles]);
  const issues = useMemo(() => hostIssues(data?.hosts, data?.devices), [data]);
  const experimental = useMemo(() => new Set(protocols.filter((p) => p.experimental).map((p) => p.id)), [protocols]);
  const detailDevice = useMemo(() => (detailId && data ? data.devices.find((d) => d.id === detailId) : null), [detailId, data]);
  const summary = useMemo(() => (data ? fleetSummary(data.devices.map((d) => deviceStateView(d, d.status, deviceStates[d.id], hostFor(d, data.hosts)))) : ''), [data, deviceStates]);
  const editingLive = useMemo(() => {
    if (!editing || editing === 'new' || !editing.id) return null;
    const cur = data?.devices.find((d) => d.id === editing.id);
    return { ...(cur?.status || {}), ...(deviceStates[editing.id] || {}) };
  }, [editing, data, deviceStates]);

  const setTab = (t) => setParams(t === 'devices' ? {} : { tab: t }, { replace: true });
  const openDetail = useCallback(
    (d, opts) => {
      setDetailOpts(opts || null);
      setParams({ device: d.id });
    },
    [setParams]
  );
  const closeDetail = useCallback(() => setParams({}, { replace: true }), [setParams]);

  // A discovery draft arrives in router state: open the form prefilled (once per draft). The editor state
  // is adjusted while rendering; the URL clean-up is a side effect and runs afterwards.
  const draft = location.state?.draft;
  const [handledDraft, setHandledDraft] = useState(null);
  if (draft && data && protocols.length && handledDraft !== draft) {
    setHandledDraft(draft);
    const desc = protocols.find((p) => p.id === draft.protocol) || protocols[0];
    setEditing({ ...blankDevice(desc), ...draft });
    setNotice(location.state?.notice || 'Prefilled from discovery. Check the details, test the connection and create the device.');
  }
  useEffect(() => {
    if (draft && handledDraft === draft) navigate(location.pathname + location.search, { replace: true, state: null });
  }, [draft, handledDraft, location.pathname, location.search, navigate]);
  // A link to a device that is gone says so instead of opening an empty drawer.
  useEffect(() => {
    if (!detailId || !data || data.devices.some((x) => x.id === detailId)) return;
    toast.error('That device no longer exists');
    setParams({}, { replace: true });
  }, [detailId, data, setParams]);

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
    setDeleteError('');
    setBusyId(d.id);
    try {
      await api.deleteDevice(d.id);
      toast.success(`Deleted ${d.name}`);
      setDeleting(null);
      if (detailId === d.id) closeDetail();
      await load();
    } catch (e) {
      setDeleteError(e.message); // shown inside the dialog, next to the button that was pressed
    } finally {
      setBusyId(null);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };
  const onEdit = useCallback(
    (d, opts) => {
      setParams({}, { replace: true });
      setEditorOpts(opts || null);
      setEditing(d);
    },
    [setParams]
  );
  const onDelete = useCallback((d) => {
    setDeleteError('');
    setDeleting(d);
  }, []);
  const onMap = useCallback((d) => navigate(`/tags?source=device:${encodeURIComponent(d.id)}`), [navigate]);
  const canAdd = protocols.length > 0;
  const closeForm = () => {
    setEditing(null);
    setEditorOpts(null);
    setNotice('');
  };

  if (editing) {
    return (
      <DeviceEditor
        key={editing === 'new' ? 'new' : editing.id || `draft-${editing.host}-${editing.port}`}
        device={editing === 'new' ? null : editing}
        protocols={protocols}
        profiles={profiles || []}
        live={editingLive}
        notice={notice}
        openBrowse={Boolean(editorOpts?.browse)}
        onClose={closeForm}
        onSaved={() => {
          closeForm();
          load();
        }}
      />
    );
  }

  const addTitle = readOnly ? READ_ONLY_REASON : canAdd ? '' : 'No device protocols available from the server';
  const deviceCount = data?.devices.length;
  const countOf = { devices: deviceCount, profiles: profiles?.length };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Devices"
        subtitle={
          tab === 'iot'
            ? 'Devices that bridges and gateways publish over MQTT'
            : tab === 'profiles'
              ? profiles
                ? `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`
                : undefined
              : summary || (data ? 'No devices yet' : undefined)
        }
        actions={
          <>
            <IconButton icon={RefreshCw} label="Refresh device list" onClick={refresh} disabled={refreshing} />
            {tab === 'devices' && (
              <>
                <Button variant="secondary" onClick={() => setPicking(true)} disabled={!canAdd || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                  From profile
                </Button>
                <Button onClick={() => setEditing('new')} disabled={!canAdd || readOnly} title={addTitle}>
                  <Plus size={14} aria-hidden="true" /> Add device
                </Button>
              </>
            )}
          </>
        }
      />

      <PageBody>
        <ReadOnlyNote className="" />
        <Tabs
          idPrefix={TABS_ID}
          label="Devices and profiles"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'devices', label: 'Devices', count: countOf.devices },
            { id: 'profiles', label: 'Profiles', count: countOf.profiles },
            { id: 'iot', label: 'IoT over MQTT' }
          ]}
        />

        {issues.map((i) => (
          <Banner key={i.id} variant={i.level === 'error' ? 'error' : 'warn'} title={i.level === 'error' ? 'A driver host is parked' : 'A driver host is restarting'}>
            {i.text}
          </Banner>
        ))}

        {error && (
          <Banner variant="error" title={data ? 'Could not refresh devices' : 'Could not load devices'} onRetry={load}>
            {error}
          </Banner>
        )}

        {loading && !data && !error && <LoadingState label="devices" rows={4} />}

        <TabPanel idPrefix={TABS_ID} id={tab} className="space-y-4">
          {tab === 'iot' && <IotDevicesTab readOnly={readOnly} />}

          {tab === 'profiles' && data && (
            <ProfilesTab profiles={profiles} error={profilesError} loading={loading} onRetry={load} protocols={protocols} devices={data.devices} labels={labels} focusId={params.get('profile')} onChanged={load} />
          )}

          {tab === 'devices' && data && data.devices.length === 0 && (
            <Card>
              <EmptyState
                title="No devices yet"
                hint="Connect a PLC, meter or gateway over Modbus TCP, Siemens S7 or EtherNet/IP, test the connection, list its tags, then map them into the UNS. Many identical devices? Define a profile once and create devices from it."
                action={
                  <Button onClick={() => setEditing('new')} disabled={!canAdd || readOnly} title={addTitle}>
                    <Plus size={14} aria-hidden="true" /> Add device
                  </Button>
                }
              />
            </Card>
          )}

          {tab === 'devices' && data && data.devices.length > 0 && (
            <DeviceList
              devices={data.devices}
              hosts={data.hosts}
              deviceStates={deviceStates}
              labels={labels}
              experimental={experimental}
              profileById={profileById}
              selectedId={detailId}
              busyId={busyId}
              readOnly={readOnly}
              onOpen={openDetail}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggle={toggle}
              onMap={onMap}
            />
          )}
        </TabPanel>
      </PageBody>

      {detailDevice && (
        <DeviceDetail
          key={detailDevice.id}
          device={detailDevice}
          live={deviceStates[detailDevice.id]}
          host={hostFor(detailDevice, data.hosts)}
          issues={issues.filter((i) => i.deviceIds?.includes(detailDevice.id))}
          profile={profileById[detailDevice.profileId]}
          protocolLabel={labels[detailDevice.protocol] || detailDevice.protocol}
          descriptor={protocols.find((p) => p.id === detailDevice.protocol)}
          experimental={experimental.has(detailDevice.protocol)}
          busy={busyId === detailDevice.id}
          readOnly={readOnly}
          initial={detailOpts}
          onClose={closeDetail}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggle={toggle}
          onMap={onMap}
        />
      )}
      {picking && (
        <PickProfileDialog
          profiles={profiles || []}
          labels={labels}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setPicking(false);
            setInstantiating(p);
          }}
        />
      )}
      {instantiating && (
        <InstantiateDialog
          profile={instantiating}
          protocols={protocols}
          onClose={() => setInstantiating(null)}
          onCreated={() => {
            setInstantiating(null);
            load();
          }}
        />
      )}
      {deleting && <DeleteDeviceDialog device={deleting} busy={busyId === deleting.id} error={deleteError} onCancel={() => setDeleting(null)} onConfirm={remove} />}
    </div>
  );
}
