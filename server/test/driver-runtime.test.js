'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');

// ---------------------------------------------------------------- fixtures

const flush = () => new Promise((r) => setImmediate(r));

class FakeClock {
  constructor() {
    this.t = 1_000_000;
    this.timers = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const h = { at: this.t + Math.max(0, ms), fn, seq: this.seq++ };
    this.timers.push(h);
    return h;
  }
  clearTimeout(h) {
    this.timers = this.timers.filter((x) => x !== h);
  }
  sleep(ms) {
    return new Promise((r) => this.setTimeout(r, ms));
  }
  async advance(ms) {
    const end = this.t + ms;
    await flush();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

const half = (req) => {
  if (req.items.length < 2) return null;
  const m = req.items.length >> 1;
  return [
    { id: req.id + 'a', unitId: req.unitId, items: req.items.slice(0, m) },
    { id: req.id + 'b', unitId: req.unitId, items: req.items.slice(m) }
  ];
};

class ScriptDriver {
  constructor(clock) {
    this.clock = clock;
    this.connected = false;
    this.connects = 0;
    this.closes = 0;
    this.executed = [];
    this.execDelay = 0;
    this.connectImpl = null;
    this.execImpl = null;
    this.planImpl = null;
  }
  get capabilities() {
    return { browse: false, subscribe: false, maxInFlight: 1 };
  }
  async connect() {
    this.connects++;
    if (this.connectImpl) await this.connectImpl();
    this.connected = true;
    return { info: true };
  }
  isConnected() {
    return this.connected;
  }
  plan(keys) {
    if (this.planImpl) return this.planImpl(keys);
    return [{ id: 'r', items: keys.map((key) => ({ key })) }];
  }
  async execute(req) {
    this.executed.push(req.items.map((i) => i.key).join(','));
    if (this.execDelay) await this.clock.sleep(this.execDelay);
    if (this.execImpl) {
      const r = await this.execImpl(req);
      if (r) return r;
    }
    return { ok: true, results: req.items.map((i) => ({ key: i.key, v: 1, type: 'int32', q: 192 })) };
  }
  bisect(req) {
    return half(req);
  }
  async probe(args) {
    return { args };
  }
  async close() {
    this.closes++;
    this.connected = false;
  }
}

function mk(over = {}) {
  const clock = new FakeClock();
  const drv = new ScriptDriver(clock);
  const batches = [];
  const states = [];
  const device = Object.assign(
    {
      id: 'dev1',
      protocol: 'fake',
      limits: { requestDeadlineMs: 10000, connectTimeoutMs: 5000, interRequestDelayMs: 0 },
      pollGroups: [{ id: 'default', intervalMs: 1000 }],
      tags: [{ key: 'a', type: 'int32' }, { key: 'b', type: 'int32' }, { key: 'c', type: 'int32' }]
    },
    over.device || {}
  );
  const rt = new DeviceRuntime({
    device,
    driver: drv,
    onSamples: (b) => batches.push(b),
    onState: (s) => states.push(s),
    timers: { setTimeout: (f, m) => clock.setTimeout(f, m), clearTimeout: (h) => clock.clearTimeout(h), now: () => clock.now() },
    random: () => 1,
    backoff: { initialMs: 1000, maxMs: 8000 },
    options: over.options
  });
  return { clock, drv, rt, batches, states };
}

// stop() waits (bounded, on the injected clock) for the in-flight request.
async function halt(clock, rt) {
  const p = rt.stop();
  await clock.advance(5000);
  await p;
}

const byKey = (b) => Object.fromEntries(b.samples.map((s) => [s.key, s]));

// ---------------------------------------------------------------- tests

test('backoff doubles with cap, no duplicate state events, then recovers', async () => {
  const { clock, drv, rt, states } = mk();
  const attempts = [];
  let fail = true;
  drv.connectImpl = async () => {
    attempts.push(clock.now());
    if (fail) throw new Error('refused');
  };
  rt.start();
  await clock.advance(0);
  await clock.advance(40000);
  const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
  assert.deepEqual(gaps.slice(0, 5), [1000, 2000, 4000, 8000, 8000]);
  assert.equal(rt.getStatus().phase, 'backoff');
  assert.deepEqual(
    states.map((s) => s.state),
    ['offline']
  );
  fail = false;
  await clock.advance(9000);
  assert.deepEqual(
    states.map((s) => s.state),
    ['offline', 'online']
  );
  assert.equal(rt.getStatus().connects, 1);
  assert.equal(states[0].deviceId, 'dev1');
  await halt(clock, rt);
});

test('one onSamples batch per cycle, however many requests', async () => {
  const { clock, drv, rt, batches } = mk();
  drv.planImpl = (keys) => keys.map((k) => ({ id: k, items: [{ key: k }] }));
  rt.start();
  await clock.advance(0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].samples.length, 3);
  assert.equal(batches[0].group, 'default');
  assert.equal(batches[0].deviceId, 'dev1');
  assert.ok(batches[0].samples.every((s) => s.q === 192 && s.tRead));
  await clock.advance(2000);
  assert.equal(batches.length, 3);
  assert.equal(rt.getStatus().requests, 9);
  await halt(clock, rt);
});

test('overrunning cycle: due ticks are skipped and counted, never queued', async () => {
  const { clock, drv, rt, batches } = mk();
  drv.execDelay = 2500;
  rt.start();
  await clock.advance(2600);
  const g = rt.getStatus().groups.default;
  assert.equal(g.cycles, 1);
  assert.equal(g.overruns, 2); // ticks at 1000 and 2000 skipped
  assert.equal(drv.executed.length, 1); // nothing was queued behind the running cycle
  await clock.advance(10000);
  assert.equal(rt.getStatus().groups.default.overruns >= 2, true);
  assert.equal(batches.length, rt.getStatus().groups.default.cycles);
  await halt(clock, rt);
});

test('requests from several groups never overlap on the one connection', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { clock, drv, rt } = mk({
    device: {
      pollGroups: [{ id: 'fast', intervalMs: 100 }, { id: 'slow', intervalMs: 300 }],
      tags: [{ key: 'f1', pollGroup: 'fast' }, { key: 's1', pollGroup: 'slow' }]
    }
  });
  drv.execImpl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await clock.sleep(40);
    inFlight--;
    return null;
  };
  rt.start();
  await clock.advance(2000);
  assert.equal(maxInFlight, 1);
  assert.ok(rt.getStatus().groups.fast.cycles > 5);
  assert.ok(rt.getStatus().groups.slow.cycles > 3);
  await halt(clock, rt);
});

