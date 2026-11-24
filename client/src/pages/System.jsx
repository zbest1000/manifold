import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import { Banner, Button, Dialog, Skeleton, StatGroup, StatusDot, StatusText } from '@/components/ui';
import { Sparkline, TimeSeriesChart } from '@/components/charts';

/**
 * System — the tool that watches your namespace, watched. Parses Manifold's own
 * Prometheus /metrics exposition and renders every reading (process health,
 * per-broker ingest, pipeline/outbox/recorder/contract/alert/binding counters)
 * live, each with a rolling sparkline. Counters show their per-interval rate;
 * gauges show their value.
 */

// Time of the latest successful poll, so modal charts anchor their time axis without calling Date.now() in render.
const UpdatedAtContext = createContext(0);

const POLL_MS = 3000;
const HISTORY = 60; // ~3 min of 3s samples

// --- Prometheus text parsing -------------------------------------------------

function parsePrometheus(text) {
  const byKey = new Map();
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (!m) continue;
    const [, name, labelStr, valStr] = m;
    const value = Number(valStr);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (labelStr) {
      for (const pair of labelStr.slice(1, -1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim();
        let v = pair.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        labels[k] = v;
      }
    }
    byKey.set(name + (labelStr || ''), { name, labels, value });
  }
  return byKey;
}

const val = (byKey, name, labels) => {
  for (const s of byKey.values()) {
    if (s.name !== name) continue;
    if (labels && !Object.entries(labels).every(([k, v]) => s.labels[k] === v)) continue;
    return s.value;
  }
  return null;
};
const sumBy = (byKey, name, label) => {
  let total = 0;
  let any = false;
  for (const s of byKey.values()) {
    if (s.name === name && (!label || s.labels.result === label)) {
      total += s.value;
      any = true;
    }
  }
  return any ? total : null;
};
const distinctLabel = (byKey, name, label) => {
  const out = [];
  for (const s of byKey.values()) if (s.name === name && s.labels[label] !== undefined) out.push(s.labels[label]);
  return [...new Set(out)];
};

// --- formatting --------------------------------------------------------------

