'use strict';

// http-json and mtconnect devices through the real DeviceManager, supervisor and child driver host:
// registration, descriptor, secrets (masked, kept on edit, redacted in exports), address pinning with
// a host name, source timestamps, device test, browse and probe over the supervisor.

const { test } = require('node:test');
const assert = require('node:assert');
const { DeviceManager, DeviceValidationError } = require('../services/deviceManager');
const { redactSecrets } = require('../services/secrets');
const { startHttpJsonSimulator } = require('./support/httpJsonSimulator');
const { startMtconnectSimulator } = require('./support/mtconnectSimulator');

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function memoryProfiles() {
  const data = { devices: {}, deviceProfiles: {}, bindings: {} };
  return {
    data,
    rev: 0,
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      data[c][id] = { ...obj, id };
      this.rev++;
      return data[c][id];
    },
    removeIn(c, id) {
      if (!data[c][id]) return false;
      delete data[c][id];
      this.rev++;
      return true;
    }
  };
}

const METER = { power: { total: 12.5 }, status: { ts: '2025-03-04T05:06:07.250Z' }, state: 'OK' };

async function setup({ lookup } = {}) {
  const sim = await startHttpJsonSimulator({ docs: { '/api/meter': METER } });
  const agent = await startMtconnectSimulator({});
  const profiles = memoryProfiles();
  const devices = new DeviceManager({
    profiles,
    ...(lookup ? { lookup, rebindCheckMs: 0 } : { guard: async () => {} }),
    supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } }
  });
  const samples = [];
  devices.on('sample', (s) => samples.push(s));
  await devices.start();
  const http = {
    name: 'Meter',
    protocol: 'http-json',
    host: '127.0.0.1',
    port: sim.port,
    scheme: 'http',
    path: '/api',
    authType: 'bearer',
    authToken: 'S3CRET-TOKEN',
    limits: { requestDeadlineMs: 400, connectTimeoutMs: 600 },
    pollGroups: [{ id: 'fast', intervalMs: 100 }],
    tags: [
      { key: 'power', address: '/meter#$.power.total', type: 'number', pollGroup: 'fast', unit: 'kW', timestampSelector: '$.status.ts' },
      { key: 'state', address: '/meter#$.state', type: 'string', pollGroup: 'fast' }
    ]
  };
  const mtc = {
    name: 'Mill',
    protocol: 'mtconnect',
    host: '127.0.0.1',
    port: agent.port,
    limits: { requestDeadlineMs: 500, connectTimeoutMs: 1500 },
    pollGroups: [{ id: 'fast', intervalMs: 100 }],
    tags: [
      { key: 'x', address: 'Xact', type: 'number', pollGroup: 'fast', unit: 'mm' },
      { key: 'exec', address: 'exec', type: 'string', pollGroup: 'fast' }
    ]
  };
  sim.requireHeader('authorization', 'Bearer S3CRET-TOKEN');
  const cleanup = async () => {
    await devices.stop();
    await sim.close();
    await agent.close();
  };
  return { sim, agent, profiles, devices, http, mtc, samples, cleanup };
}

test('both protocols are registered with descriptors the form can render', async () => {
  const t = await setup();
  try {
    const protocols = t.devices.protocols();
    const h = protocols.find((p) => p.id === 'http-json');
    const m = protocols.find((p) => p.id === 'mtconnect');
    assert.ok(h && m);
    assert.strictEqual(h.experimental, true);
    assert.strictEqual(m.experimental, true);
    assert.strictEqual(h.capabilities.browse, true);
    assert.strictEqual(h.deviceFields.find((f) => f.name === 'authPassword').type, 'password');
    assert.strictEqual(h.deviceFields.find((f) => f.name === 'tlsInsecure').type, 'boolean');
    assert.strictEqual(h.deviceFields.find((f) => f.name === 'scheme').type, 'select');
    assert.deepStrictEqual(h.tagTypes, ['number', 'bool', 'string']);
    assert.strictEqual(h.defaultPort, 80);
    assert.strictEqual(m.defaultPort, 5000);
  } finally {
    await t.cleanup();
  }
});

test('http-json: live values over the supervisor, source timestamp, secret masked in the API and kept on edit', async () => {
  const t = await setup();
  try {
    const saved = await t.devices.save(t.http);
    assert.strictEqual(saved.authToken, null, 'the saved device is returned with the secret as null');
    assert.strictEqual(t.profiles.getIn('devices', saved.id).authToken, 'S3CRET-TOKEN', 'the store keeps the real value');
    await until(() => t.devices.getValues(saved.id).power?.v === 12.5, 8000, 'first value');
    assert.strictEqual(t.devices.getValues(saved.id).state.v, 'OK');
    const s = t.samples.find((x) => x.address === 'power');
    assert.strictEqual(s.tSource, Date.parse('2025-03-04T05:06:07.250Z'));
    assert.strictEqual(t.devices.list()[0].status.state, 'online');
    assert.strictEqual(t.devices.list()[0].authToken, null, 'list() never returns the secret');
    assert.ok(!JSON.stringify(t.devices.list()).includes('S3CRET'));

    // edit with the secret left out, blank, or sent back as the null it was answered with: the stored one stays
    for (const authToken of [undefined, '', null]) {
      const { authToken: _drop, ...rest } = t.http;
      await t.devices.save({ ...rest, ...(authToken === undefined ? {} : { authToken }), name: 'Meter renamed' }, saved.id);
      assert.strictEqual(t.profiles.getIn('devices', saved.id).authToken, 'S3CRET-TOKEN');
    }
    // a new secret replaces it; switching to another authentication drops the unused one
    await t.devices.save({ ...t.http, authToken: 'NEW-TOKEN' }, saved.id);
    assert.strictEqual(t.profiles.getIn('devices', saved.id).authToken, 'NEW-TOKEN');
    await t.devices.save({ ...t.http, authType: 'basic', authUsername: 'u', authPassword: 'pw', authToken: 'NEW-TOKEN' }, saved.id);
    const stored = t.profiles.getIn('devices', saved.id);
    assert.strictEqual(stored.authToken, undefined);
    assert.strictEqual(stored.authPassword, 'pw');
    // the device keeps working only with matching credentials (the simulator wants the bearer token)
    t.sim.requireHeader('authorization', `Basic ${Buffer.from('u:pw').toString('base64')}`);
    await until(() => t.devices.statusOf(t.profiles.getIn('devices', saved.id)).state === 'online', 8000, 'online with basic auth');
  } finally {
    await t.cleanup();
  }
});

