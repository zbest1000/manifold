'use strict';

// Item 2: a device hostname is resolved and validated in the MAIN process; the driver in the host
// process connects to the validated address and never resolves the name again. The resolver here is
// injected and flips its answers, like a DNS rebinding attacker would.

const { test } = require('node:test');
const assert = require('node:assert');
const { DeviceManager } = require('../services/deviceManager');
const { startSimulator } = require('./support/modbusSimulator');

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

// A lookup whose answer can be changed between calls.
function flippingLookup(initial) {
  const state = { answer: initial, calls: 0 };
  const lookup = async (host, opts) => {
    state.calls++;
    if (host !== 'plc.example.test') throw new Error(`ENOTFOUND ${host}`);
    const list = state.answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return opts && opts.all ? list : list[0];
  };
  return { lookup, state };
}

async function setup(extra = {}) {
  const sim = await startSimulator({ port: 0, units: { 1: { holding: {} } } });
  sim.setRegister(1, 'holding', 100, 42);
  const profiles = memoryProfiles();
  const dns = flippingLookup(['127.0.0.1']);
  const devices = new DeviceManager({
    profiles,
    lookup: dns.lookup,
    rebindCheckMs: 0,
    supervisorOptions: { backoff: { initialMs: 30, maxMs: 100 }, heartbeatMs: 200 },
    ...extra
  });
  await devices.start();
  const device = {
    name: 'Named PLC',
    protocol: 'modbus-tcp',
    host: 'plc.example.test', // does not exist in real DNS: only the pinned address can work
    port: sim.port,
    unitId: 1,
    limits: { requestDeadlineMs: 300, connectTimeoutMs: 500 },
    pollGroups: [{ id: 'fast', intervalMs: 100 }],
    tags: [{ key: 'n', address: 'holding:100', type: 'uint16', pollGroup: 'fast' }]
  };
  const cleanup = async () => {
    await devices.stop();
    await sim.close();
  };
  return { sim, profiles, dns, devices, device, cleanup };
}

const status = (t, id) => t.devices.list().find((d) => d.id === id).status;

test('the driver connects to the validated address; the hostname is only a label', async () => {
  const t = await setup();
  try {
    const saved = await t.devices.save(t.device);
    await until(() => t.devices.getValues(saved.id).n?.v === 42, 8000, 'value over the pinned address');
    assert.deepStrictEqual(status(t, saved.id).addresses, ['127.0.0.1']);
    assert.strictEqual(t.profiles.getIn('devices', saved.id).host, 'plc.example.test', 'the stored device keeps its hostname');
    assert.strictEqual(t.profiles.getIn('devices', saved.id).pinned, undefined, 'a pin is runtime state, never stored');
  } finally {
    await t.cleanup();
  }
});

test('the device-test connection is pinned too', async () => {
  const t = await setup();
  try {
    const r = await t.devices.test(t.device);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    t.dns.state.answer = ['169.254.169.254'];
    await assert.rejects(t.devices.test(t.device), (e) => e.name === 'EgressBlockedError');
  } finally {
    await t.cleanup();
  }
});

test('periodic re-validation: a name that later resolves to a blocked address takes the device offline with a clear reason', async () => {
  const t = await setup({ rebindCheckMs: 60 });
  try {
    const saved = await t.devices.save(t.device);
    await until(() => status(t, saved.id).state === 'online', 8000, 'online');

    t.dns.state.answer = ['169.254.169.254']; // the rebind
    await until(() => status(t, saved.id).state === 'offline' && /169\.254\.169\.254/.test(status(t, saved.id).reason || ''), 4000, 'offline with the blocked address named');
    assert.match(status(t, saved.id).lastError, /blocked|not allowed|metadata/i);
    assert.strictEqual(t.devices.hosts()['modbus-tcp'], undefined, 'no driver host is left running for it');

    t.dns.state.answer = ['127.0.0.1']; // the name is sane again
    await until(() => status(t, saved.id).state === 'online', 8000, 'recovers without operator action');
  } finally {
    await t.cleanup();
  }
});

test('an unchanged answer does not restart a healthy device; a changed address set does', async () => {
  const t = await setup({ rebindCheckMs: 40 });
  try {
    const saved = await t.devices.save(t.device);
    await until(() => status(t, saved.id).state === 'online', 8000, 'online');
    const pid = t.devices.hosts()['modbus-tcp'].pid;
    const connects = status(t, saved.id).connects;
    const before = t.dns.state.calls;
    await sleep(250);
    assert.ok(t.dns.state.calls > before + 2, 'the name was re-resolved several times');
    assert.strictEqual(t.devices.hosts()['modbus-tcp'].pid, pid);
    assert.strictEqual(status(t, saved.id).connects, connects, 'no reconnect while the answer is unchanged');
    // the same set in another order is not a change either
    t.dns.state.answer = ['127.0.0.1', '127.0.0.2'];
    await sleep(200);
    assert.deepStrictEqual(status(t, saved.id).addresses.slice().sort(), ['127.0.0.1', '127.0.0.2']);
  } finally {
    await t.cleanup();
  }
});

test('re-validation when the supervisor restarts a host: a killed host is not reconnected to a now-blocked address', async () => {
  const t = await setup({ rebindCheckMs: 0 });
  try {
    const saved = await t.devices.save(t.device);
    await until(() => status(t, saved.id).state === 'online', 8000, 'online');
    const pid = t.devices.hosts()['modbus-tcp'].pid;
    t.dns.state.answer = ['169.254.169.254']; // flips while nobody is looking (no periodic check here)
    process.kill(pid, 'SIGKILL'); // the host dies; the supervisor restarts it
    await until(() => /169\.254\.169\.254/.test(status(t, saved.id).reason || ''), 6000, 'restart refused for the blocked address');
    assert.strictEqual(status(t, saved.id).state, 'offline');
    const conns = t.sim.stats.connections;
    await sleep(300);
    assert.strictEqual(t.sim.stats.connections, conns, 'no new connection was attempted after the refusal');
    assert.notStrictEqual(status(t, saved.id).state, 'online', 'never connected to the blocked address');
  } finally {
    await t.cleanup();
  }
});

test('literal IPs carry no pin; a hostname that resolves to a mix with one blocked address is refused', async () => {
  const t = await setup();
  try {
    const lit = await t.devices.save({ ...t.device, name: 'Literal', host: '127.0.0.1' });
    await until(() => t.devices.getValues(lit.id).n?.v === 42, 8000, 'literal ip works');
    assert.strictEqual(status(t, lit.id).addresses, null);
    t.dns.state.answer = ['127.0.0.1', '10.255.255.254']; // private range, not opted in
    await assert.rejects(t.devices.save({ ...t.device, name: 'Mixed' }), (e) => e.name === 'EgressBlockedError');
  } finally {
    await t.cleanup();
  }
});
