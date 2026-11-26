'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const matter = require('../drivers/matterserver');
const { READ_COMMANDS, encodeCommand, ReadOnlyViolation } = require('../drivers/matterserver/client');
const { parseAddress } = require('../drivers/matterserver/address');
const { convert, attributeDef } = require('../drivers/matterserver/clusters');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');
const { startMatterServerSimulator, defaultNodes } = require('./support/matterServerSimulator');

// Every command of the Matter Server API (python-matter-server APICommand, schema 11).
const ALL_API_COMMANDS = [
  'start_listening', 'diagnostics', 'server_info', 'get_nodes', 'get_node', 'commission_with_code', 'commission_on_network',
  'set_wifi_credentials', 'set_thread_dataset', 'open_commissioning_window', 'discover', 'interview_node', 'device_command',
  'remove_node', 'get_vendor_names', 'read_attribute', 'write_attribute', 'ping_node', 'get_node_ip_addresses',
  'import_test_node', 'check_node_update', 'update_node', 'set_default_fabric_label', 'set_acl_entry', 'set_node_binding',
];
const FORBIDDEN = ALL_API_COMMANDS.filter((c) => !READ_COMMANDS.includes(c));

const sims = [];
async function sim(o) {
  const s = await startMatterServerSimulator(o);
  sims.push(s);
  return s;
}
const cleanups = [];
test.after(async () => {
  for (const c of cleanups) await c();
  // No simulator, in any test, ever received a non-read command.
  for (const s of sims) {
    assert.deepEqual(s.violations, [], 'a non-read command reached the simulator');
    for (const c of s.commands) assert.ok(READ_COMMANDS.includes(c.command), `unexpected command ${c.command}`);
  }
  for (const s of sims) await s.close();
});

const TAGS = [
  { key: 'temp', address: '1/1/1026/0' },
  { key: 'tempByName', address: '1/1/TemperatureMeasurement/MeasuredValue' },
  { key: 'hum', address: '1/1/0x0405/0x0000' },
  { key: 'press', address: '1/1/1027/0' },
  { key: 'batt', address: '1/1/PowerSource/BatPercentRemaining' },
  { key: 'battV', address: '1/1/47/11' },
  { key: 'on', address: '2/1/OnOff/OnOff' },
  { key: 'level', address: '2/1/8/0' },
  { key: 'onLevel', address: '2/1/8/17' },
  { key: 'mired', address: '2/1/768/7' },
  { key: 'cieX', address: '2/1/768/3' },
  { key: 'vendor', address: '2/1/64512/1' },
  { key: 'product', address: '2/0/BasicInformation/ProductName' },
  { key: 'types', address: '1/1/Descriptor/DeviceTypeList' },
  { key: 'power', address: '3/1/ElectricalPowerMeasurement/ActivePower' },
  { key: 'volt', address: '3/1/144/4' },
  { key: 'energy', address: '3/1/145/1' },
  { key: 'energyOut', address: '3/1/145/2' },
  { key: 'door', address: '4/1/BooleanState/StateValue' },
  { key: 'thermo', address: '5/1/Thermostat/LocalTemperature' },
  { key: 'mode', address: '5/1/513/28' },
  { key: 'lock', address: '5/2/DoorLock/LockState' },
  { key: 'cover', address: '5/3/WindowCovering/CurrentPositionLiftPercent100ths' },
  { key: 'aq', address: '5/4/AirQuality/AirQuality' },
  { key: 'co2', address: '5/4/CarbonDioxideConcentrationMeasurement/MeasuredValue' },
  { key: 'occupied', address: '5/5/OccupancySensing/Occupancy' },
  { key: 'lux', address: '5/5/IlluminanceMeasurement/MeasuredValue' },
  { key: 'levelAsNumber', address: '2/1/6/0', type: 'number' },
  { key: 'missing', address: '9/1/6/0' },
  { key: 'absent', address: '2/1/6/16386' },
];

function device(s, extra = {}) {
  return {
    id: 'm1',
    name: 'Matter',
    protocol: 'matter-server',
    host: '127.0.0.1',
    port: s.port,
    path: '/ws',
    options: {},
    limits: { requestDeadlineMs: 1000, connectTimeoutMs: 1000 },
    pollGroups: [{ id: 'default', intervalMs: 200 }],
    tags: TAGS,
    ...extra,
  };
}

