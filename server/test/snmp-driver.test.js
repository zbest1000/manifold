'use strict';

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');

const snmp = require('../drivers/snmp');
const msg = require('../drivers/snmp/message');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');
const { UdpTransport } = require('../drivers/runtime/udpTransport');
const { identifySnmp } = require('../drivers/snmp/identify');
const { startSnmpSimulator, ENT } = require('./support/snmpSimulator');

// ── outgoing-datagram spy: everything any non-simulator socket sends ───────
const simSockets = new Set();
const outgoing = [];
const origSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function spy(buf, ...rest) {
  if (!simSockets.has(this) && Buffer.isBuffer(buf)) outgoing.push(Buffer.from(buf));
  return origSend.call(this, buf, ...rest);
};

const sims = [];
async function startSim(opts) {
  const sim = await startSnmpSimulator(opts);
  simSockets.add(sim.socket);
  simSockets.add(sim.foreign);
  sims.push(sim);
  return sim;
}
const drivers = [];
function makeDriver(sim, extra = {}) {
  const d = snmp.createDriver({
    id: 'agent1',
    host: '127.0.0.1',
    port: sim.port,
    version: '2c',
    limits: { requestDeadlineMs: 600, connectTimeoutMs: 1500 },
    tags: [],
    ...extra,
  });
  drivers.push(d);
  return d;
}
async function readAll(driver, deadline = 600) {
  const out = {};
  for (const req of driver.plan()) {
    const res = await driver.execute(req, deadline);
    if (!res.ok) return res;
    for (const s of res.results) out[s.key] = s;
  }
  return out;
}

test.after(async () => {
  for (const d of drivers) await d.close().catch(() => {});
  for (const s of sims) await s.close();
  dgram.Socket.prototype.send = origSend;
});

const USERS = [];
for (const authProtocol of ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512']) {
  USERS.push({ name: `an-${authProtocol}`, level: 'authNoPriv', authProtocol, authPassword: `auth-${authProtocol}-pw` });
  for (const privProtocol of ['des', 'aes']) {
    USERS.push({ name: `ap-${authProtocol}-${privProtocol}`, level: 'authPriv', authProtocol, authPassword: `auth-${authProtocol}-pw`, privProtocol, privPassword: `priv-${privProtocol}-pw` });
  }
}
USERS.push({ name: 'plain', level: 'noAuthNoPriv' });
const v3For = (u, over = {}) => ({
  version: '3',
  securityName: u.name,
  securityLevel: u.level,
  authProtocol: u.authProtocol,
  authPassword: u.authPassword,
  privProtocol: u.privProtocol,
  privPassword: u.privPassword,
  ...over,
});

const TYPED_TAGS = [
  { key: 'descr', address: 'sysDescr.0' },
  { key: 'objectId', address: 'sysObjectID.0' },
  { key: 'uptime', address: 'sysUpTime.0' },
  { key: 'mac', address: 'ifPhysAddress.1' },
  { key: 'speed', address: 'ifSpeed.1' },
  { key: 'inOctets', address: 'ifInOctets.1' },
  { key: 'hcIn', address: 'ifHCInOctets.1' },
  { key: 'ip', address: '1.3.6.1.2.1.4.20.1.1.192.168.1.10' },
  { key: 'neg', address: `${ENT}.1.0` },
  { key: 'float', address: `${ENT}.2.0` },
  { key: 'double', address: `${ENT}.3.0` },
  { key: 'opaqueRaw', address: `${ENT}.4.0` },
  { key: 'binary', address: `${ENT}.5.0` },
  { key: 'utf8', address: `${ENT}.8.0` },
  { key: 'gaugeMax', address: `${ENT}.9.0` },
  { key: 'c64max', address: `${ENT}.10.0` },
  { key: 'padded', address: `${ENT}.11.0` },
  { key: 'binaryAsText', address: `${ENT}.5.0`, encoding: 'hex' },
  { key: 'noObject', address: `${ENT}.99.0` },
  { key: 'noInstance', address: 'ifOperStatus.7' },
];

