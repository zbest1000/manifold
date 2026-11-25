import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, CopyPlus, FilePlus2, Rows3 } from 'lucide-react';
import { Button, Banner, Card, EmptyState, IconButton, Table, THead, Th, Tr, Td, Code } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ProfileForm from './ProfileForm';
import InstantiateDialog from './InstantiateDialog';
import BulkInstantiateDialog from './BulkInstantiateDialog';
import DeleteProfileDialog from './DeleteProfileDialog';
import FromDeviceDialog from './FromDeviceDialog';
import { profileFromDevice } from './profileModel';

function ProfileActions({ p, open }) {
  const ro = useReadOnly();
  const why = ro ? { disabled: true, title: READ_ONLY_REASON } : {};
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button size="sm" variant="secondary" onClick={() => open('instance', p)} aria-label={`New device from ${p.name}`} {...why}>
        <FilePlus2 size={13} aria-hidden="true" /> New device
      </Button>
      <IconButton icon={Rows3} size={14} label={`Create several devices from ${p.name}`} onClick={() => open('bulk', p)} {...why} />
      <IconButton icon={Pencil} size={14} label={`${ro ? 'View' : 'Edit'} profile ${p.name}`} onClick={() => open('edit', p)} />
      <IconButton icon={Trash2} size={14} className="hover:bg-bad/10 hover:text-bad" label={`Delete profile ${p.name}`} onClick={() => open('delete', p)} {...why} />
    </span>
  );
}

/** The Profiles tab: list, create / edit, create from a device, new device from profile, bulk create, delete. */
export default function ProfilesTab({ profiles, error, loading, onRetry, protocols, devices, labels, focusId, onChanged }) {
  const [dialog, setDialog] = useState(null); // { kind: 'edit'|'new'|'pick'|'instance'|'bulk'|'delete', profile? }
  const close = () => setDialog(null);
  const readOnly = useReadOnly();
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="max-w-2xl text-sm text-muted">
          A profile describes one kind of device once: its tags (with <Code>{'{param}'}</Code> placeholders), poll groups and options. Create as many devices from it as you need; editing the profile updates all of them.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => open('pick')} disabled={!canAdd || devices.length === 0 || readOnly} title={readOnly ? READ_ONLY_REASON : devices.length === 0 ? 'Add a device first' : undefined}>
            <CopyPlus size={14} aria-hidden="true" /> Create from device
          </Button>
          <Button onClick={() => open('new')} disabled={!canAdd || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
            <Plus size={14} aria-hidden="true" /> New profile
          </Button>
        </div>
      </div>

      {error && (
        <Banner variant="error" title="Could not load profiles" onRetry={onRetry}>
          {error}
        </Banner>
      )}
      {loading && !profiles && !error && <p className="py-10 text-center text-sm text-muted">Loading profiles…</p>}

      {profiles && profiles.length === 0 && (
        <Card>
          <EmptyState
            title="No device profiles yet"
            hint="Define a meter, drive or PLC type once with parameters for the parts that differ (a base register, a DB number), then create devices from it."
            action={
              <Button onClick={() => open('new')} disabled={!canAdd || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                <Plus size={14} aria-hidden="true" /> New profile
              </Button>
            }
          />
        </Card>
      )}

      {profiles && profiles.length > 0 && (
        <Table caption="Device profiles" className="min-w-[48rem]">
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
                  <span className="font-medium text-fg">{p.name}</span>
                  {p.description && (
                    <span className="mt-0.5 block max-w-xs truncate text-xs text-subtle" title={p.description}>
                      {p.description}
                    </span>
                  )}
                  <div className="mt-2 md:hidden">
                    <ProfileActions p={p} open={open} />
                  </div>
                </Td>
                <Td className="text-sm text-muted">{labels[p.protocol] || p.protocol}</Td>
                <Td align="right" className="tabular-nums">{(p.tags?.length || 0).toLocaleString()}</Td>
                <Td>
                  {p.params?.length ? (
                    <span className="flex flex-wrap gap-1">
                      {p.params.map((x) => (
                        <span key={x.name} title={[x.description, x.default !== undefined ? `default ${x.default}` : 'no default'].filter(Boolean).join(' · ')}>
                          <Code>
                            {x.name}
                            {x.default !== undefined ? `=${x.default}` : ''}
                          </Code>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">none</span>
                  )}
                </Td>
                <Td className="text-sm">
                  {p.instances?.length ? (
                    <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {p.instances.map((i) => (
                        <li key={i.id}>
                          <Link className="text-accent-text underline-offset-2 hover:underline" to={`/devices?device=${encodeURIComponent(i.id)}`}>
                            {i.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-xs text-faint">unused</span>
                  )}
                </Td>
                <Td align="right" className="hidden whitespace-nowrap md:table-cell">
                  <ProfileActions p={p} open={open} />
                </Td>
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
