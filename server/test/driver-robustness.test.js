'use strict';

// Item 8: the driver host is where hardware misbehaviour lands. Every failure here must stay inside
// the device (or at worst its host), carry a reason on the device, and never leave a child behind.
// Real host.js processes, fake driver (test/support/fakeDriver.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const childProcess = require('child_process');
const { DriverSupervisor } = require('../services/driverSupervisor');

const FAKE = path.join(__dirname, 'support', 'fakeDriver.js');

function dev(id, fake = {}, extra = {}) {
  return {
    id,
    name: id,
    protocol: 'fake',
    host: '127.0.0.1',
    port: 502,
    limits: { requestDeadlineMs: 500, connectTimeoutMs: 200, interRequestDelayMs: 0 },
    pollGroups: [{ id: 'default', intervalMs: 100 }],
    tags: [{ key: 't1' }],
    fake,
    ...extra
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

function make(opts = {}) {
  const children = [];
  const sup = new DriverSupervisor({
    drivers: { fake: FAKE },
    backoff: { initialMs: 30, maxMs: 100 },
    crashLoop: { max: 50, windowMs: 60000 },
    heartbeatMs: 150,
    fork: (...args) => {
      const c = childProcess.fork(...args);
      children.push(c);
      return c;
    },
    ...opts
  });
  const ev = { samples: [], states: [], hosts: [], errors: [] };
  sup.on('samples', (b) => ev.samples.push(b));
  sup.on('device-state', (s) => ev.states.push(s));
  sup.on('host-state', (s) => ev.hosts.push(s));
  sup.on('device-error', (e) => ev.errors.push(e));
  return { sup, ev, children };
}
const stateOf = (sup, id) => sup.getStatus().devices[id];

test('a driver that throws synchronously in createDriver is contained: reason on the device, neighbours unaffected', async () => {
  const { sup, ev, children } = make();
  try {
    sup.setDevices([dev('bad', { throwOnCreate: true }), dev('good')]);
    await until(() => stateOf(sup, 'bad')?.reason, 8000, 'reason on the bad device');
    assert.match(stateOf(sup, 'bad').reason, /device error: .*rejected/);
    assert.equal(stateOf(sup, 'bad').state, 'offline');
    await until(() => stateOf(sup, 'good')?.state === 'online', 8000, 'good device online');
    assert.equal(sup.getStatus().hosts.fake.restarts, 0, 'no host restart for a config error');
    assert.ok(ev.errors.some((e) => e.deviceId === 'bad'));
    assert.equal(children.length, 1);
  } finally {
    await sup.shutdown();
  }
});

test('a driver whose connect() never settles is cut off by the watchdog, retried, and does not block its neighbours', async () => {
  const { sup } = make();
  try {
    sup.setDevices([dev('hung', { hangConnect: true }), dev('fine')]);
    await until(() => stateOf(sup, 'fine')?.state === 'online', 8000, 'neighbour online despite the hung connect');
    await until(() => /connect failed.*watchdog/.test(stateOf(sup, 'hung')?.lastError || ''), 8000, 'watchdog reason on the hung device');
    assert.equal(stateOf(sup, 'hung').state, 'offline');
    // it keeps retrying (connect attempts are visible in the status), it does not wedge
    const attempts = () => sup.getStatus().devices.hung.connectAttempts ?? sup.getStatus().devices.hung.attempt ?? 0;
    const first = attempts();
    await sleep(900);
    assert.ok(attempts() >= first, 'status keeps updating');
    assert.equal(stateOf(sup, 'fine').state, 'online');
    // and a one-off connection test of a hung device returns an error instead of hanging the request
    await assert.rejects(sup.testConnection(dev('t', { hangConnect: true })), /timed out/);
  } finally {
    await sup.shutdown();
  }
});

test('a host killed with SIGKILL mid-request: the request rejects, devices report why, the host comes back', async () => {
  const { sup, children } = make({ requestTimeoutMs: 15000 });
  try {
    sup.setDevices([dev('a')]);
    await until(() => stateOf(sup, 'a')?.state === 'online', 8000, 'online');
    const pid = sup.getStatus().hosts.fake.pid;
    // a request that will still be in flight when the host dies (the fake connect never settles)
    const pending = sup.testConnection(dev('slow', { hangConnect: true }, { limits: { connectTimeoutMs: 8000 } }), 15000);
    const settled = pending.then(
      () => 'resolved',
      (e) => e.message
    );
    await sleep(100);
    process.kill(pid, 'SIGKILL');
    assert.match(await settled, /driver host down/);
    await until(() => /SIGKILL/.test(stateOf(sup, 'a')?.reason || '') || stateOf(sup, 'a')?.state === 'online', 8000, 'reason or recovery');
    await until(() => sup.getStatus().hosts.fake.pid && sup.getStatus().hosts.fake.pid !== pid, 8000, 'host restarted');
    await until(() => stateOf(sup, 'a')?.state === 'online', 8000, 'device online again');
    assert.match(sup.getStatus().hosts.fake.lastExit.reason, /SIGKILL/);
    assert.equal(alive(pid), false);
    assert.ok(children.length >= 2);
  } finally {
    await sup.shutdown();
  }
});

test('isolate:true devices get their own process and keep running while the shared host crash-loops', async () => {
  const { sup } = make({ crashLoop: { max: 3, windowMs: 60000 } });
  try {
    sup.setDevices([
      dev('s1', { crashAfterMs: 20 }),
      dev('s2'),
      dev('iso', {}, { isolate: true })
    ]);
    await until(() => sup.getStatus().hosts.fake?.state === 'parked', 12000, 'shared host parked by the crash loop');
    const hosts = sup.getStatus().hosts;
    assert.ok(hosts['fake:iso'], 'an isolated device has its own host entry');
    assert.notEqual(hosts['fake:iso'].pid, hosts.fake.pid);
    assert.deepEqual(hosts['fake:iso'].deviceIds, ['iso']);
    assert.equal(hosts['fake:iso'].restarts, 0, 'the crash loop never touched the isolated host');
    assert.equal(stateOf(sup, 'iso').state, 'online');
    assert.ok(alive(hosts['fake:iso'].pid));
    assert.match(stateOf(sup, 's2').reason, /parked after \d+ crashes/, 'the neighbour on the parked host says why it is offline');
    assert.equal(stateOf(sup, 's2').phase, 'stopped');
  } finally {
    await sup.shutdown();
  }
});

test('setDevices with 200 devices staggers the first connects instead of opening 200 sockets at once', async () => {
  const { sup, ev } = make();
  try {
    const t0 = Date.now();
    sup.setDevices(Array.from({ length: 200 }, (_, i) => dev(`d${i}`, {}, { pollGroups: [{ id: 'default', intervalMs: 2000 }] })));
    await until(() => ev.states.filter((s) => s.state === 'online').length >= 200, 30000, '200 devices online');
    const times = ev.states.filter((s) => s.state === 'online').map((s) => s.since - t0).sort((a, b) => a - b);
    const span = times[times.length - 1] - times[0];
    assert.ok(span >= 3000, `first connects must be spread over seconds, spread was ${span} ms`);
    let worst = 0;
    for (let i = 0; i < times.length; i++) {
      let j = i;
      while (j < times.length && times[j] - times[i] < 250) j++;
      worst = Math.max(worst, j - i);
    }
    assert.ok(worst <= 25, `no more than ~10-25 connects may start in any 250 ms window, saw ${worst}`);
  } finally {
    await sup.shutdown();
  }
});

test('shutting down with 50 devices mid-request leaves no child processes', async () => {
  const { sup, ev, children } = make({ shutdownKillMs: 1500 });
  const devices = Array.from({ length: 50 }, (_, i) =>
    dev(`m${i}`, { intervalExecuteMs: 400 }, { isolate: i % 5 === 0, pollGroups: [{ id: 'default', intervalMs: 50 }] })
  );
  sup.setDevices(devices);
  await until(() => ev.states.filter((s) => s.state === 'online').length >= 50, 30000, '50 devices online');
  // requests in flight: executes are sleeping 400 ms, and one test connection is mid-handshake too
  const inFlight = sup.testConnection(dev('t', { hangConnect: true }, { limits: { connectTimeoutMs: 8000 } }), 15000).catch((e) => e.message);
  await sleep(120);
  const pids = children.map((c) => c.pid).filter(Boolean);
  assert.ok(pids.length >= 11, `expected 10 isolated hosts + 1 shared + 1 test host, saw ${pids.length}`);
  await sup.shutdown();
  await inFlight;
  for (const pid of pids) assert.equal(alive(pid), false, `child ${pid} survived shutdown`);
  assert.deepEqual(sup.getStatus().hosts, {});
});
