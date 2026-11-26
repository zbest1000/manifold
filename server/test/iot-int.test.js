const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const Aedes = require('aedes');
const mqtt = require('mqtt');

const MqttManager = require('../services/mqttManager');
const { IotManager, normalizeConfig } = require('../services/iot/iotManager');
const { TagBindings } = require('../services/tagBindings');
const model = require('../services/bindingModel');
const { memoryProfiles } = require('./support/fakeMqtt');
const { startIotSimulator } = require('./support/iotMqttSimulator');

// IoT over MQTT through a REAL in-process broker: the simulator publishes every convention, the
// real MqttManager ingests, IotManager builds the registry, TagBindings maps a device into the UNS.
// Also the read-only proof: nothing is ever published to a command / set / downlink topic.

async function startBroker() {
  const AedesClass = Aedes.Aedes || Aedes;
  const aedes = AedesClass.createBroker ? await AedesClass.createBroker() : new AedesClass();
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => {
      await new Promise((r) => aedes.close(r));
      await new Promise((r) => server.close(r));
    }
  };
}

const until = async (fn, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const ALL = { conventions: Object.fromEntries(['zigbee2mqtt', 'zwavejs', 'homeassistant', 'tasmota', 'shelly', 'chirpstack', 'ttn'].map((c) => [c, { enabled: true }])) };

async function rig() {
  const broker = await startBroker();
  const manager = new MqttManager({ emit() {} });
  // Every publish Manifold makes is recorded (the binding engine's UNS output is the only one allowed).
  const published = [];
  const realPublish = manager.publish.bind(manager);
  manager.publish = (brokerId, topic, payload, opts) => {
    published.push({ brokerId, topic });
    return realPublish(brokerId, topic, payload, opts);
  };
  const profiles = memoryProfiles();
  const iot = new IotManager({ mqttManager: manager, profiles, pollMs: 50, metaDebounceMs: 10 });
  model.attachIotSource(profiles, { device: (b, d) => iot.rawDevice(b, d), readFilters: (b) => iot.readFilters(b) });
  const bindings = new TagBindings({ mqttManager: manager, profiles, sparkplugPublisher: null, ledgerFile: null, brokerPollMs: 50, retryMs: 100, heartbeatTickMs: 100 });
  bindings.registerSource('iot', iot);
  iot.start();
  bindings.start();
  manager.connectToBroker({ id: 'bk', host: '127.0.0.1', port: broker.port, name: 'home broker', reconnectPeriod: 200 });
  await until(() => manager.getConnection('bk')?.status === 'connected', 5000, 'connect');
  const sim = await startIotSimulator({ port: broker.port });
  const commands = await sim.watchCommands();
  const witness = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { reconnectPeriod: 0 });
  const uns = [];
  witness.on('message', (topic, buf) => {
    let p = buf.toString();
    try {
      p = JSON.parse(p);
    } catch {
      /* text */
    }
    uns.push({ topic, payload: p });
  });
  await new Promise((r) => witness.once('connect', r));
  await new Promise((r) => witness.subscribe('uns/#', r));
  return {
    broker, manager, profiles, iot, bindings, sim, commands, uns, published,
    async close() {
      bindings.stop();
      iot.stop();
      await commands.close();
      await sim.close();
      await new Promise((r) => witness.end(true, {}, r));
      manager.shutdown();
      await broker.close();
    }
  };
}

