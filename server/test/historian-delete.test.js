const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

// DELETE /api/historians/:id must refuse while a route, recording or binding still writes to it
// (they would otherwise keep running and lose every point), and succeed once they are gone.

function memoryProfiles() {
  const data = { historians: {}, pipelines: {}, recordings: {}, bindings: {} };
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      data[c][id] = { ...obj, id };
      return data[c][id];
    },
    removeIn(c, id) {
      if (!data[c][id]) return false;
      delete data[c][id];
      return true;
    }
  };
}

test('deleting a historian that is still in use is a 409 naming the users; unused ones delete', async () => {
  const profiles = memoryProfiles();
  const app = express();
  app.use(express.json());
  app.locals.services = { profiles };
  app.use('/api/historians', require('../routes/historians'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path) => {
    const res = await fetch(base + path, { method });
    return { status: res.status, body: await res.json() };
  };
  try {
    profiles.upsertIn('historians', 'h1', { type: 'timebase', url: 'http://x', dataset: 'd' });
    profiles.upsertIn('historians', 'h2', { type: 'timebase', url: 'http://y', dataset: 'd' });
    profiles.upsertIn('pipelines', 'r1', { name: 'to history', source: { brokerId: 'b', filter: 'a/#' }, target: { type: 'historian', historianId: 'h1' } });
    profiles.upsertIn('recordings', 'rec1', { name: 'rec', filter: '#', target: { type: 'historian', historianId: 'h1' } });
    profiles.upsertIn('bindings', 'b1', { name: 'bound', target: { mode: 'mqtt', historian: { historianId: 'h1' } } });

    let r = await call('DELETE', '/api/historians/h1');
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /still used by 3 item/);
    assert.deepStrictEqual(r.body.usedBy, ['route "to history"', 'recording "rec"', 'binding "bound"']);
    assert.ok(profiles.getIn('historians', 'h1'), 'not deleted');

    // an unrelated historian is not blocked by the others' users
    r = await call('DELETE', '/api/historians/h2');
    assert.strictEqual(r.status, 200);

    profiles.removeIn('pipelines', 'r1');
    profiles.removeIn('recordings', 'rec1');
    profiles.removeIn('bindings', 'b1');
    r = await call('DELETE', '/api/historians/h1');
    assert.strictEqual(r.status, 200);
    r = await call('DELETE', '/api/historians/h1');
    assert.strictEqual(r.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
