const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { EventEmitter } = require('events');
const Aedes = require('aedes');

const MqttManager = require('../services/mqttManager');
const { validateCanaryConfig, normalizeCanaryConfig, CANARY_PREFIX } = require('../services/brokerCanary');
const metrics = require('../services/metricsExporter');

// ---- a scripted client: no network, full control of SUBACK / PUBACK ------------------------------------------

class FakeClient extends EventEmitter {
  constructor({ subAck, pubAck } = {}) {
    super();
    this.connected = false;
    this.subs = [];
    this.published = [];
    this.subAck = subAck || ((topic, qos) => [null, [{ topic, qos }]]);
    this.pubAck = pubAck || (() => null);
  }
  subscribe(topic, opts, cb) {
    this.subs.push({ topic, qos: opts.qos });
    const [err, granted] = this.subAck(topic, opts.qos);
    setImmediate(() => cb(err, granted));
  }
  publish(topic, body, opts, cb) {
    this.published.push({ topic, body, opts });
    const err = this.pubAck(topic, body, opts);
    if (cb) setImmediate(() => cb(err));
  }
  end() {}
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function managerWith(client, config = {}) {
  const manager = new MqttManager({ emit() {} });
  manager._mqttConnect = () => client;
  manager.fake = { t: 1000 };
  manager.canary.clock = () => manager.fake.t;
  const id = manager.connectToBroker({ id: 'bk1', host: 'broker.test', port: 1883, subscribeFilter: 'plant/#', canary: { enabled: true, ...config } }).brokerId;
  client.connected = true;
  client.emit('connect');
  await settle();
  return { manager, id };
}

/** The broker echoes the canary publish back, `delay` ms of fake clock later. */
function deliver(manager, id, client, delay) {
  const last = client.published[client.published.length - 1];
  manager.fake.t += delay;
  manager.handleMessage(id, last.topic, Buffer.from(last.body), { qos: 0, retain: false });
}

test('config: defaults, validation and the default topic', () => {
  assert.strictEqual(validateCanaryConfig(undefined), null);
  assert.strictEqual(validateCanaryConfig({ enabled: true, qos: 1, intervalSec: 10, slowMs: 500 }), null);
  assert.match(validateCanaryConfig({ qos: 3 }), /qos/);
  assert.match(validateCanaryConfig({ intervalSec: 1 }), /intervalSec/);
  assert.match(validateCanaryConfig({ topic: 'a/#' }), /wildcards/);
  assert.match(validateCanaryConfig({ topic: '$SYS/x/canary' }), /\$/);
  assert.match(validateCanaryConfig({ topic: 'plant/line1/temperature' }), /cannot hide real data/);
  assert.strictEqual(validateCanaryConfig({ topic: 'plant/canary/manifold' }), null);
  const n = normalizeCanaryConfig({}, 'abcdef123456');
  assert.deepStrictEqual(n, { enabled: false, topic: `${CANARY_PREFIX}abcdef12`, qos: 0, intervalSec: 30, slowMs: 1000 });
});

test('the canary is off by default and an invalid config is refused before anything connects', () => {
  const manager = new MqttManager({ emit() {} });
  manager._mqttConnect = () => new FakeClient();
  manager.connectToBroker({ id: 'b', host: 'h' });
  assert.deepStrictEqual(manager.getCanary('b'), { state: 'off' });
  assert.strictEqual(manager.getConnection('b').canary.enabled, false);
  assert.throws(() => manager.connectToBroker({ id: 'c', host: 'h', canary: { enabled: true, qos: 7 } }), /canary\.qos/);
});

test('ok: publishes a non-retained probe, measures publish-to-deliver latency, keeps a rolling window', async () => {
  const client = new FakeClient();
  const { manager, id } = await managerWith(client, { qos: 1, slowMs: 400 });
  assert.deepStrictEqual(client.subs.find((s) => s.topic.startsWith(CANARY_PREFIX)).qos, 1);
  assert.strictEqual(manager.getCanary(id).state, 'pending');

  const rtts = [10, 20, 30, 40, 50];
  for (const r of rtts) {
    manager.canary.probe(id);
    const sent = client.published[client.published.length - 1];
    assert.strictEqual(sent.topic, `${CANARY_PREFIX}bk1`);
    assert.strictEqual(sent.opts.retain, false);
    assert.strictEqual(sent.opts.qos, 1);
    assert.ok(sent.body.length < 120, 'a small message');
    deliver(manager, id, client, r);
    await settle();
  }
  const s = manager.getCanary(id);
  assert.strictEqual(s.state, 'ok');
  assert.strictEqual(s.successRate, 1);
  assert.strictEqual(s.p50Ms, 30);
  assert.strictEqual(s.p95Ms, 50);
  assert.strictEqual(s.lastRttMs, 50);
  assert.ok(s.sinceLastSuccessMs >= 0);
  assert.strictEqual(manager.canary.summary(id).state, 'ok');

  for (let i = 0; i < 40; i++) {
    manager.canary.probe(id);
    deliver(manager, id, client, 5);
  }
  assert.strictEqual(manager.getCanary(id).window, 30, 'the window is bounded');
  manager.shutdown();
});

test('slow when the 95th percentile is above the threshold; late and duplicate deliveries are ignored', async () => {
  const client = new FakeClient();
  const { manager, id } = await managerWith(client, { slowMs: 100 });
  for (const r of [20, 30, 900]) {
    manager.canary.probe(id);
    deliver(manager, id, client, r);
  }
  assert.strictEqual(manager.getCanary(id).state, 'slow');
  assert.match(manager.getCanary(id).detail, /95th percentile 900 ms/);

  // The same delivery twice (overlapping subscriptions) and a stale probe do not add samples.
  manager.canary.probe(id);
  const stale = client.published[client.published.length - 1];
  manager.canary.probe(id); // the first probe never came back: counted as failed, a new one is in flight
  const before = manager.getCanary(id).window;
  manager.handleMessage(id, stale.topic, Buffer.from(stale.body), { qos: 0 });
  assert.strictEqual(manager.getCanary(id).window, before);
  manager.handleMessage(id, stale.topic, Buffer.from('not json'), { qos: 0 });
  assert.strictEqual(manager.getCanary(id).window, before);
  manager.shutdown();
});

test('failing after consecutive timeouts, ok again once a probe is delivered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeClient();
  const { manager, id } = await managerWith(client, { intervalSec: 5 });
  t.mock.timers.tick(500); // the first probe
  assert.strictEqual(client.published.length, 1);
  t.mock.timers.tick(4000); // the probe timeout is 80% of the interval
  assert.strictEqual(manager.getCanary(id).state, 'pending', 'one miss and nothing ever delivered is not a verdict yet');
  t.mock.timers.tick(5000); // next round
  t.mock.timers.tick(4000);
  const s = manager.getCanary(id);
  assert.strictEqual(s.state, 'failing');
  assert.match(s.detail, /no delivery within/);
  assert.match(s.detail, /publish ACL/, 'QoS 0 hints at a silent drop');
  assert.strictEqual(s.successRate, 0);
  assert.strictEqual(s.sinceLastSuccessMs, null);

  manager.canary.probe(id);
  deliver(manager, id, client, 12);
  assert.strictEqual(manager.getCanary(id).sinceLastSuccessMs >= 0, true);
  assert.notStrictEqual(manager.getCanary(id).state, 'failing', 'a delivered probe ends the consecutive failures');
  manager.shutdown();
});

