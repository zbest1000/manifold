'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const zwave = require('../drivers/zwavejs');
const { READ_COMMANDS, encodeCommand, chooseSchema, ReadOnlyViolation } = require('../drivers/zwavejs/client');
const { parseValueId, formatValueId, convertValue } = require('../drivers/zwavejs/values');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');
const { startZwaveJsServerSimulator } = require('./support/zwaveJsServerSimulator');

// Commands of @zwave-js/server that change the network, transmit on the radio or change the driver.
const FORBIDDEN = [
  'node.set_value', 'node.poll_value', 'node.refresh_info', 'node.refresh_values', 'node.refresh_cc_values', 'node.ping',
  'node.set_raw_config_parameter_value', 'node.get_raw_config_parameter_value', 'node.begin_firmware_update', 'node.update_firmware',
  'node.interview', 'node.interview_cc', 'node.set_name', 'node.set_location', 'node.set_keep_awake', 'node.wait_for_wakeup',
  'node.check_lifeline_health', 'node.check_route_health', 'node.test_powerlevel', 'node.set_date_and_time', 'node.get_date_and_time',
  'node.manually_idle_notification_value', 'node.set_default_volume', 'node.check_link_reliability',
  'controller.begin_inclusion', 'controller.stop_inclusion', 'controller.begin_exclusion', 'controller.stop_exclusion',
  'controller.remove_failed_node', 'controller.replace_failed_node', 'controller.begin_healing_network', 'controller.heal_node',
  'controller.begin_rebuilding_routes', 'controller.rebuild_node_routes', 'controller.firmware_update_ota', 'controller.firmware_update_otw',
  'controller.hard_reset', 'controller.provision_smart_start_node', 'controller.set_rf_region', 'controller.toggle_rf',
  'driver.set_log_level', 'driver.update_log_config', 'driver.enable_statistics', 'driver.hard_reset', 'driver.soft_reset',
  'driver.shutdown', 'driver.update_options', 'driver.install_config_update', 'broadcast_node.set_value', 'multicast_group.set_value',
  'endpoint.invoke_cc_api', 'endpoint.set_raw_config_parameter_value', 'initialize', 'start_listening_logs',
];

const sims = [];
async function sim(o) {
  const s = await startZwaveJsServerSimulator(o);
  sims.push(s);
  return s;
}
const cleanups = [];
test.after(async () => {
  for (const c of cleanups) await c();
  for (const s of sims) {
    assert.deepEqual(s.violations, [], 'a non-read command reached the simulator');
    for (const c of s.commands) assert.ok(READ_COMMANDS.includes(c.command), `unexpected command ${c.command}`);
  }
  for (const s of sims) await s.close();
});

const TAGS = [
  { key: 'temp', address: '2/49/0/Air temperature' },
  { key: 'tempByName', address: '2/Multilevel Sensor/0/Air temperature' },
  { key: 'hum', address: '2/0x31/0/Humidity' },
  { key: 'motion', address: '2/113/0/Home Security/Motion sensor status' },
  { key: 'overcurrent', address: '2/113/0/Power Management/Over-current%2Fvoltage status' },
  { key: 'battery', address: '2/128/0/level' },
  { key: 'low', address: '2/128/0/isLow' },
  { key: 'param3', address: '2/112/0/3' },
  { key: 'param101', address: '2/112/0/101/32' },
  { key: 'switch', address: '3/37/0/currentValue' },
  { key: 'up', address: '3/38/0/Up' },
  { key: 'duration', address: '3/38/0/duration' },
  { key: 'kwh', address: '3/50/0/value/65537' },
  { key: 'watt', address: '3/Meter/0/value/66049' },
  { key: 'fw', address: '3/134/0/firmwareVersions' },
  { key: 'code', address: '3/99/0/userCode/1' },
  { key: 'lock', address: '4/98/0/currentMode' },
  { key: 'ch1', address: '5/38/1/currentValue' },
  { key: 'ch2', address: '5/38/2/currentValue' },
  { key: 'switchAsNumber', address: '3/37/0/currentValue', type: 'number' },
  { key: 'missingNode', address: '9/37/0/currentValue' },
  { key: 'missingValue', address: '3/37/0/nope' },
];