test('v2c: every data type reads with the right sample type, exceptions are Bad with a reason', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, { tags: TYPED_TAGS });
  const info = await d.connect();
  assert.equal(info.sysName, 'sim-agent');
  assert.equal(info.sysObjectID, '1.3.6.1.4.1.8072.3.2.10');
  assert.equal(info.version, 'v2c');
  const r = await readAll(d);
  const vt = (k) => [r[k].v, r[k].type, r[k].q];
  assert.deepEqual(vt('descr'), ['Manifold SNMP simulator', 'string', 192]);
  assert.deepEqual(vt('objectId'), ['1.3.6.1.4.1.8072.3.2.10', 'string', 192]);
  assert.equal(r.uptime.type, 'uint32');
  assert.deepEqual(vt('mac'), ['00:1a:2b:3c:4d:5e', 'string', 192]);
  assert.deepEqual(vt('speed'), [1000000000, 'uint32', 192]);
  assert.deepEqual(vt('inOctets'), [1000, 'uint32', 192]);
  assert.deepEqual(vt('hcIn'), [String(1099511627776n + 12345n), 'uint64', 192]);
  assert.deepEqual(vt('ip'), ['192.168.1.10', 'string', 192]);
  assert.deepEqual(vt('neg'), [-42, 'int32', 192]);
  assert.deepEqual(vt('float'), [21.5, 'float32', 192]);
  assert.deepEqual(vt('double'), [1234.5678, 'float64', 192]);
  assert.deepEqual(vt('opaqueRaw'), ['01:02:03', 'string', 192]);
  assert.deepEqual(vt('binary'), ['00:ff:10', 'string', 192]);
  assert.deepEqual(vt('utf8'), ['Température', 'string', 192]);
  assert.deepEqual(vt('gaugeMax'), [4294967295, 'uint32', 192]);
  assert.deepEqual(vt('c64max'), ['18446744073709551615', 'uint64', 192]);
  assert.deepEqual(vt('padded'), ['padded', 'string', 192]);
  assert.deepEqual(vt('binaryAsText'), ['00:ff:10', 'string', 192]);
  assert.equal(r.noObject.q, 0);
  assert.equal(r.noObject.qReason, 'noSuchObject');
  assert.equal(r.noInstance.qReason, 'noSuchInstance');
});

test('v1: an agent that answers noSuchName + error-index loses only that varbind; the OID is then skipped', async () => {
  const sim = await startSim({ versions: [0] });
  const d = makeDriver(sim, {
    version: '1',
    tags: [
      { key: 'name', address: 'sysName.0' },
      { key: 'hc', address: 'ifHCInOctets.1' }, // Counter64 is invisible to v1 (RFC 3584)
      { key: 'missing', address: `${ENT}.99.0` },
      { key: 'neg', address: `${ENT}.1.0` },
    ],
  });
  await d.connect();
  const before = sim.stats.requests.length;
  let r = await readAll(d);
  assert.equal(r.name.v, 'sim-agent');
  assert.equal(r.neg.v, -42);
  assert.equal(r.hc.qReason, 'noSuchName');
  assert.equal(r.missing.qReason, 'noSuchName');
  assert.equal(sim.stats.requests.length - before, 3, 'one request, then one per dropped varbind');
  const again = sim.stats.requests.length;
  r = await readAll(d);
  assert.equal(r.hc.qReason, 'noSuchName');
  assert.equal(sim.stats.requests.length - again, 1, 'known-missing OIDs are not asked again within the retry period');
  assert.deepEqual(d._state().skipped.sort(), [`${ENT}.99.0`, '1.3.6.1.2.1.31.1.1.1.6.1'].sort());
  // v1 never sends GetBulk
  assert.ok(!sim.stats.pduTypes.includes(0xa5));
});

