const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { ClientLifecycle } = require('../services/clientLifecycle');

function fakeManager(connections = [{ id: 'b1', status: 'connected' }]) {
  const m = new EventEmitter();
  m.subs = [];
  m.getConnections = () => connections;
  m.subscribe = (brokerId, topic, qos) => m.subs.push({ brokerId, topic, qos });
  return m;
}

test('subscribes the capability probes on every connected broker', () => {
  const m = fakeManager([
    { id: 'b1', status: 'connected' },
    { id: 'b2', status: 'offline' }
  ]);
  const lc = new ClientLifecycle({ mqttManager: m });
  lc.subscribeAll();
  const topics = m.subs.map((s) => s.topic);
  assert.ok(topics.includes('$events/client_connected'));
  assert.ok(topics.includes('$SYS/broker/log/#'));
  assert.ok(m.subs.every((s) => s.brokerId === 'b1'), 'offline brokers are not probed');
});

test('parses EMQX $events JSON into typed events', () => {
  const m = fakeManager();
  const lc = new ClientLifecycle({ mqttManager: m });
  lc.onMessage(
    { brokerId: 'b1', topic: '$events/client_connected', payload: { clientid: 'sensor-1', username: 'ops', ipaddress: '10.0.0.9' } },
    1000
  );
  lc.onMessage(
    { brokerId: 'b1', topic: '$events/client_disconnected', payload: { clientid: 'sensor-1', reason: 'keepalive_timeout' } },
    2000
  );
  const r = lc.report('b1');
  assert.strictEqual(r.capability.emqxEvents, true);
  assert.strictEqual(r.events.length, 2);
  assert.strictEqual(r.events[0].type, 'disconnected'); // newest first
  assert.strictEqual(r.events[0].reason, 'keepalive_timeout');
  assert.strictEqual(r.events[1].type, 'connected');
  assert.strictEqual(r.events[1].ip, '10.0.0.9');
});

test('parses Mosquitto broker-log notices (connect, disconnect, socket error)', () => {
  const m = fakeManager();
  const lc = new ClientLifecycle({ mqttManager: m });
  const log = (line, ts) => lc.onMessage({ brokerId: 'b1', topic: '$SYS/broker/log/N', payload: line }, ts);
  log('1712345678: New client connected from 172.19.0.5:44532 as simulator-1 (p2, c1, k60).', 1000);
  log('1712345680: Client simulator-1 disconnected.', 2000);
  log('1712345681: Socket error on client simulator-2, disconnecting.', 3000);
  log('1712345682: New connection from 172.19.0.6:1234 on port 1883.', 4000); // pre-auth noise — ignored
  const r = lc.report('b1');
  assert.strictEqual(r.capability.brokerLog, true);
  assert.strictEqual(r.events.length, 3);
  const types = r.events.map((e) => `${e.clientId}:${e.type}`);
  assert.deepStrictEqual(types, ['simulator-2:disconnected', 'simulator-1:disconnected', 'simulator-1:connected']);
  assert.strictEqual(r.events[0].reason, 'socket error');
  assert.strictEqual(r.events[2].ip, '172.19.0.5:44532');
});

test('Sparkplug BIRTH/DEATH is the passive layer on any broker', () => {
  const m = fakeManager();
  const lc = new ClientLifecycle({ mqttManager: m });
  lc.onMessage({ brokerId: 'b1', topic: 'spBv1.0/Plant1/NBIRTH/Line1', payload: {} }, 1000);
  lc.onMessage({ brokerId: 'b1', topic: 'spBv1.0/Plant1/DDEATH/Line1/Robot1', payload: {} }, 2000);
  const r = lc.report('b1');
  assert.strictEqual(r.capability.sparkplug, true);
  assert.strictEqual(r.events[1].type, 'birth');
  assert.strictEqual(r.events[1].clientId, 'Plant1/Line1');
  assert.strictEqual(r.events[0].type, 'death');
  assert.strictEqual(r.events[0].clientId, 'Plant1/Line1/Robot1');
  assert.strictEqual(r.events[0].reason, 'device');
});

test('per-client rollup counts and flags flapping', () => {
  const m = fakeManager();
  const lc = new ClientLifecycle({ mqttManager: m });
  const now = 1_000_000;
  // stable client: one old connect
  lc.onMessage({ brokerId: 'b1', topic: '$events/client_connected', payload: { clientid: 'steady' } }, now - 60 * 60_000);
  // flappy client: 3 connects within the 10-minute window
  for (let i = 0; i < 3; i++) {
    lc.onMessage({ brokerId: 'b1', topic: '$events/client_connected', payload: { clientid: 'flappy' } }, now - i * 60_000);
    lc.onMessage({ brokerId: 'b1', topic: '$events/client_disconnected', payload: { clientid: 'flappy' } }, now - i * 60_000 + 1000);
  }
  const r = lc.report('b1', {}, now);
  const flappy = r.clients.find((c) => c.clientId === 'flappy');
  const steady = r.clients.find((c) => c.clientId === 'steady');
  assert.strictEqual(flappy.flapping, true);
  assert.strictEqual(flappy.connects, 3);
  assert.strictEqual(steady.flapping, false);
  assert.strictEqual(r.clients[0].clientId, 'flappy', 'flapping clients sort first');
});

test('ring stays bounded per broker', () => {
  const m = fakeManager();
  const lc = new ClientLifecycle({ mqttManager: m });
  for (let i = 0; i < 700; i++) {
    lc.onMessage({ brokerId: 'b1', topic: '$events/client_connected', payload: { clientid: `c${i}` } }, i);
  }
  const r = lc.report('b1', { limit: 1000 });
  assert.ok(r.events.length <= 500);
  assert.strictEqual(r.events[0].clientId, 'c699', 'newest survive');
});