/** A runtime around the driver that records the latest sample per key and every state. */
function run(dev, deps) {
  const driver = matter.createDriver(dev, deps);
  const latest = {};
  const batches = [];
  const states = [];
  const rt = new DeviceRuntime({
    device: dev,
    driver,
    backoff: { initialMs: 50, maxMs: 200 },
    onSamples: (b) => {
      batches.push(b);
      for (const s of b.samples) latest[s.key] = s;
    },
    onState: (s) => states.push(s),
  });
  rt.start();
  cleanups.push(() => rt.stop());
  return { driver, rt, latest, batches, states };
}

async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('read-only: only the allow-listed read commands can be encoded', () => {
  assert.deepEqual([...READ_COMMANDS].sort(), ['diagnostics', 'get_node', 'get_nodes', 'read_attribute', 'server_info', 'start_listening']);
  for (const c of READ_COMMANDS) assert.doesNotThrow(() => encodeCommand(c, {}, '1'));
  for (const c of [...FORBIDDEN, 'ping_node', 'START_LISTENING', '', 'start_listening ', undefined, null, {}]) {
    assert.throws(() => encodeCommand(c, {}, '1'), ReadOnlyViolation, `${String(c)} must not encode`);
  }
});

test('read-only: no forbidden command name appears anywhere in the driver source', () => {
  const dirs = [path.join(__dirname, '../drivers/matterserver'), path.join(__dirname, '../drivers/common')];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const c of FORBIDDEN) assert.ok(!src.includes(`'${c}'`) && !src.includes(`"${c}"`), `${f} names ${c}`);
    }
  }
  // The session's request() is the only path to ws.send, and it always goes through encode().
  const session = fs.readFileSync(path.join(__dirname, '../drivers/common/wsJsonSession.js'), 'utf8');
  assert.equal(session.match(/\.send\(/g).length, 1);
  assert.match(session, /const text = this\.encode\(command/);
});

test('addresses: ids, hex and names; errors', () => {
  assert.deepEqual(parseAddress('5/1/TemperatureMeasurement/MeasuredValue'), { nodeId: 5, endpoint: 1, cluster: 1026, attribute: 0, path: '1/1026/0', address: '5/1/1026/0' });
  assert.equal(parseAddress('5/1/0x0402/0x0000').address, '5/1/1026/0');
  assert.equal(parseAddress('5/1/64512/7').path, '1/64512/7');
  assert.equal(parseAddress('5/1/64512/ClusterRevision').attribute, 0xfffd);
  assert.throws(() => parseAddress('5/1/Nope/0'), /unknown cluster/);
  assert.throws(() => parseAddress('5/1/OnOff/Nope'), /unknown attribute "Nope" in OnOff/);
  assert.throws(() => parseAddress('0/1/6/0'), /node id/);
  assert.throws(() => parseAddress('5/1/6'), /node\/endpoint/);
  assert.equal(matter.validateTag({ key: 'k', address: '5/1/6/0', type: 'float' }).ok, false);
  const ok = matter.validateTag({ key: 'k', address: '5/1/TemperatureMeasurement/MeasuredValue' });
  assert.equal(ok.normalized.unit, '°C');
  assert.equal(ok.normalized.resolvedType, 'float64');
});

test('scaling rules and null handling', () => {
  const d = (c, a) => attributeDef(c, a);
  assert.deepEqual(convert(d(0x402, 0), 2134), { ok: true, v: 21.34, type: 'float64' });
  assert.deepEqual(convert(d(0x402, 0), -50), { ok: true, v: -0.5, type: 'float64' });
  assert.deepEqual(convert(d(0x402, 0), null), { ok: false, reason: 'no value' });
  assert.equal(convert(d(0x400, 0), 1).v, 1);
  assert.equal(convert(d(0x400, 0), 0).v, 0);
  assert.deepEqual(convert(d(0x400, 0), 0xffff), { ok: false, reason: 'no value' });
  assert.equal(convert(d(0x406, 0), 3).v, true);
  assert.equal(convert(d(0x2f, 12), 200).v, 100);
  assert.equal(convert(d(0x91, 1), { energy: 5000 }).v, 5);
  assert.equal(convert(d(0x90, 8), '9007199254740993').type, 'float64'); // int64 sent as text
  assert.equal(convert(null, [1, 2]).v, '[1,2]');
});

