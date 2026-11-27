'use strict';

/**
 * Well-known public MQTT test brokers, offered as one-click presets in the "Connect a broker" form.
 *
 * Anything published to a public broker is visible to everyone, and anyone can publish to it. They are for
 * trying Manifold out, never for plant data. A preset only fills the form: the broker is added through the
 * normal POST /api/mqtt/brokers, so the duplicate-broker refusal applies, and these are hostnames (no
 * address literals), so they pass the egress guard like any other public target.
 *
 * Intake starts on a narrow filter, not '#': a root subscription on a public broker is a firehose of
 * strangers' data. If a broker refuses a root wildcard the user later picks, the manager's root-wildcard
 * fallback ladder reports what was granted (see mqttManager `subscription-fallback`).
 *
 * Only entries whose host, port and transport are well established are listed. Not listed because they could
 * not be confirmed against the operators' pages from this build environment: the TLS and WebSocket ports of
 * test.mosquitto.org and broker.hivemq.com. Add them once checked.
 */

const WARNING =
  'Public broker: anything you publish is visible to everyone, and anyone can publish to it. Do not use it with plant data.';

const PRESETS = [
  {
    id: 'emqx',
    label: 'EMQX public broker',
    name: 'EMQX public (test)',
    host: 'broker.emqx.io',
    port: 1883,
    protocol: 'mqtt',
    transport: 'Plain TCP, not encrypted',
    note: 'Refuses a root subscription (#) by ACL; Manifold falls back to the nearest allowed filter and reports it.'
  },
  {
    id: 'emqx-tls',
    label: 'EMQX public broker (TLS)',
    name: 'EMQX public TLS (test)',
    host: 'broker.emqx.io',
    port: 8883,
    protocol: 'mqtts',
    transport: 'TLS, certificate verified',
    note: 'Encrypted in transit, but still a shared public broker.'
  },
  {
    id: 'hivemq',
    label: 'HiveMQ public broker',
    name: 'HiveMQ public (test)',
    host: 'broker.hivemq.com',
    port: 1883,
    protocol: 'mqtt',
    transport: 'Plain TCP, not encrypted',
    note: 'Busy shared broker.'
  },
  {
    id: 'mosquitto',
    label: 'Mosquitto test broker',
    name: 'Mosquitto test',
    host: 'test.mosquitto.org',
    port: 1883,
    protocol: 'mqtt',
    transport: 'Plain TCP, not encrypted, anonymous',
    note: 'Its $SYS topics are readable.'
  }
];

const INTAKE = { subscribeFilter: 'testtopic/#', subscribeQos: 0, mqttVersion: 4, rejectUnauthorized: true };

/** Presets as the API serves them: connection fields ready for the form, plus the shared warning. */
function presetList() {
  return PRESETS.map((p) => ({ ...p, ...INTAKE, warning: WARNING }));
}

module.exports = { presetList, PRESETS, WARNING };
