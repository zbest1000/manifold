import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, CopyPlus, Layers, FilePlus2, RefreshCw, Rows3 } from 'lucide-react';
import { Button, EmptyState, IconButton, Table, THead, Th, Tr, Td } from '@/components/ui';
import ProfileForm from './ProfileForm';
import InstantiateDialog from './InstantiateDialog';
import BulkInstantiateDialog from './BulkInstantiateDialog';
import DeleteProfileDialog from './DeleteProfileDialog';
import FromDeviceDialog from './FromDeviceDialog';
import { profileFromDevice } from './profileModel';

function ProfileActions({ p, open }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="subtle" onClick={() => open('instance', p)} aria-label={`New device from ${p.name}`}><FilePlus2 size={13} aria-hidden="true" /> New device</Button>
      <IconButton icon={Rows3} label={`Create several devices from ${p.name}`} onClick={() => open('bulk', p)} />
      <IconButton icon={Pencil} label={`Edit profile ${p.name}`} onClick={() => open('edit', p)} />
      <IconButton icon={Trash2} label={`Delete profile ${p.name}`} onClick={() => open('delete', p)} />
    </span>
  );
}

/** The Profiles tab: list, create / edit, create from a device, new device from profile, bulk create, delete. */
export default function ProfilesTab({ profiles, error, loading, onRetry, protocols, devices, labels, focusId, onChanged }) {
  const [dialog, setDialog] = useState(null); // { kind: 'edit'|'new'|'pick'|'instance'|'bulk'|'delete', profile? }
  const close = () => setDialog(null);
  const canAdd = protocols.length > 0;
  const done = () => {
    close();
    onChanged();
  };
  const open = (kind, profile) => setDialog({ kind, profile });
  const found = Boolean(focusId && profiles?.some((p) => p.id === focusId));
  useEffect(() => {
    if (found) document.getElementById(`profile-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [found, focusId]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-slate-400">A profile describes one kind of device once: its tags (with <span className="mono">{'{param}'}</span> placeholders), poll groups and options. Create as many devices from it as you need; editing the profile updates all of them.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => open('pick')} disabled={!canAdd || devices.length === 0}><CopyPlus size={14} /> Create from device</Button>
          <Button onClick={() => open('new')} disabled={!canAdd}><Plus size={14} /> New profile</Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          <span>Could not load profiles: {error}</span>
          <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw size={12} /> Retry</Button>
        </div>
      )}
      {loading && !profiles && !error && <p className="py-10 text-center text-sm text-slate-500">Loading profiles…</p>}

      {profiles && profiles.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No device profiles yet"
          hint="Define a meter, drive or PLC type once with parameters for the parts that differ (a base register, a DB number), then create devices from it."
          action={<Button onClick={() => open('new')} disabled={!canAdd}><Plus size={14} /> New profile</Button>}
        />
      )}

      {profiles && profiles.length > 0 && (
        <Table caption="Device profiles">
          <THead>
            <Th>Profile</Th>
            <Th>Protocol</Th>
            <Th align="right">Tags</Th>
            <Th>Parameters</Th>
            <Th>Devices</Th>
            <Th srOnly align="right" className="hidden md:table-cell">Actions</Th>
          </THead>
          <tbody>
            {profiles.map((p) => (
              <Tr key={p.id} highlight={p.id === focusId} id={`profile-${p.id}`}>
                <Td header>
                  <span className="font-medium text-slate-100">{p.name}</span>
                  {p.description && <span className="mt-0.5 block max-w-xs truncate text-2xs text-slate-500" title={p.description}>{p.description}</span>}
                  <div className="mt-2 md:hidden"><ProfileActions p={p} open={open} /></div>
                </Td>
                <Td className="text-xs text-slate-300">{labels[p.protocol] || p.protocol}</Td>
                <Td align="right" className="text-xs text-slate-300">{p.tags?.length || 0}</Td>
                <Td className="text-xs">
                  {p.params?.length ? p.params.map((x) => <span key={x.name} className="mono mr-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-slate-300" title={[x.description, x.default !== undefined ? `default ${x.default}` : 'no default'].filter(Boolean).join(' · ')}>{x.name}{x.default !== undefined ? `=${x.default}` : ''}</span>) : <span className="text-slate-600">none</span>}
                </Td>
                <Td className="text-xs">
                  {p.instances?.length ? (
                    <ul className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {p.instances.map((i) => <li key={i.id}><Link className="text-accent-400 underline-offset-2 hover:underline" to={`/devices?device=${encodeURIComponent(i.id)}`}>{i.name}</Link></li>)}
                    </ul>
                  ) : <span className="text-slate-600">unused</span>}
                </Td>
                <Td align="right" className="hidden md:table-cell"><ProfileActions p={p} open={open} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {dialog?.kind === 'pick' && <FromDeviceDialog devices={devices} onClose={close} onPick={(d) => setDialog({ kind: 'new', profile: profileFromDevice(d) })} />}
      {(dialog?.kind === 'new' || dialog?.kind === 'edit') && <ProfileForm profile={dialog.profile || null} protocols={protocols} onClose={close} onSaved={done} />}
      {dialog?.kind === 'instance' && <InstantiateDialog profile={dialog.profile} protocols={protocols} onClose={close} onCreated={done} />}
      {dialog?.kind === 'bulk' && <BulkInstantiateDialog profile={dialog.profile} descriptor={protocols.find((x) => x.id === dialog.profile.protocol)} onClose={close} onDone={onChanged} />}
      {dialog?.kind === 'delete' && <DeleteProfileDialog profile={dialog.profile} onClose={close} onDeleted={done} />}
    </div>
  );
}
