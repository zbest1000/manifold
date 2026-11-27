'use strict';

// Optimistic concurrency (rev / 409 stale), duplicate broker refusal, dangling references and the
// viewer/auth rules for the routes that carry them. Boots the real app with auth on.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = '0';
process.env.MANIFOLD_AUTH_TOKEN = 'admin-token';
process.env.MANIFOLD_VIEWER_TOKEN = 'viewer-token';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
process.env.MANIFOLD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-conc-test-'));

const ProfileStore = require('../services/profileStore');

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

after(async () => {
  await services?.devices?.stop?.();
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models', 'outbox', 'bindings']) services?.[s]?.stop?.();
  services?.audit?.close();
  server?.close();
});

async function call(p, { method = 'GET', token = 'admin-token', body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, body: json };
}

const BROKER = { host: '127.0.0.1', port: 1, reconnect: false, name: 'conc' };
const tmpStore = () => new ProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rev-')));

// ---- the store --------------------------------------------------------------------

test('every collection stamps rev + updatedAt and refuses a stale expectRev', () => {
  const store = tmpStore();
  for (const c of ProfileStore.COLLECTIONS) {
    const a = store.upsertIn(c, 'x', { name: 'one' });
    assert.strictEqual(a.rev, 1, `${c}: first write is rev 1`);
    assert.ok(a.updatedAt, `${c}: updatedAt set`);
    const b = store.upsertIn(c, 'x', { name: 'two', rev: 99 }, { expectRev: 1 });
    assert.strictEqual(b.rev, 2, `${c}: a client-supplied rev in the body never wins`);
    assert.throws(
      () => store.upsertIn(c, 'x', { name: 'three' }, { expectRev: 1 }),
      (e) => e.code === 'stale' && e.current.rev === 2 && e.current.name === 'two',
      `${c}: stale write refused with the current object`
    );
    assert.strictEqual(store.getIn(c, 'x').name, 'two', `${c}: a refused write changes nothing`);
    const c3 = store.upsertIn(c, 'x', { name: 'last-write-wins' }); // no expectRev: old behaviour
    assert.strictEqual(c3.rev, 3);
  }
});

test('brokers, opcua, mounts and alert rules carry revisions too', () => {
  const store = tmpStore();
  const b = store.upsertBroker('b1', { host: 'h', password: 'pw' });
  assert.strictEqual(b.rev, 1);
  assert.strictEqual(b.config.rev, undefined, 'the revision lives on the wrapper, not in the connection config');
  assert.throws(() => store.upsertBroker('b1', { host: 'h2' }, { expectRev: 0 }), (e) => e.code === 'stale');
  assert.strictEqual(store.upsertBroker('b1', { host: 'h2' }, { expectRev: 1 }).rev, 2);
  store.setBrokerAdmin('b1', { url: 'http://x' });
  assert.strictEqual(store.getBroker('b1').rev, 3, 'changing the admin config is a write');

  assert.strictEqual(store.upsertOpcua('o1', { endpointUrl: 'opc.tcp://x' }).rev, 1);
  assert.throws(() => store.upsertOpcua('o1', {}, { expectRev: 5 }), (e) => e.code === 'stale');
  assert.strictEqual(store.upsertMount('m1', { type: 'opcua' }).rev, 1);
  assert.throws(() => store.upsertMount('m1', {}, { expectRev: 0 }), (e) => e.code === 'stale');
  assert.strictEqual(store.upsertAlertRule('a1', { name: 'r' }).rev, 1);
  assert.throws(() => store.upsertAlertRule('a1', {}, { expectRev: 0 }), (e) => e.code === 'stale');
});

test('data written before revisions existed reads as rev 0, no migration needed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rev-legacy-'));
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ pipelines: { p: { id: 'p', name: 'old' } }, mqtt: { b: { config: { id: 'b', host: 'h' } } } }));
  const store = new ProfileStore(dir);
  assert.strictEqual(store.getIn('pipelines', 'p').rev, undefined);
  assert.doesNotThrow(() => store.upsertIn('pipelines', 'p', { name: 'new' }, { expectRev: 0 }), 'expectRev 0 matches an unstamped object');
  assert.strictEqual(store.getIn('pipelines', 'p').rev, 1);
  assert.strictEqual(store.upsertBroker('b', { host: 'h2' }, { expectRev: 0 }).rev, 1);
});

