const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const express = require('express');
const { EventEmitter } = require('events');

const { DeviceManager, DeviceValidationError } = require('../services/deviceManager');
const { TagBindings } = require('../services/tagBindings');
const { lintTrie } = require('../services/unsLint');
const metricsExporter = require('../services/metricsExporter');
const deviceIdentify = require('../services/deviceIdentify');
const DiscoveryService = require('../services/discovery');
const TopicTrie = require('../services/topicTrie');

// Phase 4 REST surface: device profiles/instances, bindings save warnings and
// preview; plus lint, metrics and read-only device discovery.

function memoryProfiles() {
  const data = { devices: {}, bindings: {}, deviceProfiles: {}, historians: {} };
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

let server;
let base;
let ctx;

before(async () => {
  const profiles = memoryProfiles();
  const mqtt = new EventEmitter();
  mqtt.all = [];
  mqtt.publish = async (brokerId, topic, payload, opts) => mqtt.all.push({ brokerId, topic, payload, opts });
  const devices = new DeviceManager({ profiles, guard: async () => {} }); // never started: no host processes
  const bindings = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null });
  bindings.registerSource('device', devices);
  bindings.start();
  const app = express();
  app.use(express.json());
  app.locals.services = { profiles, devices, bindings, sparkplugPublisher: { getStatus: () => ({}) } };
  app.use('/api/devices', require('../routes/devices'));
  app.use('/api/tags', require('../routes/tags'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx = { profiles, mqtt, devices, bindings };
});

after(async () => {
  ctx.bindings.stop();
  await ctx.devices.stop();
  await new Promise((r) => server.close(r));
});

const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

const PROFILE = {
  name: 'Power meter',
  protocol: 'modbus-tcp',
  params: [{ name: 'base', default: 100 }, { name: 'line', description: 'line id' }],
  tags: [
    { key: 'kw', address: 'holding:{base}', type: 'float32', property: 'activePower', unit: 'kW', range: { min: 0, max: 500 } },
    { key: 'pf', address: 'holding:2', type: 'float32', property: 'powerFactor' }
  ]
};

test('device profiles: CRUD, instantiate, effective tags, atomic re-apply, 409 on delete', async () => {
  let r = await api('POST', '/api/devices/profiles', { ...PROFILE, tags: [{ key: 'x', address: 'holding:{nope}', type: 'uint16' }] });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.details[0].error, /undeclared parameter/);

  r = await api('POST', '/api/devices/profiles', PROFILE);
  assert.strictEqual(r.status, 201);
  const pid = r.body.id;

  r = await api('POST', `/api/devices/profiles/${pid}/instantiate`, { name: 'Meter A', host: '10.0.0.7', params: { line: 'l1' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const devA = r.body;
  assert.deepStrictEqual(devA.tags, [], 'stored device keeps only ad-hoc tags');
  r = await api('POST', `/api/devices/profiles/${pid}/instantiate`, { name: 'Meter B', host: '10.0.0.8', params: { line: 'l2', base: 200 }, tags: [{ key: 'extra', address: 'holding:9', type: 'uint16' }] });
  assert.strictEqual(r.status, 201);
  const devB = r.body;

  // missing required param
  r = await api('POST', `/api/devices/profiles/${pid}/instantiate`, { name: 'Bad', host: '10.0.0.9' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.details[0].error, /parameter "line" is required/);

  // ad-hoc key conflicting with a profile key: explicit error, not override
  r = await api('PUT', `/api/devices/${devA.id}`, { ...devA, tags: [{ key: 'kw', address: 'holding:50', type: 'float32' }] });
  assert.strictEqual(r.status, 400);
  assert.match(JSON.stringify(r.body.details), /conflicts with a tag of profile/);

  r = await api('GET', '/api/devices');
  const a = r.body.devices.find((d) => d.id === devA.id);
  const b = r.body.devices.find((d) => d.id === devB.id);
  assert.strictEqual(a.profileId, pid);
  assert.deepStrictEqual(a.tags.map((t) => [t.key, t.address, t.origin]), [['kw', 'holding:100', 'profile'], ['pf', 'holding:2', 'profile']]);
  assert.deepStrictEqual(b.tags.map((t) => t.key), ['kw', 'pf', 'extra']);
  assert.strictEqual(b.tags[0].address, 'holding:200');
  assert.strictEqual(b.status.tagCount, 3);

  // echoing GET back on PUT keeps working (profile tags are not turned into ad-hoc ones)
  r = await api('PUT', `/api/devices/${devB.id}`, { ...b, name: 'Meter B2' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.tags.map((t) => t.key), ['extra']);

  // profile edit applies to every instance; an edit that would break one is rejected whole
  r = await api('PUT', `/api/devices/profiles/${pid}`, { ...PROFILE, tags: [...PROFILE.tags, { key: 'extra', address: 'holding:3', type: 'uint16' }] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.details.length, 1);
  assert.strictEqual(r.body.details[0].deviceId, devB.id);
  r = await api('GET', `/api/devices/profiles/${pid}`);
  assert.strictEqual(r.body.tags.length, 2, 'nothing saved');
  assert.strictEqual(r.body.instances.length, 2);

  r = await api('PUT', `/api/devices/profiles/${pid}`, { ...PROFILE, tags: PROFILE.tags.map((t) => (t.key === 'pf' ? { ...t, address: 'holding:4' } : t)) });
  assert.strictEqual(r.status, 200);
  assert.ok(ctx.devices.effectiveTags(devA.id).some((t) => t.key === 'pf' && t.address === 'holding:4'));
  assert.ok(ctx.devices.effectiveTags(devB.id).some((t) => t.key === 'pf' && t.address === 'holding:4'));
  await assert.doesNotReject(ctx.devices.ensureMonitored(devA.id, 'kw'));

  r = await api('DELETE', `/api/devices/profiles/${pid}`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.instances.length, 2);
  ctx.state = { pid, devA, devB };
});

test('bindings: profile binding save returns warnings; preview is read-only', async () => {
  const { pid, devA } = ctx.state;
  let r = await api('POST', '/api/tags/bindings', {
    id: 'pb',
    name: 'meters',
    source: { type: 'device-profile', profileId: pid, tags: ['kw', 'pf'] },
    target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPathTemplate: 'acme/{line}/{device}' }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.warnings, []);
  assert.strictEqual(ctx.profiles.getIn('bindings', 'pb').warnings, undefined, 'warnings are not stored');

  r = await api('POST', '/api/tags/bindings', {
    source: { type: 'device-profile', profileId: pid, tags: ['kw'] },
    target: { mode: 'mqtt', brokerId: 'br', assetPathTemplate: 'acme/{nope}' }
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /unknown placeholder/);

  // a second binding on the same topics + a raw-address name: saved, with warnings
  r = await api('POST', '/api/tags/bindings', {
    id: 'dup',
    source: { type: 'device', deviceId: devA.id, tags: [{ address: 'kw', name: 'activePower' }, { address: 'pf', name: 'DB10.DBD4' }] },
    target: { mode: 'mqtt', brokerId: 'br', assetPath: 'acme/l1/Meter_A' }
  });
  assert.strictEqual(r.status, 201);
  assert.ok(r.body.warnings.some((w) => w.type === 'collision' && w.topic === 'acme/l1/Meter_A/activePower'));
  assert.ok(r.body.warnings.some((w) => w.type === 'raw-address'));

  const before = ctx.mqtt.all.length;
  r = await api('POST', '/api/tags/bindings/preview', {
    source: { type: 'device-profile', profileId: pid, tags: 'all' },
    target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPathTemplate: 'acme/{line}/{device}' }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.valid, true);
  assert.strictEqual(r.body.units, 2);
  assert.strictEqual(r.body.totalTags, 4);
  const kw = r.body.tags.find((t) => t.topic === 'acme/l1/Meter_A/activePower');
  assert.deepStrictEqual({ v: kw.payload.v, q: kw.payload.q, u: kw.payload.u }, { v: null, q: 0, u: 'kW' });
  assert.ok(kw.collisions.some((c) => c.id === 'pb') && kw.collisions.some((c) => c.id === 'dup'));
  assert.ok(r.body.meta[0].payload.properties.activePower);

  r = await api('POST', '/api/tags/bindings/preview', {
    source: { type: 'device-profile', profileId: pid, tags: 'all' },
    target: { mode: 'mqtt', brokerId: 'br', assetPathTemplate: 'acme/{line}/{device}', layout: 'object-per-asset' }
  });
  assert.strictEqual(r.body.objects.length, 2);
  assert.ok(r.body.objects[0].worstCaseBytes < r.body.objects[0].capBytes);
  assert.deepStrictEqual(Object.keys(r.body.objects[0].payload.values).sort(), ['activePower', 'powerFactor']);

  r = await api('POST', '/api/tags/bindings/preview', { source: { type: 'device' }, target: {} });
  assert.deepStrictEqual([r.status, r.body.valid], [200, false]);
  assert.strictEqual(ctx.mqtt.all.length, before, 'preview publishes nothing');
  assert.ok(!ctx.profiles.getIn('bindings', '__preview__'));

  // a profile used by a binding cannot be deleted; its instances can
  r = await api('DELETE', `/api/devices/profiles/${pid}`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.bindings[0].id, 'pb');
  r = await api('DELETE', `/api/tags/bindings/dup`);
  r = await api('DELETE', `/api/devices/${devA.id}`);
  assert.strictEqual(r.status, 200, 'profile instances are not pinned by profile bindings');
});

test('lint: raw-address leaves are flagged; spBv1.0 and $ roots skip hierarchy-shape rules', () => {
  const trieOf = (topics) => {
    const t = new TopicTrie();
    topics.forEach((x, i) => t.insert(x, i));
    return t;
  };
  const r = lintTrie(trieOf(['acme/line1/plc/DB10.DBD4', 'acme/line1/meter/40012', 'acme/line1/opc/ns=2;s=Motor', 'acme/line1/plc/Program:Main.X', 'acme/line1/plc/speed']));
  assert.strictEqual(r.stats.byRule['raw-address'], 4);

  const deep = ['spBv1.0/G/DDATA/E/D/a/b/c/d/e', 'spBv1.0/G/NDATA/E', '$SYS/broker/load/x/y/z/w', 'acme/l1/x', 'acme/l2/y'];
  const s = lintTrie(trieOf(deep));
  assert.ok(!s.findings.some((f) => f.rule === 'depth-variance'), 'Sparkplug depth does not count');
  assert.ok(!s.findings.some((f) => f.rule === 'deep-chain' && f.path.startsWith('spBv1.0')));
  const isa = lintTrie(trieOf(['a/b/c/d/e/f/g/h', 'x/y']));
  assert.ok(isa.findings.some((f) => f.rule === 'depth-variance'), 'still applies to the ISA-95 namespace');
});

test('metrics: per-device, per-host and per-binding series', () => {
  const text = metricsExporter.render({
    devices: {
      list: () => [{ id: 'abcdef1234', name: 'M1', protocol: 's7', status: { state: 'online', connects: 2, requests: 9, timeouts: 1, exceptions: { 5: 3 }, groups: { fast: { avgCycleMs: 4.5, overruns: 2 } }, quarantined: ['t1', 't2'] } }],
      hosts: () => ({ s7: { protocol: 's7', state: 'running', restarts: 1 } })
    },
    bindings: { getStatus: () => ({ 'bind-0001-xyz': { published: 5, suppressed: 7, errors: 1 } }) }
  });
  for (const want of [
    'manifold_device_up{device="M1",device_id="abcdef12",protocol="s7"} 1',
    'manifold_device_timeouts_total{device="M1",device_id="abcdef12",protocol="s7"} 1',
    'manifold_device_exceptions_total{device="M1",device_id="abcdef12",protocol="s7",code="5"} 3',
    'manifold_device_cycle_ms{device="M1",device_id="abcdef12",protocol="s7",group="fast"} 4.5',
    'manifold_device_overruns_total{device="M1",device_id="abcdef12",protocol="s7",group="fast"} 2',
    'manifold_device_quarantined_tags{device="M1",device_id="abcdef12",protocol="s7"} 2',
    'manifold_driver_host_restarts_total{host="s7",protocol="s7"} 1',
    'manifold_binding_suppressed_total{binding="bind-000"} 7',
    'manifold_binding_errors_total{binding="bind-000"} 1'
  ]) {
    assert.ok(text.includes(want), `missing ${want}`);
  }
});

test('discovery: read-only identification of Modbus, S7 and EtherNet/IP', async () => {
  const { startSimulator } = require('./support/modbusSimulator');
  const sim = await startSimulator({ port: 0, units: { 1: { holding: {} } } });
  const { createS7Simulator } = require('./support/s7Simulator');
  const plc = createS7Simulator({ maxPdu: 240, dbs: { 1: Buffer.alloc(4) } });
  await plc.start();
  // Minimal ListIdentity responder with a real identity item.
  const eip = net.createServer((sock) => {
    sock.on('data', (req) => {
      const name = Buffer.from('1769-L33ER/A LOGIX5333ER', 'latin1');
      const ident = Buffer.alloc(15);
      ident.writeUInt16LE(1, 0); // vendor Rockwell
      ident.writeUInt16LE(14, 2); // PLC
      ident.writeUInt16LE(96, 4);
      ident[6] = 33;
      ident[7] = 11;
      ident.writeUInt32LE(0xc0ffee, 10);
      ident[14] = name.length;
      const data = Buffer.concat([Buffer.alloc(18), ident, name, Buffer.from([3])]);
      const body = Buffer.concat([Buffer.from([1, 0, 0x0c, 0, data.length & 0xff, data.length >> 8]), data]);
      const head = Buffer.alloc(24);
      head.writeUInt16LE(0x63, 0);
      head.writeUInt16LE(body.length, 2);
      req.copy(head, 12, 12, 20);
      sock.write(Buffer.concat([head, body]));
    });
  });
  await new Promise((r) => eip.listen(0, '127.0.0.1', r));
  try {
    const mb = await deviceIdentify.identifyModbus('127.0.0.1', sim.port);
    assert.strictEqual(mb.protocol, 'modbus-tcp');
    assert.strictEqual(mb.verified, true);
    assert.strictEqual(sim.stats.writesReceived, 0);

    const s7 = await deviceIdentify.identifyS7('127.0.0.1', plc.port);
    assert.deepStrictEqual([s7.protocol, s7.identity.cotp], ['s7', 'CC']);
    assert.strictEqual(plc.stats.writesReceived, 0);

    const disc = new DiscoveryService({ emit() {} });
    const e = await disc.identifyDevice('ethernet-ip', '127.0.0.1', eip.address().port);
    assert.strictEqual(e.protocol, 'ethernet-ip');
    assert.strictEqual(e.identity.productName, '1769-L33ER/A LOGIX5333ER');
    assert.strictEqual(e.identity.vendorId, 1);
    assert.deepStrictEqual(e.suggestedDevice, { name: '1769-L33ER/A LOGIX5333ER 127.0.0.1', protocol: 'ethernet-ip', host: '127.0.0.1', port: eip.address().port });

    // a port that does not speak the protocol is not reported
    assert.strictEqual(await disc.identifyDevice('modbus', '127.0.0.1', eip.address().port), null);
  } finally {
    await sim.close();
    await plc.stop?.();
    await plc.close?.();
    await new Promise((r) => eip.close(r));
  }
});

test('discovery: device ports are opt-in and the egress guard still filters targets', async () => {
  const events = [];
  const disc = new DiscoveryService({ emit: (n, p) => events.push([n, p]) });
  disc.probePort = async () => false;
  const prev = process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;
  process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS = '1';
  try {
    await disc.startScan({ range: '10.1.2.3/32', includeI3x: false });
    assert.deepStrictEqual(events.find((x) => x[0] === 'discovery-started')[1].ports, [1883, 8883, 4840]);
    await new Promise((r) => setTimeout(r, 20));
    events.length = 0;
    await disc.startScan({ range: '10.1.2.3/32', includeI3x: false, includeDevices: true });
    assert.deepStrictEqual(events.find((x) => x[0] === 'discovery-started')[1].ports, [1883, 8883, 4840, 502, 102, 44818]);
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(disc.startScan({ range: '127.0.0.1/32', includeDevices: true }), /blocked/);
  } finally {
    if (prev === undefined) delete process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;
    else process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS = prev;
  }
});

test('device validation: tag metadata is checked', () => {
  const dm = new DeviceManager({ profiles: memoryProfiles(), guard: async () => {} });
  const res = dm.validateTags('modbus-tcp', {}, [
    { key: 'a', address: 'holding:1', type: 'uint16', range: { min: 5, max: 1 } },
    { key: 'b', address: 'holding:2', type: 'uint16', property: 'x/+' },
    { key: 'c', address: 'holding:3', type: 'uint16', unit: 'rpm', property: 'speed', range: { min: 0, max: 3000 } }
  ]);
  assert.deepStrictEqual(res.map((r) => r.ok), [false, false, true]);
  assert.throws(() => dm.normalize({ protocol: 'modbus-tcp', host: 'h', profileId: 'missing' }), DeviceValidationError);
  // one supervisor batch -> N samples then exactly one batch-end
  const seen = [];
  dm.on('sample', (s) => seen.push(s.address));
  dm.on('batch-end', (e) => seen.push(`end:${e.sourceId}`));
  dm._onSamples({ deviceId: 'd1', samples: [{ key: 'a', v: 1, q: 192 }, { key: 'b', v: 2, q: 192 }] });
  assert.deepStrictEqual(seen, ['a', 'b', 'end:d1']);
  return dm.stop();
});
