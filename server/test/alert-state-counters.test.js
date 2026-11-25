'use strict';

// Item 6 (real per-rule alert state) and item 3 (route counters that do not lie for historian targets).

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { AlertEngine } = require('../services/alertEngine');
const { PipelineEngine } = require('../services/pipelineEngine');
const HistorianOutbox = require('../services/historianOutbox');
const metricsExporter = require('../services/metricsExporter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeIo = () => {
  const events = [];
  return { emit: (ev, data) => events.push({ ev, data }), events };
};

// ---- alert rule state --------------------------------------------------------------

function alertSetup(rule, extra = {}) {
  const rules = [{ id: 'r1', type: 'value-threshold', brokerId: 'b1', topic: 'p/t', op: '>', value: 10, sustainMs: 0, ...rule }];
  const io = fakeIo();
  const manager = { getConnection: () => ({}), on() {}, off() {}, stores: new Map(), ...extra };
  const profiles = { alertRules: () => rules, getBroker: () => ({}), brokers: () => [{ config: { id: 'b1' } }] };
  const eng = new AlertEngine({ io, profiles, mqttManager: manager, fetchImpl: null });
  return { eng, io, rules };
}
const msg = (v, topic = 'p/t') => ({ brokerId: 'b1', topic, payload: String(v) === 'x' ? 'x' : v });

test('a breached rule inside sustainMs reports breached with a countdown, then firing', () => {
  const { eng, io, rules } = alertSetup({ sustainMs: 10_000 });
  const t0 = 1_000_000;
  assert.strictEqual(eng.getRuleState(rules[0], t0).state, 'idle');

  eng.onMessage(msg(50), t0);
  let st = eng.getRuleState(rules[0], t0 + 3000);
  assert.strictEqual(st.state, 'breached');
  assert.strictEqual(st.value, 50);
  assert.strictEqual(st.since, t0);
  assert.strictEqual(st.remainingMs, 7000);
  assert.strictEqual(st.topic, 'p/t');
  assert.ok(io.events.some((e) => e.ev === 'alert-state' && e.data.state === 'breached'), 'the breach start is pushed on the socket');
  assert.strictEqual(io.events.filter((e) => e.ev === 'alert').length, 0, 'not firing yet');

  eng.onMessage(msg(55), t0 + 10_000);
  st = eng.getRuleState(rules[0], t0 + 10_001);
  assert.strictEqual(st.state, 'firing');
  assert.strictEqual(st.since, t0 + 10_000);
  assert.strictEqual(st.lastTransition.status, 'firing');
  assert.strictEqual(st.firingTopics, 1);

  eng.onMessage(msg(1), t0 + 11_000);
  st = eng.getRuleState(rules[0], t0 + 11_001);
  assert.strictEqual(st.state, 'idle');
  assert.strictEqual(st.lastTransition.status, 'resolved');
  eng.stop();
});

test('a breach that ends inside the sustain window goes back to idle and never fires', () => {
  const { eng, io, rules } = alertSetup({ sustainMs: 10_000 });
  eng.onMessage(msg(50), 1000);
  eng.onMessage(msg(1), 4000);
  assert.strictEqual(eng.getRuleState(rules[0], 4001).state, 'idle');
  assert.strictEqual(io.events.filter((e) => e.ev === 'alert').length, 0);
  eng.stop();
});

test('a breached value that simply stays put still fires when sustainMs elapses (no further message needed)', async () => {
  const { eng, io, rules } = alertSetup({ sustainMs: 120 });
  eng.onMessage(msg(50), Date.now());
  assert.strictEqual(eng.getRuleState(rules[0]).state, 'breached');
  await sleep(250);
  assert.strictEqual(eng.getRuleState(rules[0]).state, 'firing', 'the timer promoted it');
  assert.strictEqual(io.events.filter((e) => e.ev === 'alert' && e.data.status === 'firing').length, 1);
  eng.stop();
});

test('an edit that lengthens sustainMs re-arms the timer instead of firing early; disabling cancels it', async () => {
  const { eng, io, rules } = alertSetup({ sustainMs: 100 });
  eng.onMessage(msg(50), Date.now());
  rules[0].sustainMs = 400; // the operator edits the rule while it is breached
  await sleep(200);
  assert.strictEqual(eng.getRuleState(rules[0]).state, 'breached', 'not due yet under the new value');
  rules[0].enabled = false;
  await sleep(350);
  assert.strictEqual(io.events.filter((e) => e.ev === 'alert').length, 0, 'a disabled rule never fires');
  assert.strictEqual(eng.getRuleState(rules[0]).state, 'disabled');
  eng.stop();
});

