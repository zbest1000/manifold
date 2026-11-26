'use strict';

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { DeviceManager } = require('../services/deviceManager');
const { redactSecrets } = require('../services/secrets');
const { redact } = require('../services/auditLog');
const { startSnmpSimulator } = require('./support/snmpSimulator');

// SNMP through the real stack: DeviceManager -> supervisor -> driver host child
// process -> UDP -> simulator; plus how device credentials are stored and redacted.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function memoryProfiles() {
  const data = { devices: {}, bindings: {}, deviceProfiles: {} };
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

const USER = { name: 'ops', level: 'authPriv', authProtocol: 'sha256', authPassword: 'auth-secret-1', privProtocol: 'aes', privPassword: 'priv-secret-1' };

async function setup() {
  const sim = await startSnmpSimulator({ communities: ['plant-ro'], users: [USER] });
  const profiles = memoryProfiles();
  const devices = new DeviceManager({ profiles, guard: async () => {}, supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } } });
  await devices.start();
  const app = express();
  app.use(express.json());
  app.locals.services = { devices, profiles, bindings: { reconcile() {}, async syncMonitors() {} } };
  app.use('/api/devices', require('../routes/devices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/devices`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const cleanup = async () => {
    await new Promise((r) => server.close(r));
    await devices.stop();
    await sim.close();
  };
  return { sim, profiles, devices, call, cleanup };
}

test('the SNMP descriptor offers password fields, conditional v3 fields and browse', async () => {
  const devices = new DeviceManager({ profiles: memoryProfiles(), guard: async () => {} });
  const d = devices.protocols().find((p) => p.id === 'snmp');
  assert.ok(d, 'snmp is registered');
  assert.equal(d.defaultPort, 161);
  assert.equal(d.experimental, true);
  assert.equal(d.capabilities.browse, true);
  const f = Object.fromEntries(d.deviceFields.map((x) => [x.name, x]));
  for (const k of ['community', 'authPassword', 'privPassword']) assert.equal(f[k].type, 'password', k);
  assert.deepEqual(f.authPassword.showWhen, { version: ['3'], securityLevel: ['authNoPriv', 'authPriv'] });
  assert.equal(f.version.type, 'select');
  assert.equal(d.tagTypeOptional, true);
  assert.ok(d.tagTypes.includes('Counter64'));
});

test('device secrets: one rule for API answers, export and the audit log', async () => {
  const profiles = memoryProfiles();
  const devices = new DeviceManager({ profiles, guard: async () => {} });
  const v3 = { id: 'a', name: 'a', protocol: 'snmp', host: '127.0.0.1', version: '3', securityName: 'ops', securityLevel: 'authPriv', authPassword: 'x1234567', privPassword: 'y1234567', tags: [{ key: 'k', address: 'sysName.0' }] };
  const red = await devices.save(v3, 'a');
  assert.equal(red.authPassword, null);
  assert.equal(red.privPassword, null);
  assert.equal(red.securityName, 'ops');
  assert.equal(red.tags[0].key, 'k');
  assert.equal(profiles.getIn('devices', 'a').authPassword, 'x1234567', 'the stored object keeps the secret');
  assert.equal(devices.list()[0].privPassword, null);
  const dev = profiles.getIn('devices', 'a');
  const exported = redactSecrets({ ...dev, community: 'plant-ro' });
  assert.equal(exported.community, null);
  assert.equal(exported.authPassword, null);
  assert.equal(exported.tags[0].key, 'k');
  assert.equal(redact({ ...dev, community: 'plant-ro' }).community, '[redacted]');
  // leave blank to keep: absent, null or '' all keep; a new value replaces
  for (const blank of [undefined, null, '']) {
    await devices.save({ ...v3, authPassword: blank, privPassword: blank }, 'a');
    assert.equal(profiles.getIn('devices', 'a').authPassword, 'x1234567');
    assert.equal(profiles.getIn('devices', 'a').privPassword, 'y1234567');
  }
  await devices.save({ ...v3, authPassword: 'z7654321' }, 'a');
  assert.equal(profiles.getIn('devices', 'a').authPassword, 'z7654321');
  // a secret the settings no longer use is dropped (authNoPriv has no privacy password; v2c no v3 passwords)
  await devices.save({ ...v3, securityLevel: 'authNoPriv', privPassword: undefined }, 'a');
  assert.equal(profiles.getIn('devices', 'a').privPassword, undefined);
  await devices.save({ ...v3, version: '2c', community: 'plant-ro' }, 'a');
  assert.equal(profiles.getIn('devices', 'a').authPassword, undefined);
  assert.equal(profiles.getIn('devices', 'a').community, 'plant-ro');
  // never carried across a protocol change
  const switched = devices._keepStoredSecrets({ protocol: 'http-json', host: '127.0.0.1' }, 'a');
  assert.equal(switched.community, undefined);
});

