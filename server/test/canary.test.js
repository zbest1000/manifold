const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { BrokerCanary } = require('../services/brokerCanary');

// The canary only needs getConnections/subscribe/publish and the 'message'
// tap from the manager, so a bare fake is faithful.
function fakeManager(connections) {
  const m = new EventEmitter();
  m.conns = connections;
  m.published = [];
  m.subs = [];
  m.getConnections = () => m.conns;
  m.subscribe = (brokerId, topic, qos) => m.subs.push({ brokerId, topic, qos });
  m.publish = (brokerId, topic, payload) => {
    m.published.push({ brokerId, topic, payload });
    return Promise.resolve();
  };
  return m;
}

test('canary probes connected brokers only and records round-trips', () => {
  const m = fakeManager([
    { id: 'b1', status: 'connected' },
    { id: 'b2', status: 'reconnecting' }
  ]);
  const c = new BrokerCanary({ mqttManager: m, idSuffix: 'test' });
  c.start();

  c.tick(1000);
  assert.strictEqual(m.published.length, 1, 'only the connected broker is probed');
  assert.strictEqual(m.published[0].brokerId, 'b1');
  assert.strictEqual(m.subs[0].topic, 'manifold/canary/test');

  // The broker delivers the probe back 42ms later.
  const probe = m.published[0];
  c.onMessage({ brokerId: 'b1', topic: probe.topic, payload: probe.payload }, 1042);
  const s = c.getStats().brokers.b1;
  assert.strictEqual(s.lastRttMs, 42);
  assert.strictEqual(s.emaMs, 42);
  assert.strictEqual(s.missed, 0);
  assert.deepStrictEqual(s.samples, [42]);
  c.stop();
});

test('an unanswered probe is counted as missed on the next round', () => {
  const m = fakeManager([{ id: 'b1', status: 'connected' }]);
  const c = new BrokerCanary({ mqttManager: m, idSuffix: 'test' });
  c.tick(1000); // never answered
  c.tick(31000);
  const s = c.getStats().brokers.b1;
  assert.strictEqual(s.missed, 1);
  assert.strictEqual(s.samples[0], null, 'missed rounds leave a gap in the series');
  assert.strictEqual(s.sent, 2);
});

test('stale or foreign echoes are ignored', () => {
  const m = fakeManager([{ id: 'b1', status: 'connected' }]);
  const c = new BrokerCanary({ mqttManager: m, idSuffix: 'test' });
  c.tick(1000);
  const probe = m.published[0];
  c.onMessage({ brokerId: 'b1', topic: 'other/topic', payload: probe.payload }, 1010);
  c.onMessage({ brokerId: 'b1', topic: probe.topic, payload: { seq: 999, t: 0 } }, 1010);
  c.onMessage({ brokerId: 'b2', topic: probe.topic, payload: probe.payload }, 1010);
  assert.strictEqual(c.getStats().brokers.b1.lastRttMs, null);
  // The real echo still lands after the noise.
  c.onMessage({ brokerId: 'b1', topic: probe.topic, payload: probe.payload }, 1055);
  assert.strictEqual(c.getStats().brokers.b1.lastRttMs, 55);
});

test('a broker that disconnects takes its pending probe with it', () => {
  const m = fakeManager([{ id: 'b1', status: 'connected' }]);
  const c = new BrokerCanary({ mqttManager: m, idSuffix: 'test' });
  c.tick(1000);
  m.conns = [{ id: 'b1', status: 'offline' }];
  c.tick(31000);
  const s = c.getStats().brokers.b1;
  assert.strictEqual(s.missed, 0, 'disconnection is not a missed probe — the broker was gone, not slow');
  assert.strictEqual(s.sent, 1);
});

test('ema smooths and the sample ring stays bounded', () => {
  const m = fakeManager([{ id: 'b1', status: 'connected' }]);
  const c = new BrokerCanary({ mqttManager: m, idSuffix: 'test' });
  for (let i = 0; i < 80; i++) {
    const now = i * 30000;
    c.tick(now);
    const probe = m.published[m.published.length - 1];
    c.onMessage({ brokerId: 'b1', topic: probe.topic, payload: probe.payload }, now + 10 + (i % 5));
  }
  const s = c.getStats().brokers.b1;
  assert.ok(s.samples.length <= 60);
  assert.ok(s.emaMs >= 10 && s.emaMs <= 15);
  assert.strictEqual(s.missed, 0);
});