test('v3: every authentication and privacy combination reads through USM', async () => {
  const sim = await startSim({ users: USERS });
  for (const u of USERS) {
    const d = makeDriver(sim, { ...v3For(u), tags: [{ key: 'name', address: 'sysName.0' }, { key: 'hc', address: 'ifHCInOctets.1' }] });
    const info = await d.connect();
    assert.equal(info.engineId, sim.engineId.toString('hex'), u.name);
    const r = await readAll(d);
    assert.equal(r.name.v, 'sim-agent', u.name);
    assert.equal(r.hc.type, 'uint64', u.name);
    await d.close();
  }
  const levels = new Set(sim.stats.v3Levels);
  for (const l of ['noAuthNoPriv', 'authNoPriv', 'authPriv']) assert.ok(levels.has(l), l);
});

test('v3: wrong user, wrong passwords and a level the user lacks fail with clear messages', async () => {
  const sim = await startSim({ users: USERS });
  const sha = USERS.find((u) => u.name === 'ap-sha-aes');
  const cases = [
    [{ ...v3For(sha), securityName: 'nobody' }, /does not know this user name/],
    [{ ...v3For(sha), authPassword: 'not-the-password' }, /authentication failed: wrong authentication password/],
    [{ ...v3For(sha), authProtocol: 'md5' }, /authentication failed/],
    [{ ...v3For(sha), privPassword: 'not-the-password' }, /could not decrypt the request: wrong privacy password/],
    [{ ...v3For(USERS.find((u) => u.name === 'an-sha')), securityLevel: 'authPriv', privProtocol: 'aes', privPassword: 'whatever1' }, /does not support the requested security level/],
  ];
  for (const [cfg, re] of cases) {
    const d = makeDriver(sim, { ...cfg, tags: [{ key: 'name', address: 'sysName.0' }] });
    await assert.rejects(d.connect(), (err) => {
      assert.match(err.message, re);
      for (const secret of [cfg.authPassword, cfg.privPassword].filter(Boolean)) assert.ok(!err.message.includes(secret), 'no password in the message');
      return true;
    });
  }
});

test('v3: an agent reboot (boots+1) and a clock jump resynchronise inside one request', async () => {
  const sim = await startSim({ users: USERS });
  const u = USERS.find((x) => x.name === 'ap-sha256-aes');
  const d = makeDriver(sim, { ...v3For(u), tags: [{ key: 'name', address: 'sysName.0' }] });
  await d.connect();
  assert.equal((await readAll(d)).name.v, 'sim-agent');
  sim.reboot();
  const before = sim.stats.reports.notInTimeWindows || 0;
  assert.equal((await readAll(d, 1500)).name.v, 'sim-agent');
  assert.equal(sim.stats.reports.notInTimeWindows, before + 1, 'one notInTimeWindows report, then success');
  assert.equal(d._state().session.engine.boots, sim.engineBoots);
  sim.timeOffsetS = 1000; // agent clock jumps forward
  assert.equal((await readAll(d, 1500)).name.v, 'sim-agent');
});

