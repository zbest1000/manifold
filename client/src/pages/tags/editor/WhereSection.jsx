import { useMemo, useState } from 'react';
import { FolderTree, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Field, Input, Select, SegmentedControl, Button, Banner, Table, THead, Th, Tr, Td } from '@/components/ui';
import { EditorSection, TokenChip, ErrorText } from './parts';
import AssetPicker from '../AssetPicker';
import { instanceRows } from '../profileModel';
import { normalizeAssetPath } from '../assetPath';

const LAYOUTS = [
  { value: 'topic-per-tag', label: 'Topic per tag' },
  { value: 'object-per-asset', label: 'Object per asset' }
];
const LAYOUT_HELP = {
  'topic-per-tag': 'Each tag has its own topic, so a subscriber can follow one value. One message per change.',
  'object-per-asset': 'One JSON object on the asset path with every tag and its quality: a consistent snapshot, resent when any tag changes, capped in size.'
};

/** Name, broker and output protocol. */
export function SetupSection({ state, setState, set, brokers, errors, readOnly }) {
  const brokerErr = errors.find((e) => e.field === 'broker' || (e.section === 'setup' && !e.field))?.message;
  return (
    <EditorSection id="map-setup" title="Mapping">
      <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3" disabled={readOnly}>
        <legend className="sr-only">Name, broker and output</legend>
        <Field label="Name">
          <Input value={state.name} onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))} placeholder="Line 4 filler" />
        </Field>
        <Select label="Target broker" value={set.form.brokerId} onChange={(e) => set.patch({ brokerId: e.target.value })} error={brokerErr} aria-invalid={Boolean(brokerErr) || undefined}>
          {brokers.length === 0 && <option value="">No connected broker</option>}
          {brokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs font-medium text-muted">Publish as</p>
          <SegmentedControl
            label="Publish as"
            value={state.mode}
            onChange={(m) => !readOnly && setState((s) => ({ ...s, mode: m, form: m === 'sparkplug' ? { ...s.form, layout: 'topic-per-tag' } : s.form }))}
            options={[
              { value: 'mqtt', label: 'UNS topics' },
              { value: 'sparkplug', label: 'Sparkplug B device' }
            ]}
          />
        </div>
      </fieldset>
    </EditorSection>
  );
}

