import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Activity, Cpu, Radio, Workflow, Database, HardDriveDownload, ShieldCheck, BellRing, Tag, RefreshCw, AlertTriangle, Maximize2, X } from 'lucide-react';
import { api } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import { Card, Button, EmptyState, Modal } from '@/components/ui';
import { CHART_THEME, Sparkline, TimeSeriesChart } from '@/components/charts';

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

// --- sparkline ---------------------------------------------------------------

function StatTile({ label, value, unit, history, warn, sub }) {
  const [open, setOpen] = useState(false);
  const canChart = (history?.length || 0) >= 2;
  const tile = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        {/* Wrap the label instead of truncating — "Delivered"/"Bindings published"
            were cut to "DELI…"/"BINDIN…" in the narrow tiles. */}
        <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400" title={label}>
          {label}
          {canChart && <Maximize2 size={9} className="opacity-0 transition group-hover:opacity-100" />}
        </p>
        <p className={`mt-0.5 text-lg font-semibold tabular-nums ${warn ? 'text-amber-300' : 'text-slate-100'}`}>
          {value}
          {unit && <span className="ml-1 text-xs font-normal text-slate-400">{unit}</span>}
        </p>
        {sub && <p className="truncate text-xs text-slate-400">{sub}</p>}
      </div>
      <div className="w-20 shrink-0">
        <Sparkline values={history} warn={warn} height={28} label={label} />
      </div>
    </div>
  );
  const cardClass = `group rounded-xl border px-3 py-2.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/70 ${warn ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-white/5 bg-white/[0.02]'}`;
  return (
    <>
      {canChart ? (
        <div
          role="button"
          tabIndex={0}
          aria-label={`${label}: ${value}${unit ? ` ${unit}` : ''}. Expand history chart`}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(true);
            }
          }}
          title="Click to expand this metric"
          className={`${cardClass} cursor-pointer hover:border-white/15 hover:bg-white/[0.05]`}
        >
          {tile}
        </div>
      ) : (
        <div className={cardClass}>{tile}</div>
      )}
      {open && <MetricModal label={label} value={value} unit={unit} history={history} warn={warn} onClose={() => setOpen(false)} />}
    </>
  );
}