test('v3: an unauthenticated notInTimeWindows report does not move the clock', async () => {
  const sim = await startSim({ users: USERS });
  const u = USERS.find((x) => x.name === 'an-sha256');
  const d = makeDriver(sim, { ...v3For(u), tags: [{ key: 'name', address: 'sysName.0' }] });
  await d.connect();
  const before = { ...d._state().session.engine };
  sim.fault.unauthTimeReports = true;
  sim.reboot();
  const res = await readAll(d, 1000);
  assert.equal(res.ok, false);
  assert.match(res.message, /outside the agent's time window/);
  assert.equal(d._state().session.engine.boots, before.boots, 'the forged-looking report was not believed');
  sim.fault.unauthTimeReports = false;
});

test('v3: responses outside the time window are discarded (replay protection)', async () => {
  const sim = await startSim({ users: USERS });
  const u = USERS.find((x) => x.name === 'an-sha');
  const d = makeDriver(sim, { ...v3For(u), tags: [{ key: 'name', address: 'sysName.0' }], options: { retries: 0 } });
  await d.connect();
  await readAll(d);
  const session = d._state().session;
  // Pretend we already saw a much later engine time: the agent's (honest) answers now look like replays.
  session.engine.latest += 1000;
  session.engine.time += 1000;
  const res = await readAll(d, 400);
  assert.equal(res.ok, false);
  assert.ok(session.stats.outOfWindow >= 1);
});

test('v3: a changed engine ID (agent replaced) is learned from the unknownEngineIDs report', async () => {
  const sim = await startSim({ users: USERS });
  const u = USERS.find((x) => x.name === 'ap-md5-des');
  const d = makeDriver(sim, { ...v3For(u), tags: [{ key: 'name', address: 'sysName.0' }] });
  await d.connect();
  sim.engineId = Buffer.from('80001f8880deadbeefcafe0001', 'hex');
  sim.reboot();
  assert.equal((await readAll(d, 2000)).name.v, 'sim-agent');
  assert.equal(d._state().session.engine.id.toString('hex'), '80001f8880deadbeefcafe0001');
});

test('timeouts and retries: a lost datagram is resent; silence is a fatal timeout', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, { tags: [{ key: 'name', address: 'sysName.0' }], options: { retries: 2 } });
  await d.connect();
  sim.fault.dropNext = 2;
  assert.equal((await readAll(d, 900)).name.v, 'sim-agent', 'third attempt answered');
  assert.ok(d._state().session.stats.retries >= 2);
  sim.fault.dropAll = true;
  const res = await d.execute(d.plan()[0], 300);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'timeout');
  assert.equal(res.fatal, true);
  assert.match(res.message, /no answer from 127\.0\.0\.1:\d+ after 3 attempts/);
  sim.fault.dropAll = false;
});

test('wrong request ids, garbage and duplicate datagrams are ignored; the real answer still counts', async () => {
  const sim = await startSim({ users: USERS });
  sim.fault.wrongIdFirst = true;
  sim.fault.garbageFirst = true;
  const d = makeDriver(sim, { tags: [{ key: 'name', address: 'sysName.0' }] });
  await d.connect();
  assert.equal((await readAll(d)).name.v, 'sim-agent');
  const st = d._state().session.stats;
  assert.ok(st.stale >= 1, 'wrong request id ignored');
  assert.ok(st.malformed >= 1, 'garbage ignored');
  const u = USERS.find((x) => x.name === 'ap-sha-aes');
  const v3 = makeDriver(sim, { ...v3For(u), tags: [{ key: 'name', address: 'sysName.0' }] });
  await v3.connect();
  assert.equal((await readAll(v3)).name.v, 'sim-agent');
  sim.fault.wrongIdFirst = false;
  sim.fault.garbageFirst = false;
});

test('answers from another source address are rejected unless allowAnySource is set', async () => {
  const sim = await startSim();
  sim.fault.foreignSource = true;
  const strict = makeDriver(sim, { tags: [{ key: 'name', address: 'sysName.0' }], options: { retries: 0 }, limits: { requestDeadlineMs: 300, connectTimeoutMs: 400 } });
  await assert.rejects(strict.connect(), /no answer/);
  const loose = makeDriver(sim, { tags: [{ key: 'name', address: 'sysName.0' }], options: { allowAnySource: true } });
  await loose.connect();
  assert.equal((await readAll(loose)).name.v, 'sim-agent');
  assert.ok(loose._state().session.transport.stats.foreign >= 1);
  sim.fault.foreignSource = false;
});

test('UDP transport: unconnected mode filters by source; hostnames and blocked targets are refused', async () => {
  const sim = await startSim();
  const t = new UdpTransport({ address: '127.0.0.1', port: sim.port, allowAnySource: false });
  await t.open();
  t.close();
  await assert.rejects(new UdpTransport({ address: 'agent.example', port: 161 }).open(), /literal IP address/);
  await assert.rejects(new UdpTransport({ address: '127.0.0.1', port: 161, isAllowed: () => false }).open(), /blocked by policy/);
  const d = makeDriver(sim, { tags: [] });
  // A device whose name was never pinned by the main process cannot connect to a hostname.
  const named = snmp.createDriver({ host: 'agent.example', port: sim.port, tags: [] });
  await assert.rejects(named.connect(), /literal IP address/);
  // Pinned: the driver talks to the pinned address, not the name.
  const pinned = snmp.createDriver({ host: 'agent.example', pinned: { addresses: ['127.0.0.1'] }, port: sim.port, tags: [{ key: 'n', address: 'sysName.0' }], limits: { requestDeadlineMs: 500, connectTimeoutMs: 1000 } });
  drivers.push(pinned);
  await pinned.connect();
  assert.equal((await readAll(pinned)).n.v, 'sim-agent');
  await d.close();
});