test('disabled, broken, silent-firing states and webhook health', async () => {
  const { eng, rules } = alertSetup({ enabled: false });
  assert.strictEqual(eng.getRuleState(rules[0]).state, 'disabled');

  const gone = alertSetup({ brokerId: 'nope' });
  gone.eng.profiles.getBroker = () => null;
  gone.eng.profiles.brokers = () => [];
  gone.eng.manager.getConnection = () => null;
  const st = gone.eng.getRuleState(gone.rules[0]);
  assert.strictEqual(st.state, 'broken');
  assert.deepStrictEqual(st.broken, [{ kind: 'broker', id: 'nope', field: 'brokerId' }]);

  // webhook health: configured, failing, recovering; the URL is never part of the state
  let ok = false;
  const rulesW = [{ id: 'w', type: 'value-threshold', brokerId: 'b1', topic: 'p/t', op: '>', value: 10, webhookUrl: 'https://hooks.example/secret-path' }];
  const profiles = { alertRules: () => rulesW, getBroker: () => ({}) };
  const e2 = new AlertEngine({
    io: fakeIo(),
    profiles,
    mqttManager: { getConnection: () => ({}), on() {}, off() {} },
    fetchImpl: async () => {
      if (!ok) throw new Error('connect ECONNREFUSED');
      return { ok: true, status: 200 };
    }
  });
  e2.onMessage(msg(50), 1000);
  await sleep(20);
  let wh = e2.getRuleState(rulesW[0]).webhook;
  assert.strictEqual(wh.configured, true);
  assert.strictEqual(wh.failures, 1);
  assert.match(wh.lastError, /ECONNREFUSED/);
  ok = true;
  e2.onMessage(msg(1), 2000); // resolves -> second delivery
  await sleep(20);
  wh = e2.getRuleState(rulesW[0]).webhook;
  assert.ok(wh.lastOkAt);
  assert.strictEqual(wh.lastError, null);
  assert.ok(!JSON.stringify(e2.getRuleState(rulesW[0])).includes('secret-path'));
  assert.strictEqual(e2.getEvents(10, { ruleId: 'w' }).length, 2);
  assert.strictEqual(e2.getEvents(10, { ruleId: 'other' }).length, 0);
  e2.stop();
});

// ---- route counters ----------------------------------------------------------------

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-cnt-'));
const ok204 = { ok: true, status: 204, text: async () => '' };
const reject400 = { ok: false, status: 400, text: async () => 'field type conflict' };

test('historian target: routed counts admission, delivered/rejected/pending count what the historian did', async () => {
  const hist = { id: 'h', type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'b' };
  const route = { id: 'rt', source: { brokerId: 'b', filter: '#' }, target: { type: 'historian', historianId: 'h' }, enabled: true };
  const store = { h: hist };
  const routes = { rt: route };
  const profiles = {
    rev: 1,
    listIn: (c) => Object.values(c === 'pipelines' ? routes : c === 'historians' ? store : {}),
    getIn: (c, id) => (c === 'pipelines' ? routes[id] : c === 'historians' ? store[id] : null) || null
  };
  let accept = true;
  const outbox = new HistorianOutbox({ profiles, dir: tmp(), fetchImpl: async () => (accept ? ok204 : reject400) });
  const manager = { on() {}, off() {}, publish: async () => ({}) };
  const engine = new PipelineEngine({ mqttManager: manager, profiles, outbox });
  const feed = (n) => {
    for (let i = 0; i < n; i++) engine.onMessage({ brokerId: 'b', topic: `a/${i}`, payload: i, timestamp: Date.now() });
  };

  feed(5);
  let m = engine.getMetrics().rt;
  assert.strictEqual(m.routed, 5);
  assert.strictEqual(m.delivered, 0, 'admitted is not delivered');
  assert.strictEqual(m.pending, 5);
  assert.strictEqual(m.target, 'historian');

  await outbox.flush();
  m = engine.getMetrics().rt;
  assert.deepStrictEqual([m.routed, m.delivered, m.rejected, m.pending], [5, 5, 0, 0]);

  accept = false; // the historian now refuses everything for good
  feed(4);
  await outbox.flush();
  m = engine.getMetrics().rt;
  assert.strictEqual(m.routed, 9);
  assert.strictEqual(m.delivered, 5, 'the route no longer looks healthy');
  assert.strictEqual(m.rejected, 4);
  assert.strictEqual(m.pending, 0);
  assert.strictEqual(m.published, 9, 'published is kept as an alias of routed');

  const stats = outbox.getStats().h;
  assert.strictEqual(stats.delivered, 5);
  assert.strictEqual(stats.rejected, 4);
  assert.strictEqual(stats.admitted, 9);
  assert.strictEqual(stats.pending, 0);

  // transient failure: points are pending (spilled), neither delivered nor rejected
  outbox.fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down' });
  feed(3);
  await outbox.flush();
  m = engine.getMetrics().rt;
  assert.strictEqual(m.pending, 3);
  assert.strictEqual(outbox.getStats().h.pending, 3, 'spilled points are counted as pending');

  const text = metricsExporter.render({ pipelines: engine, outbox, profiles, mqttManager: { getConnections: () => [] } });
  assert.match(text, /manifold_pipeline_messages_total\{route="rt",result="routed"\} 12/);
  assert.match(text, /manifold_pipeline_messages_total\{route="rt",result="delivered"\} 5/);
  assert.match(text, /manifold_pipeline_messages_total\{route="rt",result="rejected"\} 4/);
  assert.match(text, /manifold_pipeline_pending_points\{route="rt"\} 3/);
  assert.match(text, /manifold_outbox_pending_points\{historian="h"\} 3/);
});

test('mqtt target: delivered follows the broker publish, pending stays 0', async () => {
  const route = { id: 'mq', source: { brokerId: 'b', filter: '#' }, target: { type: 'mqtt', brokerId: 'b2' }, enabled: true };
  const profiles = { rev: 1, listIn: () => [route], getIn: (c, id) => (id === 'mq' ? route : null) };
  const manager = { on() {}, off() {}, publish: async () => ({}) };
  const engine = new PipelineEngine({ mqttManager: manager, profiles, outbox: null });
  engine.onMessage({ brokerId: 'b', topic: 'x/y', payload: 1, timestamp: Date.now() });
  await sleep(10);
  const m = engine.getMetrics().mq;
  assert.deepStrictEqual([m.routed, m.delivered, m.rejected, m.pending, m.target], [1, 1, 0, 0, 'mqtt']);
});