test('connect reports server info; subscription delivers converted values with quality', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.latest.temp && r.latest.lux, 3000, 'initial values');
  assert.equal(r.rt.info.server, 'Matter Server');
  assert.equal(r.rt.info.schemaVersion, 11);
  assert.equal(r.rt.info.sdkVersion, '2025.7.0');
  assert.equal(r.rt.info.nodeCount, 5);
  assert.equal(r.rt.info.nodesAvailable, 4);
  const v = (k) => r.latest[k].v;
  assert.equal(v('temp'), 21.34);
  assert.equal(r.latest.temp.type, 'float64');
  assert.equal(v('tempByName'), 21.34);
  assert.equal(v('hum'), 45.2);
  assert.equal(v('press'), 101.3);
  assert.equal(v('batt'), 86);
  assert.equal(v('battV'), 3.01);
  assert.equal(v('on'), true);
  assert.equal(r.latest.on.type, 'bool');
  assert.equal(v('level'), 254);
  assert.equal(r.latest.level.type, 'int64');
  assert.equal(r.latest.onLevel.q, 0);
  assert.equal(r.latest.onLevel.qReason, 'no value');
  assert.equal(v('mired'), 366);
  assert.equal(v('cieX'), Math.round((24939 / 65536) * 1e9) / 1e9);
  assert.equal(v('vendor'), 'vendor specific');
  assert.equal(v('product'), 'Hue color lamp');
  assert.deepEqual(JSON.parse(v('types')), [{ 0: 770, 1: 2 }, { 0: 775, 1: 2 }, { 0: 773, 1: 2 }]);
  assert.equal(r.latest.types.type, 'string');
  assert.equal(v('power'), 287.65);
  assert.equal(v('volt'), 230.12);
  assert.equal(v('energy'), 12345.678);
  assert.equal(r.latest.energyOut.qReason, 'no value');
  assert.equal(r.latest.door.q, 0);
  assert.equal(r.latest.door.qReason, 'node unavailable');
  assert.equal(v('thermo'), 20.5);
  assert.equal(v('mode'), 4);
  assert.equal(v('lock'), 1);
  assert.equal(v('cover'), 50.25);
  assert.equal(v('aq'), 2);
  assert.equal(v('co2'), 612.5);
  assert.equal(v('occupied'), true);
  assert.ok(Math.abs(v('lux') - 149.968) < 0.001, 'lux = 10^((21761-1)/10000)');
  assert.equal(v('levelAsNumber'), 1);
  assert.equal(r.latest.missing.qReason, 'node not found');
  assert.equal(r.latest.absent.qReason, 'attribute not reported by the node');
  assert.equal(r.rt.getStatus().state, 'online');
});

test('events: attribute_updated (also fragmented), availability, node added/removed, node_event ignored', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.latest.temp);
  s.setAttribute(1, '1/1026/0', 2250);
  await until(() => r.latest.temp.v === 22.5, 2000, 'pushed update');
  assert.equal(r.latest.tempByName.v, 22.5);
  const pushed = r.batches.filter((b) => b.group === 'subscription').at(-1);
  assert.deepEqual(pushed.samples.map((x) => x.key).sort(), ['temp', 'tempByName']);
  s.sendFragmented({ event: 'attribute_updated', data: [1, '1/1029/0', 5000] });
  await until(() => r.latest.hum.v === 50, 2000, 'fragmented event');
  s.setAttribute(1, '1/1026/0', null);
  await until(() => r.latest.temp.qReason === 'no value');
  s.setAvailable(2, false);
  await until(() => r.latest.on.qReason === 'node unavailable');
  s.setAvailable(2, true);
  await until(() => r.latest.on.q === 192);
  s.removeNode(3);
  await until(() => r.latest.power.qReason === 'node not found');
  const n9 = defaultNodes()[1];
  s.addNode({ ...n9, node_id: 9 });
  await until(() => r.latest.missing.q === 192 && r.latest.missing.v === true);
  s.nodeEvent(2);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.rt.getStatus().state, 'online');
});