test('an SNMP v2c device polls through the driver host; the community is never returned and survives an edit', async () => {
  const t = await setup();
  try {
    const created = await t.call('POST', '', {
      name: 'Switch 1',
      protocol: 'snmp',
      host: '127.0.0.1',
      port: t.sim.port,
      version: '2c',
      community: 'plant-ro',
      limits: { requestDeadlineMs: 500, connectTimeoutMs: 1000 },
      pollGroups: [{ id: 'fast', intervalMs: 200 }],
      tags: [
        { key: 'name', address: 'sysName.0', pollGroup: 'fast' },
        { key: 'hc', address: 'ifHCInOctets.1', pollGroup: 'fast' },
        { key: 'inRate', address: 'ifInOctets.1', rate: true, pollGroup: 'fast' }
      ]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.community, null, 'not echoed');
    const id = created.body.id;
    assert.equal(t.profiles.getIn('devices', id).community, 'plant-ro', 'stored server-side');
    await until(() => t.devices.getValues(id).name?.q === 192, 8000, 'live value');
    const v = t.devices.getValues(id);
    assert.equal(v.name.v, 'sim-agent');
    assert.equal(v.hc.type, 'uint64');
    assert.equal(typeof v.hc.v, 'string');

    const list = await t.call('GET', '');
    const row = list.body.devices.find((d) => d.id === id);
    assert.equal(row.community, null);
    assert.ok(!JSON.stringify(list.body).includes('plant-ro'), 'the community appears nowhere in GET /api/devices');

    // An edit that sends back the redacted null keeps the community: the device stays online.
    const edit = await t.call('PUT', `/${id}`, { ...row, name: 'Switch 1a', rev: row.rev });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.community, null);
    assert.equal(t.profiles.getIn('devices', id).community, 'plant-ro');
    // Test connection of the saved device with the blank community uses the stored one.
    const test = await t.call('POST', '/test', { ...row, tags: [] });
    assert.equal(test.body.ok, true, JSON.stringify(test.body));
    assert.equal(test.body.info.sysName, 'sim-agent');
    // A wrong community is a silent drop on a real agent: the test says what to check.
    const wrong = await t.call('POST', '/test', { protocol: 'snmp', host: '127.0.0.1', port: t.sim.port, community: 'guess', options: { retries: 0 }, limits: { requestDeadlineMs: 300, connectTimeoutMs: 400 } });
    assert.equal(wrong.body.ok, false);
    assert.match(wrong.body.error, /Check the community/);
    assert.ok(!wrong.body.error.includes('guess'));

    // Browse through the host process.
    const roots = await t.call('GET', `/${id}/browse`);
    assert.ok(roots.body.children.some((n) => n.id === 'walk:1.3.6.1.2.1.1'));
    const sys = await t.call('GET', `/${id}/browse?node=${encodeURIComponent('walk:1.3.6.1.2.1.1')}`);
    assert.ok(sys.body.children.some((n) => n.address === 'sysName.0'));
    // Probe.
    const probe = await t.call('POST', `/${id}/probe`, { address: 'sysName.0' });
    assert.equal(probe.body.decodings.value, 'sim-agent');
    assert.ok(t.sim.stats.pduTypes.every((p) => [0xa0, 0xa1, 0xa5].includes(p)));
  } finally {
    await t.cleanup();
  }
});

test('an SNMPv3 authPriv device: passwords are stored, redacted, and kept on edit', async () => {
  const t = await setup();
  try {
    const created = await t.call('POST', '', {
      name: 'UPS',
      protocol: 'snmp',
      host: '127.0.0.1',
      port: t.sim.port,
      version: '3',
      securityName: 'ops',
      securityLevel: 'authPriv',
      authProtocol: 'sha256',
      authPassword: 'auth-secret-1',
      privProtocol: 'aes',
      privPassword: 'priv-secret-1',
      limits: { requestDeadlineMs: 800, connectTimeoutMs: 1500 },
      pollGroups: [{ id: 'fast', intervalMs: 200 }],
      tags: [{ key: 'name', address: 'sysName.0', pollGroup: 'fast' }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.authPassword, null);
    assert.equal(created.body.privPassword, null);
    const id = created.body.id;
    await until(() => t.devices.getValues(id).name?.q === 192, 10000, 'v3 live value');
    const row = (await t.call('GET', '')).body.devices.find((d) => d.id === id);
    assert.ok(!JSON.stringify(row).includes('secret-1'));
    // Too-short password on a NEW device is refused without echoing it.
    const bad = await t.call('POST', '', { name: 'Bad', protocol: 'snmp', host: '127.0.0.1', port: t.sim.port, version: '3', securityName: 'ops', securityLevel: 'authNoPriv', authPassword: 'short' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /at least 8 characters/);
    assert.ok(!JSON.stringify(bad.body).includes('short"'));
    // Editing without the passwords keeps them.
    const edit = await t.call('PUT', `/${id}`, { ...row, name: 'UPS 2', authPassword: undefined, privPassword: null, rev: row.rev });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(t.profiles.getIn('devices', id).privPassword, 'priv-secret-1');
  } finally {
    await t.cleanup();
  }
});

test('discovery: the SNMP probe is opt-in, needs no TCP port, and reports the agent as a device', async () => {
  const DiscoveryService = require('../services/discovery');
  const sim = await startSnmpSimulator();
  const d = new DiscoveryService({ emit: () => {} });
  try {
    const off = await d.plan({ range: '127.0.0.1', mqttPorts: [], opcuaPorts: [], i3xPorts: [], modbusPorts: [9], includeDevices: true });
    assert.deepEqual(off.kinds.snmp, [], 'a device scan does not imply SNMP');
    const on = await d.plan({ range: '127.0.0.1', mqttPorts: [], opcuaPorts: [], i3xPorts: [], includeSnmp: true });
    assert.deepEqual(on.kinds.snmp, [161]);
    const before = sim.stats.received;
    const finished = new Promise((resolve) => d.once('done', resolve));
    await d.startScan({ range: '127.0.0.1', mqttPorts: [], opcuaPorts: [], i3xPorts: [], snmpPorts: [sim.port], identifyTimeoutMs: 1000 });
    await finished;
    const results = d.getLastResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'snmp');
    assert.equal(results[0].protocol, 'snmp');
    assert.equal(results[0].suggestedDevice.protocol, 'snmp');
    assert.equal(results[0].suggestedDevice.port, sim.port);
    assert.match(results[0].suggestedDevice.name, /^sim-agent /);
    assert.equal(sim.stats.received - before, 1, 'one datagram per address');
  } finally {
    await sim.close();
  }
});