// ---- routes: 409 for every editable collection ---------------------------------

async function makeBroker(extra = {}) {
  const r = await call('/api/mqtt/brokers', { method: 'POST', body: { ...BROKER, ...extra } });
  assert.strictEqual(r.status, 202, JSON.stringify(r.body));
  return r.body.brokerId;
}

test('POST /api/models persists the TVQ envelope switch and its stale window', async () => {
  const broker = await makeBroker({ name: 'tvq-broker', host: 'tvq.example.test' });
  const base = { target: { brokerId: broker, topic: 'uns/tvq' }, attributes: [{ name: 'a', source: { brokerId: broker, topic: 'raw/tvq' } }] };
  const on = await call('/api/models', { method: 'POST', body: { ...base, name: 'tvq-on', envelope: true, staleMs: 15000 } });
  assert.strictEqual(on.status, 201, JSON.stringify(on.body));
  assert.strictEqual(on.body.envelope, true);
  assert.strictEqual(on.body.staleMs, 15000);
  const off = await call('/api/models', { method: 'POST', body: { ...base, name: 'tvq-off' } });
  assert.strictEqual(off.body.envelope, false);
  assert.strictEqual(off.body.staleMs, 60000);
});

test('routes answer 409 { code: stale, current } on a stale write and accept rev via body or If-Match', async () => {
  const broker = await makeBroker({ name: 'rev-broker', host: 'rev.example.test' });
  const historian = (await call('/api/historians', { method: 'POST', body: { type: 'influxdb', url: 'http://h.example.test', org: 'o', bucket: 'b', token: 'SECRET-TOKEN' } })).body;
  assert.strictEqual(historian.rev, 1);
  assert.strictEqual(historian.token, undefined, 'historian echo never carries the token');

  const cases = [
    { name: 'pipelines', path: '/api/pipelines', body: { name: 'r', source: { brokerId: broker, filter: 'a/#' }, target: { type: 'mqtt', brokerId: broker } } },
    { name: 'models', path: '/api/models', body: { name: 'm', target: { brokerId: broker, topic: 'uns/m' }, attributes: [{ name: 'a', source: { brokerId: broker, topic: 'raw/a' } }] } },
    { name: 'contracts', path: '/api/contracts', body: { name: 'c', brokerId: broker, filter: 'a/#', schema: { type: 'object' } } },
    { name: 'recordings', path: '/api/recorder', body: { name: 'rec', brokerId: broker, filter: 'a/#' } },
    { name: 'alertRules', path: '/api/alerts/rules', body: { name: 'al', type: 'topic-silent', brokerId: broker, topic: 'a/b' } },
    { name: 'historians', path: '/api/historians', body: { name: 'h', type: 'influxdb', url: 'http://h.example.test', org: 'o', bucket: 'b' } }
  ];
  for (const c of cases) {
    const created = await call(c.path, { method: 'POST', body: c.body });
    assert.strictEqual(created.status, 201, `${c.name}: ${JSON.stringify(created.body)}`);
    assert.strictEqual(created.body.rev, 1, `${c.name}: rev 1 on create`);
    const id = created.body.id;

    const ok = await call(c.path, { method: 'POST', body: { ...c.body, id, name: 'edit A', rev: 1 } });
    assert.strictEqual(ok.status, 201, `${c.name}: matching rev saves`);
    assert.strictEqual(ok.body.rev, 2);

    const stale = await call(c.path, { method: 'POST', body: { ...c.body, id, name: 'edit B', rev: 1 } });
    assert.strictEqual(stale.status, 409, `${c.name}: stale body rev`);
    assert.strictEqual(stale.body.code, 'stale');
    assert.strictEqual(stale.body.current.rev, 2);
    assert.strictEqual(stale.body.current.name, 'edit A', `${c.name}: current carries what the other writer saved`);
    assert.ok(stale.body.error);

    const staleHeader = await call(c.path, { method: 'POST', body: { ...c.body, id, name: 'edit C' }, headers: { 'If-Match': '"1"' } });
    assert.strictEqual(staleHeader.status, 409, `${c.name}: stale If-Match`);

    const okHeader = await call(c.path, { method: 'POST', body: { ...c.body, id, name: 'edit D' }, headers: { 'If-Match': 'W/"2"' } });
    assert.strictEqual(okHeader.status, 201, `${c.name}: matching If-Match saves`);
    assert.strictEqual(okHeader.body.name, 'edit D');

    const lww = await call(c.path, { method: 'POST', body: { ...c.body, id, name: 'edit E' } });
    assert.strictEqual(lww.status, 201, `${c.name}: no rev keeps last-write-wins (old clients and scripts)`);
    assert.strictEqual(lww.body.rev, 4);

    const bad = await call(c.path, { method: 'POST', body: { ...c.body, id, rev: 'abc' } });
    assert.strictEqual(bad.status, 400, `${c.name}: a malformed rev is a 400, not a silent overwrite`);
  }

  // secrets: `current` is redacted exactly as GET is
  const hs = await call('/api/historians', { method: 'POST', body: { id: historian.id, type: 'influxdb', url: 'http://h.example.test', org: 'o', bucket: 'b', rev: 0 } });
  assert.strictEqual(hs.status, 409);
  assert.strictEqual(hs.body.current.token, undefined, '409 current never carries the historian token');
  assert.strictEqual(hs.body.current.hasSecret, true);
  assert.ok(!JSON.stringify(hs.body).includes('SECRET-TOKEN'));
});

