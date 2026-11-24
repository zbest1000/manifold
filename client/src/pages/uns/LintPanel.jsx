import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import PanelHeader from './PanelHeader';
import { namespaceKind } from '@/graph/unsLevels';

const SEV_COLOR = { error: 'text-red-400', warn: 'text-amber-400', info: 'text-sky-400' };

export default function LintPanel({ brokers, onJump, onClose }) {
  // The result remembers which (brokers, attempt) it answers, so a new request
  // shows "Analyzing…" again without resetting state inside the effect.
  const [result, setResult] = useState(null); // { brokers, attempt, reports: [{ broker, report, error }] }
  const [attempt, setAttempt] = useState(0);
  const reports = result && result.brokers === brokers && result.attempt === attempt ? result.reports : null;
  useEffect(() => {
    let alive = true;
    Promise.all(
      brokers.map((b) =>
        api
          .unsLint(b.id)
          .then((report) => ({ broker: b, report, error: null }))
          .catch((e) => ({ broker: b, report: null, error: e?.message || 'Lint request failed' }))
      )
    ).then((r) => alive && setResult({ brokers, attempt, reports: r }));
    return () => {
      alive = false;
    };
  }, [brokers, attempt]);

  return (
    <aside className="flex max-h-[50%] w-full shrink-0 flex-col border-t border-white/5 bg-surface-900/40 md:max-h-none md:w-80 md:border-l md:border-t-0">
      <PanelHeader icon={ShieldCheck} title="Namespace lint" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!reports && <p className="text-xs text-slate-400" role="status">Analyzing namespace…</p>}
        {reports?.map(({ broker, report, error }) => (
          <div key={broker.id}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="truncate text-xs font-semibold text-slate-200">{broker.name}</span>
              {report && <ScoreBadge score={report.score} />}
            </div>
            {!report && (
              <div role="alert" className="flex items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
                <span>Lint unavailable{error ? `: ${error}` : ''}</span>
                <button onClick={() => setAttempt((v) => v + 1)} className="shrink-0 rounded border border-rose-400/40 px-2 py-0.5 hover:bg-rose-500/20">
                  Retry
                </button>
              </div>
            )}
            {report && report.findings.length === 0 && (
              <p className="text-xs text-emerald-400">No structural issues found in {report.stats.topics.toLocaleString()} topics.</p>
            )}
            {report?.findings.map((f, i) => {
              const navigable = Boolean(f.path);
              const cls = `mb-1 block w-full rounded-lg bg-black/20 px-2 py-1.5 text-left text-xs ${navigable ? 'group cursor-pointer transition hover:bg-white/5' : ''}`;
              const body = (
                <>
                  <div className="flex items-start gap-1.5">
                    <span className={`font-semibold ${SEV_COLOR[f.severity] || 'text-slate-300'}`}>{f.title}</span>
                    {navigable && (
                      <span className="ml-auto shrink-0 text-xs text-accent-300 opacity-0 transition group-hover:opacity-100">jump →</span>
                    )}
                  </div>
                  {f.path && <div className="mt-0.5 break-all font-mono text-xs text-slate-400">{f.path}</div>}
                  {f.detail && <div className="mt-0.5 text-slate-400">{f.detail}</div>}
                  {/* WHY it matters — the finding's explanation, previously dropped. */}
                  {namespaceKind(f.path) === 'sparkplug' && (
                    <div className="mt-1 text-xs italic text-slate-400">
                      Sparkplug topics follow the Sparkplug B spec (namespace / group / message type / edge node / device), not ISA-95 levels.
                    </div>
                  )}
                  {f.why && <div className="mt-1 leading-snug text-xs text-slate-400">{f.why}</div>}
                </>
              );
              return navigable ? (
                <button key={i} type="button" onClick={() => onJump(broker.id, f.path)} className={cls} title="Jump to this node in the topology">
                  {body}
                </button>
              ) : (
                <div key={i} className={cls}>
                  {body}
                </div>
              );
            })}
            {report?.truncated && (
              <p className="text-xs text-slate-400">
                Findings truncated — totals: {Object.entries(report.stats.byRule).map(([r, c]) => `${r}: ${c}`).join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function ScoreBadge({ score }) {
  const color = score >= 85 ? 'text-emerald-400 border-emerald-500/40' : score >= 60 ? 'text-amber-400 border-amber-500/40' : 'text-red-400 border-red-500/40';
  return <span className={`rounded-lg border px-1.5 py-0.5 font-mono text-xs ${color}`}>{score}/100</span>;
}