const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const fmtNum = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
// Rates: one decimal under 10, none above (design system data rule).
const fmtRate = (r) => (r == null ? '—' : r < 10 ? r.toFixed(1) : Math.round(r).toLocaleString());
const fmtBytes = (n) => (n == null ? '—' : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

// --- metric cells --------------------------------------------------------------

// Stable colour callbacks (charts resolve them against the current theme at paint time).
const accentLine = (_i, t) => t.accent;
const warnLine = (_i, t) => t.warn;

/**
 * One metric in a StatGroup strip: label, value with unit, an optional
 * secondary line and a real sparkline of its rolling history. The whole cell
 * opens the history Dialog once there are two samples.
 */
function StatTile({ label, value, unit, history, warn, sub }) {
  const [open, setOpen] = useState(false);
  const canChart = (history?.length || 0) >= 2;
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted">
        {warn && <StatusDot tone="warn" size={6} />}
        <span className="min-w-0 break-words">{label}</span>
      </span>
      <span className="mt-1 flex items-baseline gap-1">
        <span className={clsx('text-xl font-medium tabular-nums tracking-tight', warn ? 'text-warn' : 'text-fg')}>{value}</span>
        {unit && <span className="text-sm text-subtle">{unit}</span>}
      </span>
      {sub && <span className="mt-0.5 block truncate text-xs text-subtle">{sub}</span>}
      <span className="mt-auto block pt-2">
        <Sparkline values={history} warn={warn} height={24} label={label} />
      </span>
    </>
  );
  const cls = 'flex h-full min-w-0 flex-col items-stretch justify-start bg-panel px-4 py-3 text-left';
  return (
    <>
      {canChart ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${label}: ${value}${unit ? ` ${unit}` : ''}${warn ? ', needs attention' : ''}. Open history`}
          className={clsx(cls, 'transition-colors duration-150 hover:bg-raised focus-visible:relative focus-visible:z-10')}
        >
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
      {open && <MetricDialog label={label} value={value} unit={unit} history={history} warn={warn} onClose={() => setOpen(false)} />}
    </>
  );
}

// The history of one metric as a full time chart, on a synthesized time axis
// (samples are POLL_MS apart, newest = the latest poll).
function MetricDialog({ label, value, unit, history, warn, onClose }) {
  const now = useContext(UpdatedAtContext);
  const series = useMemo(() => {
    const n = history.length;
    return [{ tag: label, unit, points: history.map((v, i) => [now - (n - 1 - i) * POLL_MS, v]) }];
  }, [history, label, unit, now]);
  return (
    <Dialog title={label} description={`Last ${Math.round((history.length * POLL_MS) / 1000)} s · ${history.length} samples, every ${POLL_MS / 1000} s`} onClose={onClose} size="lg">
      <p className="mb-3 flex items-baseline gap-1">
        <span className={clsx('text-2xl font-medium tabular-nums', warn ? 'text-warn' : 'text-fg')}>{value}</span>
        {unit && <span className="text-sm text-subtle">{unit}</span>}
      </p>
      <TimeSeriesChart series={series} height={300} unit={unit} colorFor={warn ? warnLine : accentLine} />
    </Dialog>
  );
}

/** A group of metrics: a 13px heading (state summary on the right) over one StatGroup strip. */
function Section({ title, status, children }) {
  return (
    <section aria-labelledby={`sys-${title}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id={`sys-${title}`} className="text-sm font-medium text-fg">
          {title}
        </h2>
        {status}
      </div>
      <StatGroup className="grid-cols-2 lg:grid-cols-4">{children}</StatGroup>
    </section>
  );
}

// last delta of a counter's history, per poll interval
const rate = (hist) => (hist && hist.length >= 2 ? Math.max(0, hist[hist.length - 1] - hist[hist.length - 2]) : 0);
const deltas = (hist) => (hist ? hist.slice(1).map((v, i) => Math.max(0, v - hist[i])) : []);

// Rolling history for a single-labelled (or unlabelled) series, keyed the same
// way poll() stores it.
function histFor(hist, name, labels) {
  const key = name + (labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '');
  return hist.get(key) || [];
}

// A gauge reading: current value (through `fmt`) plus a value sparkline.
function GaugeTile({ metrics, hist, name, labels, label, unit, sub, fmt = fmtInt, warn }) {
  return <StatTile label={label} value={fmt(val(metrics, name, labels))} unit={unit} sub={sub} warn={warn} history={histFor(hist, name, labels)} />;
}

// A counter reading: total value plus a per-interval-rate sparkline. `family` is
// the metric name; `result` an optional result-label filter; warnPositive flags
// amber once the value is non-zero.
function CounterTile({ metrics, hist, family, result, label, unit, warnPositive }) {
  const value = sumBy(metrics, family, result) || 0;
  return <StatTile label={label} value={fmtInt(value)} unit={unit} warn={warnPositive && value > 0} history={deltas(aggHistory(hist, family, result))} />;
}

export default function System() {
  const [metrics, setMetrics] = useState(null); // Map(key -> sample)
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [hist, setHist] = useState(() => new Map()); // key -> number[] (rolling window per series)

  const [tick, setTick] = useState(0);
  const poll = useCallback(() => setTick((t) => t + 1), []); // manual Refresh/Retry: restart the poller (polls at once)

  useEffect(() => {
    let alive = true;
    const pollOnce = async () => {
      try {
        const text = await api.metricsText();
        if (!alive) return;
        const byKey = parsePrometheus(text);
        // Append every scalar into its rolling history for sparklines.
        setHist((prev) => {
          const next = new Map(prev);
          for (const [key, s] of byKey) {
            const arr = [...(prev.get(key) || []), s.value];
            if (arr.length > HISTORY) arr.shift();
            next.set(key, arr);
          }
          return next;
        });
        setMetrics(byKey);
        setError('');
        setUpdatedAt(Date.now());
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    pollOnce();
    const t = setInterval(() => document.visibilityState === 'visible' && pollOnce(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick]);

  const brokers = useMemo(() => (metrics ? distinctLabel(metrics, 'manifold_broker_topics', 'broker') : []), [metrics]);
  const recordings = useMemo(() => (metrics ? distinctLabel(metrics, 'manifold_recorder_points_total', 'recording') : []), [metrics]);

  // Until the first poll resolves, metrics is null — render a loading/error
  // state instead of falling through to val()/sumBy(), which iterate over it.
  if (!metrics) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="System health" />
        <div role="region" aria-label="System metrics" tabIndex={0} className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {error ? (
            <Banner variant="error" title="Could not read /metrics" onRetry={poll}>
              {error}. Check that the server is running and your access token is valid.
            </Banner>
          ) : (
            <div className="space-y-5" role="status" aria-busy="true">
              <span className="sr-only">Loading health metrics…</span>
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-24 w-full rounded-lg" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const loopP99 = val(metrics, 'manifold_event_loop_delay_ms', { quantile: '0.99' });
  const loopWarn = loopP99 != null && loopP99 > 100;
  const pipelineErrors = (sumBy(metrics, 'manifold_pipeline_messages_total', 'error') || 0) + (sumBy(metrics, 'manifold_pipeline_messages_total', 'loop_blocked') || 0);
  const dropped = sumBy(metrics, 'manifold_outbox_points_total', 'dropped') || 0;
  const spill = val(metrics, 'manifold_outbox_spill_bytes') || sumBy(metrics, 'manifold_outbox_spill_bytes') || 0;
  const violations = sumBy(metrics, 'manifold_contract_violations_total') || 0;

  return (
    <UpdatedAtContext.Provider value={updatedAt ?? 0}>
      <div className="flex h-full flex-col">
        <PageHeader
          title="System health"
          subtitle={updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()} · every ${POLL_MS / 1000} s from /metrics` : undefined}
          actions={
            <Button variant="secondary" onClick={poll}>
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </Button>
          }
        />

        <div role="region" aria-label="System metrics" tabIndex={0} className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {error && (
            <Banner variant="warn" title="Last poll failed, showing the previous readings" onRetry={poll}>
              {error}
            </Banner>
          )}

          <Section title="Process" status={loopWarn ? <StatusText tone="warn">Event loop slow</StatusText> : null}>
            <GaugeTile metrics={metrics} hist={hist} name="manifold_process_uptime_seconds" label="Uptime" fmt={fmtUptime} />
            <GaugeTile metrics={metrics} hist={hist} name="manifold_process_memory_bytes" labels={{ kind: 'rss' }} label="Memory RSS" fmt={fmtBytes} />
            <GaugeTile metrics={metrics} hist={hist} name="manifold_process_memory_bytes" labels={{ kind: 'heap_used' }} label="Heap used" fmt={fmtBytes} />
            <GaugeTile
              metrics={metrics}
              hist={hist}
              name="manifold_event_loop_delay_ms"
              labels={{ quantile: '0.99' }}
              label="Event-loop delay p99"
              unit="ms"
              fmt={(v) => fmtNum(v, 1)}
              sub={`p50 ${fmtNum(val(metrics, 'manifold_event_loop_delay_ms', { quantile: '0.5' }), 1)} ms`}
              warn={loopWarn}
            />
          </Section>

          {brokers.length > 0 && (
            <Section title="Broker ingest">
              {brokers.map((b) => {
                const msgs = histFor(hist, 'manifold_broker_messages_received_total', { broker: b });
                return (
                  <StatTile
                    key={b}
                    label={b}
                    value={fmtInt(val(metrics, 'manifold_broker_topics', { broker: b }))}
                    unit="topics"
                    sub={`${fmtRate(rate(msgs) / (POLL_MS / 1000))} msg/s · ${fmtInt(val(metrics, 'manifold_broker_messages_received_total', { broker: b }))} total`}
                    history={deltas(msgs)}
                  />
                );
              })}
            </Section>
          )}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Section title="Pipelines" status={pipelineErrors > 0 ? <StatusText tone="warn">{fmtInt(pipelineErrors)} failed</StatusText> : null}>
              {[
                { label: 'Delivered', result: 'delivered' },
                { label: 'Matched', result: 'matched' },
                { label: 'Errors', result: 'error', warnPositive: true },
                { label: 'Loop-blocked', result: 'loop_blocked', warnPositive: true }
              ].map((t) => (
                <CounterTile key={t.result} metrics={metrics} hist={hist} family="manifold_pipeline_messages_total" {...t} />
              ))}
            </Section>

            <Section title="Historian outbox" status={dropped > 0 ? <StatusText tone="warn">{fmtInt(dropped)} dropped</StatusText> : spill > 0 ? <StatusText tone="warn">Spilling to disk</StatusText> : null}>
              <CounterTile metrics={metrics} hist={hist} family="manifold_outbox_points_total" result="written" label="Written" />
              <GaugeTile metrics={metrics} hist={hist} name="manifold_outbox_queued_points" label="Queued" />
              <StatTile label="Spilled" value={fmtBytes(spill)} warn={spill > 0} history={aggHistory(hist, 'manifold_outbox_spill_bytes')} />
              <CounterTile metrics={metrics} hist={hist} family="manifold_outbox_points_total" result="dropped" label="Dropped" warnPositive />
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Section title="Contracts and alerts" status={violations > 0 ? <StatusText tone="warn">{fmtInt(violations)} violations</StatusText> : null}>
              <CounterTile metrics={metrics} hist={hist} family="manifold_contract_checks_total" label="Checks" />
              <CounterTile metrics={metrics} hist={hist} family="manifold_contract_violations_total" label="Violations" warnPositive />
              <GaugeTile metrics={metrics} hist={hist} name="manifold_alert_events" label="Alert events" />
              <CounterTile metrics={metrics} hist={hist} family="manifold_binding_published_total" label="Bindings published" />
            </Section>

            {recordings.length > 0 && (
              <Section title="Recorder">
                {recordings.map((r) => (
                  <StatTile
                    key={r}
                    label={r}
                    value={fmtInt(val(metrics, 'manifold_recorder_points_total', { recording: r }))}
                    unit="points"
                    history={deltas(histFor(hist, 'manifold_recorder_points_total', { recording: r }))}
                  />
                ))}
              </Section>
            )}
          </div>
        </div>
      </div>
    </UpdatedAtContext.Provider>
  );
}

// Sum the rolling history across every series of a counter family (optionally a
// result label) so an aggregate tile gets a real trend, not a flat line.
function aggHistory(histMap, name, result) {
  const series = [];
  for (const [key, arr] of histMap) {
    if (!key.startsWith(name)) continue;
    if (result && !key.includes(`result="${result}"`)) continue;
    series.push(arr);
  }
  if (!series.length) return [];
  const len = Math.max(...series.map((a) => a.length));
  const out = new Array(len).fill(0);
  for (const a of series) {
    const offset = len - a.length;
    for (let i = 0; i < a.length; i++) out[offset + i] += a[i];
  }
  return out;
}
