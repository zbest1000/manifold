'use strict';

// Network discovery, end to end through the REAL egress guard: nothing here stubs
// isAllowedAddress. Loopback scans work only because the tests set
// MANIFOLD_ALLOW_LOOPBACK_DEVICES=1, exactly as a developer would.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DiscoveryService = require('../services/discovery');
const { classifyScanTarget } = require('../services/egressGuard');
const deviceIdentify = require('../services/deviceIdentify');
const modbusFrame = require('../drivers/modbus/frame');
const { startDiscoveryLab, fake, listen, closeServer } = require('./support/discoveryLab');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FLAGS = ['MANIFOLD_ALLOW_LOOPBACK_DEVICES', 'MANIFOLD_ALLOW_PRIVATE_TARGETS'];

function withFlags(flags, fn) {
  const prev = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  for (const f of FLAGS) delete process.env[f];
  for (const [k, v] of Object.entries(flags)) process.env[k] = v;
  const restore = () => {
    for (const f of FLAGS) {
      if (prev[f] === undefined) delete process.env[f];
      else process.env[f] = prev[f];
    }
  };
  let out;
  try {
    out = fn();
  } catch (error) {
    restore();
    throw error;
  }
  return Promise.resolve(out).finally(restore);
}
const loopbackOn = (fn) => withFlags({ MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1' }, fn);

function recorder() {
  const events = [];
  return { events, io: { emit: (name, payload) => events.push([name, payload]) }, of: (n) => events.filter((e) => e[0] === n).map((e) => e[1]) };
}
const done = (d) => new Promise((resolve) => d.once('done', resolve));

// ---- the guard matrix --------------------------------------------------------------------

const SAMPLES = {
  loopback: '127.0.0.1',
  private: '192.168.1.10',
  public: '8.8.8.8',
  metadata: '169.254.169.254',
  multicast: '239.1.2.3',
  reserved: '192.0.2.5' // TEST-NET-1: not a real subnet
};

test('scan policy matrix: flags x address class', async () => {
  const expectations = {
    //                                  neither  loopback  private  both
    loopback: [false, true, false, true],
    private: [false, false, true, true],
    public: [true, true, true, true],
    metadata: [false, false, false, false],
    multicast: [false, false, false, false],
    reserved: [false, false, false, false]
  };
  const combos = [{}, { MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1' }, { MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }, { MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1', MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }];
  for (const [cls, ip] of Object.entries(SAMPLES)) {
    for (let i = 0; i < combos.length; i++) {
      const got = await withFlags(combos[i], () => classifyScanTarget(ip));
      assert.strictEqual(got.allowed, expectations[cls][i], `${cls} (${ip}) with ${JSON.stringify(combos[i])}`);
    }
  }
  // categories and the flag each one names
  assert.deepStrictEqual(classifyScanTarget('127.0.0.1'), { allowed: false, category: 'loopback', flag: 'MANIFOLD_ALLOW_LOOPBACK_DEVICES' });
  assert.deepStrictEqual(classifyScanTarget('10.0.0.1'), { allowed: false, category: 'private', flag: 'MANIFOLD_ALLOW_PRIVATE_TARGETS' });
  assert.strictEqual(classifyScanTarget('169.254.169.254').category, 'link-local');
  assert.strictEqual(classifyScanTarget('169.254.169.254').flag, null);
  assert.strictEqual(classifyScanTarget('224.0.0.1').category, 'multicast');
  assert.strictEqual(classifyScanTarget('100.100.100.200').category, 'reserved'); // CGNAT / Alibaba metadata
  assert.strictEqual(classifyScanTarget('::1').allowed, false); // the scan is IPv4 only
});

test('a refused range says exactly which flag would allow it, or that nothing will', async () => {
  const d = new DiscoveryService(recorder().io);
  const refused = (range, flags = {}) => withFlags(flags, () => d.plan({ range }).then(() => assert.fail('should refuse'), (e) => e));

  let e = await refused('127.0.0.1/32');
  assert.strictEqual(e.code, 'RANGE_REFUSED');
  assert.match(e.message, /blocked/);
  assert.match(e.message, /MANIFOLD_ALLOW_LOOPBACK_DEVICES=1/);
  assert.doesNotMatch(e.message, /MANIFOLD_ALLOW_PRIVATE_TARGETS/);
  assert.strictEqual(e.flag, 'MANIFOLD_ALLOW_LOOPBACK_DEVICES');

  e = await refused('192.168.1.0/24');
  assert.match(e.message, /MANIFOLD_ALLOW_PRIVATE_TARGETS=1/);
  assert.doesNotMatch(e.message, /MANIFOLD_ALLOW_LOOPBACK_DEVICES/);
  assert.strictEqual(e.flag, 'MANIFOLD_ALLOW_PRIVATE_TARGETS');

  // setting the wrong flag does not help, and the message still names the right one
  e = await refused('192.168.1.0/24', { MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1' });
  assert.match(e.message, /MANIFOLD_ALLOW_PRIVATE_TARGETS=1/);

  for (const range of ['192.0.2.0/24', '169.254.169.0/24', '239.0.0.0/24']) {
    e = await refused(range, { MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1', MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' });
    assert.strictEqual(e.code, 'RANGE_REFUSED', range);
    assert.match(e.message, /No setting allows this range/, range);
    assert.strictEqual(e.flag, null, range);
  }
});

test('a range that is only partly blocked scans the rest and reports what it skipped', async () => {
  const d = new DiscoveryService(recorder().io);
  // 100.64.0.0/10 is CGNAT (blocked); 100.128.0.0/16 is public. A /16 straddling is not possible, so use two checks.
  const plan = await withFlags({}, () => d.plan({ range: '8.8.8.8/32' }));
  assert.deepStrictEqual(plan.skipped, {});
  assert.strictEqual(plan.hosts.length, 1);
});

test('range input: IPv6, bad CIDR, hostnames, size limit', async () => {
  const d = new DiscoveryService(recorder().io, { lookup: async (h) => (h === 'plc.local' ? { address: '8.8.4.4' } : Promise.reject(new Error('ENOTFOUND'))) });
  const bad = async (range, re, code) => {
    const e = await d.plan({ range }).then(() => assert.fail(`${range} should be rejected`), (x) => x);
    assert.match(e.message, re, range);
    if (code) assert.strictEqual(e.code, code, range);
  };
  await bad('fe80::1', /IPv6/, 'RANGE_INVALID');
  await bad('2001:db8::/64', /IPv6/, 'RANGE_INVALID');
  await bad('999.1.1.0/24', /Invalid CIDR/, 'RANGE_INVALID');
  await bad('10.0.0.0/33', /prefix/, 'RANGE_INVALID');
  await bad('10.0.0.0/ab', /Invalid CIDR/, 'RANGE_INVALID');
  await bad('nonexistent.example', /Could not resolve/, 'RANGE_INVALID');
  await bad('plc.local/24', /Invalid CIDR/, 'RANGE_INVALID');
  await bad('bad host!', /not an IPv4 address, CIDR or hostname/, 'RANGE_INVALID');

  // A hostname becomes one /32 (the guard then judges the resolved address).
  const plan = await withFlags({}, () => d.plan({ range: 'plc.local' }));
  assert.deepStrictEqual([plan.range, plan.resolvedFrom, plan.hosts.length], ['8.8.4.4', 'plc.local', 1]);

  // Large ranges are refused with size, duration and the limit; nothing is expanded.
  const e = await withFlags({ MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }, () => d.plan({ range: '10.0.0.0/16' }).then(() => assert.fail('/16 must be refused'), (x) => x));
  assert.strictEqual(e.code, 'RANGE_TOO_LARGE');
  assert.match(e.message, /65,534 hosts/);
  assert.match(e.message, /limit is 1,024 hosts/);
  assert.match(e.message, /\/22/);
  assert.match(e.message, /MANIFOLD_DISCOVERY_MAX_HOSTS/);
  assert.match(e.message, /\b\d+(\.\d)? h\b/); // a duration in hours
  await bad('10.0.0.0/8', /16,777,214 hosts/, 'RANGE_TOO_LARGE');
  // a /22 is the biggest allowed with the default limit
  const ok = await withFlags({ MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }, () => d.plan({ range: '10.0.0.0/22', includeI3x: false }));
  assert.strictEqual(ok.hosts.length, 1022);
  assert.strictEqual(ok.totalProbes, 1022 * 4);

  await assert.rejects(d.plan({ range: '10.0.0.5', concurrency: 0 }), /concurrency must be a whole number from 1 to 512/);
  await assert.rejects(d.plan({ range: '10.0.0.5', mqttPorts: ['abc'] }), /not a port/);
  await assert.rejects(d.plan({ range: '10.0.0.5', mqttPorts: 'x' }), /list of port numbers/);
  await assert.rejects(d.plan({ range: '10.0.0.5', includeI3x: false, mqttPorts: [], opcuaPorts: [] }), /No ports selected/);
});

test('plan: counts, kinds, defaults and ETA are computed before anything is sent', async () => {
  const d = new DiscoveryService(recorder().io);
  const plan = await withFlags({ MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }, () => d.plan({ range: '10.1.2.0/24' }));
  assert.strictEqual(plan.hosts.length, 254);
  assert.deepStrictEqual(plan.ports, [1883, 8883, 4840, 50000, 80, 443, 8080]);
  assert.strictEqual(plan.totalProbes, 254 * 7);
  assert.deepStrictEqual(plan.settings, { concurrency: 32, perHost: 2, timeoutMs: 1200, identifyTimeoutMs: 3000 });
  assert.strictEqual(plan.estimate.worstCaseMs, Math.ceil((254 * 7) / 32) * 1200);
  const dev = await withFlags({ MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }, () => d.plan({ range: '10.1.2.0/24', includeDevices: true }));
  assert.deepStrictEqual(dev.ports, [1883, 8883, 4840, 50000, 80, 443, 8080, 502, 102, 44818]);
  // a port listed for two protocols is probed once
  const dup = await withFlags({ MANIFOLD_ALLOW_PRIVATE_TARGETS: '1' }, () => d.plan({ range: '10.1.2.3', includeI3x: false, mqttPorts: [5000], opcuaPorts: [5000], modbusPorts: [5000] }));
  assert.strictEqual(dup.totalProbes, 1);
  assert.deepStrictEqual(dup.jobs[0].kinds, ['mqtt', 'opcua', 'modbus']);
});

// ---- the scan, against real listeners ------------------------------------------------------

let lab;
before(async () => {
  lab = await startDiscoveryLab();
});
after(async () => {
  await lab.close();
});

test('without MANIFOLD_ALLOW_LOOPBACK_DEVICES a loopback scan is refused and sends nothing', async () => {
  const r = recorder();
  const d = new DiscoveryService(r.io);
  const before = lab.silent.stats.connections;
  await withFlags({}, async () => {
    await assert.rejects(d.startScan({ range: '127.0.0.1/32', modbusPorts: [lab.silent.port], includeI3x: false }), (e) => {
      assert.strictEqual(e.code, 'RANGE_REFUSED');
      assert.match(e.message, /MANIFOLD_ALLOW_LOOPBACK_DEVICES=1/);
      return true;
    });
  });
  assert.strictEqual(d.isScanning(), false);
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(lab.silent.stats.connections, before, 'no connection was opened');
});

test('a real scan identifies every protocol, reports each port once, writes nothing and leaks no socket', () =>
  loopbackOn(async () => {
    const r = recorder();
    const d = new DiscoveryService(r.io);
    const mbRequestsBefore = lab.modbus.stats.requests;
    const started = await d.startScan({
      range: '127.0.0.1/32',
      includeI3x: false,
      mqttPorts: [lab.mqttPort, lab.silent.port, lab.closedPort],
      mqttWsPorts: [lab.mqttWsPort],
      opcuaPorts: [lab.opcua.port, lab.silent.port],
      modbusPorts: [lab.modbus.port, lab.silent.port, lab.reset.port, lab.closedPort],
      s7Ports: [lab.s7.port, lab.silent.port],
      eipPorts: [lab.eip.port, lab.silent.port],
      identifyTimeoutMs: 800
    });
    assert.strictEqual(started.status, 'scanning');
    await assert.rejects(d.startScan({ range: '127.0.0.1/32' }), (e) => e.code === 'SCAN_RUNNING' && /already running/.test(e.message));
    await done(d);

    const results = d.getLastResults();
    const by = (port) => results.filter((x) => x.port === port);
    // each host:port exactly once
    assert.strictEqual(new Set(results.map((x) => `${x.host}:${x.port}`)).size, results.length);

    const mqttTcp = by(lab.mqttPort);
    assert.strictEqual(mqttTcp.length, 1);
    assert.deepStrictEqual([mqttTcp[0].kind, mqttTcp[0].protocol, mqttTcp[0].verified, mqttTcp[0].method], ['mqtt', 'mqtt', true, 'mqtt-connect']);
    assert.deepStrictEqual([mqttTcp[0].identity.transport, mqttTcp[0].identity.anonymousAccess], ['tcp', true]);
    assert.strictEqual(by(lab.mqttWsPort)[0].identity.transport, 'ws');
    assert.strictEqual(by(lab.mqttWsPort)[0].verified, true);

    const ua = by(lab.opcua.port)[0];
    // The fake answers the Hello but cannot do GetEndpoints: an OPC UA server, honestly unconfirmed
    // (the real server is verified in discovery-opcua-real.test.js).
    assert.deepStrictEqual([ua.kind, ua.verified, ua.method, ua.identity.accepted, ua.endpointUrl], ['opcua', false, 'ua-hello', true, `opc.tcp://127.0.0.1:${lab.opcua.port}`]);
    assert.match(ua.note, /Answered the OPC UA Hello, but GetEndpoints failed/);

    const mb = by(lab.modbus.port)[0];
    assert.deepStrictEqual([mb.kind, mb.protocol, mb.verified], ['modbus', 'modbus-tcp', true]);
    assert.match(mb.method, /^fc(43-device-id|3-register-read)$/);
    assert.deepStrictEqual(mb.suggestedDevice.port, lab.modbus.port);

    const s7 = by(lab.s7.port)[0];
    assert.deepStrictEqual([s7.protocol, s7.verified, s7.method, s7.identity.cotp], ['s7', true, 'cotp-connect+szl', 'CC']);
    assert.strictEqual(s7.identity.moduleTypeName, 'CPU 1516-3 PN/DP');
    assert.strictEqual(s7.identity.orderCode, '6ES7 516-3AN02-0AB0');
    assert.strictEqual(s7.identity.firmware, 'V2.9.4');
    assert.strictEqual(s7.identity.cpuState, 'RUN');
    assert.strictEqual(s7.suggestedDevice.name, 'CPU 1516-3 PN/DP 127.0.0.1');

    const eip = by(lab.eip.port)[0];
    assert.deepStrictEqual([eip.protocol, eip.verified, eip.method], ['ethernet-ip', true, 'list-identity']);
    assert.strictEqual(eip.identity.productName, '1769-L33ER/A LOGIX5333ER');
    assert.strictEqual(eip.identity.vendorId, 1);
    assert.strictEqual(eip.identity.vendor, 'Rockwell Automation / Allen-Bradley');
    assert.strictEqual(eip.identity.productCode, 166);
    assert.strictEqual(eip.identity.revision, '32.11');
    assert.strictEqual(eip.identity.serialNumber, '006c5f2a');
    assert.strictEqual(eip.identity.deviceTypeName, 'Programmable Logic Controller');
    assert.strictEqual(eip.identity.stateName, 'operational');

    // The silent port: open, never a device or an OPC UA server, at most an honestly labelled "open" MQTT guess.
    const silent = by(lab.silent.port);
    assert.strictEqual(silent.length, 1);
    assert.deepStrictEqual([silent[0].kind, silent[0].verified, silent[0].method], ['mqtt', false, 'tcp-connect']);
    assert.ok(!silent[0].suggestedDevice);
    // the resetting and the closed ports are not reported at all
    assert.strictEqual(by(lab.reset.port).length, 0);
    assert.strictEqual(by(lab.closedPort).length, 0);
    assert.strictEqual(results.filter((x) => x.suggestedDevice && x.port === lab.silent.port).length, 0);

    // Identification never writes: counters stay at zero and only reads / identification were sent.
    assert.deepStrictEqual(lab.writes(), { modbus: 0, s7: 0, eip: 0 });
    const modbusFcs = Object.keys(lab.modbus.stats.byFc).map(Number);
    assert.ok(modbusFcs.length > 0 && modbusFcs.every((fc) => fc === 3 || fc === 43), `unexpected Modbus function codes ${modbusFcs}`);
    assert.ok(lab.modbus.stats.requests > mbRequestsBefore);
    assert.strictEqual(lab.s7.stats.readVar, 0);
    assert.strictEqual(lab.eip.stats.registerSessions, 0); // ListIdentity needs no session

    // Every socket the scan opened is closed again.
    for (let i = 0; i < 30 && lab.totalOpen() > 0; i++) await sleep(50);
    assert.deepStrictEqual(lab.openSockets(), { modbus: 0, s7: 0, eip: 0, opcua: 0, silent: 0, tarpit: 0, reset: 0, mqtt: 0 });

    // Progress: monotonic, correct total, ends at the total.
    const progress = r.of('discovery-progress');
    assert.ok(progress.length >= 1);
    assert.ok(progress.every((p) => p.total === started.totalProbes));
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].completed >= progress[i - 1].completed, 'progress went backwards');
    assert.deepStrictEqual([progress.at(-1).completed, progress.at(-1).total], [started.totalProbes, started.totalProbes]);
    const complete = r.of('discovery-complete');
    assert.strictEqual(complete.length, 1);
    assert.deepStrictEqual([complete[0].status, complete[0].aborted, complete[0].found], ['complete', false, results.length]);
    // the unique ports behind totalProbes: the silent port is shared by four kinds but probed once
    const uniquePorts = new Set([lab.mqttPort, lab.silent.port, lab.closedPort, lab.mqttWsPort, lab.opcua.port, lab.modbus.port, lab.reset.port, lab.s7.port, lab.eip.port]);
    assert.strictEqual(started.totalProbes, uniquePorts.size);

    // Results persist until the next scan, and a new scan clears them.
    const state = d.getState();
    assert.strictEqual(state.scanning, false);
    assert.strictEqual(state.scan.status, 'complete');
    assert.strictEqual(state.results.length, results.length);
  }));

test('devices are never reported unless they answered, whatever the port does', () =>
  loopbackOn(async () => {
    const r = recorder();
    const d = new DiscoveryService(r.io);
    await d.startScan({ range: '127.0.0.1/32', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: [lab.silent.port, lab.reset.port, lab.tarpit.port], s7Ports: [lab.silent.port, lab.tarpit.port], eipPorts: [lab.reset.port], identifyTimeoutMs: 600 });
    await done(d);
    assert.deepStrictEqual(d.getLastResults(), []);
    for (let i = 0; i < 30 && lab.totalOpen() > 0; i++) await sleep(50);
    assert.strictEqual(lab.totalOpen(), 0);
  }));

test('the S7 identity read is optional: COTP only sends no SZL request', async () => {
  const before = lab.s7.stats.szlReads;
  const r = await deviceIdentify.identifyS7('127.0.0.1', lab.s7.port, { deep: false });
  assert.deepStrictEqual([r.method, r.identity.cotp, r.identity.accepted], ['cotp-connect', 'CC', true]);
  assert.strictEqual(lab.s7.stats.szlReads, before);
  lab.s7.faults.rejectCotp = true;
  try {
    const refused = await deviceIdentify.identifyS7('127.0.0.1', lab.s7.port);
    assert.deepStrictEqual([refused.identity.cotp, refused.identity.accepted], ['DR', false]);
    assert.strictEqual(refused.method, 'cotp-connect');
  } finally {
    lab.s7.faults.rejectCotp = false;
  }
  assert.strictEqual(lab.s7.stats.writesReceived + lab.s7.stats.controlReceived, 0);
});

test('Modbus identification: FC 43 first, FC 3 as fallback, and the driver allowlist is untouched', async () => {
  // the fixed FC 43 frame
  assert.strictEqual(deviceIdentify.encodeReadDeviceId().toString('hex'), '4d460000000501' + '2b0e0100');
  // the driver's own encoder still refuses everything but FC 1-4 (43 included)
  for (const fc of [5, 6, 15, 16, 22, 23, 43]) assert.throws(() => modbusFrame.encodeRequest({ tid: 1, unitId: 1, fc, address: 0, quantity: 1 }), modbusFrame.ModbusReadOnlyError, `fc ${fc}`);
  assert.deepStrictEqual([...modbusFrame.READ_FUNCTION_CODES].sort(), [1, 2, 3, 4]);

  // a device that answers FC 43
  const objects = [[0, 'Acme Controls'], [1, 'AC-1000'], [2, 'V1.4.2'], [4, 'Acme Pump Controller']];
  const withId = await fake((sock) => {
    sock.on('data', (req) => {
      const fc = req[7];
      if (fc !== 0x2b) return;
      const body = Buffer.concat(objects.map(([id, text]) => Buffer.concat([Buffer.from([id, text.length]), Buffer.from(text)])));
      const pdu = Buffer.concat([Buffer.from([0x2b, 0x0e, 0x01, 0x01, 0x00, 0x00, objects.length]), body]);
      const head = Buffer.alloc(7);
      req.copy(head, 0, 0, 2);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = req[6];
      sock.write(Buffer.concat([head, pdu]));
    });
  });
  try {
    const id = await deviceIdentify.identifyModbus('127.0.0.1', withId.port, { timeoutMs: 2000 });
    assert.strictEqual(id.method, 'fc43-device-id');
    assert.deepStrictEqual([id.identity.vendorName, id.identity.productCode, id.identity.revision, id.identity.productName], ['Acme Controls', 'AC-1000', 'V1.4.2', 'Acme Pump Controller']);
    const d = new DiscoveryService(recorder().io);
    const found = await d.identifyDevice('modbus', '127.0.0.1', withId.port, { timeoutMs: 2000 });
    assert.strictEqual(found.suggestedDevice.name, 'Acme Pump Controller 127.0.0.1');
  } finally {
    await withId.close();
  }

  // the shared simulator answers FC 43 with an exception, so FC 3 is what identifies it
  const sim = await deviceIdentify.identifyModbus('127.0.0.1', lab.modbus.port);
  assert.strictEqual(sim.method, 'fc3-register-read');
  assert.strictEqual(sim.identity.response, 'registers');
  assert.strictEqual(lab.modbus.stats.writesReceived, 0);
});

test('EtherNet/IP ListIdentity: identity fields come from the reply, not from a lookup', async () => {
  lab.eip.identity = { vendorId: 26, deviceType: 0x0c, productCode: 7, revMajor: 3, revMinor: 1, serial: 0x1234abcd, productName: 'Festo CPX-AP', state: 2 };
  try {
    const r = await deviceIdentify.identifyEip('127.0.0.1', lab.eip.port);
    assert.deepStrictEqual(
      [r.identity.vendorId, r.identity.vendor, r.identity.deviceTypeName, r.identity.productCode, r.identity.revision, r.identity.serialNumber, r.identity.productName, r.identity.stateName],
      [26, 'Festo', 'Communications Adapter', 7, '3.1', '1234abcd', 'Festo CPX-AP', 'standby']
    );
    lab.eip.identity = { vendorId: 9999, deviceType: 0x99 };
    const unknown = await deviceIdentify.identifyEip('127.0.0.1', lab.eip.port);
    assert.strictEqual(unknown.identity.vendorId, 9999);
    assert.strictEqual(unknown.identity.vendor, undefined);
    assert.strictEqual(unknown.identity.deviceTypeName, null);
  } finally {
    lab.eip.identity = undefined;
  }
  assert.strictEqual(lab.eip.stats.writesReceived, 0);
});

test('OPC UA: Hello is answered by ACK or ERR; anything else is not OPC UA', async () => {
  const ok = await deviceIdentify.identifyOpcua('127.0.0.1', lab.opcua.port);
  assert.strictEqual(ok.identity.accepted, true);
  const err = await fake((sock) => {
    sock.once('data', () => {
      const b = Buffer.alloc(16);
      b.write('ERRF', 0, 'latin1');
      b.writeUInt32LE(16, 4);
      b.writeUInt32LE(0x80660000, 8);
      sock.write(b);
    });
  });
  const junk = await fake((sock) => sock.once('data', () => sock.write('HTTP/1.1 400 Bad Request\r\n\r\n')));
  try {
    const e = await deviceIdentify.identifyOpcua('127.0.0.1', err.port);
    assert.deepStrictEqual([e.identity.accepted, e.identity.errorCode], [false, '0x80660000']);
    assert.strictEqual(await deviceIdentify.identifyOpcua('127.0.0.1', junk.port), null);
    assert.strictEqual(await deviceIdentify.identifyOpcua('127.0.0.1', lab.silent.port, { timeoutMs: 400 }), null);
  } finally {
    await err.close();
    await junk.close();
  }
});

test('an MQTT broker that requires credentials is still identified', () =>
  loopbackOn(async () => {
    const authed = await fake((sock) => {
      sock.once('data', () => sock.write(Buffer.from([0x20, 0x02, 0x00, 0x05]))); // CONNACK: not authorized
    });
    try {
      const d = new DiscoveryService(recorder().io);
      const r = await d.identifyMqttBroker('127.0.0.1', authed.port, { timeoutMs: 1500 });
      assert.deepStrictEqual([r.verified, r.identity.anonymousAccess], [true, false]);
    } finally {
      await authed.close();
    }
  }));

test('per-host limit: never more simultaneous connections to one IP than perHost', () =>
  loopbackOn(async () => {
    const tarpits = await Promise.all(Array.from({ length: 8 }, () => fake(() => {})));
    try {
      for (const perHost of [1, 2]) {
        const r = recorder();
        const d = new DiscoveryService(r.io);
        let peak = 0;
        const sampler = setInterval(() => {
          peak = Math.max(peak, tarpits.reduce((n, t) => n + t.open, 0));
        }, 5);
        await d.startScan({ range: '127.0.0.1/32', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: tarpits.map((t) => t.port), perHost, concurrency: 64, identifyTimeoutMs: 500, timeoutMs: 500 });
        await done(d);
        clearInterval(sampler);
        assert.ok(peak >= 1, 'the sampler saw connections');
        assert.ok(peak <= perHost, `perHost=${perHost} but ${peak} connections were open at once`);
        if (perHost === 2) assert.strictEqual(peak, 2, 'the limit is used, not just respected');
      }
    } finally {
      await Promise.all(tarpits.map((t) => t.close()));
    }
  }));

test('overall concurrency is bounded', () =>
  loopbackOn(async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => `127.0.1.${i + 1}`);
    const first = await fake(() => {}, hosts[0]);
    const servers = [first, ...(await Promise.all(hosts.slice(1).map((h) => fake(() => {}, h, first.port))))];
    try {
      const d = new DiscoveryService(recorder().io);
      // Count the engine's own sockets in flight (connect probe, then identification, one after the
      // other per job). The listeners' view lags: they see a close only after the kernel delivers it,
      // so under load they can briefly count sockets the scanner has already destroyed.
      let inFlight = 0;
      let peak = 0;
      const counted = (name) => {
        const real = d[name].bind(d);
        d[name] = async (...args) => {
          peak = Math.max(peak, ++inFlight);
          try {
            return await real(...args);
          } finally {
            inFlight--;
          }
        };
      };
      counted('probePort');
      counted('identifyDevice');
      await d.startScan({ range: '127.0.1.0/28', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: [first.port], concurrency: 4, perHost: 1, identifyTimeoutMs: 500, timeoutMs: 500 });
      await done(d);
      assert.ok(peak <= 4, `concurrency=4 but ${peak} open at once`);
      assert.ok(peak >= 3, `expected the scan to use its concurrency, saw ${peak}`);
    } finally {
      await Promise.all(servers.map((t) => t.close()));
    }
  }));

