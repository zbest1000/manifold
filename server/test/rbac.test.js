const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Boot the app with BOTH tokens: admin (MANIFOLD_AUTH_TOKEN) and read-only viewer
// (MANIFOLD_VIEWER_TOKEN). Covers role separation, the audit trail, the Prometheus
// endpoint, and config export/import.
process.env.PORT = '0';
process.env.MANIFOLD_AUTH_TOKEN = 'admin-token';
process.env.MANIFOLD_VIEWER_TOKEN = 'viewer-token';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-rbac-test-'));

let baseUrl;
let server;
let services;

before(async () => {
  const app = require('../index');
  server = app.server;
  services = app.app.locals.services;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models', 'outbox', 'bindings']) {
    services?.[s]?.stop?.();
  }
  services?.audit?.close();
  server?.close();
});

const call = (path, { method = 'GET', token = 'admin-token', body } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

test('viewer token reads but cannot mutate; admin token can', async () => {
  const read = await call('/api/mqtt/brokers', { token: 'viewer-token' });
  assert.strictEqual(read.status, 200);

  const write = await call('/api/pipelines', { method: 'POST', token: 'viewer-token', body: {} });
  assert.strictEqual(write.status, 403);

  // admin passes auth; 400 = reached validation, not blocked by role
  const adminWrite = await call('/api/pipelines', { method: 'POST', token: 'admin-token', body: {} });
  assert.strictEqual(adminWrite.status, 400);

  const noToken = await call('/api/mqtt/brokers', { token: null });
  assert.strictEqual(noToken.status, 401);
});

test('mutations land in the audit trail with secrets redacted; viewer cannot read it', async () => {
  await call('/api/historians', {
    method: 'POST',
    body: { name: 'h', type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'b', token: 'super-secret' }
  });
  const res = await call('/api/audit');
  assert.strictEqual(res.status, 200);
  const { events } = await res.json();
  const evt = events.find((e) => e.path === '/api/historians' && e.method === 'POST');
  assert.ok(evt, 'historian creation must be audited');
  assert.strictEqual(evt.role, 'admin');
  assert.ok(!JSON.stringify(evt).includes('super-secret'), 'audit must never contain secrets');

  const viewer = await call('/api/audit', { token: 'viewer-token' });
  assert.strictEqual(viewer.status, 403);
});

test('/metrics requires a token when auth is configured (any role), unless MANIFOLD_METRICS_PUBLIC=1', async () => {
  const anon = await fetch(`${baseUrl}/metrics`);
  assert.strictEqual(anon.status, 401);
  const wrong = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer nope' } });
  assert.strictEqual(wrong.status, 401);
  const viewer = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer viewer-token' } });
  assert.strictEqual(viewer.status, 200);

  process.env.MANIFOLD_METRICS_PUBLIC = '1';
  try {
    assert.strictEqual((await fetch(`${baseUrl}/metrics`)).status, 200);
  } finally {
    delete process.env.MANIFOLD_METRICS_PUBLIC;
  }
});

test('viewer may call allowlisted read-only POSTs; mutating POSTs stay forbidden', async () => {
  const allowed = [
    ['/api/historians/nope/query', {}],
    ['/api/pipelines/preview', {}],
    ['/api/mqtt/brokers/nope/subscriptions/resolve', {}],
    ['/api/devices/validate-tags', {}],
    ['/api/cesmii/history', {}]
  ];
  for (const [p, body] of allowed) {
    const res = await call(p, { method: 'POST', token: 'viewer-token', body });
    assert.notStrictEqual(res.status, 403, `${p} must pass the role gate for viewers`);
    assert.notStrictEqual(res.status, 401, p);
  }
  const forbidden = [
    '/api/pipelines',
    '/api/historians',
    '/api/historians/nope/test',
    '/api/mqtt/brokers/nope/publish',
    '/api/mqtt/brokers/nope/subscribe',
    '/api/system/config/import',
    '/api/system/discovery/start',
    '/api/tags/bindings',
    '/api/pipelines/preview/../x',
    '/api/historians/a/b/query'
  ];
  for (const p of forbidden) {
    const res = await call(p, { method: 'POST', token: 'viewer-token', body: {} });
    assert.strictEqual(res.status, 403, `${p} must stay forbidden for viewers`);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await call('/api/historians/nope/query', { method, token: 'viewer-token', body: {} });
    assert.strictEqual(res.status, 403, `${method} on an allowlisted path is still forbidden`);
  }
});

test('rejected requests (401, viewer 403) are audited, without tokens', async () => {
  await call('/api/mqtt/brokers', { token: 'wrong-token-xyz' });
  await call('/api/pipelines', { method: 'POST', token: 'viewer-token', body: { token: 'leak-me-not' } });
  const { events } = await (await call('/api/audit')).json();
  const unauth = events.find((e) => e.outcome === 'unauthorized' && e.path === '/api/mqtt/brokers');
  assert.ok(unauth, '401 must be audited even for GET');
  assert.strictEqual(unauth.role, 'none');
  const forbidden = events.find((e) => e.outcome === 'forbidden' && e.path === '/api/pipelines');
  assert.ok(forbidden, 'viewer 403 must be audited');
  assert.strictEqual(forbidden.role, 'viewer');
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes('wrong-token-xyz') && !blob.includes('leak-me-not') && !blob.includes('viewer-token'));
});

test('/metrics is Prometheus text', async () => {
  const res = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer admin-token' } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const body = await res.text();
  assert.match(body, /manifold_process_uptime_seconds/);
  assert.match(body, /manifold_event_loop_delay_ms/);
});

test('config export strips secrets; import restores objects and keeps stored secrets', async () => {
  const exported = await (await call('/api/system/config/export')).json();
  assert.strictEqual(exported.manifoldConfig, 1);
  const h = exported.historians.find((x) => x.name === 'h');
  assert.ok(h, 'historian appears in export');
  assert.strictEqual(h.token, null, 'export must not carry credentials');

  // Re-import the export plus a new pipeline: merge by id, keep stored secret.
  exported.pipelines = [
    { id: 'imported-route', name: 'imported', enabled: false, source: { brokerId: 'x', filter: 'a/#' }, transforms: [], target: { type: 'mqtt', brokerId: 'x' } }
  ];
  const res = await call('/api/system/config/import', { method: 'POST', body: exported });
  assert.strictEqual(res.status, 200);
  const { imported } = await res.json();
  assert.strictEqual(imported.pipelines, 1);

  assert.ok(services.profiles.getIn('pipelines', 'imported-route'), 'imported route persisted');
  const stored = services.profiles.getIn('historians', h.id);
  assert.strictEqual(stored.token, 'super-secret', 'import with null secret must keep the stored one');
});
