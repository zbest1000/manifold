const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const model = require('../services/bindingModel');
const { TagBindings } = require('../services/tagBindings');
const { RetainedLedger } = require('../services/bindingRetained');
const { migrationCandidates } = require('../services/bindingMigration');
const { fakeMqtt, memoryProfiles, sleep, until } = require('./support/fakeMqtt');

// Retained cleanup that survives restarts (ledger file), the explicit cleanup endpoint, the
// migration of old Tags-page pipeline routes, and the per-mapping health reasons.

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-ledger-')), 'binding-retained.json');
const DEVICE = { id: 'dev1', name: 'Meter', protocol: 'modbus-tcp', host: '127.0.0.1', tags: [{ key: 'temp', address: 'holding:0', type: 'int16' }] };
const MAPPING = { name: 'meter', source: { type: 'device', deviceId: 'dev1', tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/meter', format: 'envelope', retain: true } };

function boot({ profiles, file, mqtt, retryMs = 40 }) {
  const bindings = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null, ledgerFile: file, retryMs, brokerPollMs: 20 });
  bindings.start();
  return bindings;
}

const clears = (mqtt) => mqtt.published.filter((p) => p.payload === '' && p.opts.retain).map((p) => p.topic).sort();

test('ledger: atomic file, corrupt file moved aside, bounded', () => {
  const file = tmpFile();
  const l = new RetainedLedger({ file, maxPerBroker: 2 });
  assert.ok(l.add('b1', 'a/_status', 'x'));
  assert.ok(l.add('b1', 'a/_meta', 'x'));
  assert.ok(!l.add('b1', 'a/v', 'x'), 'full');
  assert.strictEqual(l.overflow, 1);
  l.save();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(doc.brokers.b1, { 'a/_status': { b: 'x' }, 'a/_meta': { b: 'x' } });
  assert.strictEqual(doc.version, 1);
  fs.writeFileSync(file, '{"version":1,"brokers":{"b1":{"t":');
  const l2 = new RetainedLedger({ file });
  assert.strictEqual(l2.size, 0);
  assert.match(l2.loadError, /unreadable/);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')));
});

test('crash, edit while down, restart: orphans are cleared once the broker is connected', async () => {
  const file = tmpFile();
  const profiles = memoryProfiles();
  profiles.upsertIn('devices', 'dev1', DEVICE);
  profiles.upsertIn('bindings', 'm1', model.validateBinding({ ...structuredClone(MAPPING), id: 'm1' }, { profiles }));
  const mqtt1 = fakeMqtt();
  const run1 = boot({ profiles, file, mqtt: mqtt1 });
  await until(() => mqtt1.published.some((p) => p.topic === 'uns/meter/_meta'), 2000, '_meta');
  // Crash: no stop(). The config-derived topics are already on disk.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(doc.brokers.b1).sort(), ['uns/meter/_meta', 'uns/meter/_status', 'uns/meter/temp']);
  clearInterval(run1.heartbeatTimer);
  run1.mqttSource.close();
  run1.started = false;

  // While the server is down the mapping is renamed (new asset path) - nobody clears the old topics.
  profiles.data.bindings.m1.target.assetPath = 'uns/meter2';
  profiles.rev++;

  // Restart with the broker still offline: nothing can be cleared, nothing is forgotten.
  const mqtt2 = fakeMqtt();
  mqtt2.state.set('b1', 'offline');
  const run2 = boot({ profiles, file, mqtt: mqtt2 });
  await sleep(150);
  assert.deepStrictEqual(clears(mqtt2), []);
  const dry = await run2.cleanupRetained({ dryRun: true });
  assert.deepStrictEqual(dry.topics.map((t) => [t.topic, t.connected]), [['uns/meter/_meta', false], ['uns/meter/_status', false], ['uns/meter/temp', false]]);
  assert.match(dry.topics[0].reason, /no longer published/);
  // The broker connects: the retry timer clears exactly the recorded orphans.
  mqtt2.state.set('b1', 'connected');
  await until(() => clears(mqtt2).length === 3, 3000, 'clears');
  assert.deepStrictEqual(clears(mqtt2), ['uns/meter/_meta', 'uns/meter/_status', 'uns/meter/temp']);
  await until(() => !JSON.parse(fs.readFileSync(file, 'utf8')).brokers.b1['uns/meter/_status'], 3000, 'ledger updated');
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).brokers.b1;
  assert.deepStrictEqual(Object.keys(after).sort(), ['uns/meter2/_meta', 'uns/meter2/_status', 'uns/meter2/temp']);
  // Deleting the mapping clears its topics; a topic never recorded is never touched.
  profiles.removeIn('bindings', 'm1');
  run2.reconcile();
  await until(() => clears(mqtt2).length === 6, 2000, 'delete clears');
  assert.ok(!clears(mqtt2).some((t) => !t.startsWith('uns/meter')));
  run2.stop();
});

