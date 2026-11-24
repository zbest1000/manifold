'use strict';

// Hot-path correctness: Sparkplug messages must survive the 100 ms coalescing
// window, growth must stay bounded and visible, and broker lifecycle edits
// must not destroy a working connection. See docs/REVIEW-2026-11.md, server
// findings 3, 9, 10, 11, 13 and 15.

const { test } = require('node:test');
const assert = require('node:assert');

const MqttManager = require('../services/mqttManager');
const TopicStore = require('../services/topicStore');
const SparkplugDecoder = require('../services/sparkplugDecoder');
const { encodePayload } = require('../services/sparkplugEncoder');

const pkt = { qos: 0, retain: false };

function fakeClient(extra = {}) {
  const handlers = {};
  return {
    handlers,
    connected: true,
    ended: 0,
    on(ev, fn) { handlers[ev] = fn; },
    end() { this.ended++; },
    subscribe(topic, opts, cb) { cb?.(null, [{ topic, qos: opts.qos }]); },
    publish(topic, body, opts, cb) { cb?.(null); },
    ...extra
  };
}

function mk(io) {
  const events = [];
  const m = new MqttManager(io || { emit: (ev, d) => events.push({ ev, d }), engine: { clientsCount: 1 } });
  clearInterval(m.batchTimer); // flush explicitly — no timing races
  const clients = [];
  m._mqttConnect = () => {
    const c = fakeClient();
    clients.push(c);
    return c;
  };
  return { m, events, clients };
}

function connected(m, id = 'b', cfg = {}) {
  m.connectToBroker({ id, host: 'h', ...cfg });
  m.connections.get(id).status = 'connected';
}

// ---- 1. Sparkplug metric loss under coalescing ------------------------------

test('a DDATA burst on one topic inside one flush window reaches registry and tap in full', () => {
  const { m, events } = mk();
  connected(m);
  const tapped = [];
  m.on('message', (msg) => tapped.push(msg));

  const topic = 'spBv1.0/G/DDATA/E/D';
  m.handleMessage('b', 'spBv1.0/G/NBIRTH/E', encodePayload({ metrics: [{ name: 'bdSeq', value: 0, isBdSeq: true }], seq: 0 }), pkt);
  for (let i = 0; i < 10; i++) {
    // Disjoint metrics per message: report-by-exception, exactly what NDATA/DDATA do.
    m.handleMessage('b', topic, encodePayload({ metrics: [{ name: `m${i}`, value: i * 10 }], seq: i + 1 }), pkt);
  }
  m.flushBroker('b'); // ONE flush covers all eleven messages

  // (a) the registry saw every metric
  const dev = m.getSparkplug('b').groups[0].edgeNodes[0].devices[0];
  for (let i = 0; i < 10; i++) assert.ok(dev.metrics.includes(`m${i}`), `registry lost metric m${i}`);
  assert.strictEqual(dev.msgCount, 10, 'registry must count every DDATA');

  // (b) a tap consumer saw every metric, with its value, in publish order
  const seen = [];
  for (const msg of tapped) {
    if (msg.topic !== topic) continue;
    for (const mt of msg.sparkplug.metrics) seen.push([mt.name, mt.value]);
  }
  assert.deepStrictEqual(seen, Array.from({ length: 10 }, (_, i) => [`m${i}`, i * 10]));

  // seq handling saw every message: 0 (NBIRTH) then 1..10 is gap-free
  const edge = m.getSparkplug('b').groups[0].edgeNodes[0];
  assert.strictEqual(edge.seqGaps, 0);
  assert.strictEqual(edge.lastSeq, 10);

  // the UI batch still carries only the latest value per topic
  const batches = events.filter((e) => e.ev === 'mqtt-messages');
  assert.strictEqual(batches.length, 1);
  const forTopic = batches[0].d.filter((x) => x.topic === topic);
  assert.strictEqual(forTopic.length, 1);
  assert.strictEqual(forTopic[0].sparkplug.metrics[0].name, 'm9');
  m.shutdown();
});