test('not permitted: the broker refuses the canary subscription (SUBACK 0x80), also after the QoS 0 retry', async () => {
  const client = new FakeClient({ subAck: (topic, qos) => (topic.startsWith(CANARY_PREFIX) ? [null, [{ topic, qos: 128 }]] : [null, [{ topic, qos }]]) });
  const { manager, id } = await managerWith(client, { qos: 1 });
  const canarySubs = client.subs.filter((s) => s.topic.startsWith(CANARY_PREFIX));
  assert.deepStrictEqual(canarySubs.map((s) => s.qos), [1, 0], 'retried once at QoS 0');
  const s = manager.getCanary(id);
  assert.strictEqual(s.state, 'not-permitted');
  assert.strictEqual(s.refused, 'subscribe');
  assert.match(s.detail, /refused the subscription/);
  assert.strictEqual(client.published.length, 0, 'nothing is published without a subscription');
  manager.shutdown();
});

test('not permitted: the broker answers the publish with "not authorized" (MQTT 5 reason 135)', async () => {
  const denied = Object.assign(new Error('Publish error: Not authorized'), { code: 135 });
  const client = new FakeClient({ pubAck: () => denied });
  const { manager, id } = await managerWith(client, { qos: 1 });
  manager.canary.probe(id);
  await settle();
  const s = manager.getCanary(id);
  assert.strictEqual(s.state, 'not-permitted');
  assert.strictEqual(s.refused, 'publish');
  assert.match(s.detail, /refused to let this client publish/);
  // Another error code is a failure, not a permission verdict.
  client.pubAck = () => Object.assign(new Error('Publish error: Quota exceeded'), { code: 151 });
  manager.canary.configure(id, manager.getConnection(id).canary);
  manager.canary.onConnect(id, client);
  await settle();
  manager.canary.probe(id);
  await settle();
  assert.notStrictEqual(manager.getCanary(id).state, 'not-permitted');
  manager.shutdown();
});

