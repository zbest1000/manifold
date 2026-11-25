'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { TagBindings } = require('../services/tagBindings');
const { encodePayload } = require('../services/sparkplugEncoder');
const SparkplugDecoder = require('../services/sparkplugDecoder');
const { fakeMqtt, memoryProfiles, until } = require('./support/fakeMqtt');

// A Sparkplug SOURCE mapping fed with real encoded + decoded payloads (as MqttManager hands them
// to the tap: per-metric sourceTimestamp and the Quality property as `quality`): per-metric
// quality and time, BIRTH/DEATH as source state with _status, NDEATH for the whole node.

const dec = new SparkplugDecoder();
function spMsg(topic, payload) {
  const sp = dec.decode(encodePayload(payload));
  for (const m of sp.metrics) {
    if (m.timestamp instanceof Date) m.sourceTimestamp = m.timestamp.getTime();
    const q = m.properties?.Quality;
    if (q !== undefined) m.quality = Number(q);
  }
  return { brokerId: 'b1', topic, payload: null, sparkplug: sp, timestamp: new Date().toISOString(), sourceTimestamp: sp.timestamp?.getTime() };
}

test('sparkplug source: metric quality and time, DDEATH -> Bad + offline, DBIRTH -> online, NDEATH -> offline', async () => {
  const profiles = memoryProfiles();
  const mqtt = fakeMqtt({ brokers: ['b1'] });
  const tb = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null, ledgerFile: null });
  tb.start();
  profiles.upsertIn('bindings', 's1', { id: 's1', name: 's1', source: { type: 'sparkplug', brokerId: 'b1', group: 'G', edge: 'E', device: 'D', metrics: ['Temp'] }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/sp', format: 'envelope' } });
  tb.reconcile();
  const pub = (t) => mqtt.published.filter((p) => p.topic === t).map((p) => (typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload));
  const T0 = Date.parse('2026-11-20T10:00:00Z');
  mqtt.emit('message', spMsg('spBv1.0/G/DDATA/E/D', { seq: 1, metrics: [{ name: 'Temp', value: 21.5, type: 'float64', ts: T0, properties: { Quality: 64 } }, { name: 'Other', value: 1, type: 'int32' }] }));
  await until(() => pub('uns/sp/Temp').length === 1, 2000, 'value');
  assert.deepStrictEqual(pub('uns/sp/Temp')[0], { v: 21.5, t: T0, q: 64 });
  assert.strictEqual(pub('uns/sp/_status').at(-1).online, true);
  assert.strictEqual(pub('uns/sp/Other').length, 0);

  mqtt.emit('message', spMsg('spBv1.0/G/DDEATH/E/D', { seq: 2, metrics: [] }));
  await until(() => pub('uns/sp/Temp').length === 2, 2000, 'bad on DDEATH');
  assert.strictEqual(pub('uns/sp/Temp')[1].q, 0);
  assert.deepStrictEqual([pub('uns/sp/_status').at(-1).online, pub('uns/sp/_status').at(-1).reason], [false, 'DDEATH from E/D']);
  // another device's death does not touch this mapping
  const n = mqtt.published.length;
  mqtt.emit('message', spMsg('spBv1.0/G/DDEATH/E/D2', { seq: 3, metrics: [] }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(mqtt.published.length, n);

  mqtt.emit('message', spMsg('spBv1.0/G/DBIRTH/E/D', { seq: 4, metrics: [{ name: 'Temp', value: 22, type: 'float64' }] }));
  await until(() => pub('uns/sp/_status').at(-1).online === true, 2000, 'online on DBIRTH');
  assert.strictEqual(pub('uns/sp/_status').at(-1).reason, 'birth');
  assert.strictEqual(pub('uns/sp/Temp').at(-1).v, 22);

  mqtt.emit('message', spMsg('spBv1.0/G/NDEATH/E', { metrics: [{ name: 'bdSeq', value: 0, isBdSeq: true }] }));
  await until(() => pub('uns/sp/_status').at(-1).online === false, 2000, 'offline on NDEATH');
  assert.strictEqual(tb.getStatus().s1.sourceState.state, 'offline');
  tb.stop();
});