test('permanent exception: bisect, quarantine once, exclude from plan, restore on success', async () => {
  const { clock, drv, rt, batches } = mk({
    device: { tags: ['a', 'b', 'c', 'd'].map((key) => ({ key, type: 'int32' })) }
  });
  let cFixed = false;
  drv.execImpl = async (req) => {
    if (!cFixed && req.items.some((i) => i.key === 'c')) {
      return { ok: false, kind: 'exception', code: 2, name: 'ILLEGAL_DATA_ADDRESS', classification: 'permanent', message: 'bad' };
    }
    return null;
  };
  rt.start();
  await clock.advance(0);
  assert.equal(batches.length, 1);
  const first = byKey(batches[0]);
  assert.equal(first.a.q, 192);
  assert.equal(first.b.q, 192);
  assert.equal(first.d.q, 192);
  assert.equal(first.c.q, 0);
  assert.equal(first.c.qReason, 'quarantined');
  assert.deepEqual(rt.getStatus().quarantined, ['c']);
  assert.equal(rt.getStatus().exceptions['2'] >= 2, true);

  await clock.advance(1000);
  const second = byKey(batches[1]);
  assert.equal(second.c, undefined); // excluded, not re-emitted
  assert.deepEqual(Object.keys(second).sort(), ['a', 'b', 'd']);

  cFixed = true;
  await clock.advance(61000);
  const withC = batches.filter((b) => b.samples.some((s) => s.key === 'c' && s.q === 192));
  assert.equal(withC.length >= 1, true);
  assert.deepEqual(rt.getStatus().quarantined, []);
  await clock.advance(1000);
  assert.ok(byKey(batches[batches.length - 1]).c.q === 192);
  await halt(clock, rt);
});

test('quarantined tag that still fails stays quarantined and silent', async () => {
  const { clock, drv, rt, batches } = mk({ device: { tags: [{ key: 'c', type: 'int32' }, { key: 'd', type: 'int32' }] } });
  drv.execImpl = async (req) =>
    req.items.some((i) => i.key === 'c')
      ? { ok: false, kind: 'exception', code: 2, name: 'x', classification: 'permanent', message: 'bad' }
      : null;
  rt.start();
  await clock.advance(130000);
  const qs = batches.flatMap((b) => b.samples).filter((s) => s.key === 'c');
  assert.equal(qs.length, 1);
  assert.deepEqual(rt.getStatus().quarantined, ['c']);
  await halt(clock, rt);
});