test('http-json: secrets are redacted by the shared export/audit redaction', () => {
  const dev = { protocol: 'http-json', authType: 'header', authHeaderName: 'X-Key', authHeaderSecret: 'HDR-SECRET', authPassword: 'PW', authToken: 'TOK', tlsFingerprint256: 'AA' };
  const out = JSON.stringify(redactSecrets({ devices: { d1: dev } }));
  for (const secret of ['HDR-SECRET', '"PW"', '"TOK"']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('X-Key'), 'the header name is not a secret');
});

test('http-json: invalid config is refused with details and nothing is stored', async () => {
  const t = await setup();
  try {
    await assert.rejects(
      t.devices.save({ ...t.http, tags: [{ key: 'a', address: '/x#$..bad', type: 'number' }, { key: 'b', address: '/x#$.ok', type: 'number' }] }),
      (e) => e instanceof DeviceValidationError && e.details.length === 1 && e.details[0].key === 'a'
    );
    await assert.rejects(t.devices.save({ ...t.http, authType: 'bearer', authToken: '' }), /authToken/);
    await assert.rejects(t.devices.save({ ...t.http, scheme: 'ftp' }), /scheme/);
    assert.strictEqual(t.profiles.listIn('devices').length, 0);
  } finally {
    await t.cleanup();
  }
});

test('http-json: test connection, browse and probe through the supervisor', async () => {
  const t = await setup();
  try {
    const r = await t.devices.test(t.http);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.info.status, 404);
    assert.match(r.info.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/$/);
    const bad = await t.devices.test({ ...t.http, authToken: 'WRONG' });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /401|credentials/);
    assert.ok(!bad.error.includes('WRONG'));

    const saved = await t.devices.save(t.http);
    await until(() => t.devices.statusOf(saved).state === 'online', 8000, 'online');
    const roots = await t.devices.browse(saved.id);
    assert.ok(roots.some((n) => n.id === '/meter' && n.kind === 'folder'));
    const leaves = await t.devices.browse(saved.id, '/meter');
    assert.ok(leaves.some((n) => n.address === '/meter#$.power.total' && n.meta.dataType === 'number' && n.meta.sample === 12.5));
    const probe = await t.devices.probe(saved.id, { address: '/meter#$.power.total' });
    assert.strictEqual(probe.decodings.value, 12.5);
    for (const q of t.sim.requests) assert.strictEqual(q.method, 'GET');
  } finally {
    await t.cleanup();
  }
});

test('http-json: a host name device connects to the validated, pinned address with the name in Host', async () => {
  const lookup = async (host, opts) => {
    if (host !== 'meter.example.test') throw new Error(`ENOTFOUND ${host}`);
    const list = [{ address: '127.0.0.1', family: 4 }];
    return opts && opts.all ? list : list[0];
  };
  const t = await setup({ lookup });
  try {
    const saved = await t.devices.save({ ...t.http, host: 'meter.example.test' });
    await until(() => t.devices.getValues(saved.id).power?.v === 12.5, 8000, 'value over the pinned address');
    assert.deepStrictEqual(t.devices.statusOf(saved).addresses, ['127.0.0.1']);
    assert.strictEqual(t.sim.requests.at(-1).headers.host, `meter.example.test:${t.sim.port}`);
    const r = await t.devices.test({ ...t.http, host: 'meter.example.test' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  } finally {
    await t.cleanup();
  }
});

test('mtconnect: live values with the observation timestamp, browse with units, agent restart', async () => {
  const t = await setup();
  try {
    const saved = await t.devices.save(t.mtc);
    const ts = '2024-06-01T12:00:00.500Z';
    t.agent.setValue('Xact', 12.5, { ts });
    t.agent.setValue('exec', 'ACTIVE');
    await until(() => t.devices.getValues(saved.id).x?.v === 12.5, 8000, 'x');
    assert.strictEqual(t.devices.getValues(saved.id).exec.v, 'ACTIVE');
    assert.strictEqual(t.samples.filter((s) => s.address === 'x' && s.v === 12.5).at(-1).tSource, Date.parse(ts));
    const tree = await t.devices.browse(saved.id);
    assert.strictEqual(tree[0].name, 'mill-1');
    const test = await t.devices.test(t.mtc);
    assert.strictEqual(test.ok, true, JSON.stringify(test));
    assert.deepStrictEqual(test.info.devices, ['mill-1']);
    t.agent.restart();
    t.agent.setValue('Xact', 99);
    await until(() => t.devices.getValues(saved.id).x?.v === 99, 8000, 'value after restart');
    assert.strictEqual(t.devices.statusOf(saved).state, 'online');
    for (const q of t.agent.requests) assert.strictEqual(q.method, 'GET');
  } finally {
    await t.cleanup();
  }
});
