'use strict';

/**
 * BACnet/IP driver against the in-process simulator (test/support/bacnetSimulator.js): every data
 * type, quality, RPM and RP, routed devices, replies from another port, Who-Is answered only by
 * broadcast, device errors, oversize replies, timeouts and retries, late and foreign replies,
 * invoke-id management with concurrent requests, large tag sets, browse, runtime integration
 * (quarantine and reconnect) and the full DeviceManager path. Every simulator checks at the end
 * that no write-capable request ever reached it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

const bacnet = require('../drivers/bacnet');
const frame = require('../drivers/bacnet/frame');
const { BacnetClient } = require('../drivers/bacnet/client');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');
const { BacnetSimulator, P } = require('./support/bacnetSimulator');

const sims = [];
const drivers = [];

async function startSim(opts) {
  const sim = await new BacnetSimulator(opts).start();
  sims.push(sim);
  return sim;
}

function makeDriver(sim, tags, extra = {}) {
  const d = bacnet.createDriver(
    {
      id: 'bac1',
      name: 'AHU 1',
      protocol: 'bacnet-ip',
      host: '127.0.0.1',
      port: sim.port,
      ...(extra.device || {}),
      options: { apduTimeoutMs: 200, apduRetries: 1, ...(extra.options || {}) },
      limits: { requestDeadlineMs: 1500, connectTimeoutMs: 3000, ...(extra.limits || {}) },
      tags: tags.map((t) => (typeof t === 'string' ? { key: t, address: t } : t)),
    },
    extra.deps || {}
  );
  drivers.push(d);
  return d;
}

/** Plan and execute everything, following bisect like the runtime does; returns key -> sample, plus exceptions. */
async function readAll(d, keys) {
  const out = {};
  const exceptions = [];
  const run = async (req) => {
    const res = await d.execute(req, 1500);
    if (res.ok) {
      for (const r of res.results) out[r.key] = r;
      return;
    }
    assert.equal(res.kind, 'exception', JSON.stringify(res));
    if (res.classification === 'permanent' && req.items.length > 1) {
      for (const h of d.bisect(req)) await run(h);
      return;
    }
    exceptions.push({ keys: req.items.map((i) => i.key), ...res });
  };
  for (const req of d.plan(keys)) await run(req);
  return { out, exceptions };
}