function device(s, extra = {}) {
  return {
    id: 'z1',
    name: 'Z-Wave',
    protocol: 'zwave-js',
    host: '127.0.0.1',
    port: s.port,
    options: {},
    limits: { requestDeadlineMs: 1000, connectTimeoutMs: 1000 },
    pollGroups: [{ id: 'default', intervalMs: 200 }],
    tags: TAGS,
    ...extra,
  };
}

function run(dev, deps) {
  const driver = zwave.createDriver(dev, deps);
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

test('read-only: only the allow-listed cache-read commands can be encoded', () => {
  assert.deepEqual([...READ_COMMANDS].sort(), ['node.get_defined_value_ids', 'node.get_value', 'node.get_value_metadata', 'set_api_schema', 'start_listening']);
  for (const c of READ_COMMANDS) assert.doesNotThrow(() => encodeCommand(c, {}, '1'));
  for (const c of [...FORBIDDEN, 'Node.Get_Value', 'node.get_value ', '', null, undefined, 42]) {
    assert.throws(() => encodeCommand(c, {}, '1'), ReadOnlyViolation, `${String(c)} must not encode`);
  }
  // Arguments cannot smuggle in a different command or message id.
  const text = encodeCommand('node.get_value', { command: 'node.set_value', messageId: 'x', nodeId: 2 }, 'm7');
  assert.deepEqual(JSON.parse(text), { messageId: 'm7', command: 'node.get_value', nodeId: 2 });
});

test('read-only: no forbidden command name appears in the driver source', () => {
  for (const dir of [path.join(__dirname, '../drivers/zwavejs'), path.join(__dirname, '../drivers/common')]) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const c of FORBIDDEN) assert.ok(!src.includes(`'${c}'`) && !src.includes(`"${c}"`), `${f} names ${c}`);
    }
  }
});

test('value ids: parse, names, hex, encoded slashes, numeric keys', () => {
  const a = parseValueId('2/Multilevel Sensor/0/Air temperature');
  assert.equal(a.address, '2/49/0/Air temperature');
  assert.deepEqual(a.valueId, { commandClass: 49, endpoint: 0, property: 'Air temperature' });
  assert.deepEqual(parseValueId('12/0x70/0/3/255').valueId, { commandClass: 112, endpoint: 0, property: 3, propertyKey: 255 });
  const s = parseValueId('2/113/0/Power Management/Over-current%2Fvoltage status');
  assert.equal(s.propertyKey, 'Over-current/voltage status');
  assert.equal(formatValueId(2, s.valueId), '2/113/0/Power Management/Over-current%2Fvoltage status');
  assert.throws(() => parseValueId('2/Nope/0/x'), /unknown command class/);
  assert.throws(() => parseValueId('0/37/0/x'), /node id/);
  assert.throws(() => parseValueId('2/37/200/x'), /endpoint/);
  assert.throws(() => parseValueId('2/37/0'), /node\/commandClass/);
  assert.equal(zwave.validateTag({ key: 'k', address: '2/37/0/currentValue', type: 'int' }).ok, false);
  assert.equal(zwave.validateTag({ key: 'k', address: '2/37/0/currentValue' }).normalized.commandClassName, 'Binary Switch');
});

test('schema negotiation', () => {
  assert.equal(chooseSchema({ minSchemaVersion: 0, maxSchemaVersion: 44 }).schema, 44);
  const newer = chooseSchema({ minSchemaVersion: 0, maxSchemaVersion: 52 });
  assert.equal(newer.schema, 44);
  assert.match(newer.notes[0], /offers schema 52/);
  const old = chooseSchema({ minSchemaVersion: 0, maxSchemaVersion: 13 });
  assert.equal(old.canGetValue, false);
  assert.throws(() => chooseSchema({ minSchemaVersion: 50, maxSchemaVersion: 52 }), /requires schema 50/);
  assert.throws(() => chooseSchema({ minSchemaVersion: 0, maxSchemaVersion: 2 }), /needs 3 or newer/);
  assert.deepEqual(convertValue({ type: 'duration' }, { value: 2, unit: 'minutes' }), { ok: true, v: 120, type: 'float64' });
  assert.equal(convertValue({ type: 'duration' }, { value: 0, unit: 'default' }).ok, false);
});

