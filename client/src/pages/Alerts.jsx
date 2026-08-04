import { useEffect, useMemo, useState } from 'react';
import { BellOff, History, CheckCircle2, Radio } from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, HelpButton, EmptyState } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import AlertRules from '@/components/AlertRules';

/**
 * The alarm center: what is firing right now, the rules that watch the
 * namespace, and the recent event history. Active state arrives two ways —
 * seeded from GET /api/alerts/active on mount and kept live by the 'alert'
 * socket event (see initRealtime) — so the board is correct even for alarms
 * that fired before this tab existed.
 */
export default function Alerts() {
  const activeAlarms = useStore((s) => s.activeAlarms);
  const liveEvents = useStore((s) => s.alerts);
  const brokers = useStore((s) => s.brokers);
  const seedActiveAlarms = useStore((s) => s.seedActiveAlarms);
  const markAlertsSeen = useStore((s) => s.markAlertsSeen);
  const [history, setHistory] = useState([]);
  const [, forceTick] = useState(0);

  useEffect(() => {
    api.alertsActive().then((r) => seedActiveAlarms(r.active)).catch(() => {});
    api.alertEvents(100).then((r) => setHistory(r.events || [])).catch(() => {});
  }, [seedActiveAlarms]);

  // Being on this page IS acknowledging the feed — clear the nav badge on
  // entry and again as new events land while the page is open.
  useEffect(() => {
    markAlertsSeen();
  }, [markAlertsSeen, liveEvents.length]);

  // "for 3m" durations on active alarms tick at 30s without any data changing.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const active = useMemo(
    () => Object.values(activeAlarms).sort((a, b) => b.ts - a.ts),
    [activeAlarms]
  );

  // Feed = live socket events (session) + fetched history, deduped: the same
  // firing can be in both once the history poll catches up.
  const feed = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const e of [...liveEvents, ...history]) {
      const key = `${e.ruleId}|${e.ts}|${e.status}|${e.topic || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 200);
  }, [liveEvents, history]);

  const brokerName = (id) => brokers.find((b) => b.id === id)?.name || (id ? id.slice(0, 8) : '—');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Alerts"
        subtitle="Active alarms, rules watching the namespace, and firing history"
        actions={
          <HelpButton title="How alerts work" label="How alerts work">
            <p>
              Rules watch your live namespace <b>server-side</b>: silence rules are checked every 15 seconds, value
              thresholds are evaluated on every matching message — so a breach alerts at message latency.
            </p>
            <p>
              <b>Branch silent</b> / <b>topic silent</b> catch data that stops flowing. <b>New topic</b> catches
              unexpected publishers. <b>Value threshold</b> catches out-of-range numeric values, with an optional
              sustain time (breach must hold continuously) and clear-value deadband (no flapping while a signal
              hovers near the limit).
            </p>
            <p>
              Firings show here, in the sidebar badge, and as toasts. Each rule can also POST every event to a{' '}
              <b>webhook</b> — point it at Slack, Teams, or PagerDuty. Wildcard value rules (<code>plant/+/temp</code>)
              track each matched topic independently.
            </p>
          </HelpButton>
        }
      />

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {/* Active alarm board */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Active now
            {active.length > 0 && (
              <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-300 ring-1 ring-inset ring-rose-500/30">
                {active.length}
              </span>
            )}
          </h2>
          {active.length === 0 ? (
            <Card className="flex items-center gap-3 px-4 py-3.5">
              <CheckCircle2 size={18} className="shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-slate-200">All clear — nothing is firing</p>
                <p className="text-xs text-slate-500">Alarms appear here the moment a rule trips, and clear themselves when data recovers.</p>
              </div>
            </Card>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {active.map((a) => (
                <Card
                  key={`${a.ruleId}|${a.topic || ''}`}
                  className="border-rose-500/30 bg-rose-500/[0.06] p-3.5"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-rose-200">
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-400" />
                      <span className="truncate">{a.ruleName}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-rose-300/70">
                      for {formatDistanceToNow(a.ts)}
                    </span>
                  </div>
                  {a.detail && <p className="text-xs leading-relaxed text-slate-300">{a.detail}</p>}
                  <p className="mono mt-1.5 flex items-center gap-1 truncate text-[11px] text-slate-500">
                    <Radio size={10} className="shrink-0" /> {brokerName(a.brokerId)}
                    {a.topic && <span className="truncate"> · {a.topic}</span>}
                  </p>
                </Card>
              ))}
            </div>
          )}
        </section>

        <AlertRules onChanged={() => api.alertsActive().then((r) => seedActiveAlarms(r.active)).catch(() => {})} />

        {/* Event history */}
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <History size={16} className="text-accent-400" /> Recent events
          </h2>
          {feed.length === 0 ? (
            <div className="py-8">
              <EmptyState
                icon={BellOff}
                title="No alert activity yet"
                hint="When a rule fires or resolves, the event lands here (and in the sidebar badge) in real time."
              />
            </div>
          ) : (
            <div className="max-h-96 space-y-1 overflow-y-auto">
              {feed.map((e, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-1.5 text-xs">
                  <span className="min-w-0 truncate">
                    <span
                      className={clsx(
                        'mr-2 font-semibold',
                        e.status === 'firing' ? 'text-red-400' : e.status === 'resolved' ? 'text-emerald-400' : 'text-sky-400'
                      )}
                    >
                      {e.status}
                    </span>
                    <span className="text-slate-300">{e.ruleName}</span>
                    <span className="ml-2 text-slate-500">{e.detail}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-500">{formatDistanceToNow(e.ts, { addSuffix: true })}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