test.after(async () => {
  for (const d of drivers) await d.close();
  for (const sim of sims) assert.equal(sim.stats.writesReceived, 0, 'a write-capable request reached the simulator');
  for (const sim of sims) await sim.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ALL_TYPES = {
  'analog-input:1': [21.5, 'float32', 192],
  'analog-input:2': [101.30000305175781, 'float32', 0],
  'analog-value:7': [22, 'float32', 64],
  'analog-output:3': [45.25, 'float32', 192],
  'binary-input:2': [true, 'bool', 192],
  'binary-value:4': [false, 'bool', 192],
  'binary-output:1': [true, 'bool', 192],
  'multi-state-value:1': [2, 'uint32', 192],
  'multi-state-input:5': [1, 'uint32', 192],
  'characterstring-value:1': ['Grüße', 'string', 192],
  'characterstring-value:2': ['Café', 'string', 192],
  'integer-value:1': [-1234, 'int32', 192],
  'large-analog-value:1': [123456789.125, 'float64', 192],
  'octetstring-value:1': ['deadbeef', 'string', 192],
  'bitstring-value:1': [[true, false, true], 'struct', 192],
  'date-value:1': ['2026-12-25', 'string', 192],
  'time-value:1': ['07:30:00.00', 'string', 192],
  'positive-integer-value:1': [70000, 'uint32', 192],
  'analog-input:1/units': [62, 'uint32', 192],
  'analog-input:1/object-name': ['Zone Temp', 'string', 192],
  'analog-input:1/status-flags': [{ inAlarm: false, fault: false, overridden: false, outOfService: false }, 'struct', 192],
  'multi-state-value:1/state-text[2]': ['Auto', 'string', 192],
  'multi-state-value:1/state-text[0]': [3, 'uint32', 192],
  'device:1234/object-list[0]': [20, 'uint32', 192],
  'device:1234/object-list[2]': ['analog-input:1', 'string', 192],
  'analog-output:3/priority-array': [[null, null, null, null, null, null, null, 45.25, null, null, null, null, null, null, null, null], 'struct', 192],
};

for (const rpm of [true, false]) {
  test(`every data type and quality (${rpm ? 'ReadPropertyMultiple' : 'ReadProperty only'})`, async () => {
    const sim = await startSim({ rpm });
    const d = makeDriver(sim, Object.keys(ALL_TYPES));
    const info = await d.connect();
    assert.equal(info.identity.deviceInstance, 1234);
    assert.equal(info.identity.modelName, 'SIM-BAC-1');
    assert.equal(info.identity.vendorName, 'Manifold Test Vendor');
    assert.equal(info.identity.segmentation, 'no-segmentation');
    assert.equal(info.limits.readMultiple, rpm);
    assert.equal(info.limits.maxApdu, 480);
    const plan = d.plan();
    assert.ok(plan.every((r) => r.kind === (rpm ? 'rpm' : 'rp')));
    const { out, exceptions } = await readAll(d);
    assert.deepEqual(exceptions, []);
    for (const [addr, [v, type, q]] of Object.entries(ALL_TYPES)) {
      assert.deepEqual(out[addr].v, v, addr);
      assert.equal(out[addr].type, type, addr);
      assert.equal(out[addr].q, q, addr);
    }
    assert.match(out['analog-value:7'].qReason, /out-of-service/);
    assert.match(out['analog-input:2'].qReason, rpm ? /reliability: over-range/ : /fault/);
    if (rpm) assert.equal(sim.stats.rp, 0, 'RPM device: no ReadProperty needed');
    else assert.ok(sim.stats.rpm >= 1 && sim.stats.rpm <= 1, 'one RPM probe at connect, then ReadProperty only');
  });
}

test('declared tag types cast the value', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [
    { key: 'i', address: 'analog-input:1', type: 'int32' },
    { key: 's', address: 'multi-state-value:1', type: 'string' },
    { key: 'b', address: 'binary-input:2', type: 'uint32' },
    { key: 'bad', address: 'characterstring-value:1', type: 'float32' },
  ]);
  await d.connect();
  const { out } = await readAll(d);
  assert.deepEqual([out.i.v, out.i.type], [21, 'int32']);
  assert.deepEqual([out.s.v, out.s.type], ['2', 'string']);
  assert.deepEqual([out.b.v, out.b.type], [1, 'uint32']);
  assert.deepEqual([out.bad.q, out.bad.qReason], [0, 'decode']);
});

test('readStatus off reads present-value alone and reports Good', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:2'], { options: { readStatus: false } });
  await d.connect();
  const { out } = await readAll(d);
  assert.equal(out['analog-input:2'].q, 192);
});

test('Who-Is answered only by broadcast: the device is found through the wildcard device instance', async () => {
  const sim = await startSim({ iAmBroadcastOnly: true });
  const d = makeDriver(sim, ['analog-input:1']);
  const info = await d.connect();
  assert.equal(info.identity.learnedBy, 'wildcard-read');
  assert.equal(info.identity.deviceInstance, 1234);
  assert.equal(info.limits.deviceMaxApdu, 480, 'max APDU read from the device object');
  assert.equal(sim.stats.whoIs, 1);
  const { out } = await readAll(d);
  assert.equal(out['analog-input:1'].v, 21.5);
});

test('configured device instance: a wrong one is a clear connect error', async () => {
  const sim = await startSim({ iAmBroadcastOnly: true });
  const ok = makeDriver(sim, [], { device: { deviceInstance: 1234 } });
  assert.equal((await ok.connect()).identity.learnedBy, 'configured');
  const wrong = makeDriver(sim, [], { device: { deviceInstance: 77 } });
  await assert.rejects(wrong.connect(), /device 77 does not exist there.*unknown-object/);
});

