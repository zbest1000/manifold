import { Banner } from '@/components/ui';
import { useReadOnly } from '@/store/selectors';

/**
 * Shown at the top of a page for a viewer (read-only) session, so disabled controls are explained
 * where the user is looking. Renders nothing for admin sessions and when auth is off.
 */
export default function ReadOnlyNote({ className = 'mb-4' }) {
  const readOnly = useReadOnly();
  if (!readOnly) return null;
  return (
    <Banner variant="info" title="Read-only session" className={className}>
      You are signed in with a viewer token: you can look at everything here, but buttons that change something are disabled. Sign in with the admin token to make changes.
    </Banner>
  );
}