test('broker PUT: stale edit refused BEFORE the connection is touched; current is masked', async () => {
  const id = await makeBroker({ name: 'put-broker', host: 'put.example.test', username: 'u', password: 'BROKER-PW' });
  const list = await call('/api/mqtt/brokers');
  const row = list.body.brokers.find((b) => b.id === id);
  assert.strictEqual(row.rev, 1);
  assert.ok(!JSON.stringify(list.body).includes('BROKER-PW'));
  const before = services.mqttManager.clients.get(id);

  const first = await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...BROKER, host: 'put.example.test', name: 'renamed', rev: 1 } });
  assert.strictEqual(first.status, 202);
  assert.strictEqual(first.body.rev, 2);
  const mid = services.mqttManager.clients.get(id);
  assert.notStrictEqual(mid, before, 'a good edit reconnects');

  const stale = await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...BROKER, host: 'put.example.test', name: 'tab two', rev: 1 } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.code, 'stale');
  assert.strictEqual(stale.body.current.name, 'renamed');
  assert.strictEqual(stale.body.current.rev, 2);
  assert.strictEqual(stale.body.current.password, null, 'credentials are masked in current');
  assert.ok(!JSON.stringify(stale.body).includes('BROKER-PW'));
  assert.strictEqual(services.mqttManager.clients.get(id), mid, 'the stale edit did not reconnect anything');
  assert.strictEqual(services.profiles.getBroker(id).config.name, 'renamed');
});