test('routed device: DNET/DADR on requests, SNET/SADR checked on replies', async () => {
  const sim = await startSim({ routed: { network: 5, mac: Buffer.from([12]) } });
  const d = makeDriver(sim, ['analog-input:1', 'binary-input:2'], { device: { network: 5, mac: '12' } });
  const info = await d.connect();
  assert.equal(info.identity.learnedBy, 'i-am');
  const { out } = await readAll(d);
  assert.equal(out['analog-input:1'].v, 21.5);
  assert.equal(out['binary-input:2'].v, true);
});

test('routed device with a wrong MAC: no answer, a clear connect error', async () => {
  const sim = await startSim({ routed: { network: 5, mac: Buffer.from([12]) } });
  const wrongMac = makeDriver(sim, [], { device: { network: 5, mac: '13' }, limits: { connectTimeoutMs: 1200 } });
  await assert.rejects(wrongMac.connect(), /did not answer/);
});

test('routed device configured as local: the error names the network and MAC that answered', async () => {
  // A gateway that answers un-routed requests on behalf of a device on its virtual network 5.
  const sim = await startSim({ routed: { network: 5, mac: Buffer.from([12]), answerLocal: true } });
  const d = makeDriver(sim, [], { device: { deviceInstance: 1234 }, limits: { connectTimeoutMs: 1500 } });
  await assert.rejects(d.connect(), /behind a BACnet router, set Network 5 and MAC 12/);
});

test('a router that cannot reach the network: Reject-Message-To-Network becomes a clear error', async () => {
  const sim = await startSim({ routed: { network: 5, mac: Buffer.from([12]) } });
  const d = makeDriver(sim, [], { device: { network: 6, mac: '12' } });
  await assert.rejects(d.connect(), /cannot reach network 6/);
});

test('replies from a different source port are accepted', async () => {
  const sim = await startSim({ replyFromOtherPort: true });
  const d = makeDriver(sim, ['analog-input:1']);
  await d.connect();
  const { out } = await readAll(d);
  assert.equal(out['analog-input:1'].v, 21.5);
});

test('replies from another address are dropped (reply pinning)', async () => {
  const sim = await startSim();
  // Send a valid-looking ACK for every invoke id from 127.0.0.2 while the device stays silent.
  const client = new BacnetClient({ host: '127.0.0.1', port: sim.port });
  await client.open();
  sim.faults.blackhole = true;
  const spoof = dgram.createSocket('udp4');
  await new Promise((r) => spoof.bind(0, '127.0.0.2', r));
  const p = client.request((id) => frame.readPropertyPacket(id, { objectType: 0, instance: 1, property: 85 }), { service: 12, apduTimeoutMs: 150, retries: 0, label: 'rp' });
  const localPort = client._sock.address().port;
  for (let id = 0; id < 256; id++) {
    const ack = Buffer.from(`810a0017010030${id.toString(16).padStart(2, '0')}0c0c0000000119553e4441ac00003f`, 'hex');
    spoof.send(ack, localPort, '127.0.0.1');
  }
  const res = await p;
  assert.equal(res.kind, 'timeout');
  assert.ok(client.stats.foreign > 0, 'spoofed replies counted as foreign');
  client.close();
  spoof.close();
  sim.faults.blackhole = false;
});

test('device errors: unknown object and property are quarantined alone, the rest keep reading', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1', 'analog-input:99', 'analog-input:1/high-limit', 'binary-input:2', 'multi-state-value:1/state-text[9]', 'analog-input:1/units[1]']);
  await d.connect();
  const { out, exceptions } = await readAll(d);
  assert.equal(out['analog-input:1'].v, 21.5);
  assert.equal(out['binary-input:2'].v, true);
  const byKey = Object.fromEntries(exceptions.map((e) => [e.keys[0], e]));
  assert.match(byKey['analog-input:99'].message, /unknown-object/);
  assert.match(byKey['analog-input:1/high-limit'].message, /unknown-property/);
  assert.match(byKey['multi-state-value:1/state-text[9]'].message, /invalid-array-index/);
  assert.match(byKey['analog-input:1/units[1]'].message, /property-is-not-an-array/);
  for (const e of exceptions) assert.equal(e.classification, 'permanent');
});

