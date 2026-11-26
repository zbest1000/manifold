'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DeviceManager } = require('../services/deviceManager');
const { startMatterServerSimulator } = require('./support/matterServerSimulator');
const { startZwaveJsServerSimulator } = require('./support/zwaveJsServerSimulator');

// End to end: bridge simulators <- drivers in real child host processes <- supervisor <- DeviceManager.

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
    },
  };
}

test('matter-server and zwave-js through the device manager: descriptors, secrets, live values, test, browse, reconnect', async (t) => {
  const matter = await startMatterServerSimulator({ requireToken: 'tok-123' });
  const zw = await startZwaveJsServerSimulator();
  const profiles = memoryProfiles();
  const seen = [];
  const devices = new DeviceManager({ profiles, guard: async () => [], supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } } });
  devices.on('sample', (s) => seen.push(s));
  await devices.start();
  t.after(async () => {
    await devices.stop();
    await matter.close();
    await zw.close();
  });

  const protos = devices.protocols();
  const m = protos.find((p) => p.id === 'matter-server');
  const z = protos.find((p) => p.id === 'zwave-js');
  assert.ok(m && z);
  assert.equal(m.capabilities.subscribe, true);
  assert.equal(m.defaultPort, 5580);
  assert.equal(z.defaultPort, 3000);
  assert.equal(m.experimental, true);
  assert.equal(m.deviceFields.find((f) => f.name === 'authToken').type, 'password');
  assert.equal(m.deviceFields.find((f) => f.name === 'path').default, '/ws');
  assert.equal(m.tagTypeOptional, true);

  // Connection test reports server version, schema and node count.
  const tested = await devices.test({ name: 'probe', protocol: 'matter-server', host: '127.0.0.1', port: matter.port, path: '/ws', authToken: 'tok-123' });
  assert.equal(tested.ok, true, tested.error);
  assert.equal(tested.info.schemaVersion, 11);
  assert.equal(tested.info.nodeCount, 5);
  const ztest = await devices.test({ name: 'probe', protocol: 'zwave-js', host: '127.0.0.1', port: zw.port });
  assert.equal(ztest.info.serverVersion, '3.0.0');
  assert.equal(ztest.info.schemaVersion, 44);
  assert.equal(ztest.info.nodeCount, 5);

  const saved = await devices.save({
    name: 'Matter bridge',
    protocol: 'matter-server',
    host: '127.0.0.1',
    port: matter.port,
    path: '/ws',
    authToken: 'tok-123',
    limits: { requestDeadlineMs: 1000, connectTimeoutMs: 1000 },
    pollGroups: [{ id: 'default', intervalMs: 500 }],
    tags: [{ key: 'temp', address: '1/1/TemperatureMeasurement/MeasuredValue' }, { key: 'door', address: '4/1/69/0' }],
  });
  assert.equal(saved.authToken, null, 'the token is never returned');
  assert.equal(profiles.getIn('devices', saved.id).authToken, 'tok-123');
  assert.equal(devices.list().find((d) => d.id === saved.id).authToken, null);
  // An edit that sends the placeholder back keeps the stored token.
  await devices.save({ ...devices.list().find((d) => d.id === saved.id), authToken: null, name: 'Matter bridge' }, saved.id);
  assert.equal(profiles.getIn('devices', saved.id).authToken, 'tok-123');

  const zsaved = await devices.save({
    name: 'Z-Wave stick',
    protocol: 'zwave-js',
    host: '127.0.0.1',
    port: zw.port,
    limits: { requestDeadlineMs: 1000, connectTimeoutMs: 1000 },
    tags: [{ key: 'sw', address: '3/37/0/currentValue' }, { key: 'temp', address: '2/49/0/Air temperature' }],
  });

  await until(() => devices.getValues(saved.id).temp?.v === 21.34, 8000, 'matter value');
  await until(() => devices.getValues(zsaved.id).sw?.v === true, 8000, 'zwave value');
  assert.equal(devices.getValues(saved.id).door.qReason, 'node unavailable');
  assert.equal(devices.getValues(zsaved.id).temp.qReason, 'sleeping');
  assert.equal(devices.getValues(zsaved.id).temp.q, 192);

  // Pushed changes arrive between poll cycles.
  matter.setAttribute(1, '1/1026/0', 1999);
  zw.valueUpdated(3, { commandClass: 37, endpoint: 0, property: 'currentValue' }, false);
  await until(() => devices.getValues(saved.id).temp.v === 19.99, 3000, 'pushed matter change');
  await until(() => devices.getValues(zsaved.id).sw.v === false, 3000, 'pushed zwave change');

  const nodes = await devices.browse(saved.id);
  assert.equal(nodes.length, 5);
  const values = await devices.browse(zsaved.id, 'cc:3/50');
  assert.equal(values[0].meta.unit, 'kWh');
  const probe = await devices.probe(saved.id, { address: '1/1/1026/0' });
  assert.equal(probe.decodings.value, 19.99);

  // Server restart: Bad, then back online with values.
  matter.dropAll();
  await until(() => devices.getValues(saved.id).temp.q === 0, 3000, 'bad on drop');
  await until(() => devices.getValues(saved.id).temp.q === 192, 5000, 'recovered');
  assert.ok(seen.some((s) => s.sourceId === saved.id && s.address === 'temp'));

  for (const s of [matter, zw]) assert.deepEqual(s.violations, []);
});