test('a /24 with tarpits finishes in the time the plan predicts', () =>
  loopbackOn(async () => {
    // Ten tarpit hosts inside 127.0.2.0/24, one port. Every other address refuses at once.
    const first = await fake(() => {}, '127.0.2.10');
    const tarpits = [first, ...(await Promise.all(Array.from({ length: 9 }, (_, i) => fake(() => {}, `127.0.2.${11 + i}`, first.port))))];
    try {
      const options = { range: '127.0.2.0/24', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: [first.port], concurrency: 8, perHost: 1, timeoutMs: 400, identifyTimeoutMs: 500 };
      const r = recorder();
      const d = new DiscoveryService(r.io);
      const plan = await d.plan(options);
      assert.strictEqual(plan.hosts.length, 254);
      const t0 = Date.now();
      await d.startScan(options);
      await done(d);
      const took = Date.now() - t0;
      const bound = plan.estimate.worstCaseMs + Math.ceil(tarpits.length / plan.estimate.slots) * plan.estimate.perOpenPortMs;
      assert.ok(took >= 480, `the tarpits must cost their identification timeout (took ${took} ms)`);
      assert.ok(took <= bound, `took ${took} ms, the plan promised at most ${bound} ms`);
      assert.deepStrictEqual(d.getLastResults(), [], 'a tarpit is not a device');
      assert.strictEqual(r.of('discovery-complete')[0].completed, 254);
      for (let i = 0; i < 30 && tarpits.some((t) => t.open > 0); i++) await sleep(50);
      assert.deepStrictEqual(tarpits.map((t) => t.open), Array(10).fill(0));
      // each tarpit saw exactly the connect probe and one identification attempt
      assert.ok(tarpits.every((t) => t.stats.connections === 2), JSON.stringify(tarpits.map((t) => t.stats.connections)));
    } finally {
      await Promise.all(tarpits.map((t) => t.close()));
    }
  }));