/** The asset path with a picker over the existing namespace, and the legacy template under a disclosure. */
function AssetPathField({ form, patch, error, readOnly }) {
  const [picking, setPicking] = useState(false);
  const [advanced, setAdvanced] = useState(form.destKind === 'template');
  const asset = form.destKind === 'asset';
  const p = normalizeAssetPath(form.assetPath);
  return (
    <div className="space-y-3">
      <div className="max-w-2xl">
        <label htmlFor="asset-path" className="mb-1.5 block text-xs font-medium text-muted">
          Asset path{asset ? '' : ' (not used: the path template is on)'}
        </label>
        <div className="flex gap-2">
          <Input
            id="asset-path"
            value={form.assetPath}
            onChange={(e) => patch({ assetPath: e.target.value, destKind: 'asset' })}
            placeholder="acme/dallas/packaging/line4/filler"
            className="mono min-w-0 flex-1"
            aria-invalid={(asset && Boolean(error)) || undefined}
            aria-describedby="asset-path-help"
            disabled={readOnly}
          />
          <Button variant="secondary" onClick={() => setPicking(true)} disabled={!form.brokerId || readOnly} title={form.brokerId ? undefined : 'Choose a broker first'}>
            <FolderTree size={14} aria-hidden="true" /> Browse
          </Button>
        </div>
        {asset && error ? (
          <ErrorText>{error}</ErrorText>
        ) : (
          <p id="asset-path-help" className="helper mt-1.5">
            ISA-95 path of the asset (enterprise/site/area/line/cell). Each tag publishes to <span className="mono">{p || '<asset path>'}/&lt;name&gt;</span>.
          </p>
        )}
      </div>
      <div>
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          aria-controls="legacy-template"
          className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-muted transition-colors hover:text-fg"
        >
          <ChevronRight size={14} aria-hidden="true" className={clsx('text-subtle transition-transform duration-150', advanced && 'rotate-90')} />
          Legacy path template
        </button>
        {advanced && (
          <div id="legacy-template" className="mt-2 max-w-2xl space-y-2 border-l-2 border-line pl-4">
            <label className="flex items-start gap-2 text-sm text-fg">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={!asset} disabled={readOnly} onChange={(e) => patch({ destKind: e.target.checked ? 'template' : 'asset' })} />
              <span>
                Use a path template instead of an asset path
                <span className="helper block">{'{name}'} is the tag name (spaces and / + # become _). Without it the name is appended.</span>
              </span>
            </label>
            <Input value={form.pathTemplate} onChange={(e) => patch({ pathTemplate: e.target.value })} disabled={asset || readOnly} aria-label="Path template" placeholder="site/area/line/{name}" className="mono" aria-invalid={(!asset && Boolean(error)) || undefined} />
            {!asset && <ErrorText>{error}</ErrorText>}
          </div>
        )}
      </div>
      {picking && (
        <AssetPicker
          brokerId={form.brokerId}
          value={form.assetPath}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            patch({ assetPath: path, destKind: 'asset' });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** Profile mappings: an asset path template, its per-instance result and optional per-instance paths. */
function ProfileDestination({ profile, devices, devicesError, onRetryDevices, form, patch, error, readOnly }) {
  const params = (profile?.params || []).map((p) => p.name);
  const chips = ['{device}', '{deviceId}', ...params.map((n) => `{${n}}`)];
  const rows = useMemo(() => instanceRows({ profile, devices, template: form.assetPathTemplate, overrides: form.assetPaths }), [profile, devices, form.assetPathTemplate, form.assetPaths]);
  return (
    <div className="space-y-3">
      <div className="max-w-2xl">
        <Field label="Asset path template">
          <Input id="asset-path-template" value={form.assetPathTemplate} onChange={(e) => patch({ assetPathTemplate: e.target.value })} placeholder="acme/dallas/{line}/{device}" className="mono" aria-invalid={Boolean(error) || undefined} disabled={readOnly} />
        </Field>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="helper mr-1">Insert</span>
          {chips.map((c) => (
            <TokenChip key={c} token={c} label={`Append ${c} to the template`} onInsert={(t) => !readOnly && patch({ assetPathTemplate: `${form.assetPathTemplate.replace(/\/+$/, '')}${form.assetPathTemplate ? '/' : ''}${t}` })} />
          ))}
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
      {devicesError && (
        <Banner variant="error" title="Could not load the profile's instances" onRetry={onRetryDevices}>
          {devicesError}
        </Banner>
      )}
      {devices && rows.length === 0 && <p className="text-sm text-muted">This profile has no instances yet. The mapping starts publishing for each one you add on the Devices page.</p>}
      {rows.length > 0 && (
        <Table caption="Asset path per instance" className="min-w-[36rem]">
          <THead>
            <Th>Instance</Th>
            <Th>Asset path</Th>
            <Th>Own path (optional)</Th>
          </THead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.deviceId}>
                <Td header className="whitespace-nowrap font-medium">
                  {r.name}
                </Td>
                <Td className="max-w-[20rem]">
                  <span className={clsx('block truncate font-mono text-xs', r.error ? 'text-bad' : 'text-fg')} title={r.path}>
                    {r.path || '—'}
                  </span>
                  {r.error && <span className="block text-xs text-bad">{r.error}</span>}
                </Td>
                <Td>
                  <Input value={form.assetPaths[r.deviceId] || ''} onChange={(e) => patch({ assetPaths: { ...form.assetPaths, [r.deviceId]: e.target.value } })} aria-label={`Own asset path for ${r.name}`} placeholder="use the template" className="mono h-7 py-0 text-xs" disabled={readOnly} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** Where: asset path / template / Sparkplug target, and the layout. */
export default function WhereSection({ state, set, errors, profile, devices, readOnly }) {
  const f = set.form;
  const destErr = errors.find((e) => e.section === 'where' && (e.field === 'dest' || e.field === 'base'))?.message;
  const spErr = (k) => errors.find((e) => e.section === 'where' && e.field === k)?.message;
  const isProfile = state.srcType === 'device-profile';
  return (
    <EditorSection id="map-where" title="Where">
      {state.mode === 'sparkplug' ? (
        <div className="space-y-2">
          <fieldset className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3" disabled={readOnly}>
            <legend className="sr-only">Sparkplug target</legend>
            <Field label="Group" error={spErr('group')}>
              <Input className="mono" value={f.group} onChange={(e) => set.patch({ group: e.target.value })} aria-invalid={Boolean(spErr('group')) || undefined} />
            </Field>
            <Field label="Edge node" error={spErr('edge')}>
              <Input className="mono" value={f.edge} onChange={(e) => set.patch({ edge: e.target.value })} aria-invalid={Boolean(spErr('edge')) || undefined} />
            </Field>
            <Field label="Device" error={spErr('device')}>
              <Input className="mono" value={f.device} onChange={(e) => set.patch({ device: e.target.value })} aria-invalid={Boolean(spErr('device')) || undefined} />
            </Field>
          </fieldset>
          <p className="helper">
            Publishes to <span className="mono">spBv1.0/{f.group || '?'}/DDATA/{f.edge || '?'}/{f.device || '?'}</span> on a dedicated session with the full BIRTH / DATA / DEATH lifecycle. Metrics keep their types; there is no per-metric quality.
          </p>
        </div>
      ) : isProfile ? (
        <ProfileDestination profile={profile} devices={devices.data} devicesError={devices.status === 'error' ? devices.error : null} onRetryDevices={devices.retry} form={f} patch={set.patch} error={destErr} readOnly={readOnly} />
      ) : (
        <AssetPathField form={f} patch={set.patch} error={destErr} readOnly={readOnly} />
      )}

      {state.mode === 'mqtt' && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <SegmentedControl size="sm" label="Layout" value={f.layout} onChange={(v) => !readOnly && set.patch({ layout: v })} options={LAYOUTS} />
          <p className="helper min-w-0 flex-1 basis-64">{LAYOUT_HELP[f.layout]}</p>
        </div>
      )}
    </EditorSection>
  );
}