test('seq gap detection counts a missing Sparkplug sequence number', () => {
  const { m } = mk();
  connected(m);
  m.handleMessage('b', 'spBv1.0/G/NBIRTH/E', encodePayload({ metrics: [], seq: 0 }), pkt);
  m.handleMessage('b', 'spBv1.0/G/NDATA/E', encodePayload({ metrics: [{ name: 'a', value: 1 }], seq: 1 }), pkt);
  m.handleMessage('b', 'spBv1.0/G/NDATA/E', encodePayload({ metrics: [{ name: 'a', value: 2 }], seq: 3 }), pkt); // 2 lost upstream
  m.flushBroker('b');
  const sp = m.getSparkplug('b');
  assert.strictEqual(sp.groups[0].edgeNodes[0].seqGaps, 1);
  assert.strictEqual(sp.summary.seqGaps, 1);
  m.shutdown();
});

test('BIRTH and DEATH in one window are both seen, in order', () => {
  const { m } = mk();
  connected(m);
  m.handleMessage('b', 'spBv1.0/G/DBIRTH/E/D', encodePayload({ metrics: [{ name: 'x', value: 1 }], seq: 1 }), pkt);
  m.handleMessage('b', 'spBv1.0/G/DDEATH/E/D', encodePayload({ metrics: [], seq: 2 }), pkt);
  m.handleMessage('b', 'spBv1.0/G/DBIRTH/E/D', encodePayload({ metrics: [{ name: 'x', value: 1 }], seq: 3 }), pkt);
  m.flushBroker('b');
  const types = m.getNamespaceEvents('b').events.filter((e) => e.type.startsWith('device-')).map((e) => e.type);
  assert.deepStrictEqual(types.sort(), ['device-birth', 'device-birth', 'device-death']);
  m.shutdown();
});

test('Sparkplug queue overflow degrades to latest-wins and is counted', () => {
  const { m } = mk();
  connected(m);
  const store = m.stores.get('b');
  store.sparkQueueMax = 3;
  const tapped = [];
  m.on('message', (msg) => tapped.push(msg));
  const topic = 'spBv1.0/G/DDATA/E/D';
  for (let i = 0; i < 10; i++) {
    m.handleMessage('b', topic, encodePayload({ metrics: [{ name: `m${i}`, value: i }], seq: i }), pkt);
  }
  m.flushBroker('b');
  const names = tapped.map((t) => t.sparkplug.metrics[0].name);
  // first three queued in order, then the latest (never lost, never out of order)
  assert.deepStrictEqual(names, ['m0', 'm1', 'm2', 'm9']);
  assert.strictEqual(store.sparkOverflow, 7);
  assert.strictEqual(m.getConnection('b').metrics.sparkplugCoalesced, 7);

  // byte cap too
  store.sparkQueueMax = 1000;
  store.sparkQueueMaxBytes = 1; // nothing fits
  tapped.length = 0;
  m.handleMessage('b', topic, encodePayload({ metrics: [{ name: 'q1', value: 1 }] }), pkt);
  m.handleMessage('b', topic, encodePayload({ metrics: [{ name: 'q2', value: 2 }] }), pkt);
  m.flushBroker('b');
  assert.deepStrictEqual(tapped.map((t) => t.sparkplug.metrics[0].name), ['q2']);
  m.shutdown();
});

test('non-Sparkplug topics stay coalesced (one tap message per topic per flush)', () => {
  const { m } = mk();
  connected(m);
  const tapped = [];
  m.on('message', (msg) => tapped.push(msg));
  for (let i = 0; i < 100; i++) m.handleMessage('b', 'plant/a/temp', Buffer.from(String(i)), pkt);
  m.flushBroker('b');
  assert.strictEqual(tapped.length, 1);
  assert.strictEqual(tapped[0].payload, 99);
  assert.strictEqual(m.stores.get('b').sparkQueueLength(), 0);
  m.shutdown();
});

// ---- 2. Unbounded growth ----------------------------------------------------

test('msgProps is not recorded for topics dropped by the store cap, and is bounded', () => {
  const { m } = mk();
  connected(m, 'b', { mqttVersion: 5 });
  const store = m.stores.get('b');
  store.maxTopics = 1;
  const props = { properties: { contentType: 'text/plain' }, qos: 0, retain: false };
  m.handleMessage('b', 'a', Buffer.from('1'), props);
  m.handleMessage('b', 'b', Buffer.from('1'), props); // dropped by the cap
  assert.strictEqual(m.msgProps.get('b').size, 1);
  assert.ok(!m.msgProps.get('b').has('b'));

  store.maxTopics = 1_000_000;
  m.maxMsgProps = 5;
  for (let i = 0; i < 20; i++) m.handleMessage('b', `t${i}`, Buffer.from('1'), props);
  assert.ok(m.msgProps.get('b').size <= 5, `msgProps grew to ${m.msgProps.get('b').size}`);
  assert.ok(m.getConnection('b').metrics.droppedProps > 0);
  m.shutdown();
});