test('a device that answers the WHOLE RPM with one Error is split until the bad object is found', async () => {
  const sim = await startSim();
  sim.faults.rpmWholeError = true;
  const d = makeDriver(sim, ['analog-input:1', 'analog-input:2', 'analog-input:99', 'binary-value:4']);
  await d.connect();
  const { out, exceptions } = await readAll(d);
  assert.equal(out['analog-input:1'].v, 21.5);
  assert.equal(out['binary-value:4'].v, false);
  assert.deepEqual(exceptions.map((e) => e.keys), [['analog-input:99']]);
});

test('transient device error (device-busy) is Bad for one cycle, not quarantined', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1']);
  await d.connect();
  const [req] = d.plan();
  sim.faults.errorNext = [0, 3];
  const res = await d.execute(req, 1500);
  assert.equal(res.ok, false);
  assert.equal(res.classification, 'transient');
  assert.match(res.message, /device-busy/);
  assert.equal((await d.execute(req, 1500)).ok, true);
});

test('reply too large for an unsegmented APDU: RPM is split, a single value falls back to ReadProperty', async () => {
  const objects = {};
  for (let i = 0; i < 60; i++) {
    objects[`analog-value:${i}`] = { [P.presentValue]: { t: 'real', v: i }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.description]: { t: 'str', v: 'x'.repeat(100) } };
  }
  const sim = await startSim({ objects, maxApdu: 206 });
  // Descriptions are estimated at 130 bytes; force them all into one request to hit the device's limit.
  const keys = Object.keys(objects).map((a) => `${a}/description`);
  const d = makeDriver(sim, keys, { options: { maxApdu: '1476', maxProperties: 500 } });
  await d.connect();
  const { out, exceptions } = await readAll(d);
  assert.deepEqual(exceptions, []);
  assert.equal(Object.keys(out).length, 60);
  assert.equal(out['analog-value:5/description'].v, 'x'.repeat(100));
});

test('a value that can never fit in one APDU is quarantined with a message naming array index reads', async () => {
  const objects = { 'multi-state-value:1': { [P.stateText]: Array.from({ length: 40 }, (_, i) => ({ t: 'str', v: `state number ${i}` })), [P.presentValue]: { t: 'uint', v: 1 } } };
  const sim = await startSim({ objects, maxApdu: 128 });
  const d = makeDriver(sim, ['multi-state-value:1/state-text', 'multi-state-value:1/state-text[3]']);
  await d.connect();
  const { out, exceptions } = await readAll(d);
  assert.equal(out['multi-state-value:1/state-text[3]'].v, 'state number 2');
  assert.equal(exceptions.length, 1);
  assert.match(exceptions[0].message, /array index/);
});

test('segmented reply although we do not accept segmentation is handled as too large', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1', 'binary-input:2']);
  await d.connect();
  const [req] = d.plan();
  sim.faults.segmentedReply = true;
  const res = await d.execute(req, 1500);
  assert.equal(res.ok, false);
  assert.equal(res.classification, 'permanent');
  const halves = d.bisect(req);
  assert.equal(halves.length, 2);
});

test('lost requests are retried with the same invoke id', async () => {
  const sim = await startSim();
  const sent = [];
  const d = makeDriver(sim, ['analog-input:1'], { options: { apduTimeoutMs: 150, apduRetries: 2 }, deps: { onSend: (p) => sent.push(p) } });
  await d.connect();
  sent.length = 0;
  sim.faults.dropNext = 2;
  const res = await d.execute(d.plan()[0], 1500);
  assert.equal(res.ok, true);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((p) => p.equals(sent[0])), 'retries re-send the identical datagram (same invoke id)');
});

