import { LogOut } from 'lucide-react';
import { Button, KeyValue, StatusText } from '@/components/ui';
import { useStore } from '@/store/store';
import { getAuthToken, setAuthToken } from '@/lib/api';
import Section from './Section';

/**
 * Who this browser is signed in as, and a way out. Without this a viewer who needs the admin token (or
 * anyone whose token was rotated) had to clear localStorage by hand, because the unlock screen only
 * appears when the server answers 401.
 */
export default function Session() {
  const role = useStore((s) => s.authRole);
  const hasToken = Boolean(getAuthToken());
  const label = role === 'viewer' ? 'Viewer (read-only)' : role === 'admin' ? 'Administrator' : 'Open access (no token required)';
  const signOut = () => {
    setAuthToken('');
    window.location.reload();
  };
  return (
    <Section title="Session" description="Servers started with an access token ask for it when you open the console. A viewer token can look at everything but cannot change anything.">
      <KeyValue
        items={[
          ['Signed in as', <StatusText key="role" tone={role === 'viewer' ? 'warn' : 'good'}>{label}</StatusText>],
          ['Access token', hasToken ? 'Stored in this browser' : 'Not required by this server']
        ]}
      />
      {role === 'viewer' && <p className="text-xs text-subtle">Changes are disabled. To make changes, sign out and enter the admin token.</p>}
      {hasToken ? (
        <Button variant="secondary" onClick={signOut}>
          <LogOut size={14} aria-hidden="true" /> Sign out / use a different token
        </Button>
      ) : (
        <p className="text-xs text-subtle">This server is not asking for a token, so there is nothing to sign out of.</p>
      )}
    </Section>
  );
}