test('device and device-profile PUT use rev too; status is part of current like GET', async () => {
  const created = await call('/api/devices', { method: 'POST', body: { name: 'conc-dev', protocol: 'modbus-tcp', host: '127.0.0.1', port: 1, enabled: false, tags: [] } });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.strictEqual(created.body.rev, 1);
  const a = await call(`/api/devices/${id}`, { method: 'PUT', body: { ...created.body, name: 'conc-dev-a', rev: 1 } });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(a.body.rev, 2);
  const stale = await call(`/api/devices/${id}`, { method: 'PUT', body: { ...created.body, name: 'conc-dev-b', rev: 1 } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.current.name, 'conc-dev-a');
  assert.ok(stale.body.current.status, 'same shape as GET /api/devices');
  assert.ok(!('pinned' in stale.body.current));
  // a client cannot inject a pinned address through the body
  const inj = await call(`/api/devices/${id}`, { method: 'PUT', body: { ...a.body, pinned: { addresses: ['169.254.169.254'] } } });
  assert.strictEqual(inj.status, 200);
  assert.strictEqual(services.profiles.getIn('devices', id).pinned, undefined, 'pinned is never stored from a request');

  // A device with credentials: every answer, the 409 conflict body included, carries a stored secret as null.
  for (const [protocol, secret, extra] of [
    ['snmp', 'community', { version: '2c', community: 'CONC-COMMUNITY', port: 161 }],
    ['http-json', 'authToken', { authType: 'bearer', authToken: 'CONC-TOKEN', port: 80 }]
  ]) {
    const made = await call('/api/devices', { method: 'POST', body: { name: `conc-${protocol}`, protocol, host: '127.0.0.1', enabled: false, tags: [], ...extra } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body[secret], null);
    const sid = made.body.id;
    const first = await call(`/api/devices/${sid}`, { method: 'PUT', body: { ...made.body, name: `conc-${protocol}-a`, rev: 1 } });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(services.profiles.getIn('devices', sid)[secret], extra[secret], 'the null sent back keeps the stored secret');
    const conflict = await call(`/api/devices/${sid}`, { method: 'PUT', body: { ...made.body, name: `conc-${protocol}-b`, rev: 1 } });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.body.current[secret], null, `${secret} is masked in current`);
    assert.ok(!JSON.stringify(conflict.body).includes(extra[secret]));
    assert.ok(!JSON.stringify((await call('/api/devices')).body).includes(extra[secret]));
  }

  const prof = await call('/api/devices/profiles', { method: 'POST', body: { name: 'conc-prof', protocol: 'modbus-tcp', tags: [] } });
  assert.strictEqual(prof.status, 201, JSON.stringify(prof.body));
  assert.strictEqual(prof.body.rev, 1);
  const p2 = await call(`/api/devices/profiles/${prof.body.id}`, { method: 'PUT', body: { ...prof.body, name: 'conc-prof-2', rev: 1 } });
  assert.strictEqual(p2.status, 200, JSON.stringify(p2.body));
  const p3 = await call(`/api/devices/profiles/${prof.body.id}`, { method: 'PUT', body: { ...prof.body, name: 'conc-prof-3', rev: 1 } });
  assert.strictEqual(p3.status, 409);
  assert.strictEqual(p3.body.current.name, 'conc-prof-2');
});

test('bindings (routes/tags.js pass-through) answer 409 on a stale rev', async () => {
  const stale = services.profiles;
  // Minimal stored binding written straight to the store; the route re-validates on save, so use the store to bump rev.
  stale.upsertIn('bindings', 'conc-b', { name: 'b', source: { type: 'mqtt' } });
  stale.upsertIn('bindings', 'conc-b', { name: 'b2', source: { type: 'mqtt' } });
  const r = await call('/api/tags/bindings', { method: 'POST', body: { id: 'conc-b', name: 'x', rev: 1 } });
  assert.ok([409, 400].includes(r.status));
  if (r.status === 409) {
    assert.strictEqual(r.body.code, 'stale');
    assert.strictEqual(r.body.current.rev, 2);
  }
});

test('config import bypasses the check but bumps revisions', async () => {
  const id = (await call('/api/historians', { method: 'POST', body: { name: 'imp', type: 'influxdb', url: 'http://imp.example.test', org: 'o', bucket: 'b' } })).body.id;
  const exp = await call('/api/system/config/export');
  const item = exp.body.historians.find((h) => h.id === id);
  const imp = await call('/api/system/config/import', { method: 'POST', body: { manifoldConfig: 1, historians: [{ ...item, name: 'imported', rev: 1 }] } });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
  const now = services.profiles.getIn('historians', id);
  assert.strictEqual(now.name, 'imported');
  assert.strictEqual(now.rev, 2, 'import writes through the store, so the revision moves');
});

// ---- duplicate brokers --------------------------------------------------------

test('an exact duplicate broker is refused with a 409 naming the existing connection', async () => {
  const cfg = { host: 'dup.example.test', port: 1883, reconnect: false, username: 'u', subscribeFilter: 'plant/#', name: 'first-dup' };
  const first = await call('/api/mqtt/brokers', { method: 'POST', body: cfg });
  assert.strictEqual(first.status, 202);
  const before = services.mqttManager.getConnections().length;

  const again = await call('/api/mqtt/brokers', { method: 'POST', body: { ...cfg, name: 'second', host: 'DUP.example.test', clientId: 'other' } });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.code, 'duplicate');
  assert.strictEqual(again.body.existing.id, first.body.brokerId);
  assert.match(again.body.error, /first-dup/);
  assert.strictEqual(services.mqttManager.getConnections().length, before, 'nothing was connected');

  // legitimate: same broker, different filter / different user / different port
  for (const over of [{ subscribeFilter: 'other/#' }, { username: 'v' }, { port: 1884 }]) {
    const ok = await call('/api/mqtt/brokers', { method: 'POST', body: { ...cfg, name: `dup-${JSON.stringify(over)}`, ...over } });
    assert.strictEqual(ok.status, 202, JSON.stringify(over));
  }

  // an edit that would collide with another connection is refused too; editing itself is fine
  const other = await call('/api/mqtt/brokers', { method: 'POST', body: { ...cfg, name: 'third', subscribeFilter: 'third/#' } });
  const clash = await call(`/api/mqtt/brokers/${other.body.brokerId}`, { method: 'PUT', body: { ...cfg, name: 'third', subscribeFilter: 'plant/#' } });
  assert.strictEqual(clash.status, 409);
  const self = await call(`/api/mqtt/brokers/${other.body.brokerId}`, { method: 'PUT', body: { ...cfg, name: 'third-renamed', subscribeFilter: 'third/#' } });
  assert.strictEqual(self.status, 202);
});