test('no answer within the deadline is fatal (the runtime reconnects)', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1'], { options: { apduTimeoutMs: 100, apduRetries: 1 } });
  await d.connect();
  sim.faults.blackhole = true;
  const res = await d.execute(d.plan()[0], 1000);
  assert.equal(res.ok, false);
  assert.equal(res.fatal, true);
  assert.equal(res.kind, 'timeout');
  assert.match(res.message, /no answer from 127\.0\.0\.1:\d+ after 2 attempts/);
  sim.faults.blackhole = false;
});

test('a late reply to a timed-out invoke id is never matched to a newer request', async () => {
  const sim = await startSim();
  const client = new BacnetClient({ host: '127.0.0.1', port: sim.port, retireMs: 5000 });
  await client.open();
  const rp = (instance) => client.request((id) => frame.readPropertyPacket(id, { objectType: 0, instance, property: 85 }), { service: 12, apduTimeoutMs: 100, retries: 0, label: 'rp' });
  sim.faults.lateReply = 250;
  const first = await rp(1);
  assert.equal(first.kind, 'timeout');
  const second = await rp(2); // sent while the late reply for instance 1 is still on its way
  assert.equal(second.ok, true);
  assert.equal(frame.parseReadPropertyAck(second.apdu.body).instance, 2);
  await sleep(300);
  assert.equal(client.stats.late, 1, 'the late reply arrived and was dropped');
  client.close();
});

test('wrong invoke id, wrong service and an inconsistent BVLC length are dropped; the retry succeeds', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1'], { options: { apduTimeoutMs: 150, apduRetries: 1 } });
  await d.connect();
  for (const fault of ['wrongInvokeId', 'wrongService', 'badBvlcLength']) {
    sim.faults[fault] = true;
    const res = await d.execute(d.plan()[0], 1500);
    assert.equal(res.ok, true, fault);
    assert.equal(res.results[0].v, 21.5, fault);
  }
  const st = d.clientStats();
  assert.ok(st.late >= 1 && st.wrongService >= 1 && st.malformed >= 1, JSON.stringify(st));
});

test('a truncated reply to our own invoke id is a framing error (never a value); the next request works', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1', 'binary-input:2']);
  await d.connect();
  sim.faults.truncate = true;
  const res = await d.execute(d.plan()[0], 1500);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'framing');
  assert.equal(res.fatal, true);
  assert.match(res.message, /malformed ReadPropertyMultiple-ACK/);
  assert.equal((await d.execute(d.plan()[0], 1500)).ok, true);
});

test('Abort and Reject PDUs become clear, classified messages', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1']);
  await d.connect();
  sim.faults.abortNext = 9;
  let res = await d.execute(d.plan()[0], 1500);
  assert.match(res.message, /aborted by the device: out-of-resources/);
  sim.faults.rejectNext = 4;
  res = await d.execute(d.plan()[0], 1500);
  assert.match(res.message, /rejected: invalid-tag/);
  assert.equal(res.code, 'reject/invalid-tag');
});

test('a device that starts rejecting RPM mid-session falls back to ReadProperty in the same cycle', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['analog-input:1', 'binary-input:2']);
  await d.connect();
  assert.equal(d.session().rpm, true);
  sim.rpm = false;
  const res = await d.execute(d.plan()[0], 1500);
  assert.equal(res.ok, true);
  assert.equal(d.session().rpm, false);
  assert.ok(d.plan().every((r) => r.kind === 'rp'));
});