test('stop takes effect within a second, leaves no sockets, and a new scan can start straight away', () =>
  loopbackOn(async () => {
    const tarpits = await Promise.all(Array.from({ length: 6 }, () => fake(() => {})));
    try {
      const r = recorder();
      const d = new DiscoveryService(r.io);
      await d.startScan({ range: '127.0.0.1/32', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: tarpits.map((t) => t.port), perHost: 2, identifyTimeoutMs: 15000, timeoutMs: 5000 });
      await sleep(300);
      assert.ok(tarpits.some((t) => t.open > 0), 'connections are in flight');
      const t0 = Date.now();
      assert.deepStrictEqual(d.stopScan(), { status: 'stopping' });
      const complete = r.of('discovery-complete');
      assert.strictEqual(complete.length, 1);
      assert.deepStrictEqual([complete[0].status, complete[0].aborted], ['cancelled', true]);
      assert.strictEqual(d.isScanning(), false);
      for (let i = 0; i < 20 && tarpits.some((t) => t.open > 0); i++) await sleep(50);
      assert.ok(Date.now() - t0 < 1000, 'sockets gone within a second');
      assert.deepStrictEqual(tarpits.map((t) => t.open), Array(6).fill(0));
      assert.strictEqual(d.getState().scan.status, 'cancelled');
      // stop when idle is harmless
      assert.deepStrictEqual(d.stopScan(), { status: 'idle' });
      // and the next scan starts at once
      await d.startScan({ range: '127.0.0.1/32', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: [lab.closedPort] });
      await done(d);
      assert.strictEqual(d.getState().scan.status, 'complete');
      assert.deepStrictEqual(d.getLastResults(), []);
      // events from the cancelled scan never leak into the new one
      assert.strictEqual(r.of('discovery-complete').length, 2);
    } finally {
      await Promise.all(tarpits.map((t) => t.close()));
    }
  }));

