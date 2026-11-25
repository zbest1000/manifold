const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { filterProblem, topicProblem } = require('../services/mqttMatch');

// Pipelines, models and recordings used to accept any string as a topic filter / output topic; a bad
// one then failed silently at runtime (a route that never matches, a publish that errors forever).

test('filterProblem / topicProblem follow MQTT topic rules', () => {
  for (const ok of ['a/b', 'a/+/c', 'a/#', '#', '+', 'a//b', '$SYS/#']) assert.strictEqual(filterProblem(ok), null, ok);
  for (const bad of ['', 'a/#/b', 'a/b#', 'a+/b', 'a/+b', '#/a']) assert.ok(filterProblem(bad), bad);
  assert.ok(filterProblem(undefined));
  for (const ok of ['a/b', 'uns/line 1/temp', 'a//b']) assert.strictEqual(topicProblem(ok), null, ok);
  for (const bad of ['', 'a/+/b', 'a/#']) assert.ok(topicProblem(bad), bad);
});

function memoryProfiles() {
  const data = {};
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      (data[c] ||= {})[id] = { ...obj, id };
      return data[c][id];
    },
    removeIn: (c, id) => Boolean(data[c] && delete data[c][id])
  };
}

test('the pipeline, model and recorder routes reject malformed topics with a clear message', async () => {
  const profiles = memoryProfiles();
  const app = express();
  app.use(express.json());
  // a broker that exists (saves are refused when the broker they point at is missing)
  app.locals.services = { profiles, mqttManager: { getConnection: () => ({}) }, pipelines: { getMetrics: () => ({}) }, models: { syncTimers() {}, getStatus: () => ({}) }, recorder: { getStatus: () => ({}) } };
  app.use('/api/pipelines', require('../routes/pipelines'));
  app.use('/api/models', require('../routes/models'));
  app.use('/api/recorder', require('../routes/recorder'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const route = (over = {}) => ({ source: { brokerId: 'b', filter: 'plant/#' }, transforms: [{ type: 'repath', to: 'uns/{1-}' }], target: { type: 'mqtt', brokerId: 'b' }, ...over });
  try {
    assert.strictEqual((await post('/api/pipelines', route())).status, 201);

    let r = await post('/api/pipelines', route({ source: { brokerId: 'b', filter: 'plant/#/x' } }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /not the last level/);

    r = await post('/api/pipelines', route({ transforms: [{ type: 'repath', to: 'uns/+/{1-}' }] }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /repath target "uns\/\+\/\{1-\}" must not contain the wildcards/);

    r = await post('/api/pipelines', route({ transforms: [{ type: 'repath', to: '' }] }));
    assert.strictEqual(r.status, 400);
    r = await post('/api/pipelines', route({ transforms: [{ type: 'repath', to: '{topic}' }] }));
    assert.strictEqual(r.status, 201, 'a pure placeholder is a valid output topic');

    r = await post('/api/pipelines/preview', { route: route({ source: { brokerId: 'b', filter: 'a+b' } }) });
    assert.strictEqual(r.status, 400, 'the dry run applies the same checks');

    const model = { target: { brokerId: 'b', topic: 'uns/+/pump' }, attributes: [{ name: 'a', source: { brokerId: 'b', topic: 'raw/a' } }] };
    r = await post('/api/models', model);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /target\.topic/);
    assert.strictEqual((await post('/api/models', { ...model, target: { brokerId: 'b', topic: 'uns/pump7' } })).status, 201);

    r = await post('/api/recorder', { brokerId: 'b', filter: 'a/#/b' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await post('/api/recorder', { brokerId: 'b', filter: 'a/#' })).status, 201);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