test('periodic resync repairs a change the event stream missed', async () => {
  const s = await sim();
  let tick;
  const timers = { setInterval: (fn) => ((tick = fn), { unref() {} }), clearInterval: () => {} };
  const r = run(device(s, { options: { resyncIntervalS: 60 }, pollGroups: [{ id: 'default', intervalMs: 60000 }] }), { timers });
  await until(() => r.latest.temp && tick);
  s.setSilently(1, '1/1026/0', 1000);
  const before = r.batches.length;
  tick();
  await until(() => r.latest.temp.v === 10, 2000, 'resync');
  const resyncBatch = r.batches.slice(before).find((b) => b.samples.some((x) => x.key === 'temp'));
  assert.deepEqual(resyncBatch.samples.map((x) => x.key).sort(), ['temp', 'tempByName'], 'resync pushes only what changed');
  assert.ok(s.commands.some((c) => c.command === 'get_nodes'));
});

test('browse: nodes -> endpoints -> clusters -> attributes with names, units and values', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.rt.getStatus().state === 'online');
  const roots = await r.rt.browse();
  assert.equal(roots.length, 5);
  assert.equal(roots[0].name, 'Node 1 - Eve Systems Balcony');
  assert.match(roots[3].name, /\(unavailable\)/);
  const eps = await r.rt.browse('node:1');
  assert.deepEqual(eps.map((e) => e.id), ['ep:1/0', 'ep:1/1']);
  assert.match(eps[1].name, /Temperature sensor, Humidity sensor, Pressure sensor/);
  const cls = await r.rt.browse('ep:1/1');
  assert.ok(cls.some((c) => c.name === 'TemperatureMeasurement (0x0402)'));
  const attrs = await r.rt.browse('cl:1/1/1026');
  const mv = attrs.find((a) => a.address === '1/1/1026/0');
  assert.equal(mv.kind, 'tag');
  assert.equal(mv.name, 'MeasuredValue (0x0000)');
  assert.equal(mv.meta.unit, '°C');
  assert.equal(mv.meta.value, 21.34);
  assert.equal(mv.meta.dataType, 'number');
  const co2 = (await r.rt.browse('cl:5/4/1037')).find((a) => a.address === '5/4/1037/0');
  assert.equal(co2.meta.unit, 'ppm', 'concentration unit from MeasurementUnit');
  const unknown = await r.rt.browse('cl:2/1/64512');
  assert.equal(unknown[0].name, 'Attribute (0x0001)');
  assert.equal(unknown[0].meta.dataType, 'string');
  const mode = (await r.rt.browse('cl:5/1/513')).find((a) => a.address === '5/1/513/28');
  assert.match(mode.meta.description, /4=Heat/);
  await assert.rejects(r.rt.browse('node:77'), /not known/);
  for (const a of [...attrs, co2, ...unknown, mode]) assert.equal(matter.validateTag({ key: 'k', address: a.address }).ok, true);
});

test('probe: live read_attribute on schema >= 9, cached value on older servers', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.rt.getStatus().state === 'online');
  const p = await r.rt.probe({ address: '1/1/TemperatureMeasurement/MeasuredValue' });
  assert.equal(p.source, 'live read');
  assert.equal(p.decodings.value, 21.34);
  assert.deepEqual(s.reads.at(-1), { node_id: 1, attribute_path: '1/1026/0' });

  const old = await sim({ schemaVersion: 8, minSupportedSchemaVersion: 5 });
  const r2 = run(device(old));
  await until(() => r2.rt.getStatus().state === 'online');
  assert.match(r2.rt.info.schemaNotes, /no read_attribute/);
  const p2 = await r2.rt.probe({ address: '1/1/1026/0' });
  assert.equal(p2.source, 'server cache');
  assert.equal(old.commands.filter((c) => c.command === 'read_attribute').length, 0);
});

test('schema: a newer server notes it; a server that requires a newer client is refused clearly', async () => {
  const newer = await sim({ schemaVersion: 14, minSupportedSchemaVersion: 9 });
  const d = matter.createDriver(device(newer));
  const info = await d.connect();
  assert.match(info.schemaNotes, /newer than the tested 11/);
  await d.close();
  const strict = await sim({ schemaVersion: 15, minSupportedSchemaVersion: 12 });
  const d2 = matter.createDriver(device(strict));
  await assert.rejects(d2.connect(), /requires clients of schema 12/);
  await d2.close();
});

