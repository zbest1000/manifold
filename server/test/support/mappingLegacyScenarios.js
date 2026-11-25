'use strict';

/**
 * Legacy binding scenarios for the backward-compatibility fixture
 * (test/fixtures/mapping-legacy.json). The fixture was captured from the code
 * BEFORE per-tag entries, selection rules, field choice and context existed;
 * mapping-context.test.js re-runs these scenarios and asserts byte-for-byte
 * identical topics, payloads, options and _meta documents.
 *
 * Regenerate (only when a deliberate, documented behaviour change requires it):
 *   node test/support/mappingLegacyScenarios.js > test/fixtures/mapping-legacy.json
 */

const { EventEmitter } = require('events');
const { TagBindings } = require('../../services/tagBindings');
const model = require('../../services/bindingModel');

const NOW = 1700000000000;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function memoryProfiles(data) {
  const d = { devices: {}, bindings: {}, deviceProfiles: {}, historians: {}, ...data };
  return {
    data: d,
    rev: 0,
    listIn: (c) => Object.values(d[c] || {}),
    getIn: (c, id) => (d[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      d[c][id] = { ...obj, id };
      this.rev++;
      return d[c][id];
    }
  };
}

const METER = {
  id: 'dev1',
  name: 'Meter 1',
  protocol: 'modbus-tcp',
  host: '10.0.0.5',
  pollGroups: [{ id: 'default', intervalMs: 1000 }],
  tags: [
    { key: 'temp', address: 'holding:100', type: 'float32', unit: 'degC', property: 'temperature', description: 'Supply temp', range: { min: 0, max: 200 } },
    { key: 'count', address: '40103', type: 'uint16' },
    { key: 'raw', address: 'holding:5', type: 'uint16', property: '40005' }
  ]
};

const PROFILE = {
  id: 'pm',
  name: 'Power meter',
  protocol: 'modbus-tcp',
  pollGroups: [{ id: 'default', intervalMs: 1000 }],
  params: [{ name: 'line' }],
  tags: [
    { key: 'kw', address: 'holding:10', type: 'float32', property: 'activePower', unit: 'kW', range: { min: 0, max: 500 } },
    { key: 'pf', address: 'holding:12', type: 'float32', property: 'powerFactor' }
  ]
};
const inst = (id, name, line) => ({ id, name, protocol: 'modbus-tcp', host: '10.0.0.9', profileId: 'pm', params: { line }, tags: [], pollGroups: [] });

const SCENARIOS = {
  envelopeAssetPath: {
    id: 'b1',
    enabled: true,
    source: { type: 'device', deviceId: 'dev1', tags: ['temp', 'count', { address: 'raw', name: 'rawCount' }] },
    target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPath: 'acme/dallas/meter1', retain: true },
    rbe: { deadband: { type: 'absolute', value: 0.5 } }
  },
  plainTemplate: {
    id: 'b2',
    enabled: true,
    source: { type: 'device', deviceId: 'dev1', tags: 'all' },
    target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'legacy/meter/{name}' }
  },
  objectPerAsset: {
    id: 'b3',
    enabled: true,
    source: { type: 'device', deviceId: 'dev1', tags: ['temp', 'count'] },
    target: { mode: 'mqtt', brokerId: 'br', assetPath: 'acme/obj', layout: 'object-per-asset', retain: true }
  },
  profileAll: {
    id: 'pb',
    enabled: true,
    source: { type: 'device-profile', profileId: 'pm', tags: 'all' },
    target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPathTemplate: 'acme/{line}/{device}', assetPaths: { m3: 'acme/special/meter3' } }
  },
  sparkplug: {
    id: 'b5',
    enabled: true,
    source: { type: 'device', deviceId: 'dev1', tags: ['temp', 'count'] },
    target: { mode: 'sparkplug', brokerId: 'br', group: 'G', edge: 'E', device: 'M1' }
  }
};

async function runScenario(name) {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const b = SCENARIOS[name];
    const profiles = memoryProfiles({
      devices: { dev1: METER, m1: inst('m1', 'Meter 1', 'l1'), m2: inst('m2', 'Meter 2', 'l2'), m3: inst('m3', 'Meter 3', 'l1') },
      deviceProfiles: { pm: PROFILE },
      bindings: { [b.id]: b }
    });
    const out = { publishes: [], sparkplug: [] };
    const mqtt = new EventEmitter();
    mqtt.publish = async (brokerId, topic, payload, opts) => {
      out.publishes.push({ brokerId, topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), opts });
    };
    const spb = {
      updateDevice: (x) => out.sparkplug.push(JSON.parse(JSON.stringify(x))),
      setDeviceOnline: (x) => out.sparkplug.push({ online: x })
    };
    const src = new EventEmitter();
    src.ensureMonitored = async () => {};
    const sample = (dev, key, v, type = 'float32', t = NOW - 100) =>
      src.emit('sample', { sourceType: 'device', sourceId: dev, address: key, v, type, q: 192, tRead: t });
    const tb = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: spb, objectFlushMs: 5 });
    tb.registerSource('device', src);
    tb.start();
    await tick();
    for (const dev of ['dev1', 'm1', 'm2', 'm3']) src.emit('source-state', { sourceType: 'device', sourceId: dev, state: 'online', reason: null });
    for (const dev of ['dev1']) {
      sample(dev, 'temp', 21.5);
      sample(dev, 'temp', 21.7); // inside the 0.5 deadband where one applies
      sample(dev, 'temp', 23);
      sample(dev, 'count', 7, 'uint16');
      sample(dev, 'raw', 3, 'uint16');
      src.emit('batch-end', { sourceType: 'device', sourceId: dev });
    }
    for (const dev of ['m1', 'm2', 'm3']) {
      sample(dev, 'kw', 10.25);
      sample(dev, 'pf', 0.97);
    }
    await tick(20);
    src.emit('source-state', { sourceType: 'device', sourceId: 'dev1', state: 'offline', reason: 'timeout' });
    src.emit('source-state', { sourceType: 'device', sourceId: 'm1', state: 'offline', reason: 'timeout' });
    await tick(20);
    tb.stop();
    out.retained = model.retainedTopics(b, profiles);
    out.dataTopics = model.dataTopics(b, profiles);
    out.metaDocs = model.expandUnits(b, profiles).map((u) => model.metaDoc(u));
    out.preview = JSON.parse(JSON.stringify(model.previewBinding(b, profiles, { latest: (unit, address) => (address === 'temp' ? { v: 1.5, q: 192, t: NOW - 5, type: 'float32' } : null) })));
    out.warnings = model.bindingWarnings(b, profiles);
    return out;
  } finally {
    Date.now = realNow;
  }
}

async function runAll() {
  const out = {};
  for (const name of Object.keys(SCENARIOS)) out[name] = await runScenario(name);
  return out;
}

module.exports = { SCENARIOS, runScenario, runAll, NOW };

if (require.main === module) {
  runAll().then((r) => process.stdout.write(`${JSON.stringify(r, null, 1)}\n`));
}
