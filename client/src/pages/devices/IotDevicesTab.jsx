import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Waypoints, Search } from 'lucide-react';
import { Input, Select, StatusText, Timestamp, IconButton, Table, THead, Th, Tr, Td, EmptyState, Banner, LoadingState, Card, Badge } from '@/components/ui';
import IotDetectionPanel from './IotDetectionPanel';
import IotDeviceDetail from './IotDeviceDetail';
import { availabilityView, conventionLabel, filterDevices, mapLink, iotSummary, CONVENTION_SHORT } from './iotModel';
import { usePolled } from '@/lib/usePolled';
import { fetchIotBrokers, fetchIotDevices } from './iotHooks';

/**
 * Devices > IoT over MQTT: devices that bridges and gateways (Zigbee2MQTT, Z-Wave JS UI, Home
 * Assistant discovery, Tasmota, Shelly, ChirpStack, The Things Stack) publish on a connected broker,
 * as devices with named tags. Detection is opt-in per broker and convention.
 */
export default function IotDevicesTab({ readOnly }) {
  const brokers = usePolled(fetchIotBrokers, { interval: 5000 });
  const devices = usePolled(fetchIotDevices, { interval: 3000 });
  const [text, setText] = useState('');
  const [convention, setConvention] = useState('all');
  const [brokerId, setBrokerId] = useState('all');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const openId = params.get('iot');
  const list = useMemo(() => filterDevices(devices.data, { text, convention, brokerId }), [devices.data, text, convention, brokerId]);
  const open = useMemo(() => (openId ? (devices.data || []).find((d) => d.sourceId === openId) : null), [openId, devices.data]);
  const onMap = (d) => navigate(mapLink(d));
  const setOpen = (d) => setParams(d ? { tab: 'iot', iot: d.sourceId } : { tab: 'iot' }, { replace: !d });
  const reloadAll = () => {
    brokers.reload();
    devices.reload();
  };

  return (
    <div className="space-y-4">
      <IotDetectionPanel brokers={brokers.data} error={brokers.error?.message} loading={brokers.loading} onRetry={brokers.reload} onSaved={reloadAll} readOnly={readOnly} />

      {devices.error && (
        <Banner variant="error" title={devices.data ? 'Could not refresh IoT devices' : 'Could not load IoT devices'} onRetry={devices.reload}>
          {devices.error.message}
        </Banner>
      )}
      {devices.loading && !devices.data && <LoadingState label="IoT devices" rows={4} />}
      {devices.data && devices.data.length === 0 && (
        <Card>
          <EmptyState
            title="No IoT devices yet"
            hint="Turn on detection for a convention above. Devices appear as soon as the bridge's device list, discovery configs or first messages arrive on the broker."
          />
        </Card>
      )}
      {devices.data && devices.data.length > 0 && (
        <section aria-label="IoT devices" className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <p className="mr-auto text-sm text-muted" aria-live="polite">{iotSummary(devices.data)}</p>
            <div className="relative w-full sm:w-56">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
              <Input type="search" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter IoT devices" placeholder="Filter devices" className="pl-8" />
            </div>
            <Select label="Convention" hideLabel id="iot-filter-convention" value={convention} onChange={(e) => setConvention(e.target.value)} fieldClassName="w-full sm:w-44">
              <option value="all">All conventions</option>
              {Object.entries(CONVENTION_SHORT).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
            {(brokers.data?.length || 0) > 1 && (
              <Select label="Broker" hideLabel id="iot-filter-broker" value={brokerId} onChange={(e) => setBrokerId(e.target.value)} fieldClassName="w-full sm:w-44">
                <option value="all">All brokers</option>
                {brokers.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          {list.length === 0 ? (
            <p className="px-1 py-3 text-sm text-muted">No device matches the filter.</p>
          ) : (
            <Table caption="IoT devices" className="!min-w-0">
              <THead>
                <Th>Device</Th>
                <Th>State</Th>
                <Th className="hidden md:table-cell">Convention</Th>
                <Th className="hidden lg:table-cell">Model</Th>
                <Th align="right" className="hidden sm:table-cell">Tags</Th>
                <Th className="hidden xl:table-cell">Last seen</Th>
                <Th srOnly>Actions</Th>
              </THead>
              <tbody>
                {list.map((d) => {
                  const v = availabilityView(d.availability);
                  return (
                    <Tr key={d.sourceId} highlight={openId === d.sourceId} className="cursor-pointer" onClick={(e) => !e.target.closest('a,button') && setOpen(d)} data-iot-device={d.id}>
                      <Td header>
                        {/* max-width on a table cell is ignored by the table layout: constrain the content, so a long name truncates instead of pushing State and the Map action off a phone screen */}
                        <button type="button" onClick={() => setOpen(d)} className="block max-w-[9.5rem] truncate rounded text-left text-sm font-medium text-fg hover:text-accent-text sm:max-w-[14rem] md:max-w-[16rem]" title={d.name}>
                          {d.name}
                        </button>
                        <span className="block max-w-[9.5rem] truncate text-xs text-muted sm:max-w-[14rem] md:max-w-[16rem]" title={`${conventionLabel(d.convention)} · via ${d.brokerName}`}>
                          <span className="md:hidden">{conventionLabel(d.convention)} · </span>via {d.brokerName}
                        </span>
                      </Td>
                      <Td>
                        <StatusText tone={v.tone}>{v.label}</StatusText>
                      </Td>
                      <Td className="hidden md:table-cell">
                        <Badge>{conventionLabel(d.convention)}</Badge>
                      </Td>
                      <Td className="hidden max-w-[12rem] lg:table-cell">
                        <span className="block truncate text-sm text-fg">{d.model || '—'}</span>
                        {d.manufacturer && <span className="block truncate text-xs text-subtle">{d.manufacturer}</span>}
                      </Td>
                      <Td align="right" className="hidden tabular-nums sm:table-cell">{d.tagCount}</Td>
                      <Td className="hidden text-xs text-muted xl:table-cell">{d.lastSeen ? <Timestamp value={d.lastSeen} /> : '—'}</Td>
                      <Td align="right">
                        <IconButton icon={Waypoints} size={14} label={`Map ${d.name} to the UNS`} onClick={() => onMap(d)} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
      )}
      {open && <IotDeviceDetail key={open.sourceId} device={open} onClose={() => setOpen(null)} onMap={onMap} />}
    </div>
  );
}
