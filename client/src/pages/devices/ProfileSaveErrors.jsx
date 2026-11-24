import { Link } from 'react-router-dom';
import { Banner } from '@/components/ui';
import { splitProfileErrors } from './profileModel';

/**
 * The server's refusal of a profile save. A per-instance failure (400 with
 * details [{ deviceId, name, error, details }]) lists every device that would
 * break; nothing was saved. Per-tag details are listed as key: error.
 */
export default function ProfileSaveErrors({ error }) {
  if (!error) return null;
  const { instances, tags } = splitProfileErrors(error.details);
  return (
    <Banner variant="error" title={error.message}>
      {instances.length > 0 && (
        <>
          <p className="mt-1">The profile was not changed. Fix these devices or adjust your edit:</p>
          <ul className="mt-1 space-y-1.5">
            {instances.map((i) => (
              <li key={i.deviceId} className="rounded-md border border-line px-2 py-1">
                <Link to={`/devices?device=${encodeURIComponent(i.deviceId)}`} className="font-medium text-accent-text underline underline-offset-2">
                  {i.name || i.deviceId}
                </Link>
                : {i.error}
                {Array.isArray(i.details) && i.details.length > 0 && (
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                    {i.details.map((d, n) => (
                      <li key={n}>
                        {d.key ? <span className="mono">{d.key}: </span> : null}
                        {d.error}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {tags.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {tags.map((d, n) => (
            <li key={n}>
              {d.key ? <span className="mono">{d.key}: </span> : null}
              {d.error}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  );
}
