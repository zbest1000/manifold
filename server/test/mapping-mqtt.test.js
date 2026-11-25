const { test } = require('node:test');
const assert = require('node:assert');

const mq = require('../services/bindingMqtt');
const model = require('../services/bindingModel');
const { TagBindings } = require('../services/tagBindings');
const { PipelineEngine } = require('../services/pipelineEngine');
const { fakeMqtt, memoryProfiles, sleep, until } = require('./support/fakeMqtt');

// MQTT-topic sources as first-class mappings: payload reading, loop safety (static + run time),
// broker state, staleness, rules and preview.

function engine({ echo = false, opts = {} } = {}) {
  const profiles = memoryProfiles();
  const mqtt = fakeMqtt({ echo, brokers: ['b1', 'b2'] });
  const bindings = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null, ledgerFile: null, brokerPollMs: 20, heartbeatTickMs: 50, retryMs: 50, ...opts });
  bindings.start();
  return { profiles, mqtt, bindings };
}

function save(ctx, id, b) {
  const body = model.validateBinding({ ...b, id }, { profiles: ctx.profiles });
  ctx.profiles.upsertIn('bindings', id, body);
  ctx.bindings.reconcile();
  return ctx.bindings.syncMonitors();
}

const values = (mqtt, topic) => mqtt.published.filter((p) => p.topic === topic).map((p) => p.payload);

test('readMessage: scalar, field path, both envelope shapes, missing field, structured value', () => {
  const out = {};
  const msg = (payload) => ({ payload, payloadFormat: typeof payload === 'object' ? 'json' : 'text', timestamp: '2026-11-25T10:00:00.000Z' });
  mq.readMessage(msg(21.5), undefined, out);
  assert.deepStrictEqual([out.v, out.q, out.u, out.r], [21.5, 192, undefined, undefined]);
  mq.readMessage(msg({ v: 3, t: 1795540707783, q: 0, u: 'bar' }), undefined, out);
  assert.deepStrictEqual([out.v, out.q, out.t, out.u], [3, 0, 1795540707783, 'bar']);
  mq.readMessage(msg({ value: 7, timestamp: '2026-11-25T09:00:00.000Z', quality: 'uncertain', unit: 'kPa' }), undefined, out);
  assert.deepStrictEqual([out.v, out.q, out.t, out.u], [7, 64, Date.parse('2026-11-25T09:00:00.000Z'), 'kPa']);
  mq.readMessage(msg({ data: { temp: { v: 9, q: 192 } } }), 'data.temp', out);
  assert.deepStrictEqual([out.v, out.q], [9, 192]);
  mq.readMessage(msg({ data: [1, 2, 3] }), 'data.1', out);
  assert.strictEqual(out.v, 2);
  mq.readMessage(msg({ data: 1 }), 'nope.x', out);
  assert.deepStrictEqual([out.v, out.q, out.r], [null, 0, 'field "nope.x" not in the payload']);
  mq.readMessage(msg({ state: 'running', since: 3 }), undefined, out);
  assert.deepStrictEqual(out.v, { state: 'running', since: 3 });
  // an implausible source time falls back to arrival time (shared pipeline helper)
  mq.readMessage(msg({ v: 1, t: 5 }), undefined, out);
  assert.strictEqual(out.t, Date.parse('2026-11-25T10:00:00.000Z'));
});

test('filter algebra: overlap and coverage', () => {
  assert.ok(mq.filtersOverlap('raw/#', 'raw/plant1/x'));
  assert.ok(mq.filtersOverlap('a/+/c', 'a/b/#'));
  assert.ok(mq.filtersOverlap('a/#', 'a'));
  assert.ok(!mq.filtersOverlap('raw/#', 'uns/plant1/#'));
  assert.ok(!mq.filtersOverlap('a/+/c', 'a/b/d'));
  assert.ok(mq.filterCovers('#', 'raw/plant1/#'));
  assert.ok(mq.filterCovers('raw/+/x', 'raw/a/x'));
  assert.ok(!mq.filterCovers('raw/+/x', 'raw/#'));
  assert.ok(!mq.filterCovers('raw/a', 'raw/+'));
});