test('retryable exception: bad this cycle, retried next cycle', async () => {
  const { clock, drv, rt, batches } = mk();
  let n = 0;
  drv.execImpl = async () => {
    n++;
    return n === 1 ? { ok: false, kind: 'exception', code: 6, name: 'BUSY', classification: 'retry', message: 'busy' } : null;
  };
  rt.start();
  await clock.advance(0);
  assert.ok(batches[0].samples.every((s) => s.q === 0 && s.qReason === 'device-exception'));
  assert.deepEqual(rt.getStatus().quarantined, []);
  await clock.advance(1000);
  assert.ok(batches[1].samples.every((s) => s.q === 192));
  assert.equal(rt.getStatus().phase, 'online');
  await halt(clock, rt);
});

test('unit circuit breaker: opens after 3, skips, probes every 30 s, closes on success', async () => {
  const { clock, drv, rt, batches } = mk({
    device: { tags: [{ key: 'u1', type: 'int32' }, { key: 'u2', type: 'int32' }] }
  });
  drv.planImpl = (keys) => keys.map((k) => ({ id: k, unitId: k === 'u1' ? 1 : 2, items: [{ key: k }] }));
  let unit1Down = true;
  let unit1Calls = 0;
  drv.execImpl = async (req) => {
    if (req.unitId === 1) {
      unit1Calls++;
      if (unit1Down) return { ok: false, kind: 'exception', code: 11, name: 'GW', classification: 'unit-down', message: 'x' };
    }
    return null;
  };
  rt.start();
  await clock.advance(0);
  await clock.advance(2000); // 3 cycles total
  assert.equal(unit1Calls, 3);
  assert.deepEqual(rt.getStatus().openUnits, [1]);
  const u1Samples = batches.flatMap((b) => b.samples).filter((s) => s.key === 'u1');
  assert.equal(u1Samples.length, 3);
  assert.ok(u1Samples.every((s) => s.q === 0 && s.qReason === 'unit-down'));

  await clock.advance(10000);
  assert.equal(unit1Calls, 3); // skipped while open
  assert.equal(batches.flatMap((b) => b.samples).filter((s) => s.key === 'u1').length, 3); // silent
  assert.ok(batches[batches.length - 1].samples.every((s) => s.key === 'u2' && s.q === 192));

  await clock.advance(20000); // past 30 s since opening
  assert.equal(unit1Calls, 4); // exactly one probe
  assert.deepEqual(rt.getStatus().openUnits, [1]);

  unit1Down = false;
  await clock.advance(31000);
  assert.deepEqual(rt.getStatus().openUnits, []);
  const last = batches.flatMap((b) => b.samples).filter((s) => s.key === 'u1').pop();
  assert.equal(last.q, 192);
  await halt(clock, rt);
});

test('fatal result: every tag Bad once, reconnect, Good again', async () => {
  const { clock, drv, rt, batches, states } = mk();
  let killed = false;
  drv.execImpl = async () => {
    if (!killed && clock.now() > 1_000_000 + 2500) {
      killed = true;
      return { ok: false, kind: 'timeout', fatal: true, message: 'no answer' };
    }
    return null;
  };
  rt.start();
  await clock.advance(3000);
  const bad = batches.filter((b) => b.samples.some((s) => s.qReason === 'disconnected'));
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0].samples.map((s) => s.key).sort(), ['a', 'b', 'c']);
  assert.ok(bad[0].samples.every((s) => s.q === 0));
  assert.equal(drv.closes >= 1, true);
  assert.equal(rt.getStatus().phase, 'backoff');
  assert.equal(rt.getStatus().timeouts, 1);
  const count = batches.length;
  await clock.advance(500);
  assert.equal(batches.length, count); // silent while offline
  await clock.advance(1500);
  assert.equal(rt.getStatus().phase, 'online');
  assert.equal(rt.getStatus().connects, 2);
  const lastBatch = batches[batches.length - 1];
  assert.ok(lastBatch.samples.every((s) => s.q === 192));
  assert.deepEqual(
    states.map((s) => s.state),
    ['offline', 'online', 'offline', 'online']
  );
  await halt(clock, rt);
});

test('adaptive slowdown doubles after 5 overrunning cycles (cap 8x) and restores after 20 clean', async () => {
  const { clock, drv, rt } = mk();
  drv.execDelay = 1500;
  rt.start();
  await clock.advance(0);
  await clock.advance(5 * 2000 + 500);
  assert.equal(rt.getStatus().groups.default.effectiveIntervalMs, 2000);
  assert.equal(rt.getStatus().groups.default.intervalMs, 1000);
  drv.execDelay = 100;
  await clock.advance(20 * 2100 + 4000);
  assert.equal(rt.getStatus().groups.default.effectiveIntervalMs, 1000);
  await halt(clock, rt);

  const b = mk();
  b.drv.execDelay = 9000;
  b.rt.start();
  await b.clock.advance(9000 * 40);
  assert.equal(b.rt.getStatus().groups.default.effectiveIntervalMs, 8000);
  await halt(b.clock, b.rt);
});