test('an unreachable port fails fast with a clear message', async () => {
  const probe = dgram.createSocket('udp4');
  await new Promise((r) => probe.bind(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r)); // nothing listens there now
  const d = snmp.createDriver({ host: '127.0.0.1', port, tags: [], limits: { requestDeadlineMs: 3000, connectTimeoutMs: 3000 } });
  const started = Date.now();
  await assert.rejects(d.connect(), /unreachable|no answer/);
  assert.ok(Date.now() - started < 2900, 'ICMP port unreachable ends the wait early');
});

test('tooBig: batches split and the smaller size is remembered; an oversized value alone is Bad', async () => {
  const sim = await startSim({ maxResponseSize: 400 });
  const tags = Array.from({ length: 2 }, (_, i) => ({ key: `if${i + 1}`, address: `ifDescr.${i + 1}` }));
  for (let i = 0; i < 30; i++) {
    sim.set(`${ENT}.50.${i}`, 'OctetString', `value-${String(i).padStart(3, '0')}`);
    tags.push({ key: `s${i}`, address: `${ENT}.50.${i}` });
  }
  tags.push({ key: 'huge', address: `${ENT}.7.0` });
  const d = makeDriver(sim, { tags, options: { maxMessageSize: 65507, maxVarbinds: 100 }, limits: { requestDeadlineMs: 2000, connectTimeoutMs: 1500 } });
  await d.connect();
  const r = await readAll(d, 2000);
  for (let i = 0; i < 30; i++) assert.equal(r[`s${i}`].v, `value-${String(i).padStart(3, '0')}`);
  assert.equal(r.huge.q, 0);
  assert.equal(r.huge.qReason, 'tooBig');
  const learned = d._state().learnedMaxVarbinds;
  assert.ok(learned < 33, `learned ${learned}`);
  const n = sim.stats.requests.length;
  await readAll(d, 2000);
  const second = sim.stats.requests.length - n;
  assert.ok(second < 10, `the second cycle uses the learned size (${second} requests)`);
});

test('genErr: with an error-index the varbind is dropped, without one the batch is halved to find it', async () => {
  const sim = await startSim();
  const tags = Array.from({ length: 8 }, (_, i) => ({ key: `t${i}`, address: `${ENT}.60.${i}` }));
  for (let i = 0; i < 8; i++) sim.set(`${ENT}.60.${i}`, 'Integer32', i * 10);
  sim.fault.genErrOids.add(`${ENT}.60.5`);
  const d = makeDriver(sim, { tags });
  await d.connect();
  let r = await readAll(d);
  assert.equal(r.t5.qReason, 'genErr');
  assert.equal(r.t4.v, 40);
  sim.fault.genErrIndexZero = true;
  const d2 = makeDriver(sim, { tags });
  await d2.connect();
  r = await readAll(d2);
  assert.equal(r.t5.qReason, 'genErr');
  for (const i of [0, 1, 2, 3, 4, 6, 7]) assert.equal(r[`t${i}`].v, i * 10);
  sim.fault.genErrOids.clear();
});

test('large tag sets: 400 tags are planned into PDUs of at most maxVarbinds and all read Good', async () => {
  const sim = await startSim();
  const tags = [];
  for (let i = 0; i < 400; i++) {
    sim.set(`${ENT}.70.${i}`, 'Counter32', i);
    tags.push({ key: `c${i}`, address: `${ENT}.70.${i}` });
  }
  const d = makeDriver(sim, { tags, options: { maxVarbinds: 25 } });
  await d.connect();
  const plan = d.plan();
  assert.ok(plan.every((p) => p.oids.length <= 25));
  assert.equal(plan.reduce((n, p) => n + p.items.length, 0), 400);
  const r = await readAll(d, 1000);
  assert.equal(Object.keys(r).length, 400);
  assert.ok(Object.values(r).every((s) => s.q === 192));
  assert.equal(r.c399.v, 399);
});