test('connect reports versions and counts; values with sleeping/dead semantics', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.latest.temp && r.latest.ch2, 3000, 'initial values');
  const info = r.rt.info;
  assert.equal(info.server, 'Z-Wave JS Server');
  assert.equal(info.serverVersion, '3.0.0');
  assert.equal(info.driverVersion, '15.0.0');
  assert.equal(info.homeId, '0xdeadbeef');
  assert.equal(info.schemaVersion, 44);
  assert.equal(info.nodeCount, 5);
  assert.equal(info.nodesAsleep, 1);
  assert.equal(info.nodesDead, 1);
  assert.deepEqual(s.schemas, [44]);
  const L = r.latest;
  assert.deepEqual([L.temp.v, L.temp.q, L.temp.qReason, L.temp.type], [21.5, 192, 'sleeping', 'float64'], 'asleep node: last value, Good, noted');
  assert.equal(L.tempByName.v, 21.5);
  assert.equal(L.hum.v, 48);
  assert.equal(L.motion.v, 8);
  assert.equal(L.motion.type, 'int64');
  assert.equal(L.overcurrent.v, 0);
  assert.equal(L.battery.v, 87);
  assert.equal(L.low.v, false);
  assert.equal(L.low.type, 'bool');
  assert.equal(L.param3.v, 240);
  assert.equal(L.param101.v, 241);
  assert.deepEqual([L.switch.v, L.switch.q, L.switch.qReason], [true, 192, undefined]);
  assert.equal(L.up.q, 0);
  assert.equal(L.up.qReason, 'value is write-only');
  assert.equal(L.duration.v, 5);
  assert.equal(L.kwh.v, 12.34);
  assert.equal(L.watt.v, 150.5);
  assert.equal(L.fw.v, '["1.4","2.0"]');
  assert.equal(L.code.v, '0102ff');
  assert.equal(L.lock.q, 0);
  assert.equal(L.lock.qReason, 'node dead');
  assert.equal(L.ch1.v, 99);
  assert.equal(L.ch2.v, 0);
  assert.equal(L.switchAsNumber.v, 1);
  assert.equal(L.missingNode.qReason, 'node not found');
  assert.equal(L.missingValue.qReason, 'value not reported by the node');
});

test('events: value updated/added/removed/notification, metadata, status changes, node added/removed', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.latest.temp);
  s.valueUpdated(2, { commandClass: 49, endpoint: 0, property: 'Air temperature' }, 23.25);
  await until(() => r.latest.temp.v === 23.25, 2000, 'value updated');
  const pushed = r.batches.filter((b) => b.group === 'subscription').at(-1);
  assert.deepEqual(pushed.samples.map((x) => x.key).sort(), ['temp', 'tempByName']);
  s.nodeStatus(2, 'wake up');
  await until(() => r.latest.temp.qReason === undefined && r.latest.temp.q === 192, 2000, 'awake');
  s.nodeStatus(2, 'sleep');
  await until(() => r.latest.temp.qReason === 'sleeping');
  s.nodeStatus(4, 'alive');
  await until(() => r.latest.lock.q === 192 && r.latest.lock.v === 255);
  s.nodeStatus(3, 'dead');
  await until(() => r.latest.switch.qReason === 'node dead');
  s.nodeStatus(3, 'alive');
  await until(() => r.latest.switch.q === 192);
  s.valueRemoved(3, { commandClass: 50, endpoint: 0, property: 'value', propertyKey: 66049 });
  await until(() => r.latest.watt.qReason === 'value not reported by the node');
  s.valueAdded(3, { commandClass: 37, endpoint: 0, property: 'nope', value: 'hello', metadata: { type: 'string', readable: true } });
  await until(() => r.latest.missingValue.v === 'hello');
  s.metadataUpdated(3, { commandClass: 37, endpoint: 0, property: 'nope' }, { type: 'string', readable: false });
  await until(() => r.latest.missingValue.qReason === 'value is write-only');
  s.valueNotification(2, { commandClass: 113, endpoint: 0, property: 'Home Security', propertyKey: 'Motion sensor status' }, 0);
  await until(() => r.latest.motion.v === 0);
  s.sendFragmented({ source: 'node', event: 'value updated', nodeId: 2, args: { commandClass: 128, endpoint: 0, property: 'level', newValue: 50 } });
  await until(() => r.latest.battery.v === 50, 2000, 'fragmented event');
  s.statistics(3);
  s.nodeRemoved(5);
  await until(() => r.latest.ch1.qReason === 'node not found');
  s.nodeAdded({ nodeId: 9, status: 4, ready: true, values: [{ commandClass: 37, endpoint: 0, property: 'currentValue', value: false, metadata: { type: 'boolean', readable: true } }] });
  await until(() => r.latest.missingNode.q === 192 && r.latest.missingNode.v === false);
});

