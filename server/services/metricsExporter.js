'use strict';

const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

/**
 * Prometheus exposition for Manifold itself — the tool that watches your
 * namespace should be watchable. Hand-rolled text format (no dependency):
 * process health, event-loop delay, per-broker ingest counters, pipeline
 * route metrics, historian outbox depth (store-and-forward health), recorder,
 * contracts, alerts, and tag bindings.
 */

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function line(name, labels, value) {
  if (!Number.isFinite(value)) return '';
  const l = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
  return `${name}${l} ${value}\n`;
}

function render(services) {
  const { mqttManager, pipelines, outbox, recorder, contracts, alerts, bindings, profiles } = services;
  let out = '';
  const gauge = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} gauge\n`);
  const counter = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} counter\n`);

  gauge('manifold_process_uptime_seconds', 'Process uptime');
  out += line('manifold_process_uptime_seconds', null, process.uptime());
  gauge('manifold_process_memory_bytes', 'Process memory');
  const mem = process.memoryUsage();
  out += line('manifold_process_memory_bytes', { kind: 'rss' }, mem.rss);
  out += line('manifold_process_memory_bytes', { kind: 'heap_used' }, mem.heapUsed);
  gauge('manifold_event_loop_delay_ms', 'Event loop delay percentiles');
  out += line('manifold_event_loop_delay_ms', { quantile: '0.5' }, loopDelay.percentile(50) / 1e6);
  out += line('manifold_event_loop_delay_ms', { quantile: '0.99' }, loopDelay.percentile(99) / 1e6);
  // CPU: cumulative process CPU time as a counter; rate() turns it into
  // utilisation (1.0 = one full core). Host load, CPU count and memory give the
  // view of the machine (or container) the process runs on.
  counter('manifold_process_cpu_seconds_total', 'Process CPU time by mode');
  const cpu = process.cpuUsage();
  out += line('manifold_process_cpu_seconds_total', { mode: 'user' }, cpu.user / 1e6);
  out += line('manifold_process_cpu_seconds_total', { mode: 'system' }, cpu.system / 1e6);
  gauge('manifold_host_load_average', 'System load average');
  const [l1, l5, l15] = os.loadavg();
  out += line('manifold_host_load_average', { period: '1m' }, l1);
  out += line('manifold_host_load_average', { period: '5m' }, l5);
  out += line('manifold_host_load_average', { period: '15m' }, l15);
  gauge('manifold_host_cpus', 'Logical CPUs visible to the process');
  out += line('manifold_host_cpus', null, os.cpus().length);
  gauge('manifold_host_memory_bytes', 'Host memory');
  out += line('manifold_host_memory_bytes', { kind: 'total' }, os.totalmem());
  out += line('manifold_host_memory_bytes', { kind: 'free' }, os.freemem());

  counter('manifold_broker_messages_received_total', 'Messages received per broker');
  gauge('manifold_broker_topics', 'Distinct topics per broker');
  for (const info of mqttManager?.getConnections() || []) {
    out += line('manifold_broker_messages_received_total', { broker: info.name || info.id }, info.metrics.messagesReceived);
    out += line('manifold_broker_topics', { broker: info.name || info.id }, info.metrics.topicCount);
  }

  out += renderBrokerHealth(mqttManager);

  counter('manifold_pipeline_messages_total', 'Pipeline route counters');
  const routeNames = new Map((profiles?.listIn('pipelines') || []).map((r) => [r.id, r.name || r.id.slice(0, 8)]));
  for (const [routeId, m] of Object.entries(pipelines?.getMetrics() || {})) {
    const route = routeNames.get(routeId) || routeId.slice(0, 8);
    out += line('manifold_pipeline_messages_total', { route, result: 'matched' }, m.matched);
    // routed = handed on (for a historian: admitted to the outbox); delivered = accepted by the target
    // (for a historian: by the historian); rejected = dead-lettered/unrepresentable; pending = in flight.
    out += line('manifold_pipeline_messages_total', { route, result: 'routed' }, m.routed ?? m.published);
    out += line('manifold_pipeline_messages_total', { route, result: 'delivered' }, m.delivered ?? m.published);
    out += line('manifold_pipeline_messages_total', { route, result: 'rejected' }, m.rejected ?? 0);
    out += line('manifold_pipeline_messages_total', { route, result: 'error' }, m.errors);
    out += line('manifold_pipeline_messages_total', { route, result: 'loop_blocked' }, m.loopBlocked);
  }

  gauge('manifold_pipeline_pending_points', 'Points a route handed to its target that are still waiting (queued or spilled)');
  for (const [routeId, m] of Object.entries(pipelines?.getMetrics() || {})) {
    out += line('manifold_pipeline_pending_points', { route: routeNames.get(routeId) || routeId.slice(0, 8) }, m.pending);
  }
  gauge('manifold_outbox_queued_points', 'Historian outbox in-memory queue depth');
  gauge('manifold_outbox_pending_points', 'Historian outbox points waiting (in memory + spilled to disk)');
  gauge('manifold_outbox_spill_bytes', 'Historian outbox on-disk spill size');
  counter('manifold_outbox_points_total', 'Historian outbox point outcomes');
  for (const [id, s] of Object.entries(outbox?.getStats() || {})) {
    const historian = id.slice(0, 8);
    out += line('manifold_outbox_queued_points', { historian }, s.queued);
    out += line('manifold_outbox_pending_points', { historian }, s.pending);
    out += line('manifold_outbox_spill_bytes', { historian }, s.spillBytes);
    out += line('manifold_outbox_points_total', { historian, result: 'written' }, s.written);
    out += line('manifold_outbox_points_total', { historian, result: 'spilled' }, s.spilled);
    out += line('manifold_outbox_points_total', { historian, result: 'dropped' }, s.dropped);
    out += line('manifold_outbox_points_total', { historian, result: 'admitted' }, s.admitted);
    out += line('manifold_outbox_points_total', { historian, result: 'rejected' }, s.rejected);
  }

  counter('manifold_recorder_points_total', 'Recorder captured points');
  for (const rec of profiles?.listIn('recordings') || []) {
    out += line('manifold_recorder_points_total', { recording: rec.name || rec.id.slice(0, 8) }, recorder?.getStatus(rec.id).points ?? 0);
  }

  counter('manifold_contract_checks_total', 'Contract validations');
  counter('manifold_contract_violations_total', 'Contract violations');
  for (const [id, c] of Object.entries(contracts?.getCounters() || {})) {
    out += line('manifold_contract_checks_total', { contract: id.slice(0, 8) }, c.checked);
    out += line('manifold_contract_violations_total', { contract: id.slice(0, 8) }, c.violations);
  }

  gauge('manifold_alert_events', 'Alert events in the history ring');
  out += line('manifold_alert_events', null, alerts?.history?.length ?? 0);

  // Active alarms by state and severity (every combination is present, zero included, so alert rules on
  // these series never see "no data"). Unacknowledged = firing and not acknowledged yet.
  const am = alerts?.getMetrics?.();
  if (am) {
    gauge('manifold_alerts_active', 'Active alarms by state and severity');
    gauge('manifold_alerts_unacknowledged', 'Firing alarms nobody has acknowledged, by severity');
    let activeLines = '';
    let unackLines = '';
    for (const severity of ['info', 'warning', 'critical']) {
      for (const state of ['firing', 'breached']) {
        const n = (am.active[`${state}|${severity}|true`] || 0) + (am.active[`${state}|${severity}|false`] || 0);
        activeLines += line('manifold_alerts_active', { state, severity }, n);
      }
      unackLines += line('manifold_alerts_unacknowledged', { severity }, am.active[`firing|${severity}|false`] || 0);
    }
    out = out.replace('# HELP manifold_alerts_unacknowledged', `${activeLines}# HELP manifold_alerts_unacknowledged`) + unackLines;
    counter('manifold_alert_transitions_total', 'Alert events since start, by state and severity');
    for (const [k, n] of Object.entries(am.transitions)) {
      const [state, severity] = k.split('|');
      out += line('manifold_alert_transitions_total', { state, severity }, n);
    }
    if (am.journal) {
      gauge('manifold_alert_history_bytes', 'Size of the durable alert history on disk (both segments)');
      out += line('manifold_alert_history_bytes', null, am.journal.bytes);
      counter('manifold_alert_history_write_errors_total', 'Failed writes to the alert history file');
      out += line('manifold_alert_history_write_errors_total', null, am.journal.writeErrors);
    }
  }

  counter('manifold_binding_published_total', 'Tag binding publishes');
  counter('manifold_binding_suppressed_total', 'Tag binding samples suppressed by report-by-exception');
  counter('manifold_binding_errors_total', 'Tag binding publish errors');
  const bindingStatus = Object.entries(bindings?.getStatus() || {}).slice(0, MAX_BINDINGS);
  for (const [id, s] of bindingStatus) {
    out += line('manifold_binding_published_total', { binding: id.slice(0, 8) }, s.published);
  }
  for (const [id, s] of bindingStatus) out += line('manifold_binding_suppressed_total', { binding: id.slice(0, 8) }, s.suppressed);
  for (const [id, s] of bindingStatus) out += line('manifold_binding_errors_total', { binding: id.slice(0, 8) }, s.errors);

  out += renderDevices(services.devices);
  return out;
}