test('rate tags: per-second rate from two polls, sysUpTime rides along in the same PDU', async () => {
  const sim = await startSim();
  const oid = '1.3.6.1.2.1.2.2.1.10.1';
  sim.set(oid, 'Counter32', 4294967000);
  const d = makeDriver(sim, { tags: [{ key: 'inRate', address: 'ifInOctets.1', rate: true }, { key: 'uptime', address: 'sysUpTime.0' }] });
  await d.connect();
  const plan = d.plan();
  assert.equal(plan[0].oids[0], '1.3.6.1.2.1.1.3.0');
  assert.deepEqual(plan[0].items.map((i) => i.key).sort(), ['inRate', 'uptime']);
  let r = await readAll(d);
  assert.equal(r.inRate.qReason, 'rate-warmup');
  assert.equal(r.uptime.q, 192);
  sim.upTimeOffset += 1000; // the agent's clock advances 10 s
  sim.set(oid, 'Counter32', 704); // wrapped: +1000 octets
  r = await readAll(d);
  assert.equal(r.inRate.q, 192);
  assert.ok(Math.abs(r.inRate.v - 100) < 2, `rate ${r.inRate.v}`);
  assert.equal(r.inRate.type, 'float64');
  sim.reboot(); // sysUpTime restarts: discontinuity
  r = await readAll(d);
  assert.equal(r.inRate.qReason, 'counter-reset');
});

test('browse: roots, a bounded GetBulk walk with continuation, GetNext on v1', async () => {
  const sim = await startSim({ versions: [0, 1] });
  const d = makeDriver(sim, { tags: [], options: { browseMaxRows: 4, maxRepetitions: 3 } });
  await d.connect();
  const roots = await d.browse();
  assert.ok(roots.some((n) => n.id === 'walk:1.3.6.1.2.1.1' && n.kind === 'folder'));
  const page1 = await d.browse('walk:1.3.6.1.2.1.1');
  assert.equal(page1.filter((n) => n.kind === 'tag').length, 4);
  assert.equal(page1[0].address, 'sysDescr.0');
  assert.equal(page1[0].meta.dataType, 'OctetString');
  const more = page1[page1.length - 1];
  assert.equal(more.kind, 'folder');
  assert.match(more.id, /^walk:1\.3\.6\.1\.2\.1\.1@1\.3\.6\.1\.2\.1\.1\.4\.0$/);
  const page2 = await d.browse(more.id);
  assert.deepEqual(page2.filter((n) => n.kind === 'tag').map((n) => n.address), ['sysName.0', 'sysLocation.0', 'sysServices.0']);
  assert.ok(sim.stats.pduTypes.includes(0xa5), 'v2c walks with GetBulk');
  const v1 = makeDriver(sim, { version: '1', tags: [] });
  await v1.connect();
  const before = sim.stats.requests.length;
  const all = await v1.browse('walk:1.3.6.1.2.1.1');
  assert.equal(all.length, 7);
  assert.ok(sim.stats.requests.slice(before).every((q) => q.type === 0xa1), 'v1 walks with GetNext');
  await assert.rejects(d.browse('nonsense'), /unknown browse node/);
});

test('probe: one Get with raw bytes and decodings', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, { tags: [] });
  await d.connect();
  const p = await d.probe({ address: 'sysDescr.0' });
  assert.equal(p.type, 'OctetString');
  assert.equal(p.decodings.value, 'Manifold SNMP simulator');
  assert.equal(p.rawHex, Buffer.from('Manifold SNMP simulator').toString('hex'));
  const t = await d.probe({ address: '1.3.6.1.2.1.1.3.0' });
  assert.equal(t.type, 'TimeTicks');
  assert.match(t.decodings.duration, /^\d+d \d+h \d+m \d+s$/);
  const missing = await d.probe({ address: `${ENT}.99.0` });
  assert.equal(missing.decodings.exception, 'noSuchObject');
});

