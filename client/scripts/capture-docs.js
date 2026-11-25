#!/usr/bin/env node
/**
 * Regenerates the documentation screenshots (docs/wiki/images/*.png and the copies in site/assets/)
 * from the real application.
 *
 *   cd client && npm run build && npm run docs:shots
 *   npm run docs:shots -- --only overview,trends     # just these images
 *   npm run docs:shots -- --out /tmp/shots           # write somewhere else (no site/assets copies)
 *   npm run docs:shots -- --serve                    # seed the demo plant and keep it running
 *   npm run docs:shots -- --attach --only trends     # capture against a running --serve instance
 *
 * What it does, all on 127.0.0.1 and in this process (nothing leaves the machine):
 *
 *   1. starts a demo plant made of the simulators the test suite uses (server/test/support):
 *      an MQTT broker (aedes) fed with an ISA-95 namespace and Sparkplug B edge nodes, Modbus TCP,
 *      Siemens S7 and EtherNet/IP simulators with plausible changing values, a small OPC UA server
 *      (node-opcua) with a bottling line address space, and two historian stand-ins (HTTP servers
 *      that accept the Timebase and InfluxDB write calls);
 *   2. starts the REAL backend (server/index.js) on a free port with a throwaway MANIFOLD_DATA_DIR,
 *      MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 and MANIFOLD_ALLOW_PRIVATE_TARGETS=1, serving client/dist;
 *   3. seeds it through its REST API: devices, a device profile, an OPC UA connection, mappings,
 *      pipeline routes, historians, alert rules and a recording with two hours of samples;
 *   4. drives Chromium (Playwright) through each page and writes the PNGs (device scale factor 2,
 *      1440 x 900 CSS pixels; phone images 390 x 844), dark theme unless the name ends in -light.
 *
 * Browser: Playwright's managed Chromium, or PW_CHROMIUM_PATH (falls back to /opt/pw-browsers/chromium).
 * The drivers stay read-only: the simulators only answer reads from Manifold.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const serverDir = path.join(root, 'server');
const requireServer = createRequire(path.join(serverDir, 'package.json'));

const WIKI_IMAGES = path.join(root, 'docs/wiki/images');
const SITE_ASSETS = path.join(root, 'site/assets');
/** Images the project website uses too; they must stay byte-identical to the wiki copies. */
const STATE_FILE = path.join(os.tmpdir(), 'manifold-docs-serve.json');
const SITE_COPIES = ['historians', 'overview', 'topics-3d', 'uns-topology'];

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// ---- command line ------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { only: null, out: null, serve: false, keepData: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') opts.only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--serve') opts.serve = true;
    else if (a === '--attach') opts.attach = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument "${a}" (try --help)`);
  }
  return opts;
}

// ---- small helpers -------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((resolve) => s.close(resolve));
  return port;
}
const wave = (t, mid, amp, periodS, phase = 0) => mid + amp * Math.sin((2 * Math.PI * t) / periodS + phase);
const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
const log = (...args) => console.log('[docs:shots]', ...args);

async function until(fn, { timeout = 30_000, what = 'condition', every = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

function makeApi(baseUrl) {
  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json, text };
  };
  const must = async (method, url, body) => {
    const r = await call(method, url, body);
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${r.text.slice(0, 400)}`);
    return r.json;
  };
  return { get: (u) => must('GET', u), post: (u, b) => must('POST', u, b), put: (u, b) => must('PUT', u, b), raw: call };
}

// ---- the demo plant ------------------------------------------------------------------------

/** Plain JSON telemetry on the plant broker: { topic: () => payload }. Retained, published every second. */
function plainTopics() {
  const topics = [];
  const add = (topic, gen, every = 1) => topics.push({ topic, gen, every });
  const press = (base, n) => {
    add(`${base}/temperature`, (t) => ({ value: round(wave(t, 46 + n, 2.5, 70, n)), unit: '°C' }));
    add(`${base}/hydraulic_pressure`, (t) => ({ value: round(wave(t, 182 + n * 3, 6, 23, n)), unit: 'bar' }));
    add(`${base}/stroke_rate`, (t) => ({ value: Math.round(wave(t, 28, 2, 40, n)), unit: 'spm' }));
    add(`${base}/power`, (t) => ({ value: round(wave(t, 36 + n, 4, 17, n)), unit: 'kW' }));
    add(`${base}/state`, () => ({ value: 'running' }), 5);
  };
  for (const [line, presses] of [['line-1', [1, 2, 3]], ['line-2', [4, 5]]]) {
    for (const p of presses) press(`acme/riverside/press-shop/${line}/press-${p}`, p);
  }
  const meter = (base, kw, n) => {
    let kwh = 18_000 + n * 4_000;
    add(`${base}/power`, (t) => ({ value: round(wave(t, kw, kw * 0.08, 31, n)), unit: 'kW' }));
    add(`${base}/energy`, () => ({ value: round((kwh += kw / 3600), 1), unit: 'kWh' }));
  };
  add('acme/riverside/energy/main-incomer/voltage', (t) => ({ value: round(wave(t, 401, 2, 19), 1), unit: 'V' }));
  add('acme/riverside/energy/main-incomer/current', (t) => ({ value: round(wave(t, 1180, 60, 29), 0), unit: 'A' }));
  meter('acme/riverside/energy/main-incomer', 780, 0);
  for (const [hall, n] of [['hall-a', 1], ['hall-b', 2]]) {
    add(`acme/riverside/building/${hall}/temperature`, (t) => ({ value: round(wave(t, 21 + n * 0.4, 0.4, 120, n), 1), unit: '°C' }), 3);
    add(`acme/riverside/building/${hall}/humidity`, (t) => ({ value: round(wave(t, 44 + n, 2, 150, n), 1), unit: '%' }), 3);
  }
  // A second site: an assembly plant whose gateway already publishes ISA-95 topics.
  for (const line of [1, 2]) {
    for (const r of [1, 2, 3]) {
      const base = `acme/lakeside/assembly/line-${line}/robot-${r}`;
      let cycles = 4_000 * r + line * 700;
      add(`${base}/temperature`, (t) => ({ value: round(wave(t, 38 + r, 1.5, 55, r + line)), unit: '°C' }));
      add(`${base}/speed`, (t) => ({ value: Math.round(wave(t, 1450, 50, 21, r)), unit: 'rpm' }));
      add(`${base}/cycle_count`, () => ({ value: (cycles += 1) }), 2);
      add(`${base}/state`, () => ({ value: 'running' }), 5);
    }
  }
  // Legacy topics a pipeline route and an MQTT mapping bring into the UNS.
  for (const [m, kw] of [['em-101', 42], ['em-102', 65], ['em-103', 18], ['em-104', 120]]) {
    let wh = 9_000_000 + kw * 10_000;
    add(`legacy/meters/${m}/kw`, (t) => ({ value: round(wave(t, kw, kw * 0.1, 27, kw)), unit: 'kW' }));
    add(`legacy/meters/${m}/wh`, () => ({ value: Math.round((wh += (kw * 1000) / 3600)), unit: 'Wh' }), 2);
  }
  add('legacy/hvac/ahu1/sat', (t) => ({ value: round(wave(t, 16.5, 0.6, 90), 1), unit: '°C' }));
  add('legacy/hvac/ahu1/rat', (t) => ({ value: round(wave(t, 22.4, 0.4, 110), 1), unit: '°C' }));
  add('legacy/hvac/ahu1/fan', (t) => ({ value: round(wave(t, 72, 4, 60), 0), unit: '%' }));
  add('legacy/hvac/ahu1/filter_dp', (t) => ({ value: round(wave(t, 145, 6, 200), 0), unit: 'Pa' }), 3);
  return topics;
}