test('invoke ids: concurrent requests on one socket each get their own answer', async () => {
  const sim = await startSim();
  sim.faults.delayMs = 20;
  const client = new BacnetClient({ host: '127.0.0.1', port: sim.port, maxOutstanding: 8 });
  await client.open();
  let peak = 0;
  const reqs = [];
  for (let i = 0; i < 40; i++) {
    const instance = [1, 2, 3][i % 3];
    const objectType = instance === 3 ? 1 : 0;
    reqs.push(
      client
        .request((id) => frame.readPropertyPacket(id, { objectType, instance, property: 85 }), { service: 12, apduTimeoutMs: 1000, retries: 0, label: 'rp' })
        .then((r) => ({ r, instance }))
    );
    peak = Math.max(peak, client.inFlight());
  }
  const timer = setInterval(() => (peak = Math.max(peak, client.inFlight())), 2);
  const results = await Promise.all(reqs);
  clearInterval(timer);
  for (const { r, instance } of results) {
    assert.equal(r.ok, true);
    assert.equal(frame.parseReadPropertyAck(r.apdu.body).instance, instance);
  }
  assert.ok(peak <= 8, `peak in flight ${peak}`);
  assert.ok(peak > 1, 'requests really overlapped');
  client.close();
  sim.faults.delayMs = 0;
});

test('invoke ids wrap around 255 and skip retired ids', async () => {
  const sim = await startSim();
  const client = new BacnetClient({ host: '127.0.0.1', port: sim.port, retireMs: 60000 });
  await client.open();
  client._nextId = 250;
  sim.faults.blackhole = true;
  const first = await client.request((id) => frame.readPropertyPacket(id, { objectType: 0, instance: 1, property: 85 }), { service: 12, apduTimeoutMs: 30, retries: 0 });
  assert.equal(first.kind, 'timeout');
  sim.faults.blackhole = false;
  const used = [];
  for (let i = 0; i < 10; i++) {
    const r = await client.request(
      (id) => {
        used.push(id);
        return frame.readPropertyPacket(id, { objectType: 0, instance: 1, property: 85 });
      },
      { service: 12, apduTimeoutMs: 500, retries: 0 }
    );
    assert.equal(r.ok, true);
  }
  assert.ok(!used.includes(250), 'the timed-out id stays retired');
  assert.ok(used.includes(255) && used.includes(0), `ids wrap: ${used}`);
  client.close();
});

test('large tag set: 1500 tags are planned within the APDU and all read', async () => {
  const objects = {};
  for (let i = 0; i < 1500; i++) objects[`analog-value:${i}`] = { [P.presentValue]: { t: 'real', v: i / 2 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.outOfService]: { t: 'bool', v: false }, [P.reliability]: { t: 'enum', v: 0 } };
  const sim = await startSim({ objects, maxApdu: 1476 });
  const d = makeDriver(sim, Object.keys(objects), { options: { maxProperties: 100 } });
  await d.connect();
  const plan = d.plan();
  assert.ok(plan.length < 100, `${plan.length} requests`);
  const before = sim.stats.rpm;
  const { out, exceptions } = await readAll(d);
  assert.deepEqual(exceptions, []);
  assert.equal(sim.stats.rpm - before, plan.length, 'no request was too large (no split needed)');
  assert.equal(out['analog-value:1499'].v, 749.5);
  assert.equal(Object.keys(out).length, 1500);
});

test('browse: object types, then objects with name, description and unit text; object-list read by index', async () => {
  const objects = {};
  for (let i = 0; i < 230; i++) objects[`analog-input:${i}`] = { [P.objectName]: { t: 'str', v: `Sensor ${i}` }, [P.presentValue]: { t: 'real', v: i }, [P.units]: { t: 'enum', v: i % 2 ? 62 : 98 } };
  objects['binary-value:1'] = { [P.objectName]: { t: 'str', v: 'Enable' }, [P.presentValue]: { t: 'enum', v: 1 } };
  for (const rpm of [true, false]) {
    const sim = await startSim({ objects, rpm, maxApdu: 480 });
    const d = makeDriver(sim, [], { options: { maxOutstanding: 4 } });
    await d.connect();
    const root = await d.browse();
    assert.deepEqual(root.map((n) => n.name), ['analog-input (230)', 'binary-value (1)', 'device (1)']);
    const pages = await d.browse('type:0');
    assert.equal(pages.length, 3, 'more than 100 objects are paged');
    assert.ok(pages.every((p) => p.kind === 'folder'));
    const page = await d.browse(pages[0].id);
    assert.equal(page.length, 100);
    assert.equal(page[1].address, 'analog-input:1');
    assert.equal(page[1].meta.objectName, 'Sensor 1');
    assert.equal(page[1].meta.unit, '°C');
    assert.equal(page[2].meta.unit, '%');
    const dev = await d.browse('type:8');
    assert.equal(dev[0].address, 'device:1234/object-name', 'objects without present-value are offered by name');
    const bv = await d.browse('type:5');
    assert.equal(bv[0].name, 'Enable (binary-value:1)');
    await assert.rejects(d.browse('nope'), /unknown browse node/);
    if (rpm) assert.ok(sim.stats.rp <= 2, 'RPM device: object-list and names come from RPM');
  }
});

