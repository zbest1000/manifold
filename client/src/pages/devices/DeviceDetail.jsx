import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cable, Waypoints, Pencil, Trash2 } from 'lucide-react';
import { Drawer, Tabs, TabPanel, Button, Banner, StatusText, Timestamp, KeyValue, Badge, Toggle } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { deviceStateView, lastErrorInfo, quarantineList, quarantineSummary, quarantineReasonText, formatMs } from '@/lib/deviceStatus';
import { resolveParams } from '@/lib/deviceProfiles';
import PollGroupsHealth, { Counters } from './PollHealth';
import LiveTagsTable from './LiveTagsTable';
import ProbePanel from './ProbePanel';
import { ExperimentalBadge, FromProfileBadge } from './FormControls';
import { useDeviceValues } from './hooks';
import { browseNoun } from './model';

const H = ({ children }) => <h3 className="mb-2 text-sm font-medium text-fg">{children}</h3>;

function Overview({ device, st, view, host, issues, profile, protocolLabel, descriptor, onTab }) {
  const quarantined = quarantineList(st);
  const err = lastErrorInfo(st);
  const tagCount = device.tags?.length ?? st.tagCount ?? 0;
  const params = Object.entries(profile ? resolveParams(profile, device.params).values : device.params || {});
  const limits = device.limits || {};
  const connection = [
    ['Endpoint', <span key="e" className="mono text-xs">{device.scheme ? `${device.scheme}://${device.host}:${device.port}${device.path || ''}` : `${device.host}:${device.port}`}</span>],
    ['Protocol', protocolLabel],
    device.unitId !== undefined && ['Unit id', <span key="u" className="tabular-nums">{device.unitId}</span>],
    device.rack !== undefined && device.slot !== undefined && ['Rack / slot', <span key="r" className="tabular-nums">{device.rack} / {device.slot}</span>],
    device.protocol === 'ethernet-ip' && device.slot !== undefined && ['Slot', <span key="s" className="tabular-nums">{device.slot}</span>],
    ['Tags', <span key="t" className="tabular-nums">{tagCount.toLocaleString()}{device.profileId ? ` (${device.ownTags?.length || 0} own)` : ''}</span>],
    ['Poll groups', (device.pollGroups || []).map((g) => `${g.id} ${formatMs(g.intervalMs)}`).join(', ') || '—'],
    limits.requestDeadlineMs !== undefined && ['Request deadline', <span key="d" className="tabular-nums">{formatMs(limits.requestDeadlineMs)}</span>],
    ['Driver process', device.isolate ? 'Own process (isolated)' : 'Shared with other devices'],
    host && ['Driver host', <span key="h" className="mono text-xs">{host.id || host.protocol} · {host.state}</span>],
    device.profileId && ['Profile', profile ? <Link key="p" className="text-accent-text underline-offset-2 hover:underline" to={`/devices?tab=profiles&profile=${encodeURIComponent(profile.id)}`}>{profile.name}</Link> : <span key="p" className="mono text-xs text-bad">{device.profileId}</span>],
    ...params.map(([k, v]) => [`Parameter ${k}`, <span key={k} className="mono text-xs">{String(v)}</span>])
  ];
  return (
    <div className="space-y-5 p-4">
      {issues.map((i) => (
        <Banner key={i.id} variant={i.level === 'error' ? 'error' : 'warn'}>
          {i.text}
        </Banner>
      ))}
      {device.profileErrors?.length > 0 && (
        <Banner variant="error" title="This device does not match its profile, so it is not polling">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {device.profileErrors.map((e, i) => (
              <li key={i}>
                {e.key ? <span className="mono">{e.key}: </span> : null}
                {e.error}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {quarantined.length > 0 && (
        <Banner
          variant="warn"
          title={quarantineSummary(st)}
          action={
            <Button size="sm" variant="secondary" onClick={() => onTab('tags', 'quarantined')}>
              Show tags
            </Button>
          }
        >
          The device rejected {quarantined.length === 1 ? 'this tag' : 'these tags'}. Manifold keeps polling the others and retries {quarantined.length === 1 ? 'it' : 'them'} every minute.
        </Banner>
      )}

      <section aria-label="Summary">
        <H>Summary</H>
        <KeyValue columns={2} items={connection} />
      </section>

      <section aria-label="Poll groups">
        <H>Poll groups</H>
        <PollGroupsHealth device={device} status={st} online={view.key === 'online'} />
      </section>

      <section aria-label="Counters and exceptions">
        <H>Counters and device exceptions</H>
        <Counters status={st} protocol={device.protocol} />
      </section>

      <section aria-label="Errors">
        <H>Errors</H>
        {err ? (
          <div className="rounded-lg border border-line p-3 text-sm">
            <p className="mono break-words text-xs text-bad">{err.message}</p>
            <p className="mt-1 text-xs text-subtle">
              {err.at ? <Timestamp value={err.at} /> : 'Time unknown'}
              {view.key !== 'online' && view.since ? <> · offline since {new Date(view.since).toLocaleTimeString()}</> : null}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No error since the driver started.</p>
        )}
        {quarantined.length > 0 && (
          <ul aria-label="Quarantined tags" className="mt-2 divide-y divide-line rounded-lg border border-line">
            {quarantined.slice(0, 5).map((q) => (
              <li key={q.key} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                <span className="mono min-w-0 truncate text-xs">{q.key}</span>
                <span className="min-w-0 truncate text-xs text-warn" title={quarantineReasonText(q)}>
                  {quarantineReasonText(q) || 'rejected by the device'}
                  {q.since ? <span className="text-subtle"> · <Timestamp value={q.since} /></span> : null}
                </span>
              </li>
            ))}
            {quarantined.length > 5 && (
              <li className="px-3 py-2 text-xs text-muted">
                and {quarantined.length - 5} more.{' '}
                <button type="button" className="text-accent-text underline-offset-2 hover:underline" onClick={() => onTab('tags', 'quarantined')}>
                  Show them in the tag table
                </button>
              </li>
            )}
          </ul>
        )}
        {descriptor?.experimental && <p className="mt-3 text-xs text-subtle">This driver is experimental: it has only been verified against a simulator.</p>}
      </section>
    </div>
  );
}

/**
 * Device detail drawer: everything about one device without leaving the list. Overview (summary,
 * poll groups, counters, errors), the live tag table, and a probe. Actions live in the footer.
 */
export default function DeviceDetail({ device, live, host, issues, profile, protocolLabel, descriptor, experimental, busy, readOnly, initial, onClose, onEdit, onDelete, onToggle, onMap }) {
  const [tab, setTab] = useState(initial?.tab || 'overview');
  const [chip, setChip] = useState(initial?.chip || 'all');
  const st = useMemo(() => ({ ...(device.status || {}), ...(live || {}) }), [device.status, live]);
  const view = deviceStateView(device, device.status, live, host);
  const { values, error: valuesError, retry } = useDeviceValues(device.id);
  const quarantineReasons = device.status?.quarantineReasons;
  const tags = device.tags || [];
  const why = readOnly ? READ_ONLY_REASON : undefined;
  const canBrowse = Boolean(descriptor?.capabilities?.browse);
  const idp = 'device-detail';
  const goTab = (t, c = 'all') => {
    setTab(t);
    setChip(c);
  };

  return (
    <Drawer
      title={device.name}
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <span title={why} className="mr-auto inline-flex">
            <Toggle checked={device.enabled} disabled={busy || readOnly} onChange={() => onToggle(device)} label="Polling enabled" />
          </span>
          <Button variant="danger-ghost" onClick={() => onDelete(device)} disabled={busy || readOnly} title={why}>
            <Trash2 size={14} aria-hidden="true" /> Delete
          </Button>
          {canBrowse && (
            <Button variant="secondary" onClick={() => onEdit(device, { browse: true })} disabled={readOnly} title={why}>
              <Cable size={14} aria-hidden="true" /> Import from {browseNoun(descriptor)}
            </Button>
          )}
          <Button variant="secondary" onClick={() => onMap(device)}>
            <Waypoints size={14} aria-hidden="true" /> Map to UNS
          </Button>
          <Button variant="secondary" onClick={() => onEdit(device)}>
            <Pencil size={14} aria-hidden="true" /> {readOnly ? 'View device' : 'Edit device'}
          </Button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div tabIndex={-1} data-autofocus className="shrink-0 space-y-2 px-4 pb-0 pt-3 focus:outline-hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <StatusText tone={view.tone} className="font-medium">{view.label}</StatusText>
            {view.since && view.key !== 'disabled' && (
              <span className="text-xs text-subtle">
                since <Timestamp value={view.since} />
              </span>
            )}
            <Badge>{protocolLabel}</Badge>
            {experimental && <ExperimentalBadge />}
            {device.profileId && <FromProfileBadge />}
          </div>
          {view.reason && view.key !== 'online' && view.key !== 'disabled' && <p className="mono break-words text-xs text-muted">{view.reason}</p>}
          {device.description && <p className="text-sm text-muted">{device.description}</p>}
          <Tabs
            idPrefix={idp}
            label="Device sections"
            value={tab}
            onChange={(t) => goTab(t)}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'tags', label: 'Tags', count: tags.length.toLocaleString() },
              { id: 'probe', label: 'Probe' }
            ]}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'overview' && (
            <TabPanel idPrefix={idp} id="overview">
              <Overview device={device} st={st} view={view} host={host} issues={issues} profile={profile} protocolLabel={protocolLabel} descriptor={descriptor} onTab={goTab} />
            </TabPanel>
          )}
          {tab === 'tags' && (
            <TabPanel idPrefix={idp} id="tags" className="flex h-full min-h-0 flex-col">
              {valuesError && (
                <div className="shrink-0 px-4 pt-3">
                  <Banner variant="warn" title="Live values unavailable" onRetry={retry}>
                    {valuesError}
                  </Banner>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <LiveTagsTable key={device.id} tags={tags} values={values} quarantineReasons={quarantineReasons} groups={st.groups} initialChip={chip} />
              </div>
            </TabPanel>
          )}
          {tab === 'probe' && (
            <TabPanel idPrefix={idp} id="probe" className="p-4">
              <p className="mb-3 text-sm text-muted">{device.protocol === 'modbus-tcp' ? 'Read raw registers and compare the four byte and word orders to find the right one.' : 'Read raw bytes from the device and see every way they decode.'}</p>
              <ProbePanel key={device.protocol} deviceId={device.id} protocol={device.protocol} defaultUnitId={device.unitId} selectedTag={null} onApply={null} addressHelp={descriptor?.addressHelp} />
            </TabPanel>
          )}
        </div>
      </div>
    </Drawer>
  );
}