/** Sparkplug B edge nodes: { group, node, devices: { name: [metric, base, amp, unit] } }. */
const SPARKPLUG = [
  {
    group: 'Riverside',
    node: 'Warehouse-Edge',
    devices: {
      Conveyor1: [['Speed', 1.2, 0.05, 'm/s'], ['MotorCurrent', 7.5, 0.6, 'A'], ['Running', true]],
      Palletizer1: [['PalletCount', 412, 0, ''], ['CycleTime', 38, 2, 's'], ['Running', true]]
    }
  },
  {
    group: 'Riverside',
    node: 'Wastewater-Edge',
    devices: {
      Clarifier: [['Turbidity', 3.2, 0.4, 'NTU'], ['pH', 7.1, 0.08, 'pH'], ['FlowRate', 42, 3, 'm3/h']],
      LiftStation: [['WellLevel', 61, 6, '%'], ['Pump1Running', true], ['Pump2Running', false]]
    }
  },
  {
    group: 'Lakeside',
    node: 'Paintshop-Edge',
    devices: {
      Oven1: [['ZoneTemp1', 182, 1.5, '°C'], ['ZoneTemp2', 196, 1.5, '°C'], ['ConveyorSpeed', 2.4, 0.05, 'm/min']],
      Booth2: [['Humidity', 58, 2, '%'], ['AirFlow', 9.5, 0.4, 'm/s']]
    }
  }
];

/** The recording behind the Trends image: boiler 1 metrics over two hours, as timestamped Sparkplug batches. */
const TREND = { group: 'Riverside', node: 'Utilities-Edge', device: 'Boiler1' };

