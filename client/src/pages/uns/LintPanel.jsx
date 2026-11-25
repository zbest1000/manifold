import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { namespaceKind } from '@/graph/unsLevels';
import { Banner, LoadingState, StatusText } from '@/components/ui';
import { PanelSection, SidePanel } from '@/components/CanvasChrome';

const SEVERITY = { error: { tone: 'bad', word: 'Error' }, warn: { tone: 'warn', word: 'Warning' }, info: { tone: 'info', word: 'Info' } };
const SEV_ORDER = { error: 0, warn: 1, info: 2 };

export default function LintPanel({ brokers, onJump, onClose }) {
  // The result remembers which (brokers, attempt) it answers, so a new request
  // shows the loading state again without resetting state inside the effect.
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
    <SidePanel title="Namespace lint" label="Namespace lint" onClose={onClose} width="md:w-[26rem]">
      {!reports && <LoadingState label="lint findings" rows={3} className="m-4" />}
      {reports?.map(({ broker, report, error }) => (
        <PanelSection
          key={broker.id}
          title={broker.name}
          aside={
            report && (
              <span className="tabular-nums">
                Score <span className={report.score >= 85 ? 'text-good' : report.score >= 60 ? 'text-warn' : 'text-bad'}>{report.score}</span> / 100
              </span>
            )
          }
        >
          {!report && <Banner variant="error" title="Lint unavailable" onRetry={() => setAttempt((v) => v + 1)}>{error}</Banner>}
          {report && report.findings.length === 0 && (
            <StatusText tone="good">No structural issues in {report.stats.topics.toLocaleString()} topics</StatusText>
          )}
          {report && report.findings.length > 0 && (
            <div role="region" aria-label={`Lint findings for ${broker.name}`} tabIndex={0} className="-mx-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Lint findings for {broker.name}</caption>
                <thead className="border-b border-line">
                  <tr>
                    <th scope="col" className="h-8 w-24 whitespace-nowrap px-4 align-middle text-xs font-medium text-muted">
                      Severity
                    </th>
                    <th scope="col" className="h-8 whitespace-nowrap pr-4 align-middle text-xs font-medium text-muted">
                      Finding
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.findings
                    .slice()
                    .sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3))
                    .map((f, i) => {
                      const sev = SEVERITY[f.severity] || { tone: 'neutral', word: f.severity || 'Note' };
                      return (
                        <tr key={i} className="border-t border-line align-top first:border-t-0">
                          <td className="whitespace-nowrap px-4 py-2">
                            <StatusText tone={sev.tone} className="text-xs">
                              {sev.word}
                            </StatusText>
                          </td>
                          <td className="min-w-0 py-2 pr-4">
                            <p className="font-medium text-fg">{f.title}</p>
                            {f.path && (
                              <button
                                type="button"
                                onClick={() => onJump(broker.id, f.path)}
                                className="group mt-0.5 inline-flex max-w-full items-center gap-1 rounded text-left font-mono text-xs text-accent-text hover:underline"
                                title="Show this node on the map"
                              >
                                <span className="break-all">{f.path}</span>
                                <ArrowRight size={12} aria-hidden="true" className="shrink-0" />
                                <span className="sr-only">Show on the map</span>
                              </button>
                            )}
                            {f.detail && <p className="mt-0.5 text-xs text-muted">{f.detail}</p>}
                            {namespaceKind(f.path) === 'sparkplug' && (
                              <p className="mt-1 text-xs text-subtle">Sparkplug topics follow the Sparkplug B layout (namespace, group, message type, edge node, device), not ISA-95 levels.</p>
                            )}
                            {f.why && <p className="mt-1 text-xs leading-snug text-subtle">{f.why}</p>}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
          {report?.truncated && (
            <p className="mt-2 text-xs text-subtle">
              Findings truncated. Totals: {Object.entries(report.stats.byRule).map(([r, c]) => `${r} ${c}`).join(', ')}
            </p>
          )}
        </PanelSection>
      ))}
    </SidePanel>
  );
}
