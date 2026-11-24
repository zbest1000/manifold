import { useCallback, useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import ErrorBanner from './Banner';
import { previewBinding } from './tagsApi';
import { bindingAssetPath } from './assetPath';
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
    <button
      type="button"
      onClick={async () => {
        setState((await copyText(text)) ? 'done' : 'failed');
        setTimeout(() => setState('idle'), 1800);
      }}
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white"
    >
      {state === 'done' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </button>
  );
}

/** Expanded row: source/target facts, copyable asset path, and the resolved topics (server preview of the stored binding). */
export default function BindingDetail({ binding: b, status: s, src, historians, profiles }) {
  const [view, setView] = useState({ state: 'loading', data: null, error: null });
  const key = JSON.stringify(b); // the table re-fetches bindings every few seconds; only reload on a real change
  const load = useCallback(async () => {
    setView((v) => (v.data ? v : { state: 'loading', data: null, error: null }));
    try {
      const { warnings: _w, ...draft } = JSON.parse(key);
      setView({ state: 'ok', data: await previewBinding(draft), error: null });
    } catch (e) {
      setView({ state: 'error', data: null, error: e.message });
    }
  }, [key]);
  useEffect(() => {
    load();
  }, [load]);

  const asset = bindingAssetPath(b);
  const d = view.data;
  const topics = d?.valid ? (d.layout === 'object-per-asset' ? d.objects.map((o) => o.topic) : d.tags.map((t) => t.topic)) : [];
  return (
    <div className="space-y-3 text-xs">
      <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        <dt className="text-slate-400">Source</dt>
        <dd className="break-all text-slate-200">{src.type}: {src.label}{!src.connected && ' (not connected)'}</dd>
        {asset && (
          <>
            <dt className="text-slate-400">Asset path</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2 text-slate-200">
              <span className="break-all font-mono">{asset}</span>
              <CopyButton text={asset} label={`Copy asset path ${asset}`} />
            </dd>
          </>
        )}
        {detailFacts(b, { profiles, historians }).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-400">{k}</dt>
            <dd className="break-words text-slate-200">{v}</dd>
          </div>
        ))}
        <dt className="text-slate-400">Last publish</dt>
        <dd className="text-slate-200">{s.lastTs ? new Date(s.lastTs).toLocaleString() : 'never'}</dd>
        <dt className="text-slate-400">Source state</dt>
        <dd className="text-slate-200">{s.sourceState ? `${s.sourceState.state}${s.sourceState.reason ? ` (${s.sourceState.reason})` : ''}` : 'unknown'}</dd>
        <dt className="text-slate-400">Last error</dt>
        <dd className={clsx('break-words', s.lastError ? 'text-amber-300' : 'text-slate-400')}>{s.lastError || 'none'}</dd>
      </dl>

      {b.target?.mode === 'mqtt' && (
        <div>
          <h4 className="mb-1 font-semibold text-slate-300">Resolved topics{d?.valid && d.units > 1 ? ` (${d.units} instances)` : ''}</h4>
          {view.state === 'loading' && <p className="text-slate-400">Resolving...</p>}
          {view.state === 'error' && <ErrorBanner title="Could not resolve topics" message={view.error} onRetry={load} />}
          {d?.valid === false && <p role="alert" className="text-amber-300">{d.error}</p>}
          {d?.valid && (
            <>
              <ul className="max-h-40 space-y-0.5 overflow-auto font-mono text-slate-200">
                {topics.map((t) => <li key={t} className="break-all">{t}</li>)}
                {d.status.slice(0, 3).map((t) => <li key={t} className="break-all text-slate-400">{t}</li>)}
              </ul>
              {d.truncated && <p className="mt-1 text-slate-400">First {topics.length} of {d.totalTags} tags.</p>}
              {d.warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-amber-300">
                  {d.warnings.slice(0, 5).map((w, i) => <li key={i} className="break-words">{w.message}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