test('resync re-reads tagged values from the server cache with node.get_value', async () => {
  const s = await sim();
  let tick;
  const timers = { setInterval: (fn) => ((tick = fn), { unref() {} }), clearInterval: () => {} };
  const r = run(device(s, { options: { resyncIntervalS: 60 }, pollGroups: [{ id: 'default', intervalMs: 60000 }] }), { timers });
  await until(() => r.latest.switch && tick);
  s.setSilently(3, { commandClass: 37, endpoint: 0, property: 'currentValue' }, false);
  const before = r.batches.length;
  tick();
  await until(() => r.latest.switch.v === false, 2000, 'resync');
  const changed = r.batches.slice(before).flatMap((b) => b.samples.map((x) => x.key));
  assert.deepEqual([...new Set(changed)].sort(), ['switch', 'switchAsNumber']);
  const gets = s.commands.filter((c) => c.command === 'node.get_value');
  assert.ok(gets.length >= 15);
  assert.ok(gets.every((g) => g.args.valueId && Number.isInteger(g.args.nodeId)));
});

test('old schema (13): no node.get_value, no resync, notes say so', async () => {
  const s = await sim({ maxSchemaVersion: 13 });
  const r = run(device(s, { options: { resyncIntervalS: 1 } }));
  await until(() => r.latest.switch);
  assert.match(r.rt.info.schemaNotes, /no node\.get_value/);
  const p = await r.rt.probe({ address: '3/37/0/currentValue' });
  assert.equal(p.decodings.value, true);
  assert.match(p.source, /event stream/);
  assert.equal(s.commands.filter((c) => c.command === 'node.get_value').length, 0);
});

test('server requiring a newer schema is refused with a clear message', async () => {
  const s = await sim({ minSchemaVersion: 50, maxSchemaVersion: 52 });
  const d = zwave.createDriver(device(s));
  await assert.rejects(d.connect(), /requires schema 50/);
  await d.close();
});

test('browse: nodes -> command classes -> readable values with metadata', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.rt.getStatus().state === 'online');
  const roots = await r.rt.browse();
  assert.equal(roots.length, 5);
  assert.match(roots[0].name, /controller/);
  assert.equal(roots[1].name, 'Node 2 - Hall sensor Aeotec ZW100 (asleep)');
  assert.match(roots[3].name, /\(dead\)/);
  const ccs = await r.rt.browse('node:3');
  assert.deepEqual(ccs.map((c) => c.name), ['Binary Switch (0x25)', 'Multilevel Switch (0x26)', 'Meter (0x32)', 'User Code (0x63)', 'Manufacturer Specific (0x72)', 'Version (0x86)']);
  const ml = await r.rt.browse('cc:3/38');
  assert.deepEqual(ml.map((v) => v.address), ['3/38/0/duration'], 'write-only "Up" is not offered');
  const meter = await r.rt.browse('cc:3/50');
  assert.equal(meter[0].address, '3/50/0/value/65537');
  assert.equal(meter[0].meta.unit, 'kWh');
  assert.equal(meter[0].meta.dataType, 'number');
  assert.equal(meter[0].meta.value, 12.34);
  const notif = await r.rt.browse('cc:2/113');
  const motion = notif.find((v) => v.address === '2/113/0/Home Security/Motion sensor status');
  assert.deepEqual(motion.meta.states, { 0: 'idle', 8: 'Motion detection' });
  assert.equal(motion.meta.note, 'node is asleep: last reported value');
  assert.ok(notif.some((v) => v.address === '2/113/0/Power Management/Over-current%2Fvoltage status'));
  const sw = await r.rt.browse('cc:5/38');
  assert.deepEqual(sw.map((v) => v.name), ['Current value (endpoint 1)', 'Current value (endpoint 2)']);
  for (const v of [...meter, ...notif, ...sw, ...ml]) assert.equal(zwave.validateTag({ key: 'k', address: v.address }).ok, true, v.address);
});