test('reaching the topic cap is a counted, surfaced state', () => {
  const { m, events } = mk();
  connected(m);
  const store = m.stores.get('b');
  store.maxTopics = 2;
  for (const t of ['a', 'b', 'c', 'd']) m.handleMessage('b', t, Buffer.from('1'), pkt);
  assert.strictEqual(store.dropped, 2);
  assert.strictEqual(store.capReached, true);
  assert.strictEqual(store.events.filter((e) => e.type === 'topic-cap-reached').length, 1, 'one namespace event, not one per drop');
  m.emitStats();
  const stats = events.find((e) => e.ev === 'broker-stats').d[0];
  assert.strictEqual(stats.metrics.topicCapReached, true);
  assert.strictEqual(stats.metrics.droppedTopics, 2);
  assert.strictEqual(m.getTopics('b').capReached, true);
  m.shutdown();
});

test('idle-topic TTL eviction frees slots and keeps trie, meta and props consistent', () => {
  const { m } = mk();
  connected(m, 'b', { mqttVersion: 5 });
  const store = m.stores.get('b');
  const props = { properties: { contentType: 'x' }, qos: 0, retain: false };
  m.handleMessage('b', 'spBv1.0/G/NDATA/E', encodePayload({ metrics: [] }), props);
  m.handleMessage('b', 'plant/keep', Buffer.from('1'), pkt);
  m.flushBroker('b');
  assert.strictEqual(m.getTrie('b').resolve('#').matchCount, 2);
  const oldSlot = store.index.get('spBv1.0/G/NDATA/E');

  // Age the Sparkplug topic past the TTL; keep the other fresh.
  store.ts[oldSlot] = Date.now() - 10_000;
  const evicted = m.evictIdleTopics('b', { ttlMs: 5_000 });
  assert.strictEqual(evicted, 1);
  assert.strictEqual(store.topicCount(), 1);
  assert.ok(!m.msgProps.get('b').has('spBv1.0/G/NDATA/E'));
  assert.strictEqual(m.getTrie('b').resolve('spBv1.0/#').matchCount, 0);
  assert.strictEqual(store.evicted, 1);

  // A new plain topic reuses the slot: it must not inherit Sparkplug classification.
  m.handleMessage('b', 'plant/new', Buffer.from('{"v":2}'), pkt);
  assert.strictEqual(store.index.get('plant/new'), oldSlot);
  const tapped = [];
  m.on('message', (msg) => tapped.push(msg));
  m.flushBroker('b');
  assert.strictEqual(tapped[0].topic, 'plant/new');
  assert.notStrictEqual(tapped[0].type, 'sparkplug');
  assert.strictEqual(m.getTrie('b').resolve('plant/+').matchCount, 2);
  assert.strictEqual(m.getTopicChildren('b', 'plant').children.length, 2);
  m.shutdown();
});

// ---- 3. branch-silent in O(depth) --------------------------------------------

test('branchLastActivity reads a cached per-node max instead of walking the subtree', () => {
  const { m } = mk();
  connected(m);
  for (let i = 0; i < 50; i++) m.handleMessage('b', `plant/a/dev${i}`, Buffer.from('1'), pkt);
  m.handleMessage('b', 'plant/b/x', Buffer.from('1'), pkt);
  m.flushBroker('b');
  const store = m.stores.get('b');
  const trie = m.getTrie('b');
  // Walking would visit 50 leaves; the cached path must not iterate children at all.
  const node = trie.root.children.get('plant').children.get('a');
  const realValues = node.children.values.bind(node.children);
  let walked = 0;
  node.children.values = () => { walked++; return realValues(); };
  const t = m.branchLastActivity('b', 'plant/a');
  assert.strictEqual(walked, 0, 'branchLastActivity walked the subtree');
  let max = 0;
  for (let i = 0; i < 50; i++) max = Math.max(max, store.ts[store.index.get(`plant/a/dev${i}`)]);
  assert.strictEqual(t, max);

  // New activity on one leaf propagates to every ancestor after the flush.
  const later = Date.now() + 5000;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    m.handleMessage('b', 'plant/a/dev7', Buffer.from('2'), pkt);
    m.flushBroker('b');
  } finally {
    Date.now = realNow;
  }
  assert.strictEqual(m.branchLastActivity('b', 'plant/a'), later);
  assert.strictEqual(m.branchLastActivity('b', 'plant'), later);
  assert.strictEqual(m.branchLastActivity('b', ''), later);
  assert.ok(m.branchLastActivity('b', 'plant/b') < later);
  assert.strictEqual(m.branchLastActivity('b', 'nope'), 0);
  m.shutdown();
});

