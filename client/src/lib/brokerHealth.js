// Broker canary, security posture and public-broker presets: the pure parts (unit tested in
// src/test/brokerHealth.test.js). The pages only render what these return.

export const CANARY_PREFIX = 'manifold/canary/';

/** The topic the server uses when none is configured (mirrors server/services/brokerCanary.js). */
export const defaultCanaryTopic = (brokerId) => `${CANARY_PREFIX}${String(brokerId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 8)}`;

const CANARY_WORD = {
  off: 'Off',
  unknown: 'Not running',
  pending: 'Waiting',
  ok: 'OK',
  slow: 'Slow',
  failing: 'Failing',
  'not-permitted': 'Not permitted'
};
const CANARY_TONE = { ok: 'good', slow: 'warn', failing: 'bad', 'not-permitted': 'warn', pending: 'neutral', unknown: 'neutral', off: 'neutral' };

export const canaryWord = (state) => CANARY_WORD[state] || String(state);
export const canaryTone = (state) => CANARY_TONE[state] || 'neutral';

/** Which half of the round trip the broker refused, in words. */
export const refusedWord = (refused) => (refused === 'subscribe' ? 'subscribe' : refused === 'publish' ? 'publish' : null);

/** "12 ms" / "1.4 s" / "n/a". */
export function ms(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v * 10) / 10} ms`;
}

/** "42 s ago" style for a duration in ms; "never" when null. */
export function sinceWord(v) {
  if (v === null || v === undefined) return 'never';
  const s = Math.round(v / 1000);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** One line for the broker list: "OK, p95 30 ms", "Not permitted (publish)", or null when the canary is off. */
export function canaryLine(c) {
  if (!c || c.state === 'off') return null;
  if (c.state === 'not-permitted') return `Not permitted (${refusedWord(c.refused) || 'unknown'})`;
  if (c.state === 'ok' || c.state === 'slow') return `${canaryWord(c.state)}, p95 ${ms(c.p95Ms)}`;
  return canaryWord(c.state);
}

/** Overview "Needs attention" items for brokers whose canary is failing or refused. Nothing otherwise. */
export function canaryAttention(brokers = []) {
  const items = [];
  for (const b of brokers) {
    const c = b.canaryState;
    if (!c || b.status !== 'connected') continue;
    if (c.state === 'failing') {
      items.push({ key: `canary-${b.id}`, tone: 'bad', what: `Broker canary ${b.name}`, detail: c.detail || 'Probe messages are not coming back', to: '/brokers' });
    } else if (c.state === 'not-permitted') {
      items.push({ key: `canary-${b.id}`, tone: 'warn', what: `Broker canary ${b.name}`, detail: `The broker refused the canary ${refusedWord(c.refused) || 'message'}: ${c.detail || 'check the ACL'}`, to: '/brokers' });
    }
  }
  return items;
}

const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'info', info: 'neutral' };
export const severityTone = (s) => SEVERITY_TONE[s] || 'neutral';

/** Compact list text from a posture summary: "1 high, 2 medium", "No findings", or "Info only". */
export function postureText(summary) {
  if (!summary) return null;
  const parts = ['high', 'medium', 'low'].filter((k) => summary[k] > 0).map((k) => `${summary[k]} ${k}`);
  if (parts.length) return parts.join(', ');
  return summary.info > 0 ? 'Info only' : 'No findings';
}

export const postureTone = (summary) => (!summary ? 'neutral' : summary.high > 0 ? 'bad' : summary.medium > 0 ? 'warn' : 'neutral');

/** The connect form's fields for a server-provided public-broker preset (see server/services/brokerPresets.js). */
export function presetToForm(preset, blank) {
  return {
    ...blank,
    name: preset.name,
    host: preset.host,
    port: preset.port,
    protocol: preset.protocol,
    mqttVersion: preset.mqttVersion ?? 4,
    subscribeFilter: preset.subscribeFilter,
    subscribeQos: preset.subscribeQos ?? 0,
    rejectUnauthorized: preset.rejectUnauthorized !== false,
    username: '',
    password: ''
  };
}

/** The `canary` object sent to the server from the form's fields. A topic equal to the default stays "unset". */
export function canaryConfigFromForm(form, brokerId) {
  const topic = (form.canaryTopic || '').trim();
  return {
    enabled: Boolean(form.canaryEnabled),
    ...(topic && topic !== defaultCanaryTopic(brokerId || '') ? { topic } : {}),
    qos: Number(form.canaryQos) || 0,
    intervalSec: Number(form.canaryIntervalSec) || 30,
    slowMs: Number(form.canarySlowMs) || 1000
  };
}

/** Form fields from a broker's stored canary config. */
export function canaryFormFromBroker(b) {
  const c = b?.canary || {};
  const isDefault = !c.topic || c.topic === defaultCanaryTopic(b?.id || '');
  return {
    canaryEnabled: c.enabled === true,
    canaryTopic: isDefault ? '' : c.topic,
    canaryQos: c.qos ?? 0,
    canaryIntervalSec: c.intervalSec ?? 30,
    canarySlowMs: c.slowMs ?? 1000
  };
}