test('validation: a mapping that would read its own output is refused; bad fields and stale limits too', () => {
  const profiles = memoryProfiles();
  const v = (b) => () => model.validateBinding({ id: 'x', ...b }, { profiles });
  const base = { source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'plant/#' }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'plant/clean', format: 'envelope' } };
  assert.throws(v(base), /loop: this mapping would read what it publishes \(target plant\/clean.* overlaps source plant\/#/);
  // same paths on ANOTHER broker are fine
  assert.doesNotThrow(v({ ...base, target: { ...base.target, brokerId: 'b2' } }));
  // explicit topic list inside the asset path
  assert.throws(v({ source: { type: 'mqtt', brokerId: 'b1', tags: [{ address: 'uns/a/temp' }] }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/a' } }), /loop/);
  // a Sparkplug target whose topics the filter would see
  assert.throws(v({ source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: '#' }, target: { mode: 'sparkplug', brokerId: 'b1', group: 'G', edge: 'E', device: 'D' } }), /loop/);
  assert.throws(v({ ...base, target: { ...base.target, brokerId: 'b2' }, source: { ...base.source, field: '.bad' } }), /field must be a dot path/);
  assert.throws(v({ ...base, target: { ...base.target, brokerId: 'b2' }, source: { ...base.source, staleAfterMs: 10 } }), /staleAfterMs/);
  assert.throws(v({ ...base, target: { ...base.target, brokerId: 'b2' }, source: { ...base.source, select: { pollGroups: ['x'] } } }), /include and exclude only/);
  assert.throws(v({ source: { type: 'mqtt', brokerId: 'b1', tags: [{ address: 'a/+' }] }, target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'x' } }), /concrete topic/);
  assert.throws(v({ source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'a/#/b' }, target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'x' } }), /source.filter/);
});

test('explicit topics: envelope detection, learned unit, per-tag settings, _meta source and _status', async () => {
  const ctx = engine();
  const { mqtt } = ctx;
  await save(ctx, 'm1', {
    name: 'm1',
    source: { type: 'mqtt', brokerId: 'b1', tags: [{ address: 'raw/l1/temp', name: 'temperature', scale: 2, precision: 1 }, { address: 'raw/l1/state', field: 'state' }] },
    target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'uns/l1', format: 'envelope' }
  });
  mqtt.inject('b1', 'raw/l1/temp', { value: 10.04, unit: 'C', quality: 'good' });
  mqtt.inject('b1', 'raw/l1/state', { state: 'running', other: 1 });
  mqtt.inject('b1', 'raw/l1/ignored', 1);
  await until(() => values(mqtt, 'uns/l1/state').length === 1, 2000, 'state');
  const [temp] = values(mqtt, 'uns/l1/temperature');
  assert.strictEqual(temp.v, 20.1);
  assert.strictEqual(temp.u, 'C');
  assert.strictEqual(temp.q, 192);
  assert.strictEqual(values(mqtt, 'uns/l1/state')[0].v, 'running');
  assert.ok(!mqtt.published.some((p) => p.topic.endsWith('/ignored')));
  // _status from the broker state, _meta with the topic as source
  await until(() => values(mqtt, 'uns/l1/_status').length, 2000, '_status');
  assert.strictEqual(values(mqtt, 'uns/l1/_status')[0].online, true);
  await until(() => values(mqtt, 'uns/l1/_meta').some((m) => m.properties.temperature.unit === 'C'), 2000, 'learned unit in _meta');
  const meta = values(mqtt, 'uns/l1/_meta').at(-1);
  assert.deepStrictEqual(meta.properties.state.source, { brokerId: 'b1', topic: 'raw/l1/state', field: 'state' });
  // report by exception: same value again is suppressed
  mqtt.inject('b1', 'raw/l1/temp', { value: 10.04, unit: 'C' });
  await sleep(30);
  assert.strictEqual(values(mqtt, 'uns/l1/temperature').length, 1);
  ctx.bindings.stop();
});

