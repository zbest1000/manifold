import { useMemo, useState } from 'react';
import { Waypoints, Search } from 'lucide-react';
import { Drawer, Button, Banner, StatusText, Timestamp, KeyValue, Badge, Input, Table, THead, Th, Tr, Td, LoadingState, EmptyState, Toggle } from '@/components/ui';
import { availabilityView, qualityView, formatIotValue, tagLimits, conventionLabel } from './iotModel';
import { usePolled } from '@/lib/usePolled';
import { fetchIotDevice } from './iotHooks';

const H = ({ children }) => <h3 className="mb-2 text-sm font-medium text-fg">{children}</h3>;

/**
 * One IoT device: what the convention says about it, and its tags with live values (polled every
 * 2 s while open). Read-only: there is nothing here that sends to the device.
 */
export default function IotDeviceDetail({ device, onClose, onMap }) {
  const { data, error, loading, reload } = usePolled(() => fetchIotDevice(device.brokerId, device.id), { interval: 2000, deps: [device.brokerId, device.id] });
  const [filter, setFilter] = useState('');
  const [showDiag, setShowDiag] = useState(true);
  const d = data || device;
  const view = availabilityView(d.availability);
  const tags = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return (data?.tags || []).filter((x) => (showDiag || !x.diagnostic) && (!t || `${x.name} ${x.key} ${x.unit || ''}`.toLowerCase().includes(t)));
  }, [data, filter, showDiag]);
  const details = Object.entries(d.details || {}).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && typeof v !== 'object');

  return (
    <Drawer
      title={d.name}
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => onMap(d)}>
            <Waypoints size={14} aria-hidden="true" /> Map to UNS
          </Button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div tabIndex={-1} data-autofocus className="shrink-0 space-y-2 px-4 pt-3 focus:outline-hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <StatusText tone={view.tone} className="font-medium">{view.label}</StatusText>
            {d.lastSeen && (
              <span className="text-xs text-subtle">
                last seen <Timestamp value={d.lastSeen} />
              </span>
            )}
            <Badge>{conventionLabel(d.convention)}</Badge>
            <span className="text-xs text-muted">via broker {d.brokerName}</span>
          </div>
          {d.availabilityReason && d.availability !== 'online' && <p className="text-xs text-muted">{d.availabilityReason}</p>}
          <p className="text-xs text-subtle">Read from the bridge or gateway. Manifold does not pair, configure or control this device.</p>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {error && (
            <Banner variant={data ? 'warn' : 'error'} title={data ? 'Live values are not updating' : 'Could not load the device'} onRetry={reload}>
              {error.message}
            </Banner>
          )}
          <section aria-label="Summary">
            <H>Summary</H>
            <KeyValue
              columns={2}
              items={[
                ['Manufacturer', d.manufacturer || '—'],
                ['Model', d.model || '—'],
                d.description && ['Description', d.description],
                ['Convention', d.conventionLabel || conventionLabel(d.convention)],
                ['Device id', <span key="id" className="mono break-all text-xs">{d.id}</span>],
                ...details.map(([k, v]) => [k, <span key={k} className="mono break-all text-xs">{String(v)}</span>])
              ].filter(Boolean)}
            />
          </section>
          <section aria-label="Tags">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-sm font-medium text-fg">Tags {data ? <span className="text-muted">({data.tags.length})</span> : null}</h3>
              <Toggle checked={showDiag} onChange={setShowDiag} label="Diagnostics" />
              <div className="relative w-full sm:w-56">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tags" placeholder="Filter tags" className="pl-8" />
              </div>
            </div>
            {loading && !data && <LoadingState label="tags" rows={4} />}
            {data && data.tags.length === 0 && <EmptyState title="No tags yet" hint="Tags appear when the device publishes its first values or its description." />}
            {data && data.tags.length > 0 && (
              <Table caption={`Tags of ${d.name}`}>
                <THead>
                  <Th>Tag</Th>
                  <Th align="right">Value</Th>
                  <Th>Quality</Th>
                  <Th className="hidden md:table-cell">Type</Th>
                  <Th className="hidden lg:table-cell">Range or values</Th>
                  <Th className="hidden lg:table-cell">Source</Th>
                </THead>
                <tbody>
                  {tags.map((t) => {
                    const q = qualityView(t.quality);
                    return (
                      <Tr key={t.key} data-tag={t.key}>
                        <Td header className="max-w-[12rem]">
                          <span className="block truncate text-sm text-fg" title={t.description || t.name}>{t.name}</span>
                          <span className="mono block truncate text-xs text-subtle" title={t.key}>{t.key}</span>
                          {t.diagnostic && <span className="text-xs text-subtle">diagnostic</span>}
                        </Td>
                        <Td align="right" className="tabular-nums">
                          <span className="mono text-sm" data-testid="iot-value">{formatIotValue(t.value)}</span>
                          {t.unit && <span className="ml-1 text-xs text-muted">{t.unit}</span>}
                        </Td>
                        <Td>
                          <StatusText tone={q.tone} className="text-xs">{q.label}</StatusText>
                          {t.qualityReason && t.quality !== 192 && <span className="block max-w-[12rem] truncate text-xs text-subtle" title={t.qualityReason}>{t.qualityReason}</span>}
                          {t.unsupported && <span className="block text-xs text-warn">template not supported</span>}
                        </Td>
                        <Td className="hidden text-xs text-muted md:table-cell">{t.type}</Td>
                        <Td className="hidden max-w-[10rem] truncate text-xs text-muted lg:table-cell">{tagLimits(t) || '—'}</Td>
                        <Td className="hidden max-w-[14rem] lg:table-cell">
                          <span className="mono block truncate text-xs text-muted" title={t.topic}>{t.topic}</span>
                          <span className="mono block truncate text-xs text-subtle" title={t.selector}>{t.selector}</span>
                          {t.sourceTime && <span className="block text-xs text-subtle">source time <Timestamp value={t.sourceTime} /></span>}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </section>
        </div>
      </div>
    </Drawer>
  );
}
