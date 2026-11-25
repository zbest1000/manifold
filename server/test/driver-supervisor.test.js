'use strict';

// Exercises the REAL host.js through child_process.fork with a fake driver
// module (test/support/fakeDriver.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { DriverSupervisor } = require('../services/driverSupervisor');

const FAKE = path.join(__dirname, 'support', 'fakeDriver.js');

function dev(id, fake = {}, extra = {}) {
  return Object.assign(
    {
      id,
      name: id,
      protocol: 'fake',
      host: '127.0.0.1',
      port: 502,
      limits: { requestDeadlineMs: 500, connectTimeoutMs: 500, interRequestDelayMs: 0 },
      pollGroups: [{ id: 'default', intervalMs: 40 }],
      tags: [{ key: 't1' }, { key: 't2' }],
      fake
    },
    extra
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function until(fn, timeoutMs = 8000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(opts = {}) {
  const sup = new DriverSupervisor(
    Object.assign(
      {
        drivers: { fake: FAKE },
        backoff: { initialMs: 20, maxMs: 60 },
        crashLoop: { max: 50, windowMs: 60000 },
        heartbeatMs: 100
      },
      opts
    )
  );
  const ev = { samples: [], states: [], hosts: [], errors: [] };
  sup.on('samples', (b) => ev.samples.push(b));
  sup.on('device-state', (s) => ev.states.push(s));
  sup.on('host-state', (s) => ev.hosts.push(s));
  sup.on('device-error', (e) => ev.errors.push(e));
  return { sup, ev };
}

function noConsecutiveDuplicates(states, id) {
  // A repeat of the same state is only legitimate when it carries a new reason (e.g. "parked").
  const mine = states.filter((s) => s.deviceId === id).map((s) => `${s.state}|${s.reason}`);
  for (let i = 1; i < mine.length; i++) assert.notEqual(mine[i], mine[i - 1], `duplicate state for ${id}: ${mine.join(',')}`);
}

async function finish(sup, pids = []) {
  await sup.shutdown();
  for (const pid of pids) assert.equal(alive(pid), false, `child ${pid} still alive`);
}

test('samples flow end to end over IPC; one host per protocol', async () => {
  const { sup, ev } = make();
  try {
    sup.setDevices([dev('d1', { values: { t1: 11, t2: 22 } })]);
    await until(() => ev.samples.length >= 2, 8000, 'samples');
    const b = ev.samples[0];
    assert.equal(b.deviceId, 'd1');
    assert.equal(b.group, 'default');
    assert.ok(b.tRead > 0);
    assert.deepEqual(
      b.samples.map((s) => [s.key, s.v, s.q]),
      [['t1', 11, 192], ['t2', 22, 192]]
    );
    await until(() => ev.states.some((s) => s.state === 'online'));
    const st = sup.getStatus();
    assert.equal(Object.keys(st.hosts).length, 1);
    assert.equal(st.hosts.fake.state, 'running');
    assert.ok(st.hosts.fake.pid > 0);
    assert.deepEqual(st.hosts.fake.deviceIds, ['d1']);
    assert.equal(st.devices.d1.state, 'online');
    // Status from the host arrives after configure.
    await until(() => sup.getStatus().devices.d1.tagCount === 2, 4000, 'host status');
    assert.ok(['starting', 'running'].includes(ev.hosts[0].state));
    noConsecutiveDuplicates(ev.states, 'd1');
    const pid = st.hosts.fake.pid;
    await finish(sup, [pid]);
  } finally {
    await sup.shutdown();
  }
});

test('configure diff: add, change and remove devices without restarting the host', async () => {
  const { sup, ev } = make();
  try {
    sup.setDevices([dev('d1', { values: { t1: 1 } })]);
    await until(() => ev.samples.some((b) => b.deviceId === 'd1'));
    const pid = sup.getStatus().hosts.fake.pid;

    sup.setDevices([dev('d1', { values: { t1: 1 } }), dev('d2', { values: { t1: 2 } })]);
    await until(() => ev.samples.some((b) => b.deviceId === 'd2'), 8000, 'd2 samples');
    assert.equal(sup.getStatus().hosts.fake.pid, pid);
    const d1StatesBefore = ev.states.filter((s) => s.deviceId === 'd1').length;

    // Change d1: new values appear.
    sup.setDevices([dev('d1', { values: { t1: 99 } }), dev('d2', { values: { t1: 2 } })]);
    await until(() => ev.samples.some((b) => b.deviceId === 'd1' && b.samples[0].v === 99), 8000, 'changed values');
    assert.equal(sup.getStatus().hosts.fake.pid, pid);
    assert.ok(ev.states.filter((s) => s.deviceId === 'd1').length >= d1StatesBefore);

    // Remove d1: its samples stop, d2 continues.
    sup.setDevices([dev('d2', { values: { t1: 2 } })]);
    await sleep(250);
    const n1 = ev.samples.filter((b) => b.deviceId === 'd1').length;
    const n2 = ev.samples.filter((b) => b.deviceId === 'd2').length;
    await sleep(300);
    assert.equal(ev.samples.filter((b) => b.deviceId === 'd1').length, n1);
    assert.ok(ev.samples.filter((b) => b.deviceId === 'd2').length > n2);
    assert.deepEqual(Object.keys(sup.getStatus().devices), ['d2']);
    assert.deepEqual(sup.getStatus().hosts.fake.deviceIds, ['d2']);
    noConsecutiveDuplicates(ev.states, 'd1');
    noConsecutiveDuplicates(ev.states, 'd2');

    // No devices left: the host is stopped.
    sup.setDevices([]);
    await until(() => !alive(pid), 8000, 'host exit');
    assert.deepEqual(sup.getStatus().hosts, {});
    assert.ok(ev.hosts.some((h) => h.state === 'stopped'));
  } finally {
    await sup.shutdown();
  }
});

test('isolate:true gives a device its own host', async () => {
  const { sup, ev } = make();
  try {
    sup.setDevices([dev('a'), dev('b', {}, { isolate: true })]);
    await until(() => ev.samples.some((s) => s.deviceId === 'a') && ev.samples.some((s) => s.deviceId === 'b'));
    const hosts = sup.getStatus().hosts;
    assert.deepEqual(Object.keys(hosts).sort(), ['fake', 'fake:b']);
    assert.notEqual(hosts.fake.pid, hosts['fake:b'].pid);
    await finish(sup, [hosts.fake.pid, hosts['fake:b'].pid]);
  } finally {
    await sup.shutdown();
  }
});

test('host crash: devices offline, host restarts, samples resume', async () => {
  const marker = path.join(os.tmpdir(), `fake-crash-${process.pid}-${Date.now()}`);
  const { sup, ev } = make();
  try {
    sup.setDevices([dev('d1', { crashAfterMs: 250, crashOnceFile: marker })]);
    await until(() => ev.states.some((s) => s.state === 'online'), 8000, 'first online');
    const pid1 = sup.getStatus().hosts.fake.pid;
    await until(() => ev.states.some((s) => s.state === 'offline' && s.reason === 'driver host down'), 8000, 'offline after crash');
    await until(() => ev.hosts.some((h) => h.state === 'backoff'), 8000, 'host backoff');
    const before = ev.samples.length;
    await until(() => ev.states.filter((s) => s.state === 'online').length >= 2, 8000, 'online again');
    await until(() => ev.samples.length > before + 1, 8000, 'samples resume');
    const h = sup.getStatus().hosts.fake;
    assert.equal(h.restarts, 1);
    assert.notEqual(h.pid, pid1);
    assert.equal(h.state, 'running');
    assert.ok(h.lastExit && h.lastExit.code === 1);
    assert.equal(alive(pid1), false);
    noConsecutiveDuplicates(ev.states, 'd1');
    await finish(sup, [h.pid]);
  } finally {
    await sup.shutdown();
    fs.rmSync(marker, { force: true });
  }
});

test('crash loop parks the host; setDevices or unpark restarts it', async () => {
  const { sup, ev } = make({ crashLoop: { max: 2, windowMs: 60000 }, backoff: { initialMs: 10, maxMs: 20 } });
  try {
    sup.setDevices([dev('d1', { crashAfterMs: 10 })]);
    await until(() => ev.hosts.some((h) => h.state === 'parked'), 15000, 'parked');
    const st = sup.getStatus().hosts.fake;
    assert.equal(st.state, 'parked');
    assert.equal(st.pid, null);
    const restarts = st.restarts;
    await sleep(300);
    assert.equal(sup.getStatus().hosts.fake.restarts, restarts); // no more restarts
    assert.equal(sup.getStatus().devices.d1.state, 'offline');

    const startsBefore = ev.hosts.filter((h) => h.state === 'starting').length;
    assert.equal(sup.unpark('fake'), true);
    assert.ok(ev.hosts.filter((h) => h.state === 'starting').length > startsBefore);
    await until(() => sup.getStatus().hosts.fake.state === 'parked', 15000, 'parked again');
    const startsAfter = ev.hosts.filter((h) => h.state === 'starting').length;
    sup.setDevices([dev('d1', { crashAfterMs: 10 })]); // also unparks
    assert.ok(ev.hosts.filter((h) => h.state === 'starting').length > startsAfter);
    noConsecutiveDuplicates(ev.states, 'd1');
  } finally {
    await sup.shutdown();
  }
});

test('heartbeat timeout kills a hung host; pending requests reject cleanly', async () => {
  const { sup, ev } = make({ heartbeatMs: 100, crashLoop: { max: 50, windowMs: 60000 } });
  try {
    sup.setDevices([dev('d1', { hangAfterMs: 400 })]);
    await until(() => ev.states.some((s) => s.state === 'online'), 8000, 'online');
    const pid = sup.getStatus().hosts.fake.pid;
    await sleep(450); // event loop is now blocked in the child
    const p = sup.probe('d1', { x: 1 }, 5000);
    p.catch(() => {});
    await assert.rejects(p, /driver host down/);
    await until(() => !alive(pid), 8000, 'hung child killed');
    assert.ok(ev.states.some((s) => s.state === 'offline' && s.reason === 'driver host down'));
    assert.ok(ev.hosts.some((h) => h.state === 'backoff' && /heartbeat/.test(h.reason)));
    noConsecutiveDuplicates(ev.states, 'd1');
  } finally {
    await sup.shutdown();
  }
});

test('probe and testConnection round trips', async () => {
  const { sup, ev } = make();
  const pids = [];
  try {
    // No host exists yet: testConnection uses a one-off host that is cleaned up.
    const info = await sup.testConnection(dev('x'));
    assert.deepEqual(info.info, { fake: true, id: 'x' });
    assert.ok(info.latencyMs >= 0);
    assert.deepEqual(sup.getStatus().hosts, {});
    await assert.rejects(sup.testConnection(dev('y', { failConnect: true })), /refused/);
    await assert.rejects(sup.testConnection(Object.assign(dev('z'), { protocol: 'nope' })), /unknown protocol/);

    sup.setDevices([dev('d1')]);
    await until(() => ev.states.some((s) => s.state === 'online'));
    pids.push(sup.getStatus().hosts.fake.pid);
    assert.deepEqual(await sup.probe('d1', { address: 'hr:1' }), { echo: { address: 'hr:1' }, device: 'd1' });
    await assert.rejects(sup.probe('nope', {}), /unknown device/);
    const viaShared = await sup.testConnection(dev('q'));
    assert.equal(viaShared.info.id, 'q');
    assert.deepEqual(Object.keys(sup.getStatus().hosts), ['fake']);
    await finish(sup, pids);
  } finally {
    await sup.shutdown();
  }
});

test('invalid device is reported via device-error without affecting another device', async () => {
  const { sup, ev } = make();
  try {
    sup.setDevices([dev('bad', { throwOnCreate: true }), dev('good', { values: { t1: 5 } })]);
    await until(() => ev.errors.length >= 1, 8000, 'device-error');
    assert.equal(ev.errors[0].deviceId, 'bad');
    assert.match(ev.errors[0].error, /invalid tags/);
    await until(() => ev.samples.some((b) => b.deviceId === 'good'));
    assert.equal(ev.samples.some((b) => b.deviceId === 'bad'), false);
    assert.equal(sup.getStatus().devices.bad.state, 'offline');
    assert.equal(sup.getStatus().devices.good.state, 'online');
    assert.equal(sup.getStatus().hosts.fake.state, 'running');
  } finally {
    await sup.shutdown();
  }
});

test('unknown protocol: device offline, nothing forked; disabled devices are ignored', async () => {
  const { sup, ev } = make();
  try {
    sup.setDevices([Object.assign(dev('u1'), { protocol: 'nope' }), dev('off', {}, { enabled: false })]);
    assert.equal(ev.states.length, 1);
    assert.deepEqual(
      [ev.states[0].deviceId, ev.states[0].state, ev.states[0].reason],
      ['u1', 'offline', 'unknown protocol']
    );
    sup.setDevices([Object.assign(dev('u1'), { protocol: 'nope' })]);
    assert.equal(ev.states.length, 1); // no duplicate
    assert.deepEqual(sup.getStatus().hosts, {});
    assert.equal(ev.samples.length, 0);
  } finally {
    await sup.shutdown();
  }
});

test('a throwing event listener never breaks the supervisor', async () => {
  const { sup, ev } = make();
  sup.on('samples', () => {
    throw new Error('listener boom');
  });
  sup.on('device-state', () => {
    throw new Error('listener boom');
  });
  try {
    sup.setDevices([dev('d1')]);
    await until(() => ev.samples.length >= 3);
  } finally {
    await sup.shutdown();
  }
});

test('shutdown leaves no children and is idempotent', async () => {
  const { sup, ev } = make();
  sup.setDevices([dev('a'), dev('b', {}, { isolate: true })]);
  await until(() => ev.states.filter((s) => s.state === 'online').length >= 2);
  const pids = Object.values(sup.getStatus().hosts).map((h) => h.pid);
  assert.equal(pids.length, 2);
  await sup.shutdown();
  for (const pid of pids) assert.equal(alive(pid), false);
  await sup.shutdown();
  assert.ok(ev.hosts.filter((h) => h.state === 'stopped').length >= 2);
  sup.setDevices([dev('a')]); // ignored after shutdown
  assert.deepEqual(sup.getStatus().hosts, {});
});