test('filter mode: hierarchical names, new topics picked up, include/exclude, object layout', async () => {
  const ctx = engine();
  const { mqtt } = ctx;
  mqtt.inject('b1', 'raw/p1/l1/temp', 1); // seen before the mapping exists
  await save(ctx, 'f1', {
    name: 'f1',
    source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'raw/p1/#', select: { exclude: ['*secret*'] }, overrides: { 'raw/p1/l1/temp': { name: 'line1/temperature', unit: 'degC' } } },
    target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/p1', format: 'envelope' }
  });
  mqtt.inject('b1', 'raw/p1/l1/temp', 2);
  mqtt.inject('b1', 'raw/p1/l2/flow', { v: 5, q: 192 }); // appears after save
  mqtt.inject('b1', 'raw/p1/l2/secret', 9);
  await until(() => values(mqtt, 'uns/p1/l2/flow').length === 1, 2000, 'new topic');
  assert.deepStrictEqual(values(mqtt, 'uns/p1/line1/temperature')[0].u, 'degC');
  assert.ok(!mqtt.published.some((p) => p.topic.includes('secret')));
  await until(() => values(mqtt, 'uns/p1/_meta').some((m) => m.properties['l2/flow']), 2000, '_meta lists the new topic');
  // the preview sees observed topics (selection rows) and latest values
  const pv = model.previewBinding({ ...ctx.profiles.getIn('bindings', 'f1') }, ctx.profiles, { latest: (u, a) => ctx.bindings.latestMqtt(u, u.tags.find((t) => t.address === a)) });
  assert.deepStrictEqual(pv.tags.map((t) => t.topic).sort(), ['uns/p1/l2/flow', 'uns/p1/line1/temperature']);
  assert.ok(pv.selection.rows.some((r) => r.key === 'raw/p1/l2/secret' && r.rule === 'exclude'));
  assert.strictEqual(pv.tags.find((t) => t.name === 'l2/flow').payload.v, 5);
  assert.strictEqual(pv.tags.find((t) => t.name === 'line1/temperature').origins.unit, 'mapping');
  ctx.bindings.stop();
});

test('broker offline: one Bad publish per tag and _status offline; back online: Good', async () => {
  const ctx = engine();
  const { mqtt } = ctx;
  await save(ctx, 'o1', { name: 'o1', source: { type: 'mqtt', brokerId: 'b1', tags: [{ address: 'raw/x' }] }, target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'uns/o', format: 'envelope' } });
  mqtt.inject('b1', 'raw/x', 4);
  await until(() => values(mqtt, 'uns/o/x').length === 1, 2000, 'first value');
  mqtt.state.set('b1', 'offline');
  await until(() => values(mqtt, 'uns/o/x').length === 2, 2000, 'bad publish');
  assert.deepStrictEqual([values(mqtt, 'uns/o/x')[1].v, values(mqtt, 'uns/o/x')[1].q], [4, 0]);
  await until(() => values(mqtt, 'uns/o/_status').some((s) => s.online === false), 2000, 'status offline');
  await sleep(100);
  assert.strictEqual(values(mqtt, 'uns/o/x').length, 2, 'Bad is published once');
  mqtt.state.set('b1', 'connected');
  await until(() => values(mqtt, 'uns/o/_status').at(-1).online === true, 2000, 'status online');
  mqtt.inject('b1', 'raw/x', 4);
  await until(() => values(mqtt, 'uns/o/x').at(-1).q === 192, 2000, 'good again');
  ctx.bindings.stop();
});

test('staleness: no message within staleAfterMs -> Bad with reason stale once; next message -> Good', async () => {
  const ctx = engine();
  const { mqtt } = ctx;
  await save(ctx, 's1', { name: 's1', source: { type: 'mqtt', brokerId: 'b1', tags: [{ address: 'raw/s', staleAfterMs: 1000 }] }, target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'uns/s', format: 'envelope' } });
  mqtt.inject('b1', 'raw/s', 1);
  await until(() => values(mqtt, 'uns/s/s').length === 1, 2000, 'value');
  await until(() => values(mqtt, 'uns/s/s').length === 2, 3000, 'stale');
  assert.deepStrictEqual(values(mqtt, 'uns/s/s')[1], { ...values(mqtt, 'uns/s/s')[1], v: 1, q: 0, reason: 'stale' });
  assert.strictEqual(ctx.bindings.getStatus().s1.staleNow, 1);
  await sleep(1200);
  assert.strictEqual(values(mqtt, 'uns/s/s').length, 2, 'stale is published once');
  mqtt.inject('b1', 'raw/s', 1);
  await until(() => values(mqtt, 'uns/s/s').length === 3, 2000, 'good again');
  assert.strictEqual(values(mqtt, 'uns/s/s')[2].q, 192);
  assert.strictEqual(values(mqtt, 'uns/s/s')[2].reason, undefined);
  assert.strictEqual(ctx.bindings.getStatus().s1.staleNow, 0);
  ctx.bindings.stop();
});