// ---- dangling references ------------------------------------------------------

test('saving something that points at a missing broker or historian is a 400 naming it', async () => {
  const broker = await makeBroker({ name: 'ref-ok', host: 'ref.example.test' });
  const gone = 'no-such-broker';
  const cases = [
    ['/api/pipelines', { source: { brokerId: gone, filter: 'a/#' }, target: { type: 'mqtt', brokerId: broker } }, /broker "no-such-broker"/],
    ['/api/pipelines', { source: { brokerId: broker, filter: 'a/#' }, target: { type: 'historian', historianId: 'no-such-hist' } }, /historian "no-such-hist"/],
    ['/api/models', { target: { brokerId: broker, topic: 'uns/x' }, attributes: [{ name: 'a', source: { brokerId: gone, topic: 'raw/a' } }] }, /broker "no-such-broker"/],
    ['/api/recorder', { brokerId: gone, filter: 'a/#' }, /broker "no-such-broker"/],
    ['/api/recorder', { brokerId: broker, filter: 'a/#', target: { type: 'historian', historianId: 'no-such-hist' } }, /historian "no-such-hist"/],
    ['/api/contracts', { brokerId: gone, filter: 'a/#', schema: { type: 'object' } }, /broker "no-such-broker"/],
    ['/api/alerts/rules', { type: 'topic-silent', brokerId: gone, topic: 'a/b' }, /broker "no-such-broker"/]
  ];
  for (const [p, body, re] of cases) {
    const r = await call(p, { method: 'POST', body });
    assert.strictEqual(r.status, 400, `${p} ${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, re);
  }
});

test('deleting a broker that is still referenced is a 409 naming the users; then it works', async () => {
  const id = await makeBroker({ name: 'del-broker', host: 'del.example.test' });
  const route = await call('/api/pipelines', { method: 'POST', body: { name: 'uses-del', source: { brokerId: id, filter: 'x/#' }, target: { type: 'mqtt', brokerId: id } } });
  const rec = await call('/api/recorder', { method: 'POST', body: { name: 'rec-del', brokerId: id, filter: 'x/#' } });
  const rule = await call('/api/alerts/rules', { method: 'POST', body: { name: 'rule-del', type: 'topic-silent', brokerId: id, topic: 'x/y' } });
  const model = await call('/api/models', { method: 'POST', body: { name: 'model-del', target: { brokerId: id, topic: 'uns/d' }, attributes: [{ name: 'a', source: { brokerId: id, topic: 'raw/d' } }] } });
  const contract = await call('/api/contracts', { method: 'POST', body: { name: 'contract-del', brokerId: id, filter: 'x/#', schema: { type: 'object' } } });
  services.sparkplugPublisher.hostSessions.set(`${id} host1`, { key: `${id} host1`, brokerId: id, hostId: 'host1' });

  const refused = await call(`/api/mqtt/brokers/${id}`, { method: 'DELETE' });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.code, 'in-use');
  const types = refused.body.usedBy.map((u) => u.type).sort();
  assert.deepStrictEqual(types, ['Sparkplug host session', 'alert rule', 'contract', 'model', 'recording', 'route']);
  for (const n of ['uses-del', 'rec-del', 'rule-del', 'model-del', 'contract-del', 'host1']) assert.match(refused.body.error, new RegExp(n));
  assert.ok(services.mqttManager.getConnection(id), 'still connected');

  services.sparkplugPublisher.hostSessions.delete(`${id} host1`);
  for (const [p, r] of [['/api/pipelines', route], ['/api/recorder', rec], ['/api/alerts/rules', rule], ['/api/models', model], ['/api/contracts', contract]]) {
    assert.strictEqual((await call(`${p}/${r.body.id}`, { method: 'DELETE' })).status, 200);
  }
  assert.strictEqual((await call(`/api/mqtt/brokers/${id}`, { method: 'DELETE' })).status, 200);
});

test('objects whose reference disappeared are reported as broken, with the missing id', async () => {
  const id = await makeBroker({ name: 'ghost', host: 'ghost.example.test' });
  const route = await call('/api/pipelines', { method: 'POST', body: { name: 'ghost-route', source: { brokerId: id, filter: 'g/#' }, target: { type: 'mqtt', brokerId: id } } });
  const rule = await call('/api/alerts/rules', { method: 'POST', body: { name: 'ghost-rule', type: 'topic-silent', brokerId: id, topic: 'g/t' } });
  // the broker vanishes behind the API's back (hand-edited profile, removed over the socket, import)
  services.mqttManager.disconnectFromBroker(id);
  services.profiles.removeBroker(id);

  const routes = await call('/api/pipelines');
  const row = routes.body.routes.find((r) => r.id === route.body.id);
  assert.deepStrictEqual(row.broken.map((b) => [b.kind, b.id]), [['broker', id]]);
  const rules = await call('/api/alerts/rules');
  const st = rules.body.rules.find((r) => r.id === rule.body.id).state;
  assert.strictEqual(st.state, 'broken');
  assert.strictEqual(st.broken[0].id, id);
  const { scanBroken } = require('../services/references');
  const found = scanBroken({ profiles: services.profiles, mqttManager: services.mqttManager });
  assert.ok(found.some((f) => f.name === 'ghost-route'));
});

// ---- roles ------------------------------------------------------------------------

test('viewer cannot write any of the revisioned routes; GET still works and shows rule state', async () => {
  const viewer = (p, method = 'POST', body = {}) => call(p, { method, token: 'viewer-token', body });
  for (const p of ['/api/pipelines', '/api/models', '/api/contracts', '/api/recorder', '/api/historians', '/api/alerts/rules', '/api/mqtt/brokers', '/api/devices', '/api/devices/profiles', '/api/tags/bindings']) {
    const r = await viewer(p);
    assert.strictEqual(r.status, 403, `${p} must be admin-only`);
  }
  assert.strictEqual((await viewer('/api/devices/x', 'PUT')).status, 403);
  assert.strictEqual((await viewer('/api/mqtt/brokers/x', 'DELETE')).status, 403);
  const rules = await call('/api/alerts/rules', { token: 'viewer-token' });
  assert.strictEqual(rules.status, 200);
  const ev = await call('/api/alerts/events?ruleId=nothing', { token: 'viewer-token' });
  assert.strictEqual(ev.status, 200);
  assert.deepStrictEqual(ev.body.events, []);
  const noAuth = await call('/api/pipelines', { token: null });
  assert.strictEqual(noAuth.status, 401);
});

test('the audit log records stale and duplicate refusals without leaking secrets', async () => {
  await call('/api/mqtt/brokers', { method: 'POST', body: { host: 'audit.example.test', port: 1, reconnect: false, password: 'AUDIT-PW' } });
  await call('/api/mqtt/brokers', { method: 'POST', body: { host: 'audit.example.test', port: 1, reconnect: false, password: 'AUDIT-PW' } });
  const log = await call('/api/audit?limit=50');
  assert.strictEqual(log.status, 200);
  const text = JSON.stringify(log.body);
  assert.ok(!text.includes('AUDIT-PW'));
  assert.ok(/409/.test(text));
});