const CANARY_STATES = ['ok', 'slow', 'failing', 'not-permitted', 'pending', 'unknown'];

/** Broker canary (only brokers that opted in) and security posture finding counts. */
function renderBrokerHealth(mqttManager) {
  if (!mqttManager?.getConnections) return '';
  let out = '';
  const gauge = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} gauge\n`);
  const counter = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} counter\n`);
  const brokers = mqttManager.getConnections().map((b) => ({ id: b.id, label: b.name || b.id, canary: mqttManager.canary?.getStatus(b.id) }));
  const watched = brokers.filter((b) => b.canary && b.canary.state !== 'off');

  gauge('manifold_broker_canary_state', 'Canary state per broker (1 for the current state, 0 for the others)');
  for (const b of watched) for (const state of CANARY_STATES) out += line('manifold_broker_canary_state', { broker: b.label, state }, b.canary.state === state ? 1 : 0);
  gauge('manifold_broker_canary_success_ratio', 'Share of canary probes delivered in the rolling window');
  for (const b of watched) out += line('manifold_broker_canary_success_ratio', { broker: b.label }, b.canary.successRate);
  gauge('manifold_broker_canary_latency_ms', 'Canary publish-to-deliver latency over the rolling window');
  for (const b of watched) {
    out += line('manifold_broker_canary_latency_ms', { broker: b.label, quantile: '0.5' }, b.canary.p50Ms);
    out += line('manifold_broker_canary_latency_ms', { broker: b.label, quantile: '0.95' }, b.canary.p95Ms);
  }
  gauge('manifold_broker_canary_last_success_age_seconds', 'Seconds since the last delivered canary probe');
  for (const b of watched) out += line('manifold_broker_canary_last_success_age_seconds', { broker: b.label }, b.canary.sinceLastSuccessMs === null ? NaN : b.canary.sinceLastSuccessMs / 1000);
  counter('manifold_broker_canary_probes_total', 'Canary probes sent');
  for (const b of watched) out += line('manifold_broker_canary_probes_total', { broker: b.label }, b.canary.sent);

  gauge('manifold_broker_posture_findings', 'Security posture findings per broker by severity');
  for (const b of brokers) {
    const summary = mqttManager.getPosture?.(b.id)?.summary;
    if (!summary) continue;
    for (const severity of ['high', 'medium', 'low', 'info']) out += line('manifold_broker_posture_findings', { broker: b.label, severity }, summary[severity]);
  }
  return out;
}

