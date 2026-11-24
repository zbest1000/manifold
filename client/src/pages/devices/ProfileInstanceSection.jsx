import { Link } from 'react-router-dom';
import { Section } from './FormControls';
import ParamValues from './ParamValues';
import EffectiveTagsTable from './EffectiveTagsTable';

/**
 * The profile part of a device that uses a profile: a link to the profile, its
 * parameter values, any `profileErrors` from the server, and the profile's tags
 * (read-only, "from profile") with live values and quarantine reasons.
 */
export default function ProfileInstanceSection({ profile, profileId, params, onParam, profileErrors, preview, errors, values, quarantineReasons }) {
  return (
    <Section title="Device profile" hint="The tags below come from the profile and cannot be edited here. Edit the profile to change them for every device that uses it.">
      <p className="text-sm text-slate-300">
        Profile:{' '}
        {profile ? <Link className="font-medium text-accent-400 underline-offset-2 hover:underline" to={`/devices?tab=profiles&profile=${encodeURIComponent(profile.id)}`}>{profile.name}</Link> : <span className="mono text-rose-300">{profileId}</span>}
        {!profile && <span className="ml-2 text-xs text-rose-300">This profile no longer exists.</span>}
      </p>
      {profileErrors?.length > 0 && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <p className="font-medium">The profile and this device do not fit together, so the device is not polling:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{profileErrors.map((e, i) => <li key={i}>{e.key ? <span className="mono">{e.key}: </span> : null}{e.error}</li>)}</ul>
        </div>
      )}
      {profile && <ParamValues params={profile.params} values={params} onChange={onParam} />}
      {preview.errors.length > 0 && (
        <ul role="alert" className="list-disc space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 py-2 pl-7 pr-3 text-xs text-amber-100">
          {preview.errors.map((e, i) => <li key={i}>{e.key ? <span className="mono">{e.key}: </span> : null}{e.error}</li>)}
        </ul>
      )}
      <EffectiveTagsTable tags={preview.tags} errors={errors} values={values} quarantineReasons={quarantineReasons} caption="Tags from the profile (read-only)" empty={preview.errors.length ? 'Fix the parameter values to see the tags.' : 'The profile has no tags.'} />
    </Section>
  );
}