test('scale and offset apply to numeric values only', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, {
    tags: [
      { key: 'tenths', address: 'ifInOctets.1', scale: 0.1, offset: 1 },
      { key: 'big', address: 'ifHCInOctets.1', scale: 2 },
      { key: 'text', address: 'sysName.0', scale: 2 },
    ],
  });
  await d.connect();
  const r = await readAll(d);
  assert.deepEqual([r.tenths.v, r.tenths.type], [101, 'float64']);
  assert.deepEqual([r.big.v, r.big.type], [2 * Number(1099511627776n + 12345n), 'float64']);
  assert.deepEqual([r.text.v, r.text.type], ['sim-agent', 'string']);
  assert.match(snmp.validateTag({ key: 'x', address: 'sysUpTime.0', scale: 'a' }).error, /scale must be a finite number/);
});

test('runtime: the device goes offline when the agent stops answering and recovers by itself', async () => {
  const sim = await startSim();
  const device = { id: 'rt', host: '127.0.0.1', port: sim.port, version: '2c', options: { retries: 0 }, limits: { requestDeadlineMs: 200, connectTimeoutMs: 300 }, pollGroups: [{ id: 'fast', intervalMs: 100 }], tags: [{ key: 'name', address: 'sysName.0', pollGroup: 'fast' }] };
  const driver = snmp.createDriver(device);
  const states = [];
  const samples = [];
  const rt = new DeviceRuntime({ device, driver, backoff: { initialMs: 50, maxMs: 100 }, onState: (s) => states.push(s.state), onSamples: (b) => samples.push(...b.samples) });
  rt.start();
  const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out');
  };
  await until(() => samples.some((s) => s.key === 'name' && s.q === 192));
  sim.fault.dropAll = true;
  await until(() => states[states.length - 1] === 'offline' && samples.some((s) => s.qReason === 'disconnected'));
  sim.fault.dropAll = false;
  const n = samples.length;
  await until(() => states[states.length - 1] === 'online' && samples.slice(n).some((s) => s.q === 192));
  await rt.stop();
});

test('discovery probe: one v2c Get identifies an agent; silence and a wrong community find nothing', async () => {
  const sim = await startSim();
  const before = sim.stats.received;
  const found = await identifySnmp('127.0.0.1', sim.port, { timeoutMs: 1000 });
  assert.equal(found.protocol, 'snmp');
  assert.equal(found.identity.sysName, 'sim-agent');
  assert.equal(found.identity.productName, 'sim-agent');
  assert.equal(sim.stats.received - before, 1, 'exactly one datagram');
  const other = await startSim({ communities: ['secret-community'] });
  assert.equal(await identifySnmp('127.0.0.1', other.port, { timeoutMs: 300 }), null);
  assert.equal(other.stats.badCommunity, 1);
});

test('read-only: nothing but GetRequest, GetNextRequest and GetBulkRequest ever left the driver', () => {
  const allowed = new Set([0xa0, 0xa1, 0xa5]);
  for (const s of sims) for (const t of s.stats.pduTypes) assert.ok(allowed.has(t), `agent received PDU 0x${t.toString(16)}`);
  let decoded = 0;
  for (const buf of outgoing) {
    let m;
    try {
      m = msg.decodeMessage(buf);
    } catch {
      continue;
    }
    const pdu = m.pdu || (m.scoped && m.scoped.pdu);
    if (!pdu) continue; // encrypted v3: covered by the agent-side record above
    decoded++;
    assert.ok(allowed.has(pdu.type), `driver sent PDU 0x${pdu.type.toString(16)}`);
    assert.ok(pdu.varbinds.every((v) => v.tag === 0x05), 'every outgoing value is NULL');
  }
  assert.ok(decoded > 50, `checked ${decoded} outgoing messages`);
});
