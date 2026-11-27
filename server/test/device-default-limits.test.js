'use strict';

// A device saved without limits (or with only some) gets its driver's declared defaults
// (describe().limits), not the runtime's generic 2 s request deadline. Devices stored before that
// still run with the defaults: the device handed to the supervisor carries them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeviceManager } = require('../services/deviceManager');

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

function manager() {
  const profiles = memoryProfiles();
  const devices = new DeviceManager({ profiles, guard: async () => ['127.0.0.1'], rebindCheckMs: 0 });
  return { profiles, devices };
}

const descLimits = (devices, protocol) => devices.drivers[protocol].mod.describe().limits;

test('CoAP and BACnet/IP devices saved without limits store the descriptor defaults', async () => {
  const { devices } = manager();
  const coap = await devices.save({ name: 'sensor', protocol: 'coap', host: '127.0.0.1', port: 5683, tags: [] });
  assert.deepEqual(coap.limits, descLimits(devices, 'coap'));
  assert.equal(coap.limits.requestDeadlineMs, 10000, 'CoAP needs time for its retransmissions');
  const bacnet = await devices.save({ name: 'ahu', protocol: 'bacnet-ip', host: '127.0.0.1', limits: {}, tags: [] });
  assert.deepEqual(bacnet.limits, descLimits(devices, 'bacnet-ip'));
  const b = devices.drivers['bacnet-ip'].mod.describe();
  assert.ok(bacnet.limits.requestDeadlineMs >= b.options.apduTimeoutMs * b.options.apduRetries, 'APDU timeout x retries fits');
});

test('set limit fields are kept; only unset ones (absent, null, empty) take the defaults', async () => {
  const { devices } = manager();
  const d = await devices.save({ name: 's', protocol: 'coap', host: '127.0.0.1', limits: { requestDeadlineMs: 15000, connectTimeoutMs: null, interRequestDelayMs: '' }, tags: [] });
  assert.equal(d.limits.requestDeadlineMs, 15000);
  assert.equal(d.limits.connectTimeoutMs, descLimits(devices, 'coap').connectTimeoutMs);
  assert.equal(d.limits.interRequestDelayMs, descLimits(devices, 'coap').interRequestDelayMs);
  // the test connection validates the same effective limits
  assert.deepEqual(devices.normalize({ name: 't', protocol: 'coap', host: '127.0.0.1', tags: [] }, 't').limits, descLimits(devices, 'coap'));
});

test('a device stored without limits is handed to the runtime with the driver defaults', async () => {
  const { profiles, devices } = manager();
  // As written by an older version: no limits field at all.
  profiles.upsertIn('devices', 'old', { id: 'old', name: 'old', protocol: 'coap', enabled: true, host: '127.0.0.1', port: 5683, options: {}, pollGroups: [{ id: 'default', intervalMs: 1000 }], tags: [] });
  let handed = null;
  devices.supervisor.setDevices = (list) => {
    handed = list;
  };
  devices.supervisor.shutdown = async () => {};
  await devices.start();
  try {
    assert.equal(handed.length, 1);
    assert.deepEqual(handed[0].limits, descLimits(devices, 'coap'));
    assert.equal(profiles.getIn('devices', 'old').limits, undefined, 'the stored record is not rewritten');
  } finally {
    await devices.stop();
  }
});