test('probe: value, application tags, status and unit text', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, []);
  await d.connect();
  const p = await d.probe({ address: 'analog-input:1' });
  assert.equal(p.address, 'analog-input:1');
  assert.equal(p.type, 'float32');
  assert.equal(p.rawHex, '4441ac0000');
  assert.equal(p.decodings.value, 21.5);
  assert.equal(p.decodings.units, '°C (degrees-celsius)');
  assert.equal(p.decodings['object-name'], 'Zone Temp');
  const s = await d.probe({ address: 'characterstring-value:1' });
  assert.equal(s.decodings.characterSet, 'ucs-2');
  await assert.rejects(d.probe({ address: 'analog-input:99' }), /unknown-object/);
});

test('nothing but Who-Is, ReadProperty and ReadPropertyMultiple ever leaves the socket', async () => {
  const sim = await startSim();
  const sent = [];
  const d = makeDriver(sim, Object.keys(ALL_TYPES), { deps: { onSend: (p) => sent.push(p) } });
  await d.connect();
  await readAll(d);
  await d.browse();
  await d.browse('type:0');
  await d.probe({ address: 'analog-input:1' });
  assert.ok(sent.length > 5);
  for (const p of sent) {
    assert.equal(p[1], 0x0a, 'BVLC Original-Unicast only');
    const pkt = frame.decodePacket(p);
    assert.equal(pkt.networkMessage, undefined);
    const a = frame.decodeApdu(pkt.apdu);
    if (a.type === 'unconfirmed-request') assert.equal(a.service, 8);
    else {
      assert.equal(a.type, 'confirmed-request');
      assert.ok([12, 14].includes(a.service), `service ${a.service}`);
    }
  }
  // And the client refuses to build anything else even if asked directly.
  const client = new BacnetClient({ host: '127.0.0.1', port: sim.port });
  await client.open();
  const res = await client.request((id) => frame.encodePacket(frame.confirmedApdu({ invokeId: id, service: 15, params: Buffer.alloc(0) })), { service: 15, apduTimeoutMs: 100, retries: 0 });
  assert.equal(res.kind, 'invalid');
  assert.match(res.message, /writeProperty/);
  client.close();
});