test('results carry a server-side `known` marker for what Manifold already has', () =>
  loopbackOn(async () => {
    const index = {
      brokers: [{ id: 'b1', name: 'Plant broker', host: '127.0.0.1', port: lab.mqttPort }],
      opcua: [{ id: 'u1', name: 'Line OPC', endpointUrl: `opc.tcp://localhost:${lab.opcua.port}` }],
      i3x: { configured: false },
      devices: [{ id: 'dev1', name: 'Pump PLC', host: '127.0.0.1', port: lab.modbus.port }]
    };
    const r = recorder();
    const d = new DiscoveryService(r.io, { known: () => index });
    await d.startScan({ range: '127.0.0.1/32', includeI3x: false, mqttPorts: [lab.mqttPort, lab.silent.port], opcuaPorts: [lab.opcua.port], modbusPorts: [lab.modbus.port, lab.silent.port], s7Ports: [lab.s7.port] });
    await done(d);
    const results = d.getLastResults();
    const at = (port) => results.find((x) => x.port === port);
    assert.deepStrictEqual(at(lab.mqttPort).known, { kind: 'broker', id: 'b1', name: 'Plant broker' });
    assert.deepStrictEqual(at(lab.opcua.port).known, { kind: 'opcua', id: 'u1', name: 'Line OPC' });
    assert.deepStrictEqual(at(lab.modbus.port).known, { kind: 'device', id: 'dev1', name: 'Pump PLC' });
    assert.strictEqual(at(lab.s7.port).known, null);
    assert.strictEqual(at(lab.silent.port).known, null);
    // the same marker travels in the live result events
    const live = r.of('discovery-result').find((x) => x.port === lab.modbus.port);
    assert.strictEqual(live.known.id, 'dev1');
    // and is recomputed on read: once a device is added, the stored result says so
    index.devices.push({ id: 'dev2', name: 'Main PLC', host: '127.0.0.1', port: lab.s7.port });
    assert.strictEqual(d.getLastResults().find((x) => x.port === lab.s7.port).known.id, 'dev2');
  }));

