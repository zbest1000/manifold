import { useCallback, useEffect, useState } from 'react';
import { Copy, Check, Network } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, KeyValue, Banner, Spinner, buttonClass } from '@/components/ui';
import { previewBinding } from './tagsApi';
import { bindingAssetPath, unsLink } from './assetPath';
import { detailFacts } from './bindingView';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label }) {
  const [state, setState] = useState('idle');
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-1.5"
      aria-label={label}
      onClick={async () => {
        setState((await copyText(text)) ? 'done' : 'failed');
        setTimeout(() => setState('idle'), 1800);
      }}
    >
      {state === 'done' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </Button>
  );
}

/** Expanded row: facts, the copyable asset path with a link to the UNS page, and the resolved topics (server preview of the stored mapping). */
export default function BindingDetail({ binding: b, status: s, src, historians, profiles }) {
  // The stored result is stamped with the request it answers; the last good data stays on screen
  // while a changed mapping is re-resolved.
  const [result, setResult] = useState({ requestKey: null, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(b); // the table re-fetches every few seconds; only reload on a real change
  const requestKey = `${nonce}|${key}`;
  useEffect(() => {
    let stale = false;
    const { warnings: _w, ...draft } = JSON.parse(key);
    previewBinding(draft).then(
      (data) => !stale && setResult({ requestKey, data, error: null }),
      (e) => !stale && setResult({ requestKey, data: null, error: e.message })
    );
    return () => {
      stale = true;
    };
  }, [key, requestKey]);
  const load = useCallback(() => setNonce((n) => n + 1), []);
  const view =
    result.requestKey === requestKey
      ? result.error !== null
        ? { state: 'error', data: null, error: result.error }
        : { state: 'ok', data: result.data, error: null }
      : result.data
        ? { state: 'ok', data: result.data, error: null }
        : { state: 'loading', data: null, error: null };

  const asset = bindingAssetPath(b);
  const uns = unsLink(b);
  const d = view.data;
  const topics = d?.valid ? (d.layout === 'object-per-asset' ? d.objects.map((o) => o.topic) : d.tags.map((t) => t.topic)) : [];
  const facts = [
    ['Source', `${src.label}${!src.connected ? ' (not connected)' : ''}`],
    ...detailFacts(b, { profiles, historians }),
    ['Last publish', s.lastTs ? new Date(s.lastTs).toLocaleString() : 'never'],
    ['Source state', s.sourceState ? `${s.sourceState.state}${s.sourceState.reason ? ` (${s.sourceState.reason})` : ''}` : 'unknown']
  ];
  return (
    <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-3">
        {asset && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Asset path</span>
            <span className="min-w-0 break-all font-mono text-xs text-fg">{asset}</span>
            <CopyButton text={asset} label={`Copy asset path ${asset}`} />
            {uns && (
              <Link to={uns.to} className={buttonClass('ghost', 'sm') + ' h-6 px-1.5 text-accent-text'} title={uns.partial ? `Opens ${uns.path}, the part of the template that is the same for every instance` : `Open ${uns.path} on the UNS page`}>
                <Network size={12} aria-hidden="true" /> Show in UNS
              </Link>
            )}
          </div>
        )}
        <KeyValue items={facts} className="text-xs" />
        {s.lastError && (
          <Banner variant="error" title="Last error">
            <span className="break-words font-mono text-xs">{s.lastError}</span>
          </Banner>
        )}
      </div>
      {b.target?.mode === 'mqtt' && (
        <div className="min-w-0">
          <h4 className="mb-1.5 text-xs font-medium text-muted">
            Resolved topics{d?.valid && d.units > 1 ? ` (${d.units} instances)` : ''}
          </h4>
          {view.state === 'loading' && (
            <p className="flex items-center gap-2 text-xs text-muted">
              <Spinner size={12} /> Resolving…
            </p>
          )}
          {view.state === 'error' && (
            <Banner variant="error" title="Could not resolve topics" onRetry={load}>
              {view.error}
            </Banner>
          )}
          {d?.valid === false && <p role="alert" className="text-xs text-bad">{d.error}</p>}
          {d?.valid && (
            <>
              <ul className="max-h-48 space-y-0.5 overflow-auto rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-xs text-fg">
                {topics.map((t) => (
                  <li key={t} className="truncate" title={t}>
                    {t}
                  </li>
                ))}
                {d.status.slice(0, 3).map((t) => (
                  <li key={t} className="truncate text-subtle" title={t}>
                    {t}
                  </li>
                ))}
              </ul>
              {d.truncated && <p className="helper mt-1">First {topics.length} of {d.totalTags} tags.</p>}
              {d.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {d.warnings.slice(0, 5).map((w, i) => (
                    <li key={i} className="break-words text-xs text-warn">
                      {w.message}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