test('stop() leaves no timers and closes the driver', async () => {
  const { clock, drv, rt } = mk();
  rt.start();
  await clock.advance(2500);
  assert.ok(clock.timers.length > 0);
  await halt(clock, rt);
  assert.equal(clock.timers.length, 0);
  assert.equal(rt.pendingTimers(), 0);
  assert.equal(drv.closes >= 1, true);
  assert.equal(rt.getStatus().phase, 'stopped');
  await clock.advance(10000);
  assert.equal(drv.executed.length, 3);
});

test('stop() during backoff and during connect leaves no timers', async () => {
  const a = mk();
  a.drv.connectImpl = async () => {
    throw new Error('no');
  };
  a.rt.start();
  await a.clock.advance(100);
  assert.equal(a.rt.getStatus().phase, 'backoff');
  await halt(a.clock, a.rt);
  assert.equal(a.clock.timers.length, 0);

  const b = mk();
  let release;
  b.drv.connectImpl = () => new Promise((r) => (release = r));
  b.rt.start();
  await b.clock.advance(10);
  await halt(b.clock, b.rt);
  release();
  await b.clock.advance(10);
  assert.equal(b.clock.timers.length, 0);
  assert.equal(b.drv.executed.length, 0);
});

test('a misbehaving driver is contained: throws, malformed results, throwing close', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { clock, drv, rt, batches } = mk();
    let mode = 'throw';
    drv.close = async () => {
      throw new Error('close exploded');
    };
    drv.execute = async () => {
      if (mode === 'throw') throw new Error('boom');
      if (mode === 'junk') return 42;
      if (mode === 'sync') throw new TypeError('sync');
      return { ok: true, results: [{ key: 'a', v: 1, type: 'int32', q: 192 }] };
    };
    rt.start();
    await clock.advance(0);
    assert.equal(rt.getStatus().phase, 'backoff');
    assert.match(rt.getStatus().lastError, /boom/);
    mode = 'junk';
    await clock.advance(1000);
    assert.equal(rt.getStatus().phase, 'backoff');
    assert.match(rt.getStatus().lastError, /malformed/);
    mode = 'ok';
    await clock.advance(5000);
    assert.equal(rt.getStatus().phase, 'online');
    assert.ok(batches.length >= 1);

    drv.plan = () => {
      throw new Error('plan exploded');
    };
    mode = 'throw'; // force a reconnect; the fresh plan() then throws
    await clock.advance(30000);
    assert.match(rt.getStatus().lastError, /plan exploded/);
    assert.equal(rt.getStatus().phase === 'backoff' || rt.getStatus().phase === 'connecting', true);
    await halt(clock, rt);
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('throwing onSamples/onState consumers do not break the runtime', async () => {
  const clock = new FakeClock();
  const drv = new ScriptDriver(clock);
  const rt = new DeviceRuntime({
    device: { id: 'x', tags: [{ key: 'a' }], pollGroups: [{ id: 'default', intervalMs: 100 }] },
    driver: drv,
    onSamples: () => {
      throw new Error('consumer');
    },
    onState: () => {
      throw new Error('consumer');
    },
    timers: { setTimeout: (f, m) => clock.setTimeout(f, m), clearTimeout: (h) => clock.clearTimeout(h), now: () => clock.now() }
  });
  rt.start();
  await clock.advance(500);
  assert.ok(rt.getStatus().groups.default.cycles >= 4);
  await halt(clock, rt);
});

test('interRequestDelayMs spaces requests', async () => {
  const { clock, drv, rt } = mk({
    device: { limits: { requestDeadlineMs: 2000, interRequestDelayMs: 50 }, tags: [{ key: 'a' }, { key: 'b' }] }
  });
  const times = [];
  drv.planImpl = (keys) => keys.map((k) => ({ id: k, items: [{ key: k }] }));
  drv.execImpl = async () => {
    times.push(clock.now());
    return null;
  };
  rt.start();
  await clock.advance(200);
  assert.ok(times[1] - times[0] >= 50);
  await halt(clock, rt);
});

test('probe goes through the single connection; offline probe rejects', async () => {
  const { clock, rt } = mk();
  await assert.rejects(rt.probe({ x: 1 }), /offline/);
  rt.start();
  await clock.advance(0);
  assert.deepEqual(await rt.probe({ x: 1 }), { args: { x: 1 } });
  await halt(clock, rt);
});