test('dynamic retained topics (filter-mode MQTT source) are recorded and cleared when retain goes off', async () => {
  const file = tmpFile();
  const profiles = memoryProfiles();
  const mqtt = fakeMqtt({ brokers: ['b1', 'b2'] });
  const run = boot({ profiles, file, mqtt });
  const body = model.validateBinding({ id: 'f', name: 'f', source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'raw/#' }, target: { mode: 'mqtt', brokerId: 'b2', assetPath: 'uns/f', format: 'plain', retain: true, statusTopic: false, metaTopic: false } }, { profiles });
  profiles.upsertIn('bindings', 'f', body);
  run.reconcile();
  await run.syncMonitors();
  mqtt.inject('b1', 'raw/a/b', 5);
  await until(() => mqtt.published.some((p) => p.topic === 'uns/f/a/b'), 2000, 'value');
  run.ledger.save();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).brokers.b2['uns/f/a/b'], { b: 'f', d: 1, n: 'f' });
  profiles.upsertIn('bindings', 'f', { ...body, target: { ...body.target, retain: false } });
  run.reconcile();
  await until(() => clears(mqtt).includes('uns/f/a/b'), 2000, 'cleared');
  run.stop();
});

test('migration: only Tags-page shaped routes qualify; the proposed mapping publishes the same topics', () => {
  const routes = [
    { id: 'r1', name: 'tags -> uns/plant', source: { brokerId: 'b1', filter: 'plant/#' }, transforms: [{ type: 'repath', to: 'uns/plant/{2-}' }, { type: 'envelope' }], target: { type: 'mqtt', brokerId: 'b1', retain: false, qos: 0 } },
    { id: 'r2', name: 'one topic', source: { brokerId: 'b1', filter: 'plant/env/tvq' }, transforms: [{ type: 'repath', to: 'uns/env/{3-}' }], target: { type: 'mqtt', brokerId: 'b1', retain: true, qos: 1 } },
    { id: 'r3', name: 'hand made', source: { brokerId: 'b1', filter: 'plant/#' }, transforms: [{ type: 'repath', to: 'uns/{2-}' }, { type: 'scale', mul: 2 }], target: { type: 'mqtt', brokerId: 'b1' } },
    { id: 'r4', name: 'historian', source: { brokerId: 'b1', filter: 'plant/#' }, transforms: [{ type: 'repath', to: 'uns/{2-}' }], target: { type: 'historian', historianId: 'h' } },
    { id: 'r5', name: 'wrong level', source: { brokerId: 'b1', filter: 'plant/#' }, transforms: [{ type: 'repath', to: 'uns/{3-}' }], target: { type: 'mqtt', brokerId: 'b1' } }
  ];
  const c = migrationCandidates(routes);
  assert.deepStrictEqual(c.map((x) => x.route.id), ['r1', 'r2']);
  assert.deepStrictEqual(c[0].mapping, { name: 'uns/plant (from route)', enabled: true, source: { type: 'mqtt', brokerId: 'b1', tags: 'all', filter: 'plant/#' }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/plant', layout: 'topic-per-tag', format: 'envelope' } });
  assert.strictEqual(c[0].createdByTags, true);
  assert.deepStrictEqual(c[1].mapping.source.tags, [{ address: 'plant/env/tvq', name: 'tvq' }]);
  assert.deepStrictEqual([c[1].mapping.target.qos, c[1].mapping.target.retain, c[1].mapping.target.format], [1, true, 'plain']);
  // route topic plant/line1/temperature -> uns/plant/line1/temperature; the mapping agrees
  const profiles = memoryProfiles();
  const tag = model.expandUnits({ id: 'x', ...c[0].mapping }, profiles)[0];
  assert.strictEqual(tag.mqtt.prefixLen, 1);
  assert.strictEqual(model.valueTopicOf(tag, 'line1/temperature'), 'uns/plant/line1/temperature');
});

async function routesApp(services) {
  const app = express();
  app.use(express.json());
  app.locals.services = { sparkplugPublisher: { getStatus: () => ({}) }, ...services };
  app.use('/api/tags', require('../routes/tags'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { api, close: () => new Promise((r) => server.close(r)) };
}

test('routes: cleanup-retained dry run + clear, migrations list + migrate, health reasons', async () => {
  const profiles = memoryProfiles();
  profiles.upsertIn('devices', 'dev1', DEVICE);
  const mqtt = fakeMqtt();
  const bindings = boot({ profiles, file: tmpFile(), mqtt });
  const { api, close } = await routesApp({ profiles, bindings, mqttManager: mqtt });
  // a mapping, then its broker goes offline and the mapping is deleted: orphans wait
  const saved = await api('POST', '/api/tags/bindings', MAPPING);
  assert.strictEqual(saved.status, 201);
  mqtt.state.set('b1', 'offline');
  await api('DELETE', `/api/tags/bindings/${saved.body.id}`);
  const dry = await api('POST', '/api/tags/bindings/cleanup-retained', {});
  assert.strictEqual(dry.body.dryRun, true);
  assert.deepStrictEqual(dry.body.topics.map((t) => t.topic), ['uns/meter/_meta', 'uns/meter/_status', 'uns/meter/temp']);
  assert.strictEqual(dry.body.topics[0].reason, 'mapping deleted');
  assert.strictEqual(dry.body.topics[0].bindingName, 'meter');
  assert.deepStrictEqual(clears(mqtt), []);
  // GET is the same dry run (the read viewers may make)
  assert.deepStrictEqual((await api('GET', '/api/tags/bindings/cleanup-retained')).body.topics, dry.body.topics);
  bindings.retryMs = 60_000; // only the explicit request clears from here on
  mqtt.state.set('b1', 'connected');
  const done = await api('POST', '/api/tags/bindings/cleanup-retained', { dryRun: false });
  assert.strictEqual(done.body.cleared + clears(mqtt).length >= 3, true);
  await until(() => clears(mqtt).length >= 3, 2000, 'cleared');
  assert.deepStrictEqual((await api('POST', '/api/tags/bindings/cleanup-retained', {})).body.topics, []);

  // migrations
  profiles.upsertIn('pipelines', 'r1', { name: 'tags -> uns/plant', source: { brokerId: 'b1', filter: 'plant/#' }, transforms: [{ type: 'repath', to: 'uns/plant/{2-}' }], target: { type: 'mqtt', brokerId: 'b1' } });
  profiles.upsertIn('pipelines', 'r9', { name: 'loop', source: { brokerId: 'b1', filter: 'uns/#' }, transforms: [{ type: 'repath', to: 'uns/x/{2-}' }], target: { type: 'mqtt', brokerId: 'b1' } });
  const list = await api('GET', '/api/tags/bindings/migrations');
  assert.deepStrictEqual(list.body.candidates.map((c) => [c.route.id, Boolean(c.blocked)]), [['r1', false], ['r9', true]]);
  assert.match(list.body.candidates[1].blocked, /loop/);
  assert.strictEqual((await api('POST', '/api/tags/bindings/migrate', { routeId: 'nope' })).status, 404);
  const mig = await api('POST', '/api/tags/bindings/migrate', { routeId: 'r1', mapping: { ...list.body.candidates[0].mapping, name: 'plant topics' } });
  assert.strictEqual(mig.status, 201);
  assert.strictEqual(mig.body.binding.name, 'plant topics');
  assert.strictEqual(profiles.getIn('pipelines', 'r1').enabled, false);
  assert.strictEqual(profiles.getIn('pipelines', 'r1').migratedTo, mig.body.binding.id);
  // A migrated route is not offered again (no second mapping for the same topics).
  assert.ok(!(await api('GET', '/api/tags/bindings/migrations')).body.candidates.some((c) => c.route.id === 'r1'));
  assert.strictEqual((await api('POST', '/api/tags/bindings/migrate', { routeId: 'r1', route: 'delete' })).status, 404);
  profiles.upsertIn('pipelines', 'r2', { name: 'tags -> uns/hall', source: { brokerId: 'b1', filter: 'hall/a/temp' }, transforms: [{ type: 'repath', to: 'uns/hall/{3-}' }], target: { type: 'mqtt', brokerId: 'b1' } });
  const del = await api('POST', '/api/tags/bindings/migrate', { routeId: 'r2', route: 'delete' });
  assert.strictEqual(del.status, 201, JSON.stringify(del.body));
  assert.strictEqual(profiles.getIn('pipelines', 'r2'), null);
  assert.deepStrictEqual(del.body.binding.source.tags, [{ address: 'hall/a/temp', name: 'temp' }]);

  // health: a mapping whose device is gone, one with every tag off
  profiles.upsertIn('bindings', 'gone', { ...MAPPING, name: 'gone', source: { type: 'device', deviceId: 'missing', tags: ['temp'] } });
  profiles.upsertIn('bindings', 'off', { ...MAPPING, name: 'off', target: { ...MAPPING.target, assetPath: 'uns/off' }, source: { type: 'device', deviceId: 'dev1', tags: [{ address: 'temp', enabled: false }] } });
  const g = await api('GET', '/api/tags/bindings');
  assert.strictEqual(g.body.health.gone.state, 'source-missing');
  assert.match(g.body.health.gone.reasons[0].message, /device missing no longer exists/);
  assert.ok(g.body.health.gone.reasons[0].fix);
  assert.ok(g.body.health.off.reasons.some((r) => r.code === 'all-disabled'));
  assert.strictEqual(g.body.health.off.state, 'problem');
  bindings.stop();
  await close();
});
