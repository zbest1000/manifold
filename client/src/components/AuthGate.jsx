import { useEffect, useRef, useState } from 'react';
import { getAuthToken, setAuthToken, api } from '@/lib/api';
import { reconnectSocket } from '@/lib/socket';
import { useStore } from '@/store/store';
import { Button, Field, Input, Spinner } from '@/components/ui';

// Only a 401 means "locked": any other status (or a network error) is NOT a
// rejected token, so we open rather than hang on "Connecting…" forever or lock
// out a user because the status endpoint blipped.
const probe = async (candidate) => {
  try {
    const res = await fetch('/api/system/status', {
      headers: candidate ? { Authorization: `Bearer ${candidate}` } : {}
    });
    return res.status !== 401;
  } catch {
    return true; // network/transport error — don't trap the user on the gate
  }
};

// Discover the caller's role so the UI can show a read-only badge for viewers.
const loadRole = async (setAuthRole) => {
  try {
    const who = await api.whoami();
    setAuthRole(who?.role ?? null);
  } catch {
    setAuthRole(null);
  }
};

/** The Manifold mark, as in the sidebar: three lines converging into one. */
function Mark() {
  return (
    <svg viewBox="0 0 20 20" width="24" height="24" aria-hidden="true" className="shrink-0">
      <rect x="0.5" y="0.5" width="19" height="19" rx="4.5" className="fill-fg" />
      <path d="M5 5.5h3.2L12 10M5 10h7M5 14.5h3.2L12 10M12 10h3" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="stroke-app" />
    </svg>
  );
}

/**
 * Boot-time auth gate. Probes an authenticated endpoint once: if the server was
 * started with MANIFOLD_AUTH_TOKEN and we don't hold a valid token, everything would
 * 401 — so show a single unlock screen instead of a broken app. Servers running
 * without auth pass straight through.
 */
export default function AuthGate({ children }) {
  const [state, setState] = useState('checking'); // checking | locked | open
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const tokenRef = useRef(null);
  useEffect(() => {
    if (state === 'locked') tokenRef.current?.focus();
  }, [state]);

  const setAuthRole = useStore((s) => s.setAuthRole);

  useEffect(() => {
    probe(getAuthToken()).then((ok) => {
      if (ok) loadRole(setAuthRole);
      setState(ok ? 'open' : 'locked');
    });
  }, [setAuthRole]);

  const unlock = async (e) => {
    e.preventDefault();
    setError(null);
    setChecking(true);
    const ok = await probe(token.trim());
    if (ok) {
      setAuthToken(token.trim());
      reconnectSocket();
      await loadRole(setAuthRole);
      setState('open');
    } else {
      setError('That token was rejected by the server. Check it and try again.');
      setChecking(false);
      tokenRef.current?.focus();
    }
  };

  if (state === 'open') return children;
  if (state === 'checking') {
    return (
      <div role="status" className="grid h-screen place-items-center bg-app">
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Connecting…
        </span>
      </div>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-app px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <Mark />
          <span className="text-base font-semibold tracking-tight text-fg">Manifold</span>
        </div>
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold text-fg">Manifold is locked</h1>
          <p className="mt-1 text-sm text-muted">
            This server asks for an access token. It controls live brokers and equipment, so it is not open by default.
          </p>
          <form onSubmit={unlock} className="mt-5 space-y-4" noValidate>
            <Field
              label="Access token"
              help={
                <>
                  Set with <span className="mono">MANIFOLD_AUTH_TOKEN</span> on the server. A viewer token opens the console read-only.
                </>
              }
              error={error}
            >
              <Input
                ref={tokenRef}
                type="password"
                autoComplete="current-password"
                aria-invalid={error ? 'true' : undefined}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  if (error) setError(null);
                }}
              />
            </Field>
            <Button type="submit" size="lg" loading={checking} disabled={!token.trim()} className="w-full">
              Unlock
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
