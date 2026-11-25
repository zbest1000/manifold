import { useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Dialog, Button, Input, Select, Banner, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { FormField, FormSection, DescriptorFields } from './FormControls';
import PollGroupsEditor from './PollGroupsEditor';
import ParamsEditor from './ParamsEditor';
import ProfileSaveErrors from './ProfileSaveErrors';
import TagTable, { newTagId } from './TagTable';
import { useProfileValidation } from './profileHooks';
import { blankProfile, toProfilePayload, placeholderRowErrors, splitProfileErrors } from './profileModel';
import { createProfile, updateProfile } from './devicesApi';
import { useConflict } from '@/components/ConflictDialog';
import { localTagErrors } from '@/lib/deviceTags';
import { undeclaredPlaceholders, unusedParams } from '@/lib/deviceProfiles';

const withIds = (p) => ({ ...p, params: p.params || [], pollGroups: p.pollGroups?.length ? p.pollGroups : [{ id: 'default', intervalMs: 1000 }], tags: (p.tags || []).map((t) => ({ ...t, _id: t._id || newTagId() })) });

/** Create / edit a device profile: tags may use {param} placeholders in key, address and UNS property. */
export default function ProfileForm({ profile, protocols, onClose, onSaved }) {
  const editing = Boolean(profile?.id);
  const [draft, setDraft] = useState(() => withIds(profile || blankProfile(protocols[0])));
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const readOnly = useReadOnly();
  const [saveError, setSaveError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const { resolveConflict, conflictDialog } = useConflict();
  const baseRev = useRef(profile?.rev); // the revision this form is based on
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
    const errs = {};
    const all = { ...localTagErrors(draft.tags) };
    const ph = placeholderRowErrors(draft.tags, draft.params);
    draft.tags.forEach((t, i) => {
      // "Key is required" waits for a save attempt; a duplicate key or an undeclared placeholder is a real mistake at once.
      const local = all[i] && (submitted || all[i].startsWith('Duplicate')) ? all[i] : undefined;
      const e = local || ph[i] || serverTagErrs[t.key];
      if (e) errs[i] = e;
    });
    return errs;
  }, [draft.tags, draft.params, serverTagErrs, submitted]);
  const usage = useMemo(() => {
    const u = {};
    for (const t of draft.tags) if (t.pollGroup) u[t.pollGroup] = (u[t.pollGroup] || 0) + 1;
    return u;
  }, [draft.tags]);
  const instances = profile?.instances || [];

  const requestClose = async () => {
    if (JSON.stringify(payload()) === initial.current) return onClose();
    const ok = await confirm({ title: 'Discard your unsaved changes?', message: 'This profile has changes that are not saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true });
    if (ok) onClose();
  };

  const changeProtocol = (id) => {
    const d = protocols.find((p) => p.id === id);
    if (d) setDraft((cur) => ({ ...blankProfile(d), name: cur.name, description: cur.description, params: cur.params }));
  };

  const save = async () => {
    if (readOnly || saving) return;
    setSubmitted(true);
    if (!draft.name.trim()) return setSaveError({ message: 'Give the profile a name.' });
    const bad = Object.keys(localTagErrors(draft.tags)).length || Object.keys(localErrors).length;
    if (bad) return setSaveError({ message: `${bad} tag row${bad === 1 ? ' has' : 's have'} problems. Fix the highlighted rows.` });
    setSaving(true);
    setSaveError(null);
    try {
      let saved;
      try {
        saved = editing ? await updateProfile(profile.id, { ...payload(), rev: baseRev.current }) : await createProfile(payload());
      } catch (err) {
        const choice = editing ? await resolveConflict(err, { what: 'device profile', mine: payload() }) : null;
        if (choice === null) throw err;
        if (choice === 'cancel') return;
        if (choice === 'theirs') {
          baseRev.current = err.current?.rev;
          if (err.current) setDraft(withIds(err.current));
          toast('Showing the saved version');
          return;
        }
        saved = await updateProfile(profile.id, { ...payload(), rev: err.current?.rev });
      }
      toast.success(`Profile "${saved.name}" ${editing ? 'updated' : 'created'}${editing && instances.length ? ` and applied to ${instances.length} device${instances.length === 1 ? '' : 's'}` : ''}`);
      onSaved(saved);
    } catch (err) {
      setSaveError({ message: err.message || 'Save failed', details: err.details });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        title={editing ? `Edit profile ${profile.name}` : 'New device profile'}
        description={editing ? undefined : profile ? 'Started from a device: review the tags, then add {param} placeholders where devices differ.' : 'Describe one kind of device once, then create devices from it.'}
        size="max-w-6xl"
        onClose={requestClose}
        onSubmit={save}
        footer={
          <>
            {saveError && (
              <div className="basis-full">
                <ProfileSaveErrors error={saveError} />
              </div>
            )}
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <span title={readOnly ? READ_ONLY_REASON : undefined}>
              <Button type="submit" loading={saving} disabled={readOnly}>
                {editing ? 'Save profile' : 'Create profile'}
              </Button>
            </span>
          </>
        }
      >
        <div className="space-y-6">
          {editing && instances.length > 0 && (
            <Banner variant="info">
              {instances.length} device{instances.length === 1 ? ' uses' : 's use'} this profile ({instances.map((i) => i.name).join(', ')}). Saving applies the change to all of them at once; if any would become invalid the server refuses the edit and nothing changes.
            </Banner>
          )}
          <section aria-label="Profile" className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <FormField label="Name">{(a) => <Input {...a} data-autofocus value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Energy meter" aria-invalid={submitted && !draft.name.trim() ? true : undefined} />}</FormField>
            <FormField label="Protocol" help={editing ? 'Fixed once created' : undefined}>
              {(a) => (
                <Select {...a} value={draft.protocol} disabled={editing} onChange={(e) => changeProtocol(e.target.value)}>
                  {protocols.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.experimental ? ' (experimental)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Description (optional)" className="sm:col-span-2">
              {(a) => <Input {...a} value={draft.description || ''} onChange={(e) => set('description', e.target.value)} />}
            </FormField>
          </section>

          <FormSection className="border-t border-line pt-5" title="Parameters" hint="Use {name} in a tag's key, address or UNS property. Each device that uses the profile gives the value; a default makes it optional.">
            <ParamsEditor params={draft.params} onChange={(p) => set('params', p)} undeclared={undeclared} />
            {unused.length > 0 && <p className="helper">Declared but not used by any tag: {unused.map((n) => `{${n}}`).join(', ')}</p>}
          </FormSection>

          {descriptor.optionFields?.length > 0 && (
            <FormSection className="border-t border-line pt-5" title="Protocol options" hint="Defaults for every device on this profile; a device can override them.">
              <DescriptorFields fields={descriptor.optionFields} values={draft.options} onChange={(n, v) => set('options', { ...draft.options, [n]: v })} />
            </FormSection>
          )}

          <FormSection className="border-t border-line pt-5" title="Poll groups" hint="Devices inherit these; a device may override a group's interval by id.">
            <PollGroupsEditor groups={draft.pollGroups} onChange={(g) => set('pollGroups', g)} usage={usage} />
          </FormSection>

          <FormSection className="border-t border-line pt-5" title="Tags" hint="Addresses are checked with each parameter's default. Tags using a parameter without a default are checked per device when it is created.">
            {validation.skipped.length > 0 && (
              <p role="status" className="text-xs text-warn">
                Not checked yet (parameter has no default): {validation.skipped.join(', ')}
              </p>
            )}
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
          </FormSection>
        </div>
      </Dialog>
      {conflictDialog}
      {confirmDialog}
    </>
  );
}