test('auto-detect suggests every convention from the traffic; enabling replays what the broker already sent', async () => {
  const r = await rig();
  try {
    await r.sim.publishRetained();
    await r.sim.tick();
    await until(() => r.iot.status('bk').suggestions.length === 7, 8000, 'seven suggestions').catch(() => {
      assert.deepStrictEqual(r.iot.status('bk').suggestions.map((s) => s.convention).sort(), ['chirpstack', 'homeassistant', 'shelly', 'tasmota', 'ttn', 'zigbee2mqtt', 'zwavejs']);
    });
    const sug = Object.fromEntries(r.iot.status('bk').suggestions.map((s) => [s.convention, s.options]));
    assert.deepStrictEqual(sug.zigbee2mqtt, { baseTopic: 'zigbee2mqtt' });
    assert.deepStrictEqual(sug.zwavejs, { prefix: 'zwave' });
    assert.deepStrictEqual(sug.homeassistant, { prefix: 'homeassistant' });
    assert.deepStrictEqual(sug.chirpstack, { prefix: 'application' });
    assert.deepStrictEqual(sug.ttn, { prefix: 'v3' });
    assert.strictEqual(r.iot.listDevices().length, 0, 'nothing is read before a convention is enabled');

    r.iot.setConfig('bk', ALL);
    assert.deepStrictEqual(r.profiles.getIn('iotDetection', 'bk').conventions.zigbee2mqtt, { enabled: true, baseTopic: 'zigbee2mqtt' });
    // Replay from the topic store: the retained device lists / configs are there at once.
    const byConv = () => {
      const out = {};
      for (const d of r.iot.listDevices()) out[d.convention] = (out[d.convention] || 0) + 1;
      return out;
    };
    await until(() => Object.keys(byConv()).length === 7, 8000, 'devices of all seven conventions');
    const climate = r.iot.getDevice('bk', `z2m:${r.sim.ieee.climate}`);
    assert.strictEqual(climate.name, 'living_room/climate');
    assert.strictEqual(climate.brokerName, 'home broker');
    const temp = climate.tags.find((t) => t.key === 'temperature');
    assert.deepStrictEqual([temp.unit, temp.type, temp.quality], ['°C', 'float64', 192]);
    assert.ok(temp.sourceTime, 'last_seen is the source time');
    // live values flow
    const before = temp.value;
    await r.sim.tick();
    await until(() => r.iot.getDevice('bk', `z2m:${r.sim.ieee.climate}`).tags.find((t) => t.key === 'temperature').value !== before, 5000, 'live update');
    const ha = r.iot.getDevice('bk', 'ha:garage_env_01');
    assert.strictEqual(ha.tags.find((t) => t.key === 'garage_env_power').value > 1000, true);
    assert.match(ha.tags.find((t) => t.key === 'garage_env_mode').unsupported, /template not supported/);
    const em = r.iot.getDevice('bk', 'ha:em01');
    assert.strictEqual(em.tags.find((t) => t.key === 'em01_energy').value, 123.456);
    const cs = r.iot.getDevice('bk', `chirpstack:${r.sim.devEui.cs1}`);
    assert.ok(cs.tags.some((t) => t.key === 'decoded.temperature' && typeof t.value === 'number'));
    const deadNode = r.iot.getDevice('bk', 'zwave:topic:Kitchen/Door_sensor');
    assert.strictEqual(deadNode.availability, 'offline');
    // HA entity removal by empty retained config
    await r.sim.removeHaEntity();
    await until(() => !r.iot.getDevice('bk', 'ha:garage_env_01').tags.some((t) => t.key === 'garage_env_door'), 5000, 'entity removed');
    // disabling a convention drops its devices
    r.iot.setConfig('bk', { conventions: { ...ALL.conventions, shelly: { enabled: false } } });
    assert.ok(!r.iot.listDevices().some((d) => d.convention === 'shelly'));
    assert.throws(() => normalizeConfig({ conventions: { zigbee: { enabled: true } } }), /unknown convention/);
    assert.throws(() => normalizeConfig({ conventions: { zigbee2mqtt: { enabled: 'yes' } } }), /boolean/);
  } finally {
    await r.close();
  }
});

test('a mapping from an IoT device: metadata pre-filled, quality follows availability, rename keeps identity', async () => {
  const r = await rig();
  try {
    await r.sim.publishRetained();
    r.iot.setConfig('bk', ALL);
    const devId = `z2m:${r.sim.ieee.plug}`;
    await until(() => r.iot.getDevice('bk', devId), 5000, 'plug');
    // Loop guard: publishing into what detection reads on the same broker is refused.
    assert.throws(
      () => model.validateBinding({ id: 'x', source: { type: 'iot', brokerId: 'bk', deviceId: devId, tags: ['power'] }, target: { mode: 'mqtt', brokerId: 'bk', assetPath: 'zigbee2mqtt/uns' } }, { profiles: r.profiles }),
      /loop: this mapping would publish into topics IoT detection reads/
    );
    const body = model.validateBinding({ id: 'm1', name: 'plug', source: { type: 'iot', brokerId: 'bk', deviceId: devId, tags: 'all' }, target: { mode: 'mqtt', brokerId: 'bk', assetPath: 'uns/home/kitchen/plug', format: 'envelope' } }, { profiles: r.profiles });
    r.profiles.upsertIn('bindings', 'm1', body);
    r.bindings.reconcile();
    await r.bindings.syncMonitors();
    const sug = model.suggestMapping({ type: 'iot', brokerId: 'bk', deviceId: devId }, r.profiles);
    assert.deepStrictEqual(sug.tags.find((t) => t.address === 'power').unit, 'W');

    await r.sim.tick();
    await until(() => r.uns.some((m) => m.topic === 'uns/home/kitchen/plug/Power' && m.payload.q === 192), 8000, 'power published');
    const meta = r.uns.filter((m) => m.topic === 'uns/home/kitchen/plug/_meta').at(-1);
    assert.strictEqual(meta.payload.properties.Power.unit, 'W');
    assert.deepStrictEqual(meta.payload.properties.Power.source, { brokerId: 'bk', iotDeviceId: devId, address: 'power' });
    // offline availability -> Bad
    await r.sim.setZigbeeAvailability('kitchen_plug', 'offline', { legacy: true });
    await until(() => r.uns.some((m) => m.topic === 'uns/home/kitchen/plug/Power' && m.payload.q === 0), 8000, 'Bad on offline');
    await until(() => r.uns.some((m) => m.topic === 'uns/home/kitchen/plug/_status' && m.payload.online === false), 8000, '_status offline');
    // rename in Zigbee2MQTT: same IEEE address, the mapping keeps publishing from the new topic
    await r.sim.renameZigbee('kitchen_plug', 'pantry_plug');
    await until(() => r.iot.getDevice('bk', devId)?.name === 'pantry_plug', 5000, 'renamed');
    const n = r.uns.filter((m) => m.topic === 'uns/home/kitchen/plug/Power' && m.payload.q === 192).length;
    await r.sim.tick();
    await until(() => r.uns.filter((m) => m.topic === 'uns/home/kitchen/plug/Power' && m.payload.q === 192).length > n, 8000, 'values after rename');
  } finally {
    await r.close();
  }
});

