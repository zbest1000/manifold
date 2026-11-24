import { KeyRound, LogOut } from 'lucide-react';
import { Card, Button, Badge } from '@/components/ui';
import { useStore } from '@/store/store';
import { getAuthToken, setAuthToken } from '@/lib/api';

/**
 * Who this browser is signed in as, and a way out. Without this a viewer who needs the admin token (or
 * anyone whose token was rotated) had to clear localStorage by hand, because the unlock screen only
 * appears when the server answers 401.
 */
export default function SessionCard() {
  const role = useStore((s) => s.authRole);
  const hasToken = Boolean(getAuthToken());
  const label = role === 'viewer' ? 'Viewer (read-only)' : role === 'admin' ? 'Administrator' : 'Open access (no token required)';
  const signOut = () => {
    setAuthToken('');
    window.location.reload();
  };
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <KeyRound size={16} className="text-accent-400" aria-hidden="true" /> Session
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-2">
            <span className="text-muted">Signed in as</span> <Badge status={role === 'viewer' ? 'connecting' : 'connected'}>{label}</Badge>
          </p>
          {role === 'viewer' && <p className="helper">Changes are disabled. To make changes, sign out and enter the admin token.</p>}
          {!hasToken && <p className="helper">This server is not asking for a token, so there is nothing to sign out of.</p>}
        </div>
        {hasToken && (
          <Button variant="outline" onClick={signOut}>
            <LogOut size={14} aria-hidden="true" /> Sign out / use a different token
          </Button>
        )}
      </div>
    </Card>
  );
}