test('an in-flight probe lost to a closed connection counts as a failure (brokers that disconnect on a denied publish)', async () => {
  const client = new FakeClient();
  const { manager, id } = await managerWith(client);
  for (let i = 0; i < 2; i++) {
    manager.canary.probe(id);
    client.connected = false;
    client.emit('close');
    client.connected = true;
    client.emit('connect');
    await settle();
  }
  const s = manager.canary.getStatus(id);
  assert.strictEqual(s.window, 2);
  assert.match(s.lastError, /connection closed while a probe was in flight/);
  manager.shutdown();
});

test('canary traffic never reaches the topic store, the message tap, the counters or the UNS', async () => {
  const client = new FakeClient();
  const { manager, id } = await managerWith(client, { topic: 'plant/canary/mine' });
  const tapped = [];
  manager.on('message', (m) => tapped.push(m.topic));
  const feed = (topic, body = '{}') => manager.handleMessage(id, topic, Buffer.from(body), { qos: 0, retain: false });

  feed('plant/line1/temp', '21');
  manager.canary.probe(id);
  const probe = client.published[client.published.length - 1];
  feed(probe.topic, probe.body); // own canary (custom topic)
  feed(`${CANARY_PREFIX}other-instance`, '{"canary":"manifold"}'); // another Manifold's canary on a shared broker
  manager.flushBroker(id);

  assert.deepStrictEqual(tapped, ['plant/line1/temp']);
  assert.deepStrictEqual(manager.getTopics(id).topics.map((t) => t.topic), ['plant/line1/temp']);
  assert.strictEqual(manager.getConnection(id).metrics.messagesReceived, 1);
  assert.strictEqual(manager.getTrie(id).root.children.has('manifold'), false);
  assert.strictEqual(manager.getUnsTree(id).nodes.map((n) => n.name).includes('manifold'), false);
  assert.strictEqual(manager.getMessages(id, probe.topic).length, 0);
  assert.strictEqual(manager.getCanary(id).window, 1, 'but the probe itself was delivered to the canary');
  manager.shutdown();
});

test('follows broker edits and is removed with the broker', async () => {
  const client = new FakeClient();
  const { manager, id } = await managerWith(client);
  assert.strictEqual(manager.canary.brokers.has(id), true);
  const next = new FakeClient();
  manager._mqttConnect = () => next;
  manager.updateBroker(id, { host: 'broker.test', port: 1883, subscribeFilter: 'plant/#', canary: { enabled: true, qos: 2, topic: `${CANARY_PREFIX}edited` } });
  next.connected = true;
  next.emit('connect');
  await settle();
  assert.strictEqual(manager.getConnection(id).canary.qos, 2);
  assert.ok(next.subs.some((s) => s.topic === `${CANARY_PREFIX}edited` && s.qos === 2), 'the new client subscribes to the edited topic');

  // Switching it off through an edit removes the probe.
  const third = new FakeClient();
  manager._mqttConnect = () => third;
  manager.updateBroker(id, { host: 'broker.test', port: 1883, subscribeFilter: 'plant/#' });
  assert.deepStrictEqual(manager.getCanary(id), { state: 'off' });

  manager.disconnectFromBroker(id);
  assert.strictEqual(manager.canary.brokers.size, 0);
  assert.strictEqual(manager.getCanary(id), null);
  manager.shutdown();
});

