import { Link } from 'react-router-dom';
import { Banner } from '@/components/ui';
import ParamValues from './ParamValues';

/**
 * The profile part of a device that uses a profile: a link to the profile, its parameter values and any
 * `profileErrors` from the server. The profile's tags are listed read-only in the tag table below.
 */
export default function ProfileInstanceSection({ profile, profileId, params, onParam, profileErrors, preview, showErrors }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Profile:{' '}
        {profile ? (
          <Link className="font-medium text-accent-text underline-offset-2 hover:underline" to={`/devices?tab=profiles&profile=${encodeURIComponent(profile.id)}`}>
            {profile.name}
          </Link>
        ) : (
          <span className="mono text-bad">{profileId}</span>
        )}
        {!profile && <span className="ml-2 text-xs text-bad">This profile no longer exists.</span>}
        <span className="ml-2 text-xs text-subtle">Its tags are read-only here. Edit the profile to change them for every device that uses it.</span>
      </p>
      {profileErrors?.length > 0 && (
        <Banner variant="error" title="The profile and this device do not fit together, so the device is not polling">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {profileErrors.map((e, i) => (
              <li key={i}>
                {e.key ? <span className="mono">{e.key}: </span> : null}
                {e.error}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {profile && <ParamValues params={profile.params} values={params} onChange={onParam} showErrors={showErrors} />}
      {preview.errors.length > 0 && (
        <Banner variant="warn" title="The tags cannot be built yet">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {preview.errors.map((e, i) => (
              <li key={i}>
                {e.key ? <span className="mono">{e.key}: </span> : null}
                {e.error}
              </li>
            ))}
          </ul>
        </Banner>
      )}
    </div>
  );
}