// Label cardinality bounds: devices/bindings/hosts come from configuration
// (bounded by it, and capped here); exception codes and poll groups are capped
// per device so a misbehaving device cannot explode the series count.
const MAX_DEVICES = 500;
const MAX_BINDINGS = 500;
const MAX_CODES_PER_DEVICE = 16;
const MAX_GROUPS_PER_DEVICE = 16;

/** Southbound devices and driver hosts (design 4.3 "Metrics"). */
function renderDevices(devices) {
  if (!devices?.list) return '';
  let out = '';
  const gauge = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} gauge\n`);
  const counter = (n, help) => (out += `# HELP ${n} ${help}\n# TYPE ${n} counter\n`);
  let list;
  let hosts;
  try {
    list = devices.list().slice(0, MAX_DEVICES);
    hosts = devices.hosts() || {};
  } catch {
    return '';
  }
  const rows = list.map((d) => ({ labels: { device: d.name || d.id.slice(0, 8), device_id: String(d.id).slice(0, 8), protocol: d.protocol }, st: d.status || {} }));

  gauge('manifold_device_up', 'Device connection state (1 online, 0 otherwise)');
  for (const r of rows) out += line('manifold_device_up', r.labels, r.st.state === 'online' ? 1 : 0);
  counter('manifold_device_connects_total', 'Device connection attempts that succeeded');
  for (const r of rows) out += line('manifold_device_connects_total', r.labels, Number(r.st.connects));
  counter('manifold_device_requests_total', 'Device read requests sent');
  for (const r of rows) out += line('manifold_device_requests_total', r.labels, Number(r.st.requests));
  counter('manifold_device_timeouts_total', 'Device requests that hit their deadline');
  for (const r of rows) out += line('manifold_device_timeouts_total', r.labels, Number(r.st.timeouts));
  counter('manifold_device_exceptions_total', 'Device protocol exceptions by code');
  for (const r of rows) {
    for (const [code, n] of Object.entries(r.st.exceptions || {}).slice(0, MAX_CODES_PER_DEVICE)) {
      out += line('manifold_device_exceptions_total', { ...r.labels, code }, Number(n));
    }
  }
  gauge('manifold_device_cycle_ms', 'Average poll cycle time per poll group');
  counter('manifold_device_overruns_total', 'Poll cycles skipped because the previous one overran');
  for (const r of rows) {
    const groups = Object.entries(r.st.groups || {}).slice(0, MAX_GROUPS_PER_DEVICE);
    for (const [group, g] of groups) out += line('manifold_device_cycle_ms', { ...r.labels, group }, Number(g.avgCycleMs));
    for (const [group, g] of groups) out += line('manifold_device_overruns_total', { ...r.labels, group }, Number(g.overruns));
  }
  gauge('manifold_device_quarantined_tags', 'Tags currently quarantined (failing reads retried slowly)');
  for (const r of rows) out += line('manifold_device_quarantined_tags', r.labels, Array.isArray(r.st.quarantined) ? r.st.quarantined.length : 0);

  gauge('manifold_driver_host_up', 'Driver host process state (1 running)');
  counter('manifold_driver_host_restarts_total', 'Driver host process restarts');
  const hostRows = Object.entries(hosts).slice(0, MAX_DEVICES);
  for (const [id, h] of hostRows) out += line('manifold_driver_host_up', { host: id, protocol: h.protocol }, h.state === 'running' ? 1 : 0);
  for (const [id, h] of hostRows) out += line('manifold_driver_host_restarts_total', { host: id, protocol: h.protocol }, Number(h.restarts));
  return out;
}

module.exports = { render };
