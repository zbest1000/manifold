import { useId, useMemo, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal, Button, IconButton, Input } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { FormField, Section, selectCls, DescriptorFields } from './FormControls';
import PollGroupsEditor from './PollGroupsEditor';
import ParamsEditor from './ParamsEditor';
import ProfileSaveErrors from './ProfileSaveErrors';
import TagTable, { newTagId } from './TagTable';
import { useProfileValidation } from './profileHooks';
import { blankProfile, toProfilePayload, placeholderRowErrors, splitProfileErrors } from './profileModel';
import { createProfile, updateProfile } from './devicesApi';
import { localTagErrors } from '@/lib/deviceTags';
import { undeclaredPlaceholders, unusedParams } from '@/lib/deviceProfiles';

const withIds = (p) => ({ ...p, params: p.params || [], pollGroups: p.pollGroups?.length ? p.pollGroups : [{ id: 'default', intervalMs: 1000 }], tags: (p.tags || []).map((t) => ({ ...t, _id: t._id || newTagId() })) });

/** Create / edit a device profile: tags may use {param} placeholders in key, address and UNS property. */
export default function ProfileForm({ profile, protocols, onClose, onSaved }) {
  const editing = Boolean(profile?.id);
  const titleId = useId();
  const [draft, setDraft] = useState(() => withIds(profile || blankProfile(protocols[0])));
  const [saving, setSaving] = useState(false);
  const readOnly = useReadOnly();
  const [saveError, setSaveError] = useState(null);
  const descriptor = protocols.find((p) => p.id === draft.protocol) || protocols[0];
  const initial = useRef(null);
  const payload = () => toProfilePayload(draft, descriptor);
  if (initial.current === null) initial.current = JSON.stringify(payload());

  const set = (name, v) => setDraft((d) => ({ ...d, [name]: v }));
  const setTags = (upd) => setDraft((d) => ({ ...d, tags: typeof upd === 'function' ? upd(d.tags) : upd }));
  const undeclared = useMemo(() => undeclaredPlaceholders(draft.tags, draft.params), [draft.tags, draft.params]);
  const unused = useMemo(() => unusedParams(draft.tags, draft.params), [draft.tags, draft.params]);
  const validation = useProfileValidation(draft.protocol, draft.options, draft.tags, draft.params);
  const serverTagErrs = useMemo(() => Object.fromEntries(splitProfileErrors(saveError?.details).tags.map((d) => [d.key, d.error])), [saveError]);
  const localErrors = useMemo(() => {
    const errs = { ...localTagErrors(draft.tags) };
    const ph = placeholderRowErrors(draft.tags, draft.params);
    draft.tags.forEach((t, i) => {
      const e = errs[i] || ph[i] || serverTagErrs[t.key];
      if (e) errs[i] = e;
    });
    return errs;
  }, [draft.tags, draft.params, serverTagErrs]);
  const usedGroups = useMemo(() => new Set(draft.tags.map((t) => t.pollGroup).filter(Boolean)), [draft.tags]);
  const instances = profile?.instances || [];

  const requestClose = () => {
    if (JSON.stringify(payload()) === initial.current || window.confirm('Discard your unsaved changes to this profile?')) onClose();
  };

  const changeProtocol = (id) => {
    const d = protocols.find((p) => p.id === id);
    if (d) setDraft((cur) => ({ ...blankProfile(d), name: cur.name, description: cur.description, params: cur.params }));
  };

  const save = async (e) => {
    e.preventDefault();
    if (readOnly || saving) return;
    if (!draft.name.trim()) return setSaveError({ message: 'Give the profile a name.' });
    const bad = Object.keys(localErrors).length;
    if (bad) return setSaveError({ message: `${bad} tag row${bad === 1 ? ' has' : 's have'} problems. Fix the highlighted rows.` });
    setSaving(true);
    setSaveError(null);
    try {
      const saved = editing ? await updateProfile(profile.id, payload()) : await createProfile(payload());
      toast.success(`Profile "${saved.name}" ${editing ? 'updated' : 'created'}${editing && instances.length ? ` and applied to ${instances.length} device${instances.length === 1 ? '' : 's'}` : ''}`);
      onSaved(saved);
    } catch (err) {
      setSaveError({ message: err.message || 'Save failed', details: err.details });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? `Edit profile ${profile.name}` : 'New device profile'} labelledBy={titleId} onClose={requestClose} className="max-w-6xl p-0">
      <form onSubmit={save} noValidate>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          <h3 id={titleId} className="text-base font-semibold text-slate-100">{editing ? `Edit profile ${profile.name}` : profile ? 'New profile from device' : 'New device profile'}</h3>
          <IconButton icon={X} side="left" label="Close" onClick={requestClose} />
        </div>
        <div className="space-y-5 px-5 py-4 sm:px-6">
          {editing && instances.length > 0 && (
            <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
              {instances.length} device{instances.length === 1 ? ' uses' : 's use'} this profile ({instances.map((i) => i.name).join(', ')}). Saving applies the change to all of them at once; if any would become invalid the server refuses the edit and nothing changes.
            </p>
          )}
          <section aria-label="Profile" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Name">{(a) => <Input {...a} data-autofocus value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Energy meter" />}</FormField>
            <FormField label="Protocol" help={editing ? 'Fixed once created' : undefined}>
              {(a) => (
                <select {...a} className={selectCls} value={draft.protocol} disabled={editing} onChange={(e) => changeProtocol(e.target.value)}>
                  {protocols.map((p) => <option key={p.id} value={p.id}>{p.label}{p.experimental ? ' (experimental)' : ''}</option>)}
                </select>
              )}
            </FormField>
            <FormField label="Description (optional)" className="sm:col-span-2">{(a) => <Input {...a} value={draft.description || ''} onChange={(e) => set('description', e.target.value)} />}</FormField>
          </section>

          <Section title="Parameters" hint="Use {name} in a tag's key, address or UNS property. Each device that uses the profile gives the value; a default makes it optional.">
            <ParamsEditor params={draft.params} onChange={(p) => set('params', p)} undeclared={undeclared} />
            {unused.length > 0 && <p className="text-2xs text-slate-500">Declared but not used by any tag: {unused.map((n) => `{${n}}`).join(', ')}</p>}
          </Section>

          <Section title="Protocol options" hint="Defaults for every device on this profile; a device can override them.">
            <DescriptorFields fields={descriptor.optionFields} values={draft.options} onChange={(n, v) => set('options', { ...draft.options, [n]: v })} />
          </Section>

          <Section title="Poll groups" hint="Devices inherit these; a device may override a group's interval by id.">
            <PollGroupsEditor groups={draft.pollGroups} onChange={(g) => set('pollGroups', g)} usedIds={usedGroups} />
          </Section>

          <Section title="Tags" hint="Addresses are checked with each parameter's default. Tags using a parameter without a default are checked per device when it is created.">
            {validation.skipped.length > 0 && <p role="status" className="text-2xs text-amber-300/90">Not checked yet (parameter has no default): {validation.skipped.join(', ')}</p>}
            <TagTable
              tags={draft.tags}
              setTags={setTags}
              descriptor={descriptor}
              pollGroups={draft.pollGroups}
              validation={validation}
              localErrors={localErrors}
              values={{}}
              showLive={false}
              selectedId={null}
              onSelect={() => {}}
              deviceName={draft.name}
            />
          </Section>
        </div>
        <div className="sticky bottom-0 z-10 space-y-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          <ProfileSaveErrors error={saveError} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={requestClose}>Cancel</Button>
            <Button type="submit" disabled={saving || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>{saving && <Loader2 size={14} className="animate-spin" />} {editing ? 'Save profile' : 'Create profile'}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