test('probe reads cached value and metadata; never a radio command', async () => {
  const s = await sim();
  const r = run(device(s));
  await until(() => r.rt.getStatus().state === 'online');
  const p = await r.rt.probe({ address: '2/49/0/Air temperature' });
  assert.equal(p.decodings.value, 21.5);
  assert.equal(p.decodings.unit, '°C');
  assert.equal(p.nodeStatus, 'asleep');
  assert.ok(s.commands.some((c) => c.command === 'node.get_value_metadata'));
});

test('malformed and oversized messages, dropped connection and driver restart: Bad, reconnect, values back', async () => {
  const s = await sim();
  const r = run(device(s, { options: { maxMessageMB: 1 } }));
  await until(() => r.latest.switch && r.latest.switch.q === 192);
  const cycle = async (act, what) => {
    const n = s.connections;
    act();
    await until(() => r.latest.switch.qReason === 'disconnected', 2000, `bad after ${what}`);
    await until(() => s.connections > n && r.latest.switch.q === 192, 3000, `reconnect after ${what}`);
  };
  await cycle(() => s.sendRaw('{"type":"event","event":'), 'truncated JSON');
  await cycle(() => s.sendRaw('{"type":"mystery"}'), 'unknown message');
  await cycle(() => s.sendOversized(1.2 * 1024 * 1024), 'oversized');
  await cycle(() => s.dropAll(), 'drop');
  await cycle(() => s.driverReady(), 'driver restart');
  assert.ok(r.states.some((x) => /driver restarted/.test(x.reason || '')));
});

test('token header and wss verification', async () => {
  const { CERT } = require('./support/tlsFixture');
  const tok = await sim({ requireToken: 'abc' });
  await assert.rejects(zwave.createDriver(device(tok)).connect(), /401/);
  const d = zwave.createDriver(device(tok, { authToken: 'abc' }));
  assert.equal((await d.connect()).nodeCount, 5);
  await d.close();
  const tls = await sim({ tls: true });
  const base = { host: 'localhost', pinned: { addresses: ['127.0.0.1'] }, scheme: 'wss' };
  await assert.rejects(zwave.createDriver(device(tls, base)).connect(), /certificate|self.signed/i);
  const ok = zwave.createDriver(device(tls, { ...base, tlsCa: CERT }));
  assert.equal((await ok.connect()).nodeCount, 5);
  await ok.close();
});

test('large network: 230 nodes x 40 values, 3000 tags, one cache read per poll', async () => {
  const nodes = [];
  for (let id = 2; id < 232; id++) {
    const values = [];
    for (let k = 0; k < 40; k++) values.push({ commandClass: 49, commandClassName: 'Multilevel Sensor', endpoint: k % 4, property: `S${k}`, value: id + k / 10, metadata: { type: 'number', readable: true, unit: 'x' } });
    nodes.push({ nodeId: id, status: 4, ready: true, values });
  }
  const s = await sim({ nodes });
  const tags = [];
  for (let id = 2; id < 77; id++) for (let k = 0; k < 40; k++) tags.push({ key: `n${id}_${k}`, address: `${id}/49/${k % 4}/S${k}` });
  const r = run(device(s, { tags, options: { resyncIntervalS: 0 } }));
  await until(() => Object.keys(r.latest).length === 3000, 5000, '3000 tags');
  assert.equal(r.latest.n76_39.v, 79.9);
  assert.equal(r.driver.plan(tags.map((t) => t.key)).length, 1);
  const before = s.commands.length;
  await new Promise((res) => setTimeout(res, 450));
  assert.equal(s.commands.length, before, 'polling reads the local state, not the server');
});