async function startPlantBroker() {
  const aedesModule = requireServer('aedes');
  const Aedes = aedesModule.Aedes || aedesModule;
  // A fixed id keeps the broker's own $SYS topics readable ($SYS/broker/...).
  const brokerOpts = { id: 'broker', heartbeatInterval: 30_000 };
  const broker = Aedes.createBroker ? await Aedes.createBroker(brokerOpts) : new Aedes(brokerOpts);
  const server = net.createServer(broker.handle);
  const port = await listen(server);
  const stats = { received: 0, subscriptions: 0 };
  const retained = new Set();
  broker.on('subscribe', (subs) => (stats.subscriptions += subs.length));
  broker.on('unsubscribe', (subs) => (stats.subscriptions = Math.max(0, stats.subscriptions - subs.length)));
  broker.on('publish', (packet) => {
    if (!packet.topic.startsWith('$SYS/')) stats.received += 1;
  });
  const publish = (topic, body, retain = true) => {
    if (retain && !topic.startsWith('$SYS/')) retained.add(topic);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return new Promise((resolve) => broker.publish({ cmd: 'publish', qos: 0, dup: false, retain, topic, payload }, resolve));
  };

  const { encodePayload } = requireServer('./services/sparkplugEncoder.js');
  const metric = (name, value, unit) => ({ name, value, properties: unit ? { engUnit: unit } : undefined });
  const seqs = new Map();
  const nextSeq = (node) => {
    const s = ((seqs.get(node) ?? -1) + 1) % 256;
    seqs.set(node, s);
    return s;
  };
  const sparkplugValue = ([, base, amp], t, i) => (typeof base === 'boolean' ? base : amp ? round(wave(t, base, amp, 30 + i * 7, i)) : base);
  const births = async () => {
    for (const e of SPARKPLUG) {
      seqs.set(e.node, -1);
      await publish(`spBv1.0/${e.group}/NBIRTH/${e.node}`, encodePayload({ seq: nextSeq(e.node), metrics: [{ name: 'bdSeq', value: 0, isBdSeq: true }, metric('Node Control/Rebirth', false), metric('Properties/Hardware', 'Edge gateway')] }));
      for (const [d, ms] of Object.entries(e.devices)) {
        await publish(`spBv1.0/${e.group}/DBIRTH/${e.node}/${d}`, encodePayload({ seq: nextSeq(e.node), metrics: ms.map((m, i) => metric(m[0], sparkplugValue(m, 0, i), m[3])) }));
      }
    }
    seqs.set(TREND.node, -1);
    await publish(`spBv1.0/${TREND.group}/NBIRTH/${TREND.node}`, encodePayload({ seq: nextSeq(TREND.node), metrics: [{ name: 'bdSeq', value: 0, isBdSeq: true }, metric('Node Control/Rebirth', false)] }));
    await publish(`spBv1.0/${TREND.group}/DBIRTH/${TREND.node}/${TREND.device}`, encodePayload({ seq: nextSeq(TREND.node), metrics: trendSample(Date.now(), 7200).map(({ name, value, unit }) => metric(name, value, unit)) }));
  };

  const plain = plainTopics();
  const started = Date.now();
  let tick = 0;
  const publishTick = async () => {
    tick += 1;
    const t = (Date.now() - started) / 1000;
    for (const p of plain) if (tick % p.every === 0 || tick === 1) await publish(p.topic, p.gen(t));
    for (const e of SPARKPLUG) {
      for (const [d, ms] of Object.entries(e.devices)) {
        const live = ms.map((m, i) => [m, i]).filter(([m]) => typeof m[1] !== 'boolean' && (m[2] || m[0] === 'PalletCount'));
        if (!live.length) continue;
        await publish(`spBv1.0/${e.group}/DDATA/${e.node}/${d}`, encodePayload({ seq: nextSeq(e.node), metrics: live.map(([m, i]) => metric(m[0], m[0] === 'PalletCount' ? m[1] + Math.floor(t / 40) : sparkplugValue(m, t, i), m[3])) }), false);
      }
    }
  };
  await births();
  await publishTick();
  const timer = setInterval(() => publishTick().catch(() => {}), 1000);
  // Broker health in the $SYS layout most brokers use, from the broker's real counters.
  const aedesVersion = JSON.parse(fs.readFileSync(path.join(serverDir, 'node_modules/aedes/package.json'), 'utf8')).version;
  const sysTick = async () => {
    const sys = {
      version: `aedes ${aedesVersion}`,
      uptime: `${Math.round((Date.now() - started) / 1000)} seconds`,
      'clients/connected': broker.connectedClients,
      'subscriptions/count': stats.subscriptions,
      'messages/received': stats.received,
      'retained messages/count': retained.size
    };
    for (const [k, v] of Object.entries(sys)) await publish(`$SYS/broker/${k}`, String(v));
  };
  await sysTick();
  const sysTimer = setInterval(() => sysTick().catch(() => {}), 5000);

  return {
    port,
    publish,
    topicCount: plain.length,
    /** Two hours of boiler samples ending now, 10 s apart, with a short communication loss (Bad) on the pressure. */
    async backfillTrend() {
      const end = Date.now() - 2000;
      const count = 720;
      const start = end - (count - 1) * 10_000;
      const topic = `spBv1.0/${TREND.group}/DDATA/${TREND.node}/${TREND.device}`;
      for (let from = 0; from < count; from += 60) {
        const metrics = [];
        for (let i = from; i < Math.min(count, from + 60); i++) {
          const ts = start + i * 10_000;
          for (const s of trendSample(ts, i)) {
            const bad = s.name === 'SteamPressure' && i >= 410 && i < 428;
            metrics.push({ name: s.name, value: bad ? 0 : s.value, ts, properties: { engUnit: s.unit, Quality: bad ? 0 : 192 } });
          }
        }
        await publish(topic, encodePayload({ seq: nextSeq(TREND.node), ts: start + from * 10_000, metrics }), false);
      }
      return { topic, tags: ['SupplyTemp', 'ReturnTemp', 'SteamPressure'].map((m) => `${topic}/${m}`) };
    },
    async close() {
      clearInterval(timer);
      clearInterval(sysTimer);
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Boiler 1 at sample i (10 s steps): a slow load cycle with a little noise. */
function trendSample(_ts, i) {
  const load = Math.sin((2 * Math.PI * i) / 360) * 0.5 + Math.sin((2 * Math.PI * i) / 97) * 0.15;
  const noise = (k) => Math.sin(i * 12.9898 + k * 78.233) * 0.3;
  return [
    { name: 'SupplyTemp', value: round(82 + 4 * load + noise(1), 2), unit: '°C' },
    { name: 'ReturnTemp', value: round(64 + 3 * load + noise(2), 2), unit: '°C' },
    { name: 'SteamPressure', value: round(10.2 + 0.6 * load + noise(3) * 0.2, 3), unit: 'bar' }
  ];
}

/** Modbus units with changing values. `fill(sim, t)` writes the registers. */
async function startModbusUnit(fill) {
  const { startSimulator } = requireServer('./test/support/modbusSimulator.js');
  const unit = () => ({ holding: {}, input: {}, coils: {}, discrete: {} });
  const sim = await startSimulator({ port: 0, units: { 1: unit() } });
  const started = Date.now();
  const tick = () => fill(sim, (Date.now() - started) / 1000);
  tick();
  const timer = setInterval(tick, 1000);
  return { port: sim.port, close: async () => { clearInterval(timer); await sim.close(); } };
}

const boilerRegisters = (sim, t) => {
  sim.setRegister(1, 'holding', 0, Math.round(wave(t, 82.4, 1.2, 80) * 10) & 0xffff);
  sim.setRegister(1, 'holding', 1, Math.round(wave(t, 1480, 35, 23)));
  sim.setFloat32(1, 'holding', 2, wave(t, 212, 9, 41));
  sim.setFloat32(1, 'holding', 4, wave(t, 10.3, 0.25, 33), { wordOrder: 'little' });
  sim.setRegister(1, 'coil', 0, 1);
};

const checkweigherRegisters = (offset) => {
  let rejects = 37 + offset * 11;
  return (sim, t) => {
    sim.setFloat32(1, 'holding', 0, wave(t, 500.6 + offset * 0.3, 0.8, 7, offset));
    if (Math.random() < 0.05) rejects += 1;
    sim.setUInt32(1, 'holding', 2, rejects);
    sim.setRegister(1, 'holding', 4, Math.round(wave(t, 118 - offset * 6, 2, 30, offset)));
    sim.setRegister(1, 'coil', 0, 1);
  };
};

/** An S7 CPU: DB1 with REAL/DINT/BOOL values. */
async function startS7Cpu({ identity, fill }) {
  const { createS7Simulator } = requireServer('./test/support/s7Simulator.js');
  const db1 = Buffer.alloc(64);
  const sim = createS7Simulator({ dbs: { 1: db1 }, identity });
  const port = await sim.start();
  const started = Date.now();
  const tick = () => fill(db1, (Date.now() - started) / 1000);
  tick();
  const timer = setInterval(tick, 1000);
  return { port, close: async () => { clearInterval(timer); await sim.stop(); } };
}

const compressorDb = (() => {
  let hours = 18_342;
  return (db, t) => {
    db.writeFloatBE(wave(t, 7.4, 0.12, 26), 0); // DBD0 discharge pressure, bar
    db.writeFloatBE(wave(t, 78, 1.5, 61), 4); // DBD4 discharge temperature, C
    db.writeFloatBE(wave(t, 31.5, 1.2, 37), 8); // DBD8 free air delivery, m3/min
    db[12] = 1; // DBX12.0 running
    if (Math.random() < 0.01) hours += 1;
    db.writeInt32BE(hours, 14); // DBD14 running hours
  };
})();

const wastewaterDb = (db, t) => {
  db.writeFloatBE(wave(t, 2.1, 0.15, 44), 0); // DBD0 dissolved oxygen, mg/l
  db.writeFloatBE(wave(t, 7.2, 0.05, 90), 4); // DBD4 pH
  db.writeFloatBE(wave(t, 48, 4, 52), 8); // DBD8 blower speed, %
  db[12] = 1; // DBX12.0 blower running
};

/** A Logix controller with plant tag names. */
async function startLogix(tags) {
  const { EipSimulator, STRING_TPL, MOTOR_TPL } = requireServer('./test/support/eipSimulator.js');
  const SIZE = { BOOL: 1, DINT: 4, REAL: 4 };
  const controller = tags.map(([name, type]) => ({ name, type, dims: [], data: Buffer.alloc(SIZE[type]), access: 0 }));
  controller.push({ name: 'Program:MainProgram', program: true });
  const programs = { MainProgram: [{ name: 'StepNumber', type: 'DINT', dims: [], data: Buffer.alloc(4), access: 0 }] };
  const sim = await new EipSimulator({ database: { controller, programs, templates: [STRING_TPL, MOTOR_TPL] } }).start();
  const started = Date.now();
  const byName = new Map(controller.map((c) => [c.name, c]));
  const tick = () => {
    const t = (Date.now() - started) / 1000;
    for (const [name, type, gen] of tags) {
      const v = gen(t);
      const buf = byName.get(name).data;
      if (type === 'REAL') buf.writeFloatLE(v, 0);
      else if (type === 'DINT') buf.writeInt32LE(Math.round(v), 0);
      else buf[0] = v ? 1 : 0;
    }
    programs.MainProgram[0].data.writeInt32LE(10 + (Math.floor(t / 6) % 8) * 10, 0);
  };
  tick();
  const timer = setInterval(tick, 1000);
  return { port: sim.port, close: async () => { clearInterval(timer); await sim.stop(); } };
}

/** A small OPC UA server for bottling line 1 (node-opcua, security None, anonymous). */
async function startBottlingServer() {
  const { OPCUAServer, Variant, DataType, StatusCodes, standardUnits, makeEUInformation, nodesets } = requireServer('node-opcua');
  const pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-docs-ua-'));
  const removePki = () => fs.rmSync(pkiDir, { recursive: true, force: true });
  process.on('exit', removePki);
  const { OPCUACertificateManager, SecurityPolicy, MessageSecurityMode } = requireServer('node-opcua');
  const certificateManager = new OPCUACertificateManager({ rootFolder: pkiDir, automaticallyAcceptUnknownCertificate: true });
  await certificateManager.initialize();
  const server = new OPCUAServer({
    port: 0,
    hostname: '127.0.0.1',
    alternateHostname: ['127.0.0.1'],
    nodeset_filename: [nodesets.standard],
    serverCertificateManager: certificateManager,
    securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
    securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
    allowAnonymous: true,
    buildInfo: { productName: 'Line 1 SCADA gateway', manufacturerName: 'Demo plant', softwareVersion: '4.2.0' },
    serverInfo: { applicationUri: 'urn:demo:riverside:bottling-line-1', productUri: 'urn:demo:scada-gateway', applicationName: { text: 'Bottling line 1 gateway' } },
    isAuditing: false
  });
  await server.initialize();
  const addressSpace = server.engine.addressSpace;
  const ns = addressSpace.getOwnNamespace();
  const live = [];
  // String node ids, as PLC gateways usually expose them: ns=1;s=Line1.Filler.Speed
  const idOf = (parent, name) => `s=${[parent.__path, name].filter(Boolean).join('.')}`;
  const folder = (parent, name) => {
    const f = ns.addFolder(parent, { browseName: name, ...(parent.__path !== undefined ? { nodeId: idOf(parent, name) } : {}) });
    f.__path = parent.__path !== undefined ? [parent.__path, name].filter(Boolean).join('.') : '';
    return f;
  };
  const analog = (parent, name, unit, low, high, gen, description) => {
    const node = ns.addAnalogDataItem({ componentOf: parent, browseName: name, nodeId: idOf(parent, name), dataType: 'Double', engineeringUnitsRange: { low, high }, engineeringUnits: unit, minimumSamplingInterval: 0, description });
    live.push([node, DataType.Double, gen]);
  };
  const plain = (parent, name, dataType, gen, description) => {
    const node = ns.addVariable({ componentOf: parent, browseName: name, nodeId: idOf(parent, name), dataType, minimumSamplingInterval: 0, description });
    live.push([node, dataType, gen]);
  };
  const bpm = makeEUInformation('bpm', 'bpm', 'bottles per minute');
  const ml = makeEUInformation('ml', 'ml', 'millilitre');
  const nm = makeEUInformation('N·m', 'N·m', 'newton metre');
  const line = folder(folder(folder(addressSpace.rootFolder.objects, 'Riverside'), 'Bottling'), 'Line1');
  const filler = folder(line, 'Filler');
  analog(filler, 'Speed', bpm, 0, 600, (t) => wave(t, 412, 6, 25), 'Filler output speed');
  analog(filler, 'FillVolume', ml, 480, 520, (t) => wave(t, 500.4, 0.6, 9), 'Average fill volume of the last 20 bottles');
  analog(filler, 'ProductTemperature', standardUnits.degree_celsius, 0, 40, (t) => wave(t, 6.8, 0.2, 70), 'Product temperature at the bowl');
  plain(filler, 'GoodCount', DataType.UInt32, (t) => 182_400 + Math.floor(t * 6.8), 'Good bottles this shift');
  plain(filler, 'Running', DataType.Boolean, () => true, 'Filler running');
  const capper = folder(line, 'Capper');
  analog(capper, 'Torque', nm, 0, 5, (t) => wave(t, 2.1, 0.05, 13), 'Average application torque');
  plain(capper, 'RejectCount', DataType.UInt32, (t) => 214 + Math.floor(t / 45), 'Rejected bottles this shift');
  plain(capper, 'Running', DataType.Boolean, () => true, 'Capper running');
  const labeler = folder(line, 'Labeler');
  analog(labeler, 'Speed', bpm, 0, 600, (t) => wave(t, 411, 6, 25, 0.3), 'Labeler speed');
  analog(labeler, 'GlueTemperature', standardUnits.degree_celsius, 100, 200, (t) => wave(t, 162, 1, 60), 'Hot-melt glue temperature');
  plain(labeler, 'Running', DataType.Boolean, () => true, 'Labeler running');
  const started = Date.now();
  const tick = () => {
    const t = (Date.now() - started) / 1000;
    for (const [node, dt, gen] of live) {
      const v = gen(t);
      node.setValueFromSource(new Variant({ dataType: dt, value: dt === DataType.Double ? round(v, 2) : v }), StatusCodes.Good, new Date());
    }
  };
  tick();
  await server.start();
  const timer = setInterval(tick, 1000);
  const port = server.endpoints[0].port;
  return {
    port,
    endpointUrl: `opc.tcp://127.0.0.1:${port}`,
    async close() {
      clearInterval(timer);
      try {
        await server.shutdown(0);
      } finally {
        removePki();
        process.off('exit', removePki);
      }
    }
  };
}

/** Historian stand-ins: accept writes (Timebase dataset data, InfluxDB v2 write) and count them. */
async function startHistorianStandIn() {
  let received = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received += 1;
      if (req.url.startsWith('/api/v2/write')) {
        res.statusCode = 204;
        return res.end();
      }
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        return res.end('{"data":[]}');
      }
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, received: () => received, close: () => new Promise((resolve) => server.close(resolve)) };
}

// ---- backend -------------------------------------------------------------------------------

async function startBackend({ brokerPort }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-docs-'));
  fs.writeFileSync(
    path.join(dataDir, 'profiles.json'),
    JSON.stringify({
      mqtt: { 'plant-broker': { config: { id: 'plant-broker', name: 'Plant broker', host: '127.0.0.1', port: brokerPort, protocol: 'mqtt', autoSubscribe: true, reconnect: true, reconnectPeriod: 2000 } } },
      opcua: {},
      cesmii: null,
      i3x: null
    })
  );
  const port = await freePort();
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), MANIFOLD_DATA_DIR: dataDir, MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1', MANIFOLD_ALLOW_PRIVATE_TARGETS: '1', MANIFOLD_AUTH_TOKEN: '', MANIFOLD_VIEWER_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Last resort if this process exits before the async cleanup ran (a signal, a library calling process.exit).
  const onExit = () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  process.on('exit', onExit);
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  try {
    await until(async () => child.exitCode === null && (await fetch(`${url}/health`)).ok, { timeout: 40_000, what: 'the backend' });
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n${output.slice(-4000)}`);
  }
  return {
    url,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve))), sleep(5000)]);
      child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
      process.off('exit', onExit);
    }
  };
}

// ---- seeding -------------------------------------------------------------------------------

async function seed(api, plant) {
  const ids = {};
  const device = async (body) => {
    const d = await api.post('/api/devices', { enabled: true, ...body });
    return d.id;
  };

  // Devices -----------------------------------------------------------------------------
  ids.boiler = await device({
    name: 'Boiler house PLC',
    protocol: 'modbus-tcp',
    host: '127.0.0.1',
    port: plant.boiler.port,
    unitId: 1,
    pollGroups: [{ id: 'default', intervalMs: 1000 }],
    tags: [
      { key: 'supply_temp', address: 'holding:0', type: 'int16', scale: 0.1, unit: '°C', description: 'Boiler supply water temperature (raw is tenths of a degree)', property: 'supply_temperature', range: { min: 0, max: 120 }, pollGroup: 'default' },
      { key: 'burner_rpm', address: 'holding:1', type: 'uint16', unit: 'rpm', description: 'Burner fan speed', property: 'burner_speed', pollGroup: 'default' },
      { key: 'gas_flow', address: 'holding:2', type: 'float32', unit: 'm³/h', description: 'Gas flow to the burner', property: 'gas_flow', pollGroup: 'default' },
      { key: 'steam_pressure', address: 'holding:4', type: 'float32', wordOrder: 'little', unit: 'bar', description: 'Steam header pressure', property: 'steam_pressure', pollGroup: 'default' },
      { key: 'burner_on', address: 'coil:0', type: 'bool', description: 'Burner running', property: 'burner_running', pollGroup: 'default' }
    ]
  });
  // A PLC that is unreachable today (nothing listens on its port): it shows as connecting.
  ids.cooling = await device({
    name: 'Cooling tower PLC',
    protocol: 'modbus-tcp',
    host: '127.0.0.1',
    port: plant.coolingPort,
    unitId: 1,
    pollGroups: [{ id: 'default', intervalMs: 2000 }],
    tags: [
      { key: 'basin_temp', address: 'holding:0', type: 'int16', scale: 0.1, unit: '°C', description: 'Basin water temperature', pollGroup: 'default' },
      { key: 'fan_speed', address: 'holding:1', type: 'uint16', unit: '%', description: 'Fan speed', pollGroup: 'default' }
    ]
  });
  const profile = await api.post('/api/devices/profiles', {
    name: 'Checkweigher',
    protocol: 'modbus-tcp',
    description: 'Inline checkweigher, Modbus TCP gateway, unit 1',
    params: [{ name: 'line' }],
    pollGroups: [{ id: 'default', intervalMs: 1000 }],
    tags: [
      { key: 'net_weight', address: 'holding:0', type: 'float32', unit: 'g', description: 'Net weight of the last pack' },
      { key: 'reject_count', address: 'holding:2', type: 'uint32', description: 'Packs rejected this shift' },
      { key: 'throughput', address: 'holding:4', type: 'uint16', unit: 'packs/min', description: 'Packs per minute' },
      { key: 'running', address: 'coil:0', type: 'bool', description: 'Belt running' }
    ]
  });
  ids.profile = profile.id;
  ids.cw1 = await device({ name: 'Checkweigher 1', protocol: 'modbus-tcp', host: '127.0.0.1', port: plant.cw1.port, unitId: 1, profileId: profile.id, params: { line: 'line-1' } });
  ids.cw2 = await device({ name: 'Checkweigher 2', protocol: 'modbus-tcp', host: '127.0.0.1', port: plant.cw2.port, unitId: 1, profileId: profile.id, params: { line: 'line-2' } });
  ids.compressor = await device({
    name: 'Compressor house S7-1500',
    protocol: 's7',
    host: '127.0.0.1',
    port: plant.compressor.port,
    rack: 0,
    slot: 1,
    pollGroups: [{ id: 'default', intervalMs: 1000 }],
    tags: [
      { key: 'discharge_pressure', address: 'DB1.DBD0', type: 'REAL', unit: 'bar', description: 'Compressor discharge pressure', pollGroup: 'default' },
      { key: 'discharge_temp', address: 'DB1.DBD4', type: 'REAL', unit: '°C', description: 'Discharge air temperature', pollGroup: 'default' },
      { key: 'air_flow', address: 'DB1.DBD8', type: 'REAL', unit: 'm³/min', description: 'Free air delivery', pollGroup: 'default' },
      { key: 'running', address: 'DB1.DBX12.0', type: 'BOOL', description: 'Compressor running', pollGroup: 'default' },
      { key: 'run_hours', address: 'DB1.DBD14', type: 'DINT', unit: 'h', description: 'Running hours', pollGroup: 'default' }
    ]
  });
  ids.wastewater = await device({
    name: 'Wastewater S7-1200',
    protocol: 's7',
    host: '127.0.0.1',
    port: plant.wastewater.port,
    rack: 0,
    slot: 1,
    pollGroups: [{ id: 'default', intervalMs: 2000 }],
    tags: [
      { key: 'dissolved_oxygen', address: 'DB1.DBD0', type: 'REAL', unit: 'mg/l', description: 'Aeration basin dissolved oxygen', pollGroup: 'default' },
      { key: 'ph', address: 'DB1.DBD4', type: 'REAL', unit: 'pH', description: 'Basin pH', pollGroup: 'default' },
      { key: 'blower_speed', address: 'DB1.DBD8', type: 'REAL', unit: '%', description: 'Aeration blower speed', pollGroup: 'default' },
      { key: 'blower_running', address: 'DB1.DBX12.0', type: 'BOOL', description: 'Blower running', pollGroup: 'default' }
    ]
  });
  ids.filler2 = await device({
    name: 'Filler line 2 (Logix)',
    protocol: 'ethernet-ip',
    host: '127.0.0.1',
    port: plant.filler2.port,
    slot: 0,
    pollGroups: [{ id: 'default', intervalMs: 1000 }],
    tags: [
      { key: 'speed', address: 'Filler_Speed', type: 'REAL', unit: 'bpm', description: 'Filler output speed', pollGroup: 'default' },
      { key: 'product_temp', address: 'Filler_ProductTemp', type: 'REAL', unit: '°C', description: 'Product temperature at the bowl', pollGroup: 'default' },
      { key: 'good_count', address: 'Filler_GoodCount', type: 'DINT', description: 'Good bottles this shift', pollGroup: 'default' },
      { key: 'running', address: 'Filler_Running', type: 'BOOL', description: 'Filler running', pollGroup: 'default' },
      { key: 'step', address: 'Program:MainProgram.StepNumber', type: 'DINT', description: 'Sequence step', pollGroup: 'default' }
    ]
  });
  ids.palletizer = await device({
    name: 'Palletizer cell (Logix)',
    protocol: 'ethernet-ip',
    host: '127.0.0.1',
    port: plant.palletizer.port,
    slot: 0,
    pollGroups: [{ id: 'default', intervalMs: 2000 }],
    tags: [
      { key: 'layers_done', address: 'Pal_LayerCount', type: 'DINT', description: 'Layers on the current pallet', pollGroup: 'default' },
      { key: 'cycle_time', address: 'Pal_CycleTime', type: 'REAL', unit: 's', description: 'Last layer cycle time', pollGroup: 'default' },
      { key: 'running', address: 'Pal_Running', type: 'BOOL', description: 'Cell running', pollGroup: 'default' }
    ]
  });

  // OPC UA ----------------------------------------------------------------------------------
  const ua = await api.post('/api/opcua/connections', { name: 'Bottling line 1 gateway', endpointUrl: plant.opcua.endpointUrl });
  ids.opcua = ua.connectionId;
  const uaTree = await resolveUaNodes(api, ids.opcua);

  // Historians ------------------------------------------------------------------------------
  ids.timebase = (await api.post('/api/historians', { type: 'timebase', name: 'Plant historian', url: plant.historian.url, dataset: 'Riverside' })).id;
  ids.influx = (await api.post('/api/historians', { type: 'influxdb', name: 'Energy dashboards', url: plant.influx.url, org: 'riverside', bucket: 'energy', token: 'demo-token' })).id;

  // Mappings --------------------------------------------------------------------------------
  const target = (assetPath, extra = {}) => ({ mode: 'mqtt', brokerId: 'plant-broker', assetPath, format: 'envelope', ...extra });
  const binding = async (body) => (await api.post('/api/tags/bindings', body)).id;
  ids.boilerMap = await binding({
    name: 'Boiler house to UNS',
    source: {
      type: 'device',
      deviceId: ids.boiler,
      tags: [
        { address: 'supply_temp', precision: 1, limits: { lo: 60, hi: 95, hihi: 105 } },
        { address: 'burner_rpm' },
        { address: 'gas_flow', precision: 1 },
        { address: 'steam_pressure', precision: 2, limits: { hi: 11.5, hihi: 12.5 } },
        { address: 'burner_on' }
      ]
    },
    target: target('acme/riverside/utilities/boiler-1', {
      context: { site: 'Riverside', area: 'Utilities', equipment: 'Steam boiler 1', device: '{device}' },
      historian: { historianId: ids.timebase }
    })
  });
  ids.compressorMap = await binding({
    name: 'Compressor house to UNS',
    source: { type: 'device', deviceId: ids.compressor, tags: 'all' },
    target: target('acme/riverside/utilities/compressor-1', { context: { site: 'Riverside', area: 'Utilities', equipment: 'Air compressor 1' } })
  });
  ids.checkweighers = await binding({
    name: 'Checkweighers to UNS',
    source: { type: 'device-profile', profileId: ids.profile, tags: 'all' },
    target: { mode: 'mqtt', brokerId: 'plant-broker', format: 'envelope', assetPathTemplate: 'acme/riverside/packaging/{line}/checkweigher', context: { site: 'Riverside', area: 'Packaging', line: '{param:line}' } }
  });
  ids.fillerMap = await binding({
    name: 'Filler line 2 to UNS',
    source: { type: 'device', deviceId: ids.filler2, tags: [{ address: 'speed' }, { address: 'product_temp' }, { address: 'good_count' }, { address: 'running' }] },
    target: target('acme/riverside/bottling/line-2/filler')
  });
  ids.uaMap = await binding({
    name: 'Bottling line 1 to UNS',
    source: {
      type: 'opcua',
      connectionId: ids.opcua,
      tags: [
        { address: uaTree['Filler/Speed'], name: 'filler_speed' },
        { address: uaTree['Filler/FillVolume'], name: 'fill_volume' },
        { address: uaTree['Filler/ProductTemperature'], name: 'product_temperature' },
        { address: uaTree['Filler/GoodCount'], name: 'good_count' },
        { address: uaTree['Capper/Torque'], name: 'capper_torque' },
        { address: uaTree['Labeler/GlueTemperature'], name: 'glue_temperature' }
      ]
    },
    target: target('acme/riverside/bottling/line-1', { context: { site: 'Riverside', area: 'Bottling', line: 'Line 1' } })
  });
  ids.ahuMap = await binding({
    name: 'Air handling unit 1',
    source: {
      type: 'mqtt',
      brokerId: 'plant-broker',
      field: 'value',
      staleAfterMs: 30_000,
      tags: [
        { address: 'legacy/hvac/ahu1/sat', name: 'supply_air_temperature', unit: '°C', description: 'Supply air temperature' },
        { address: 'legacy/hvac/ahu1/rat', name: 'return_air_temperature', unit: '°C', description: 'Return air temperature' },
        { address: 'legacy/hvac/ahu1/fan', name: 'fan_speed', unit: '%', description: 'Supply fan speed' },
        { address: 'legacy/hvac/ahu1/filter_dp', name: 'filter_differential_pressure', unit: 'Pa', description: 'Filter differential pressure' }
      ]
    },
    target: target('acme/riverside/building/ahu-1', { context: { site: 'Riverside', area: 'Building services', equipment: 'AHU 1' } })
  });

  // Pipeline routes ---------------------------------------------------------------------------
  ids.routeLegacy = (await api.post('/api/pipelines', {
    name: 'Legacy meters into the UNS',
    source: { brokerId: 'plant-broker', filter: 'legacy/meters/+/kw' },
    transforms: [{ type: 'numeric', field: 'value' }, { type: 'repath', to: 'acme/riverside/energy/{3}/power' }, { type: 'envelope' }],
    target: { type: 'mqtt', brokerId: 'plant-broker', retain: true, qos: 0 }
  })).id;
  ids.routeHistorian = (await api.post('/api/pipelines', {
    name: 'Press shop to plant historian',
    source: { brokerId: 'plant-broker', filter: 'acme/riverside/press-shop/#' },
    transforms: [{ type: 'numeric', field: 'value' }],
    target: { type: 'historian', historianId: ids.timebase }
  })).id;
  ids.routeInflux = (await api.post('/api/pipelines', {
    name: 'Energy to dashboards',
    source: { brokerId: 'plant-broker', filter: 'acme/riverside/energy/#' },
    transforms: [{ type: 'numeric', field: 'value' }],
    target: { type: 'historian', historianId: ids.influx }
  })).id;

  // Alert rules -----------------------------------------------------------------------------
  await api.post('/api/alerts/rules', { name: 'Steam pressure high', type: 'value-threshold', brokerId: 'plant-broker', topic: 'acme/riverside/utilities/boiler-1/steam_pressure', field: 'v', op: '>', value: 12, sustainMs: 10_000 });
  await api.post('/api/alerts/rules', { name: 'Main incomer silent', type: 'topic-silent', brokerId: 'plant-broker', topic: 'acme/riverside/energy/main-incomer/power', thresholdMs: 60_000 });

  // Recording for Trends ------------------------------------------------------------------------
  const filter = `spBv1.0/${TREND.group}/DDATA/${TREND.node}/${TREND.device}`;
  ids.recording = (await api.post('/api/recorder', { name: 'Boiler 1 commissioning', brokerId: 'plant-broker', filter, target: { type: 'file' } })).id;
  await sleep(500);
  const trend = await plant.broker.backfillTrend();
  ids.trendTags = trend.tags;
  await until(async () => ((await api.get(`/api/recorder/${ids.recording}/data?limit=1`)).total || 0) >= 12, { what: 'the recording', timeout: 30_000 });
  return ids;
}

/** Walk the bottling server's address space through the backend's browse API: { 'Filler/Speed': nodeId }. */
async function resolveUaNodes(api, connectionId) {
  const browse = async (nodeId) => {
    const r = await api.get(`/api/opcua/connections/${encodeURIComponent(connectionId)}/browse?nodeId=${encodeURIComponent(nodeId)}`);
    return r.references || r.nodes || r.children || r;
  };
  const nameOf = (n) => n.browseName?.name || n.browseName || n.displayName?.text || n.displayName;
  const find = async (parent, name) => {
    const list = await until(async () => {
      const l = await browse(parent);
      return Array.isArray(l) && l.length ? l : null;
    }, { what: `OPC UA browse of ${parent}` });
    const hit = list.find((n) => String(nameOf(n)).replace(/^\d+:/, '') === name);
    if (!hit) throw new Error(`OPC UA node ${name} not found under ${parent}: ${JSON.stringify(list).slice(0, 300)}`);
    return hit.nodeId;
  };
  const line = await find(await find(await find('ns=0;i=85', 'Riverside'), 'Bottling'), 'Line1');
  const out = {};
  for (const [machine, vars] of [['Filler', ['Speed', 'FillVolume', 'ProductTemperature', 'GoodCount']], ['Capper', ['Torque']], ['Labeler', ['GlueTemperature']]]) {
    const m = await find(line, machine);
    for (const v of vars) out[`${machine}/${v}`] = await find(m, v);
  }
  return out;
}

// ---- screenshots ---------------------------------------------------------------------------

/** Wait until nothing on the page says it is loading and fonts are in. */
async function settle(page, ms = 600) {
  await page.evaluate(() => document.fonts?.ready);
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"], .animate-spin'), null, { timeout: 15_000 })
    .catch(() => {});
  await sleep(ms);
}

async function hideToasts(page) {
  await page.addStyleTag({ content: '[role="status"][aria-live] > div:has(> div[role="status"]), .go2072408551, [data-hot-toast] { display: none !important; }' }).catch(() => {});
}

/**
 * Every image: name, page path, theme, viewport, and what to do before the capture.
 * `ids` holds what the seeding created (device ids, mapping ids, ...).
 */
function shots(ids) {
  const dlg = (page, name) => page.getByRole('dialog', { name, exact: true });
  return [
    { name: 'overview', path: '/', wait: async (page) => { await page.getByText('Needs attention').first().waitFor(); await sleep(2500); } },
    { name: 'overview-light', path: '/', theme: 'light', wait: async (page) => { await page.getByText('Needs attention').first().waitFor(); await sleep(2500); } },
    {
      name: 'devices',
      path: '/devices',
      wait: async (page) => {
        await page.getByRole('row').filter({ hasText: 'Boiler house PLC' }).getByText('Online', { exact: true }).waitFor();
        await sleep(2500);
      }
    },
    {
      name: 'devices-light',
      path: '/devices',
      theme: 'light',
      wait: async (page) => {
        await page.getByRole('row').filter({ hasText: 'Boiler house PLC' }).getByText('Online', { exact: true }).waitFor();
        await sleep(2500);
      }
    },
    {
      name: 'device-detail',
      path: '/devices',
      wait: async (page) => {
        await page.getByRole('button', { name: 'Boiler house PLC', exact: true }).click();
        const drawer = page.getByRole('dialog', { name: 'Boiler house PLC' });
        await drawer.waitFor();
        await drawer.getByRole('tab', { name: /^Tags/ }).click();
        await drawer.locator('tr[data-tag-key="steam_pressure"] [data-quality="good"]').waitFor();
        await sleep(1500);
      }
    },
    {
      name: 'device-form',
      path: `/devices?edit=${ids.compressor}`,
      wait: async (page) => {
        if (!(await page.getByRole('heading', { level: 1, name: /Edit|Compressor/ }).count())) {
          await page.getByRole('button', { name: 'Compressor house S7-1500', exact: true }).click();
          const drawer = page.getByRole('dialog', { name: 'Compressor house S7-1500' });
          await drawer.getByRole('button', { name: /^Edit/ }).first().click();
        }
        await page.getByRole('radio', { name: 'S7-1200 / S7-1500' }).waitFor();
        await sleep(800);
      }
    },
    {
      name: 'device-profiles',
      path: '/devices?tab=profiles',
      wait: async (page) => {
        await page.getByText('Checkweigher', { exact: true }).first().waitFor();
        await sleep(800);
      }
    },
    {
      name: 'discovery',
      path: '/discovery',
      wait: async (page, ctx) => runDiscovery(page, ctx)
    },
    {
      name: 'opcua',
      path: '/opcua',
      wait: async (page) => openOpcuaBrowse(page)
    },
    {
      name: 'broker-form',
      path: '/brokers',
      wait: async (page) => {
        await page.getByRole('button', { name: /Connect broker|Add broker|Connect a broker/ }).first().click();
        const form = page.getByRole('dialog').first();
        await form.waitFor();
        await form.getByLabel('Name', { exact: true }).fill('Lakeside plant broker');
        await form.getByLabel('Host', { exact: true }).fill('mqtt.lakeside.example');
        await sleep(600);
      }
    },
    {
      name: 'tags-workspace',
      path: `/tags?source=device:${ids.boiler}`,
      wait: async (page) => {
        await page.getByText('supply_temperature').first().waitFor();
        await sleep(1200);
      }
    },
    {
      name: 'mappings',
      path: '/tags?view=mappings',
      wait: async (page) => {
        const row = page.getByRole('row').filter({ hasText: 'Boiler house to UNS' });
        await row.waitFor();
        await row.getByRole('button', { name: /Expand|Show topics|Boiler house to UNS/ }).first().click().catch(() => {});
        await sleep(1500);
      }
    },
    { name: 'mapping-editor', path: '/tags?view=mappings', wait: async (page) => openMappingEditor(page, dlg, 'Boiler house to UNS', 'tag') },
    { name: 'mapping-editor-context', path: '/tags?view=mappings', wait: async (page) => openMappingEditor(page, dlg, 'Boiler house to UNS', 'context') },
    { name: 'mapping-editor-light', path: '/tags?view=mappings', theme: 'light', wait: async (page) => openMappingEditor(page, dlg, 'Bottling line 1 to UNS', 'tag') },
    {
      name: 'pipelines',
      path: '/pipelines',
      wait: async (page) => {
        await page.getByRole('row').filter({ hasText: 'Legacy meters into the UNS' }).waitFor();
        await sleep(2500);
      }
    },
    {
      name: 'route-editor',
      path: '/pipelines',
      wait: async (page) => {
        const row = page.getByRole('row').filter({ hasText: 'Legacy meters into the UNS' });
        await row.getByRole('button', { name: /^Edit/ }).first().click();
        await page.getByRole('dialog').first().waitFor();
        await sleep(1500);
      }
    },
    {
      name: 'historians',
      path: '/pipelines?tab=historians',
      wait: async (page) => {
        await page.getByRole('row').filter({ hasText: 'Plant historian' }).waitFor();
        await sleep(2000);
      }
    },
    { name: 'trends', path: '/trends', wait: async (page) => openTrends(page, ids) },
    {
      name: 'flows',
      path: '/flows',
      wait: async (page) => {
        await page.getByText('Sparkplug devices').first().waitFor();
        await sleep(5000);
      }
    },
    {
      name: 'health',
      path: '/system',
      wait: async (page) => {
        await page.getByRole('heading', { level: 1, name: 'Health' }).waitFor();
        await sleep(2500);
      }
    },
    {
      name: 'settings',
      path: '/settings',
      wait: async (page) => {
        await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
        await sleep(800);
      }
    },
    { name: 'topics-graph', path: '/topics?broker=plant-broker', wait: async (page) => topicsView(page, 'Graph') },
    { name: 'topics-3d', path: '/topics?broker=plant-broker', wait: async (page) => topicsView(page, '3D') },
    { name: 'uns-topology', path: '/uns?broker=plant-broker&path=acme/riverside/utilities/boiler-1', wait: async (page) => unsTopology(page) },
    { name: 'uns-topology-light', path: '/uns?broker=plant-broker&path=acme/riverside/utilities/boiler-1', theme: 'light', wait: async (page) => unsTopology(page) },
    {
      name: 'phone-devices',
      path: '/devices',
      viewport: PHONE,
      wait: async (page) => {
        await page.getByText('Boiler house PLC').first().waitFor();
        await sleep(2000);
      }
    },
    {
      name: 'phone-uns',
      path: '/uns?broker=plant-broker&path=acme/riverside/utilities/boiler-1',
      viewport: PHONE,
      wait: async () => sleep(5000)
    }
  ];
}

async function openMappingEditor(page, dlg, name, focus) {
  await page.getByRole('button', { name: `Edit mapping ${name}` }).click();
  const editor = dlg(page, `Edit ${name}`);
  await editor.getByRole('heading', { name: `Edit ${name}` }).waitFor();
  const preview = editor.getByRole('complementary', { name: 'Preview' });
  await preview.getByText('Checked by the server', { exact: true }).waitFor({ timeout: 20_000 });
  if (focus === 'tag') {
    await editor.getByRole('button', { name: /^Tags/ }).first().click().catch(() => {});
    await editor.getByRole('button', { name: /^Details of / }).first().click();
    await page.mouse.move(5, 5); // no tooltip in the picture
  } else if (focus === 'context') {
    await editor.getByRole('button', { name: /^Context/ }).first().click().catch(() => {});
  }
  await sleep(1500);
}

async function openOpcuaBrowse(page) {
  const name = 'Bottling line 1 gateway';
  await page.getByRole('row').filter({ hasText: name }).getByText('Connected', { exact: true }).waitFor();
  const explorer = page.getByRole('region', { name: 'Address space explorer' });
  await explorer.getByRole('radio', { name: 'Tree' }).click();
  const tree = explorer.getByRole('tree', { name: 'Nodes' });
  const item = (n) => tree.getByRole('treeitem').filter({ has: page.getByText(n, { exact: true }) }).first();
  const path = [name, 'Objects', 'Riverside', 'Bottling', 'Line1', 'Filler'];
  for (let i = 0; i < path.length - 1; i++) {
    await item(path[i]).focus();
    await item(path[i]).press('ArrowRight');
    await item(path[i + 1]).waitFor();
  }
  await item('Filler').focus();
  await item('Filler').press('ArrowRight');
  await item('FillVolume').waitFor();
  await item('Speed').press('Enter');
  const details = page.getByRole('complementary', { name: 'Node details' });
  // The mapping already samples this node; otherwise start monitoring it here.
  await details.getByRole('button', { name: /Monitor value|Stop monitoring/ }).waitFor();
  if (await details.getByRole('button', { name: 'Monitor value' }).count()) await details.getByRole('button', { name: 'Monitor value' }).click();
  await page.getByRole('table', { name: 'Monitored values' }).getByText('Good', { exact: true }).first().waitFor();
  await sleep(2000);
}

async function openTrends(page, ids) {
  await page.getByRole('radio', { name: 'Recording' }).click();
  await page.locator('select').first().selectOption(ids.recording);
  await page.getByRole('radio', { name: '6h' }).click().catch(() => {});
  const input = page.getByPlaceholder(/Search topics|Type the tag/);
  for (const t of ids.trendTags) {
    await input.fill(t);
    await input.press('Enter');
  }
  await page.getByRole('list', { name: 'Series' }).getByText('bar · right axis').waitFor({ timeout: 30_000 });
  await input.blur();
  await sleep(1500);
}

async function topicsView(page, view) {
  await page.getByRole('radio', { name: view }).click();
  await sleep(view === '3D' ? 9000 : 6000);
}

async function unsTopology(page) {
  // The deep link expands to boiler-1 and selects it; wait for its details, then for the layout.
  await page.getByText('Topics in branch').first().waitFor();
  await sleep(2500);
  await page.getByRole('button', { name: /^Fit to view/ }).first().click();
  await page.mouse.move(5, 5); // no tooltip in the picture
  await sleep(2500);
}

async function runDiscovery(page, ctx) {
  const { plant } = ctx;
  const box = (name) => page.getByRole('textbox', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}( |$)`) });
  await page.getByLabel('Range: CIDR, IP address or hostname').fill('127.0.0.1/32');
  await page.getByRole('checkbox', { name: /^i3X servers/ }).uncheck().catch(() => {});
  for (const name of [/^Modbus TCP/, /^Siemens S7/, /^EtherNet\/IP/]) await page.getByRole('checkbox', { name }).check();
  await page.getByRole('checkbox', { name: /^I understand/ }).click();
  const toggle = page.getByRole('button', { name: 'Advanced options' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await box('MQTT brokers ports').fill(String(plant.broker.port));
  await box('MQTT over WebSocket ports').fill('');
  await box('OPC UA servers ports').fill(String(plant.opcua.port));
  await box('Modbus TCP ports').fill(`${plant.boiler.port}, ${plant.cw1.port}, ${plant.cw2.port}, ${plant.spareMeter.port}`);
  await box('Siemens S7 ports').fill(`${plant.compressor.port}, ${plant.wastewater.port}`);
  await box('EtherNet/IP ports').fill(`${plant.filler2.port}, ${plant.palletizer.port}`);
  await toggle.click();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await page.getByText(/Last scan of 127\.0\.0\.1\/32/).first().waitFor({ timeout: 60_000 });
  await page.locator(`tr[data-endpoint="127.0.0.1:${plant.opcua.port}"]`).waitFor();
  // The results are the point of the image: bring them to the top.
  await page.locator('#discovery-results').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sleep(1500);
}

// ---- main ----------------------------------------------------------------------------------

async function startEverything(cleanups) {
  log('starting the demo plant');
  const plant = {};
  plant.broker = await startPlantBroker();
  cleanups.push(() => plant.broker.close());
  plant.boiler = await startModbusUnit(boilerRegisters);
  plant.cw1 = await startModbusUnit(checkweigherRegisters(0));
  plant.cw2 = await startModbusUnit(checkweigherRegisters(1));
  // A meter on the network that Manifold does not have yet: Discovery finds it.
  plant.spareMeter = await startModbusUnit((sim, t) => sim.setRegister(1, 'holding', 0, Math.round(wave(t, 230, 2, 30))));
  for (const k of ['boiler', 'cw1', 'cw2', 'spareMeter']) cleanups.push(() => plant[k].close());
  plant.coolingPort = await freePort();
  plant.compressor = await startS7Cpu({
    identity: { systemName: 'Compressor house', moduleName: 'CPU 1515-2 PN', serialNumber: 'S C-DEMO15151', moduleTypeName: 'CPU 1515-2 PN', orderCode: '6ES7 515-2AM02-0AB0', firmware: [2, 9, 4] },
    fill: compressorDb
  });
  plant.wastewater = await startS7Cpu({
    identity: { systemName: 'Wastewater', moduleName: 'CPU 1214C DC/DC/DC', serialNumber: 'S C-DEMO12141', moduleTypeName: 'CPU 1214C DC/DC/DC', orderCode: '6ES7 214-1AG40-0XB0', firmware: [4, 6, 1] },
    fill: wastewaterDb
  });
  cleanups.push(() => plant.compressor.close(), () => plant.wastewater.close());
  let good = 96_200;
  plant.filler2 = await startLogix([
    ['Filler_Speed', 'REAL', (t) => wave(t, 398, 5, 27)],
    ['Filler_ProductTemp', 'REAL', (t) => wave(t, 7.1, 0.2, 80)],
    ['Filler_GoodCount', 'DINT', () => (good += 7)],
    ['Filler_Running', 'BOOL', () => true]
  ]);
  let layers = 3;
  plant.palletizer = await startLogix([
    ['Pal_LayerCount', 'DINT', (t) => (layers = 1 + (Math.floor(t / 40) % 8))],
    ['Pal_CycleTime', 'REAL', (t) => wave(t, 38, 1.5, 50)],
    ['Pal_Running', 'BOOL', () => layers > 0]
  ]);
  cleanups.push(() => plant.filler2.close(), () => plant.palletizer.close());
  plant.opcua = await startBottlingServer();
  cleanups.push(() => plant.opcua.close());
  plant.historian = await startHistorianStandIn();
  plant.influx = await startHistorianStandIn();
  cleanups.push(() => plant.historian.close(), () => plant.influx.close());

  log('starting the backend');
  const backend = await startBackend({ brokerPort: plant.broker.port });
  cleanups.push(() => backend.stop());
  const api = makeApi(backend.url);
  await until(async () => ((await api.get('/api/mqtt/brokers/plant-broker/topics?limit=100000')).topics || []).length >= plant.broker.topicCount, { what: 'the broker topics', timeout: 40_000 });

  log('seeding');
  const ids = await seed(api, plant);
  log('waiting for devices, mappings and counters to settle');
  await until(async () => {
    const { devices } = await api.get('/api/devices');
    return devices.filter((d) => d.status?.state === 'online').length >= 7 || null;
  }, { what: 'seven devices online', timeout: 60_000 }).catch((e) => log('warning:', e.message));
  await sleep(12_000);

  return { plant, backend, api, ids };
}

async function launchBrowser() {
  const fallback = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  try {
    return await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  } catch (error) {
    if (!fs.existsSync(fallback)) throw error;
    return chromium.launch({ executablePath: fallback });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 9).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return;
  }
  if (!fs.existsSync(path.join(root, 'client/dist/index.html'))) throw new Error('client/dist is missing: run `npm run build` in client/ first.');

  const cleanups = [];
  const cleanupAll = async () => {
    for (const c of cleanups.reverse()) await c().catch((e) => log('cleanup:', e.message));
  };
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    cleanupAll().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    let plant, backend, ids;
    if (opts.attach) {
      if (!fs.existsSync(STATE_FILE)) throw new Error('--attach needs a running `--serve` instance');
      ({ plant, ids, url: backend } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      backend = { url: backend };
    } else {
      ({ plant, backend, ids } = await startEverything(cleanups));
    }
    const api = makeApi(backend.url);

    if (opts.serve) {
      log(`serving ${backend.url} (Ctrl-C to stop)`);
      fs.writeFileSync(STATE_FILE, JSON.stringify({ url: backend.url, ids, plant: Object.fromEntries(Object.entries(plant).map(([k, v]) => [k, typeof v === 'object' ? { port: v.port } : v])) }, null, 2));
      cleanups.push(async () => fs.rmSync(STATE_FILE, { force: true }));
      await new Promise(() => {});
    }

    const outDir = opts.out || WIKI_IMAGES;
    fs.mkdirSync(outDir, { recursive: true });
    const browser = await launchBrowser();
    cleanups.push(() => browser.close());
    const list = shots(ids).filter((s) => !opts.only || opts.only.has(s.name));
    if (opts.only) for (const n of opts.only) if (!list.some((s) => s.name === n)) throw new Error(`no image called "${n}"`);
    const failures = [];
    for (const shot of list) {
      const context = await browser.newContext({
        baseURL: backend.url,
        viewport: shot.viewport || DESKTOP,
        deviceScaleFactor: 2,
        colorScheme: shot.theme || 'dark',
        reducedMotion: 'reduce',
        ...(shot.viewport === PHONE ? { isMobile: true, hasTouch: true } : {})
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(shot.path);
        await hideToasts(page);
        await settle(page, 300);
        await shot.wait(page, { plant, ids, api });
        await settle(page, 300);
        const file = path.join(outDir, `${shot.name}.png`);
        await page.screenshot({ path: file });
        if (!opts.out && SITE_COPIES.includes(shot.name)) fs.copyFileSync(file, path.join(SITE_ASSETS, `${shot.name}.png`));
        log(`wrote ${path.relative(root, file)}${errors.length ? ` (page errors: ${errors.join('; ')})` : ''}`);
      } catch (error) {
        failures.push(shot.name);
        log(`FAILED ${shot.name}: ${error.message.split('\n')[0]}`);
        await page.screenshot({ path: path.join(os.tmpdir(), `manifold-docs-failed-${shot.name}.png`) }).catch(() => {});
      } finally {
        await context.close();
      }
    }
    if (failures.length) {
      process.exitCode = 1;
      log(`failed: ${failures.join(', ')} (a screenshot of each failure is in ${os.tmpdir()})`);
    }
  } finally {
    await cleanupAll();
  }
}

main().catch((error) => {
  console.error('[docs:shots]', error.stack || error.message);
  process.exit(1);
});