test('/metrics: canary state, latency and posture findings, only for brokers that opted in', async () => {
  const client = new FakeClient();
  const { manager, id } = await managerWith(client);
  manager.canary.probe(id);
  deliver(manager, id, client, 25);
  const other = new MqttManager({ emit() {} });
  other._mqttConnect = () => new FakeClient();
  other.connectToBroker({ id: 'quiet', host: 'h', name: 'Quiet' });
  const text = metrics.render({ mqttManager: manager });
  assert.match(text, /manifold_broker_canary_state\{broker="broker.test:1883",state="ok"\} 1/);
  assert.match(text, /manifold_broker_canary_state\{broker="broker.test:1883",state="failing"\} 0/);
  assert.match(text, /manifold_broker_canary_latency_ms\{broker="broker.test:1883",quantile="0.95"\} 25/);
  assert.match(text, /manifold_broker_canary_success_ratio\{broker="broker.test:1883"\} 1/);
  assert.match(text, /manifold_broker_posture_findings\{broker="broker.test:1883",severity="medium"\} \d/);
  assert.doesNotMatch(metrics.render({ mqttManager: other }), /manifold_broker_canary_state\{/);
  manager.shutdown();
  other.shutdown();
});

// ---- against a real in-process broker, including an ACL -------------------------------------------------------

async function startBroker(opts = {}) {
  const AedesClass = Aedes.Aedes || Aedes;
  const aedes = AedesClass.createBroker ? await AedesClass.createBroker(opts) : new AedesClass(opts);
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => {
      await new Promise((r) => aedes.close(r));
      await new Promise((r) => server.close(r));
    }
  };
}
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

test('real broker: a canary round trip reaches ok and stays out of the topic tree', async () => {
  const broker = await startBroker();
  const manager = new MqttManager({ emit() {} });
  manager.connectToBroker({ id: 'real', host: '127.0.0.1', port: broker.port, subscribeFilter: '#', canary: { enabled: true, intervalSec: 5 } });
  try {
    assert.ok(await until(() => manager.getCanary('real').state === 'ok'), 'round trip observed');
    const s = manager.getCanary('real');
    assert.ok(s.lastRttMs >= 0 && s.lastRttMs < 1000);
    manager.flushBroker('real');
    assert.ok(!manager.getTopics('real').topics.some((t) => t.topic.startsWith('manifold/')));
  } finally {
    manager.shutdown();
    await broker.close();
  }
});

test('real broker with an ACL: a refused canary subscription reads as not permitted (subscribe)', async () => {
  const broker = await startBroker({ authorizeSubscribe: (client, sub, cb) => cb(null, sub.topic.startsWith('manifold/canary/') ? null : sub) });
  const manager = new MqttManager({ emit() {} });
  manager.connectToBroker({ id: 'acl', host: '127.0.0.1', port: broker.port, subscribeFilter: 'plant/#', canary: { enabled: true } });
  try {
    assert.ok(await until(() => manager.getCanary('acl').state === 'not-permitted'));
    assert.strictEqual(manager.getCanary('acl').refused, 'subscribe');
  } finally {
    manager.shutdown();
    await broker.close();
  }
});

test('real broker with an ACL: a publish the broker answers by closing the connection reads as failing, naming the ACL', async () => {
  const broker = await startBroker({ authorizePublish: (client, packet, cb) => cb(packet.topic.startsWith('manifold/canary/') ? new Error('not authorized') : null) });
  const manager = new MqttManager({ emit() {} });
  manager.connectToBroker({ id: 'acl2', host: '127.0.0.1', port: broker.port, subscribeFilter: 'plant/#', reconnectPeriod: 100, canary: { enabled: true, qos: 1 } });
  try {
    assert.ok(await until(() => manager.canary.getStatus('acl2').window >= 2, 10_000), 'two lost probes');
    assert.match(manager.canary.getStatus('acl2').lastError, /publish ACL/);
  } finally {
    manager.shutdown();
    await broker.close();
  }
});