test('hostile payloads neither crash nor block ingest; caps are counted', async () => {
  const r = await rig();
  try {
    await r.sim.publishRetained();
    r.iot.setConfig('bk', ALL);
    await until(() => r.iot.getDevice('bk', `z2m:${r.sim.ieee.climate}`), 5000, 'climate');
    await r.sim.hostile();
    await new Promise((res) => setTimeout(res, 300));
    const st = r.iot.status('bk').stats;
    assert.ok(st.refusedDepth >= 1, 'deep JSON refused');
    assert.ok(st.refusedLarge >= 1, 'oversized payload refused');
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual({}.bad, undefined);
    const evil = r.iot.getDevice('bk', 'ha:entity:sensor%2Fevil%2Fy');
    if (evil) assert.match(evil.tags[0].unsupported || '', /template not supported/);
    // still ingesting normally afterwards
    const t0 = r.iot.getDevice('bk', `z2m:${r.sim.ieee.climate}`).tags.find((t) => t.key === 'temperature').receivedAt;
    await r.sim.tick();
    await until(() => r.iot.getDevice('bk', `z2m:${r.sim.ieee.climate}`).tags.find((t) => t.key === 'temperature').receivedAt > t0, 5000, 'ingest continues');
  } finally {
    await r.close();
  }
});

test('read-only proof: no publish path exists, and none happens to any command/set/downlink topic', async () => {
  // 1. Static: no IoT module, nor its route, contains a publish call or holds a client of its own.
  const dir = path.join(__dirname, '../services/iot');
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'conventions')).map((f) => path.join(dir, 'conventions', f)), path.join(__dirname, '../routes/iot.js')].filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // code, not comments
    assert.ok(!/\.publish\s*\(|\bpublish\s*\(|\.connect\s*\(|require\(['"]mqtt['"]\)|\.write\s*\(/.test(src), `${path.basename(f)} must not publish, connect or write`);
  }
  // The route exposes reads plus one config PUT; no POST that could reach a device.
  const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/iot.js'), 'utf8');
  assert.deepStrictEqual([...routeSrc.matchAll(/router\.(get|put|post|delete|patch)\(/g)].map((m) => m[1]).sort(), ['get', 'get', 'get', 'get', 'get', 'put']);

  // 2. Runtime: a manager whose publish throws, the full simulator traffic, every convention on.
  const r = await rig();
  const calls = [];
  const iotOnly = new IotManager({ mqttManager: new Proxy(r.manager, { get: (t, k) => (k === 'publish' ? (...a) => calls.push(a) && Promise.reject(new Error('IoT must not publish')) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }), profiles: memoryProfiles() });
  try {
    iotOnly.start();
    iotOnly.setConfig('bk', ALL);
    r.iot.setConfig('bk', ALL);
    await r.sim.publishRetained();
    for (let i = 0; i < 3; i++) await r.sim.tick();
    await r.sim.renameZigbee('kitchen_plug', 'pantry_plug');
    await r.sim.hostile();
    await until(() => iotOnly.listDevices().length >= 10, 5000, 'devices on the second manager');
    await new Promise((res) => setTimeout(res, 400));
    assert.deepStrictEqual(calls, [], 'IotManager never calls publish');
    assert.deepStrictEqual(r.commands.messages, [], 'nothing reached a command, set or downlink topic');
    assert.ok(r.published.every((p) => p.topic.startsWith('uns/')), `only mapping output may be published: ${JSON.stringify(r.published.slice(0, 5))}`);
  } finally {
    iotOnly.stop();
    await r.close();
  }
});