// Click-to-expand: a full uPlot time chart of a tile's rolling history, on a
// synthesized time axis (samples are POLL_MS apart, newest = now).
function MetricModal({ label, value, unit, history, warn, onClose }) {
  const now = useContext(UpdatedAtContext);
  const series = useMemo(() => {
    const n = history.length;
    const points = history.map((v, i) => [now - (n - 1 - i) * POLL_MS, v]);
    return [{ tag: `${label}${unit ? ` (${unit})` : ''}`, points }];
  }, [history, label, unit, now]);
  // The shared Modal portals to <body>, escaping the tile's backdrop-blur Card.
  return (
    <Modal title={`${label} history`} onClose={onClose} className="max-w-3xl p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">{label}</h3>
          <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${warn ? 'text-amber-300' : 'text-slate-100'}`}>
            {value}
            {unit && <span className="ml-1 text-sm font-normal text-slate-400">{unit}</span>}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">last ~{Math.round((history.length * POLL_MS) / 1000)}s · {history.length} samples</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200">
          <X size={16} />
        </button>
      </div>
      <TimeSeriesChart series={series} height={320} colorFor={() => (warn ? CHART_THEME.warn : CHART_THEME.accent)} />
    </Modal>
  );
}

function Section({ icon: Icon, title, children, warn }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <Icon size={15} className={warn ? 'text-amber-400' : 'text-accent-400'} /> {title}
      </h2>
      {/* auto-fit so tiles never shrink below a label-readable width, whether the
          section is full-width or half-width */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }}>
        {children}
      </div>
    </Card>
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
        <PageHeader title="System" subtitle="Manifold's own health and Prometheus readings" />
        <div role="region" aria-label="System metrics" tabIndex={0} className="flex-1 overflow-y-auto p-4 sm:p-6">
          {error ? (
            <EmptyState
              icon={AlertTriangle}
              title="Couldn't read /metrics"
              hint={`${error}. Check that the server is running and your access token is valid, then retry.`}
              action={
                <Button variant="outline" size="sm" onClick={poll}>
                  <RefreshCw size={14} /> Retry
                </Button>
              }
            />
          ) : (
            <div className="grid gap-4" aria-busy="true" aria-label="Loading health metrics">
              {[0, 1, 2].map((i) => (
                <Card key={i} className="h-28 animate-pulse p-4" />
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
          title="System"
          subtitle="Manifold's own health and Prometheus readings — /metrics, live"
          actions={
            <div className="flex flex-wrap items-center gap-3">
              {updatedAt && <span className="text-xs text-slate-400">updated {new Date(updatedAt).toLocaleTimeString()}</span>}
              <Button variant="outline" size="sm" onClick={poll}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </div>
          }
        />

        <div role="region" aria-label="System metrics" tabIndex={0} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          {error && (
            <p role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span>Last poll failed: {error}. Showing the previous readings.</span>
              <button type="button" onClick={poll} className="shrink-0 rounded border border-amber-400/40 px-2 py-0.5 hover:bg-amber-500/20">Retry</button>
            </p>
          )}

          <Section icon={Activity} title="Process health" warn={loopWarn}>
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
            <Section icon={Radio} title="Broker ingest">
              {brokers.map((b) => {
                const msgs = histFor(hist, 'manifold_broker_messages_received_total', { broker: b });
                return (
                  <StatTile
                    key={b}
                    label={b}
                    value={fmtInt(val(metrics, 'manifold_broker_topics', { broker: b }))}
                    unit="topics"
                    sub={`${fmtInt(rate(msgs) / (POLL_MS / 1000))}/s · ${fmtInt(val(metrics, 'manifold_broker_messages_received_total', { broker: b }))} total`}
                    history={deltas(msgs)}
                  />
                );
              })}
            </Section>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section icon={Workflow} title="Pipelines" warn={pipelineErrors > 0}>
              {[
                { label: 'Delivered', result: 'delivered' },
                { label: 'Matched', result: 'matched' },
                { label: 'Errors', result: 'error', warnPositive: true },
                { label: 'Loop-blocked', result: 'loop_blocked', warnPositive: true }
              ].map((t) => (
                <CounterTile key={t.result} metrics={metrics} hist={hist} family="manifold_pipeline_messages_total" {...t} />
              ))}
            </Section>

            <Section icon={Database} title="Historian outbox" warn={dropped > 0 || spill > 0}>
              <CounterTile metrics={metrics} hist={hist} family="manifold_outbox_points_total" result="written" label="Written" />
              <GaugeTile metrics={metrics} hist={hist} name="manifold_outbox_queued_points" label="Queued" />
              <StatTile label="Spilled" value={fmtBytes(spill)} warn={spill > 0} history={aggHistory(hist, 'manifold_outbox_spill_bytes')} />
              <CounterTile metrics={metrics} hist={hist} family="manifold_outbox_points_total" result="dropped" label="Dropped" warnPositive />
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section icon={ShieldCheck} title="Contracts" warn={violations > 0}>
              <CounterTile metrics={metrics} hist={hist} family="manifold_contract_checks_total" label="Checks" />
              <CounterTile metrics={metrics} hist={hist} family="manifold_contract_violations_total" label="Violations" warnPositive />
              <GaugeTile metrics={metrics} hist={hist} name="manifold_alert_events" label="Alert events" />
              <CounterTile metrics={metrics} hist={hist} family="manifold_binding_published_total" label="Bindings published" />
            </Section>

            {recordings.length > 0 && (
              <Section icon={HardDriveDownload} title="Recorder">
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