// ---- i3X, against the repo's mock server -------------------------------------------------------

test('i3X identification against the mock i3X server (loopback is not probed in a scan)', async () => {
  const script = path.join(__dirname, '../../docker/i3x-mock/server.js');
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      const up = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/info' }, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false)));
      if (up) break;
      await sleep(100);
    }
    // The real I3xClient.probe goes through the guarded fetch (which never allows loopback), so this
    // test supplies the same probe contract over plain HTTP to exercise the engine's identification path.
    const probe = async (baseUrl) => {
      try {
        const res = await fetch(`${baseUrl}/info`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    };
    const d = new DiscoveryService(recorder().io, { i3x: { probe } });
    const found = await d.identifyI3xServer('127.0.0.1', port);
    assert.strictEqual(found.verified, true);
    assert.strictEqual(found.method, 'i3x-info');
    assert.strictEqual(found.serverName, 'Manifold Mock i3X');
    assert.strictEqual(found.baseUrl, `http://127.0.0.1:${port}`);
    // an open HTTP port that is not i3X is not reported
    const html = await fake((sock) => sock.once('data', () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi')));
    try {
      assert.strictEqual(await d.identifyI3xServer('127.0.0.1', html.port), null);
    } finally {
      await html.close();
    }

    // In a real scan, i3X is skipped on loopback (its client could not connect there) and the plan says so.
    const plan = await loopbackOn(() => d.plan({ range: '127.0.0.1/32', i3xPorts: [port], mqttPorts: [], opcuaPorts: [] }));
    assert.strictEqual(plan.totalProbes, 0);
    assert.ok(plan.notes.some((n) => /i3X is not probed on loopback/.test(n)));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('the lab ports are really free of leftovers', async () => {
  // a final tally over everything this file started
  for (let i = 0; i < 30 && lab.totalOpen() > 0; i++) await sleep(50);
  assert.strictEqual(lab.totalOpen(), 0);
  const probe = net.createServer();
  const p = await listen(probe);
  await closeServer(probe);
  assert.ok(p > 0);
});