// ---- 4. updateBroker validates before tearing down --------------------------

test('updateBroker with an invalid config keeps the working connection', () => {
  const { m, clients } = mk();
  connected(m);
  assert.throws(() => m.updateBroker('b', { host: 'h', protocol: 'http' }), /protocol/);
  assert.throws(() => m.updateBroker('b', { host: 'h', port: 70000 }), /port/);
  assert.throws(() => m.updateBroker('b', { host: 'h', port: 'abc' }), /port/);
  assert.ok(m.connections.has('b'), 'connection was torn down by an invalid edit');
  assert.strictEqual(clients[0].ended, 0);
  assert.strictEqual(m.getConnection('b').status, 'connected');
  // A valid edit still swaps.
  m.updateBroker('b', { host: 'h2', port: 1884 });
  assert.strictEqual(clients[0].ended, 1);
  assert.strictEqual(m.getConnection('b').host, 'h2');
  m.shutdown();
});

// ---- 5. Subscribe retry and status transitions -------------------------------

test('transient subscribe failures are retried with a bound', async () => {
  const { m, events } = mk();
  connected(m);
  m.subscribeRetryBaseMs = 1;
  let calls = 0;
  m.clients.get('b').subscribe = (topic, opts, cb) => {
    calls++;
    if (calls < 3) cb(new Error('connection busy'));
    else cb(null, [{ topic, qos: opts.qos }]);
  };
  m.subscribe('b', 'plant/#', 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls, 3);
  assert.ok(m.subscriptions.get('b').has('plant/#'));

  // Permanent failure: bounded attempts, then a surfaced error.
  calls = 0;
  m.clients.get('b').subscribe = (topic, opts, cb) => { calls++; cb(new Error('nope')); };
  m.subscribe('b', 'other/#', 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(calls, 1 + m.subscribeRetries);
  assert.strictEqual(events.filter((e) => e.ev === 'subscription-error' && e.d.topic === 'other/#').length, 1);
  m.shutdown();
});

test('a transient error does not leave status at error after the socket closes', () => {
  const { m, clients } = mk();
  m.connectToBroker({ id: 'b', host: 'h' });
  const c = clients[0];
  c.handlers.connect();
  // An error while the session stays up is recorded, not a status change.
  c.handlers.error(new Error('protocol hiccup'));
  assert.strictEqual(m.getConnection('b').status, 'connected');
  assert.strictEqual(m.getConnection('b').lastError, 'protocol hiccup');
  // An error with the socket down, followed by close -> offline (will reconnect).
  c.connected = false;
  c.handlers.error(new Error('ECONNRESET'));
  assert.strictEqual(m.getConnection('b').status, 'error');
  c.handlers.close();
  assert.strictEqual(m.getConnection('b').status, 'offline');
  // Giving up after max retries stays a terminal error through close.
  m.connections.get('b').maxReconnect = 1;
  c.handlers.reconnect();
  c.handlers.reconnect();
  c.handlers.close();
  assert.strictEqual(m.getConnection('b').status, 'error');
  m.shutdown();
});

// ---- 6. publish-success is rate-bounded ---------------------------------------

test('publish-success is coalesced into a bounded-rate summary', async () => {
  const { m, events } = mk();
  connected(m);
  await Promise.all(Array.from({ length: 100 }, (_, i) => m.publish('b', `out/${i}`, 'x')));
  const before = events.filter((e) => e.ev === 'publish-success');
  assert.ok(before.length <= 1, `${before.length} publish-success emits for 100 publishes`);
  m.flushPublishSummary();
  const all = events.filter((e) => e.ev === 'publish-success');
  assert.strictEqual(all.length, 2);
  const total = all.reduce((n, e) => n + (e.d.count || 1), 0);
  assert.strictEqual(total, 100);
  assert.strictEqual(all[1].d.topic, 'out/99'); // client-compatible shape: { brokerId, topic }
  assert.strictEqual(all[1].d.brokerId, 'b');
  assert.strictEqual(m.getConnection('b').metrics.messagesSent, 100);
  m.flushPublishSummary(); // idle window emits nothing
  assert.strictEqual(events.filter((e) => e.ev === 'publish-success').length, 2);
  m.shutdown();
});

// ---- 7. Source timestamp and quality ------------------------------------------

test('TVQ envelopes and Sparkplug metrics surface source timestamp and quality', () => {
  const { m } = mk();
  connected(m);
  const tapped = [];
  m.on('message', (msg) => tapped.push(msg));
  m.handleMessage('b', 'uns/a/temp', Buffer.from(JSON.stringify({ v: 21.5, t: 1700000000000, q: 0 })), pkt);
  m.handleMessage('b', 'uns/a/plain', Buffer.from(JSON.stringify({ v: 1, other: 2, more: 3, x: 4 })), pkt);

  const dec = new SparkplugDecoder();
  const buf = Buffer.from(dec.Payload.encode(dec.Payload.create({
    timestamp: 1700000001000,
    seq: 0,
    metrics: [
      { name: 'bad', timestamp: 1700000000500, datatype: 3, int_value: 7, properties: { keys: ['Quality'], values: [{ type: 3, int_value: 0 }] } },
      { name: 'good', timestamp: 1700000000600, datatype: 3, int_value: 8 }
    ]
  })).finish());
  m.handleMessage('b', 'spBv1.0/G/NDATA/E', buf, pkt);
  m.flushBroker('b');

  const tvq = tapped.find((t) => t.topic === 'uns/a/temp');
  assert.strictEqual(tvq.sourceTimestamp, 1700000000000);
  assert.strictEqual(tvq.quality, 0);
  const plain = tapped.find((t) => t.topic === 'uns/a/plain');
  assert.strictEqual(plain.sourceTimestamp, undefined);
  assert.strictEqual(plain.quality, undefined);

  const sp = tapped.find((t) => t.topic === 'spBv1.0/G/NDATA/E');
  assert.strictEqual(sp.sourceTimestamp, 1700000001000);
  const [bad, good] = sp.sparkplug.metrics;
  assert.strictEqual(bad.quality, 0);
  assert.strictEqual(bad.sourceTimestamp, 1700000000500);
  assert.strictEqual(good.quality, undefined); // not declared -> consumer default
  assert.strictEqual(good.sourceTimestamp, 1700000000600);
  m.shutdown();
});

test('TopicStore without a classifier never queues (plain stores unchanged)', () => {
  const s = new TopicStore();
  for (let i = 0; i < 10; i++) s.ingest('spBv1.0/G/NDATA/E', Buffer.from('x'), 0, false);
  assert.strictEqual(s.sparkQueueLength(), 0);
  assert.strictEqual(s.drain().length, 1);
});

test('the JSON pre-check classifies payloads exactly as a bare JSON.parse would', () => {
  const { m } = mk();
  connected(m);
  const cases = ['{"a":1}', ' 42', '\n[1,2]', '"s"', '-1.5', 'true', 'false', 'null', 'nul', 'hello', '', '   ', '{bad', Buffer.from([0x08, 0xff, 0xfe, 0x01])];
  for (const c of cases) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    const store = m.stores.get('b');
    store.ingest('plain/x', buf, 0, false);
    const msg = m.buildMessage('b', store.getLatest('plain/x'));
    const text = buf.toString('utf8');
    let expected;
    try {
      expected = { payload: JSON.parse(text), payloadFormat: 'json' };
    } catch {
      expected = text.includes('�') ? { payload: buf.toString('base64'), payloadFormat: 'binary' } : { payload: text, payloadFormat: 'text' };
    }
    assert.deepStrictEqual({ payload: msg.payload, payloadFormat: msg.payloadFormat }, expected, `payload ${JSON.stringify(text)}`);
  }
  m.shutdown();
});