test('loop A -> B -> A across two mappings is stopped by the hop guard', async () => {
  const ctx = engine({ echo: true });
  const { mqtt } = ctx;
  await save(ctx, 'A', { name: 'A', source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'a/#' }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'b/out', format: 'plain' } });
  // B reads A's output and writes into A's source, doubling the value each pass
  const warn = model.bindingWarnings({ id: 'B', name: 'B', source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'b/#', overrides: {} }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a/in', format: 'plain' } }, ctx.profiles);
  assert.ok(warn.some((w) => w.type === 'loop-risk'), 'the save warns about the cycle');
  await save(ctx, 'B', { name: 'B', source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'b/#' }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a/in', format: 'plain', fields: undefined } });
  ctx.profiles.data.bindings.B.source.overrides = { 'b/out/x': { scale: 2 } };
  ctx.profiles.rev++;
  ctx.bindings.reconcile();
  mqtt.inject('b1', 'a/x', 1);
  await sleep(500);
  const n = mqtt.published.filter((p) => p.payload !== '' && !p.topic.endsWith('_status') && !p.topic.endsWith('_meta')).length;
  assert.ok(n <= 12, `bounded (${n} publishes)`);
  const st = ctx.bindings.getStatus();
  assert.ok((st.A.loopBlocked || 0) + (st.B.loopBlocked || 0) > 0, 'loop guard counted');
  await sleep(300);
  assert.strictEqual(mqtt.published.filter((p) => p.payload !== '' && !p.topic.endsWith('_status') && !p.topic.endsWith('_meta')).length, n, 'and it stays stopped');
  ctx.bindings.stop();
});

test('loop mapping -> pipeline -> mapping is stopped (shared hop registry)', async () => {
  const ctx = engine({ echo: true });
  const { mqtt, profiles } = ctx;
  const pipelines = new PipelineEngine({ mqttManager: mqtt, profiles, outbox: null });
  pipelines.start();
  ctx.bindings.setPipelines(pipelines);
  profiles.upsertIn('pipelines', 'r1', { name: 'back', source: { brokerId: 'b1', filter: 'm/#' }, transforms: [{ type: 'repath', to: 'src/{2-}' }, { type: 'scale', mul: 2 }], target: { type: 'mqtt', brokerId: 'b1' } });
  await save(ctx, 'M', { name: 'M', source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'src/#' }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'm', format: 'plain', statusTopic: false, metaTopic: false } });
  mqtt.inject('b1', 'src/v', 1);
  await sleep(600);
  const n = mqtt.published.length;
  assert.ok(n <= 12, `bounded (${n} publishes)`);
  const blocked = (ctx.bindings.getStatus().M.loopBlocked || 0) + (pipelines.getMetrics().r1?.loopBlocked || 0);
  assert.ok(blocked > 0, 'a hop guard fired');
  await sleep(300);
  assert.strictEqual(mqtt.published.length, n);
  pipelines.stop();
  ctx.bindings.stop();
});

test('suggest and schema know mqtt sources', () => {
  const profiles = memoryProfiles();
  const s = model.suggestMapping({ type: 'mqtt', brokerId: 'b1', tags: [{ address: 'raw/l1/temp' }] }, profiles);
  assert.deepStrictEqual(s.tags[0].suggestedName, 'temp');
  const schema = model.bindingSchema();
  assert.ok(schema.sourceTypes.includes('mqtt'));
  assert.deepStrictEqual(schema.placeholders.mqtt, []);
});

test('a new mapping publishes what its topics already hold (retained / slow topics), once', async () => {
  const ctx = engine();
  const { mqtt } = ctx;
  mqtt.latest.set('b1\u0000raw/held/a', { v: 4, q: 192 });
  mqtt.latest.set('b1\u0000raw/held/b', 9);
  await save(ctx, 'h1', { name: 'h1', source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'raw/held/#' }, target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'uns/held', format: 'plain' } });
  await until(() => values(mqtt, 'uns/held/a').length === 1 && values(mqtt, 'uns/held/b').length === 1, 2000, 'seeded values');
  assert.deepStrictEqual([values(mqtt, 'uns/held/a')[0], values(mqtt, 'uns/held/b')[0]], [4, 9]);
  // another sync (any edit elsewhere) does not publish them again
  await ctx.bindings.syncMonitors();
  await sleep(50);
  assert.strictEqual(values(mqtt, 'uns/held/a').length, 1);
  ctx.bindings.stop();
});