test('runtime: polling, quarantine with the reason, Bad on loss and reconnect', async () => {
  const sim = await startSim();
  const device = {
    id: 'rt1',
    protocol: 'bacnet-ip',
    host: '127.0.0.1',
    port: sim.port,
    options: { apduTimeoutMs: 100, apduRetries: 1 },
    limits: { requestDeadlineMs: 600, connectTimeoutMs: 1500 },
    pollGroups: [{ id: 'fast', intervalMs: 100 }],
    tags: [
      { key: 'temp', address: 'analog-input:1', pollGroup: 'fast' },
      { key: 'ghost', address: 'analog-input:42', pollGroup: 'fast' },
      { key: 'fan', address: 'binary-input:2', pollGroup: 'fast' },
    ],
  };
  const driver = bacnet.createDriver(device);
  const samples = [];
  const states = [];
  const rt = new DeviceRuntime({ device, driver, backoff: { initialMs: 50, maxMs: 200 }, onSamples: (b) => samples.push(...b.samples), onState: (s) => states.push(s.state) });
  rt.start();
  try {
    await until(() => samples.some((s) => s.key === 'temp' && s.q === 192), 5000, 'first good sample');
    await until(() => rt.getStatus().quarantined.includes('ghost'), 5000, 'quarantine');
    assert.match(rt.getStatus().quarantineReasons.ghost.message, /unknown-object/);
    assert.ok(samples.some((s) => s.key === 'fan' && s.v === true));
    sim.faults.blackhole = true;
    await until(() => samples.some((s) => s.key === 'temp' && s.qReason === 'disconnected'), 5000, 'Bad on loss');
    assert.match(rt.getStatus().lastError, /no answer/);
    sim.faults.blackhole = false;
    sim.setValue('analog-input:1', P.presentValue, { t: 'real', v: 30 });
    await until(() => samples.some((s) => s.key === 'temp' && s.v === 30 && s.q === 192), 8000, 'reconnect');
    assert.ok(rt.getStatus().connects >= 2);
  } finally {
    await rt.stop();
  }
});

// ---- DeviceManager end to end (real child host process) ---------------------------------------

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
    },
  };
}

test('DeviceManager: descriptor, save, live values, browse and test connection through the host process', async () => {
  const { DeviceManager } = require('../services/deviceManager');
  const sim = await startSim();
  const devices = new DeviceManager({ profiles: memoryProfiles(), io: new EventEmitter(), guard: async () => {}, supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } }, rebindCheckMs: 0 });
  await devices.start();
  try {
    const desc = devices.protocols().find((p) => p.id === 'bacnet-ip');
    assert.ok(desc, 'bacnet-ip is registered');
    assert.equal(desc.experimental, true);
    assert.equal(desc.capabilities.browse, true);
    assert.ok(desc.deviceFields.some((f) => f.name === 'deviceInstance'));
    assert.ok(desc.tagTypes.includes('float32'));
    await assert.rejects(devices.save({ name: 'bad', protocol: 'bacnet-ip', host: '127.0.0.1', tags: [{ key: 'x', address: 'nope:1' }] }), /invalid tag/);
    await assert.rejects(devices.save({ name: 'bad2', protocol: 'bacnet-ip', host: '127.0.0.1', network: 5 }), /mac is required/);
    const saved = await devices.save({
      name: 'AHU sim',
      protocol: 'bacnet-ip',
      host: '127.0.0.1',
      port: sim.port,
      options: { apduTimeoutMs: 200, apduRetries: 1 },
      pollGroups: [{ id: 'default', intervalMs: 200 }],
      tags: [{ key: 'zoneTemp', address: 'analog-input:1' }, { key: 'fan', address: 'binary-input:2' }],
    });
    assert.equal(saved.port, sim.port);
    await until(() => devices.getValues(saved.id).zoneTemp?.v === 21.5, 10000, 'live value');
    assert.equal(devices.getValues(saved.id).fan.v, true);
    const nodes = await devices.browse(saved.id);
    assert.ok(nodes.some((n) => n.name.startsWith('analog-input')));
    const t = await devices.test({ name: 'probe', protocol: 'bacnet-ip', host: '127.0.0.1', port: sim.port });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.info.identity.modelName, 'SIM-BAC-1');
  } finally {
    await devices.stop();
  }
});

test('DeviceManager: the egress guard refuses a loopback BACnet target unless allowed', async () => {
  const { DeviceManager } = require('../services/deviceManager');
  const prev = process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  const devices = new DeviceManager({ profiles: memoryProfiles(), rebindCheckMs: 0 });
  try {
    await assert.rejects(devices.save({ name: 'lo', protocol: 'bacnet-ip', host: '127.0.0.1', tags: [] }), /loopback|blocked|not allowed/i);
  } finally {
    if (prev !== undefined) process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = prev;
    await devices.stop();
  }
});