test('malformed JSON, unknown shapes and oversized messages drop the connection; the runtime reconnects', async () => {
  const s = await sim();
  const r = run(device(s, { options: { maxMessageMB: 1 } }));
  await until(() => r.latest.temp && r.latest.temp.q === 192);
  for (const bad of ['{not json', '[1,2,3]', '{"foo":1}']) {
    const connections = s.connections;
    s.sendRaw(bad);
    await until(() => r.latest.temp.qReason === 'disconnected', 2000, `bad quality after ${bad}`);
    await until(() => s.connections > connections && r.latest.temp.q === 192, 3000, `reconnect after ${bad}`);
  }
  const connections = s.connections;
  s.sendOversized(1.5 * 1024 * 1024);
  await until(() => r.states.some((x) => /exceeds/.test(x.reason || '')), 2000, 'oversized refused');
  await until(() => s.connections > connections && r.latest.temp.q === 192, 3000, 'reconnect after oversized');
});

test('server restart and shutdown event: Bad quality, reconnect with backoff, values return', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.latest.temp && r.latest.temp.q === 192);
  s.dropAll();
  await until(() => r.latest.temp.qReason === 'disconnected');
  await until(() => r.latest.temp.q === 192, 3000, 'recovered');
  s.serverShutdown();
  await until(() => r.states.some((x) => /shutting down/.test(x.reason || '')));
  await until(() => r.latest.temp.q === 192, 3000, 'recovered after shutdown');
  assert.ok(r.rt.getStatus().connects >= 3);
});

test('no greeting, wrong path and token: clear connect errors', async () => {
  const silent = await sim({ noGreeting: true });
  await assert.rejects(matter.createDriver(device(silent, { limits: { connectTimeoutMs: 200 } })).connect(), /no greeting/);
  const tok = await sim({ requireToken: 's3cret' });
  await assert.rejects(matter.createDriver(device(tok)).connect(), /HTTP 401/);
  const d = matter.createDriver(device(tok, { authToken: 's3cret' }));
  const info = await d.connect();
  assert.equal(info.nodeCount, 5);
  assert.equal(tok.requests.at(-1).headers.authorization, 'Bearer s3cret');
  await d.close();
  await assert.rejects(matter.createDriver(device(tok, { path: '/nope', authToken: 's3cret' })).connect(), /404/);
});

test('wss with the certificate verified (CA) and refused without it', async () => {
  const { CERT } = require('./support/tlsFixture');
  const s = await sim({ tls: true });
  await assert.rejects(matter.createDriver(device(s, { host: 'localhost', pinned: { addresses: ['127.0.0.1'] }, scheme: 'wss' })).connect(), /certificate|self.signed/i);
  const d = matter.createDriver(device(s, { host: 'localhost', pinned: { addresses: ['127.0.0.1'] }, scheme: 'wss', tlsCa: CERT }));
  assert.equal((await d.connect()).nodeCount, 5);
  // Connected to the pinned address; Host header and certificate check use the configured name.
  assert.equal(s.requests.at(-1).headers.host, `localhost:${s.port}`);
  await d.close();
});

test('large installation: 400 nodes in one dump, 2000 tags, one cache read per poll', async () => {
  const nodes = [];
  for (let i = 1; i <= 400; i++) {
    const attrs = { '0/40/3': `Sensor ${i}`, '0/40/1': 'Acme' };
    for (let ep = 1; ep <= 5; ep++) {
      attrs[`${ep}/1026/0`] = 2000 + i;
      attrs[`${ep}/1029/0`] = 4000 + ep;
      for (let k = 0; k < 10; k++) attrs[`${ep}/64512/${k}`] = k;
    }
    nodes.push({ node_id: i, available: true, is_bridge: false, attributes: attrs, attribute_subscriptions: [] });
  }
  const s = await sim({ nodes });
  const tags = [];
  for (let i = 1; i <= 400; i++) for (let ep = 1; ep <= 5; ep++) tags.push({ key: `t${i}_${ep}`, address: `${i}/${ep}/1026/0` });
  const r = run(device(s, { tags }));
  await until(() => Object.keys(r.latest).length === 2000, 5000, 'all 2000 tags');
  assert.equal(r.latest.t400_5.v, 24);
  const plan = r.driver.plan(tags.map((t) => t.key));
  assert.equal(plan.length, 1);
  const before = s.commands.length;
  await new Promise((res) => setTimeout(res, 450));
  assert.equal(s.commands.length, before, 'polling reads the cache, not the server');
  s.setAttribute(400, '5/1026/0', 9999);
  await until(() => r.latest.t400_5.v === 99.99);
});
