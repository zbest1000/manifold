/**
 * Helpers shared by the functional specs.
 *
 *   - device simulators (Modbus, S7, EtherNet/IP) started IN the test worker from
 *     server/test/support, one fresh instance per test, closed afterwards. They listen on
 *     127.0.0.1 with OS-chosen ports; the backend is started with
 *     MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 so it may connect to them;
 *   - REST helpers against the real backend (cleanup of what a test created);
 *   - an MQTT subscription on the broker the backend publishes to (E2E_MQTT_PORT).
 *
 * Each test names everything it creates with a unique suffix and removes it again, so the
 * specs are independent of each other and of the order they run in.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../../server');
const requireServer = createRequire(path.join(serverDir, 'package.json'));

export const baseUrl = () => `http://127.0.0.1:${process.env.E2E_PORT}`;

let counter = 0;
/** A short unique token for names, safe in topics and ids. */
export const unique = (prefix) => `${prefix}${Date.now().toString(36)}${(counter += 1)}`;

// ---- simulators ------------------------------------------------------------------------

/** Modbus unit 1 with a holding register 40101 (offset 100) = `value`. Returns { port, set(v), outage(), restore(), close() }. */
export async function startModbus({ value = 7 } = {}) {
  const { startSimulator } = requireServer('./test/support/modbusSimulator.js');
  const sim = await startSimulator({ port: 0, units: { 1: { holding: {} } } });
  sim.setRegister(1, 'holding', 100, value);
  return {
    port: sim.port,
    set: (v) => sim.setRegister(1, 'holding', 100, v),
    /** The device disappears: no new connections, existing ones are reset. */
    async outage() {
      const closed = sim.stopListening(); // resolves only once every open socket is gone
      sim.dropAll();
      await closed;
    },
    /** The device comes back on the same port. */
    restore: () => sim.startListening(),
    close: () => sim.close()
  };
}

/** S7 simulator with DB1: DBW0 INT = 123, DBD2 REAL = 6.5, STRING[16] "PUMP-1" at DBB12. */
export async function startS7() {
  const { createS7Simulator } = requireServer('./test/support/s7Simulator.js');
  const db1 = Buffer.alloc(64);
  db1.writeInt16BE(123, 0);
  db1.writeFloatBE(6.5, 2);
  db1[12] = 16;
  db1[13] = 6;
  db1.write('PUMP-1', 14, 'latin1');
  const sim = createS7Simulator({ dbs: { 1: db1 } });
  const port = await sim.start();
  return { port, close: () => sim.stop() };
}

/** EtherNet/IP (Logix) simulator with its default tag database (RealTag = 3.5, DintTag = 123456, ...). */
export async function startEip() {
  const { EipSimulator } = requireServer('./test/support/eipSimulator.js');
  const sim = await new EipSimulator().start();
  return { port: sim.port, close: () => sim.stop() };
}

/** HTTP/JSON simulator: /api/meter = { power: { total: 12.5 }, state: "OK" }. Returns { port, sim, close() }. */
export async function startHttpJson() {
  const { startHttpJsonSimulator } = requireServer('./test/support/httpJsonSimulator.js');
  const sim = await startHttpJsonSimulator({ docs: { '/api/meter': { power: { total: 12.5 }, state: 'OK', device: { online: true } } } });
  return { port: sim.port, sim, close: () => sim.close() };
}

/** MTConnect agent simulator with the default milling machine; Xact = 12.5, exec = ACTIVE. Returns { port, sim, close() }. */
export async function startMtconnect() {
  const { startMtconnectSimulator } = requireServer('./test/support/mtconnectSimulator.js');
  const sim = await startMtconnectSimulator({});
  sim.setValue('Xact', 12.5);
  sim.setValue('exec', 'ACTIVE');
  return { port: sim.port, sim, close: () => sim.close() };
}

/** BACnet/IP device simulator (UDP) with its default objects (analog-input:1 = 21.5 Good, analog-input:2 = fault, ...). */
export async function startBacnet(opts = {}) {
  const { BacnetSimulator } = requireServer('./test/support/bacnetSimulator.js');
  const sim = await new BacnetSimulator(opts).start();
  return { port: sim.port, sim, close: () => sim.stop() };
}

/** CoAP (UDP) simulator: /json (temperature 21.5), /senml (Cel / %RH records), /obs (observable text, starts at 1). */
export async function startCoap() {
  const { CoapSimulator } = requireServer('./test/support/coapSimulator.js');
  const sim = await new CoapSimulator().start();
  return {
    port: sim.port,
    /** Push a new value to every observer of /obs. */
    notify: (body) => sim.notify('/obs', { body: String(body) }),
    /** Requests that were not GET (always 0). */
    nonGet: () => sim.stats.nonGetReceived,
    close: () => sim.stop()
  };
}

/** SNMP agent (UDP, loopback) from server/test/support/snmpSimulator.js with its default MIB (sysName.0 = "sim-agent", ...). */
export async function startSnmp(options = {}) {
  const { startSnmpSimulator } = requireServer('./test/support/snmpSimulator.js');
  const sim = await startSnmpSimulator(options);
  return { port: sim.port, sim, close: () => sim.close() };
}

/** Matter Server simulator (WebSocket, path /ws) with its default five-node dump; node 1 temperature = 21.34 degC. Returns { port, sim, close() }. */
export async function startMatterServer() {
  const { startMatterServerSimulator } = requireServer('./test/support/matterServerSimulator.js');
  const sim = await startMatterServerSimulator({});
  return { port: sim.port, sim, close: () => sim.close() };
}

/** Z-Wave JS Server simulator (WebSocket, path /) with its default network; node 3 switch on. Returns { port, sim, close() }. */
export async function startZwaveJsServer() {
  const { startZwaveJsServerSimulator } = requireServer('./test/support/zwaveJsServerSimulator.js');
  const sim = await startZwaveJsServerSimulator({});
  return { port: sim.port, sim, close: () => sim.close() };
}

// ---- REST ------------------------------------------------------------------------------

async function call(method, url, body) {
  const res = await fetch(`${baseUrl()}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body) => call('POST', url, body),
  del: (url) => call('DELETE', url)
};

export async function deviceByName(name) {
  const { json } = await api.get('/api/devices');
  return (json?.devices || []).find((d) => d.name === name) || null;
}

/** Create a Modbus device through the API (unit 1, 500 ms polling); throws with the server's message on failure. */
export async function createModbusDevice({ name, port, tags }) {
  const res = await api.post('/api/devices', {
    name,
    protocol: 'modbus-tcp',
    host: '127.0.0.1',
    port,
    unitId: 1,
    enabled: true,
    pollGroups: [{ id: 'default', intervalMs: 500 }],
    tags: tags.map((t) => ({ type: 'uint16', pollGroup: 'default', ...t }))
  });
  if (!res.ok) throw new Error(`create device failed: ${res.status} ${res.text}`);
  return res.json;
}

/** Remove what a test created (best effort; never throws). Bindings first: a bound device cannot be deleted. */
export async function cleanup({ devices = [], profiles = [], bindings = [] } = {}) {
  const list = await api.get('/api/tags/bindings').catch(() => ({ json: null }));
  for (const name of bindings) {
    const b = (list.json?.bindings || []).find((x) => x.name === name);
    if (b) await api.del(`/api/tags/bindings/${b.id}`).catch(() => {});
  }
  for (const name of devices) {
    const d = await deviceByName(name).catch(() => null);
    if (d) await api.del(`/api/devices/${d.id}`).catch(() => {});
  }
  const { json } = await api.get('/api/devices/profiles').catch(() => ({ json: null }));
  for (const name of profiles) {
    const p = (json?.profiles || []).find((x) => x.name === name);
    if (p) await api.del(`/api/devices/profiles/${p.id}`).catch(() => {});
  }
}

// ---- MQTT ------------------------------------------------------------------------------

/**
 * Subscribe to `filter` on the e2e broker. Returns { messages, waitFor(predicate), close() };
 * `messages` is the live list of { topic, payload (parsed JSON when possible), retain }.
 */
export async function subscribe(filter) {
  const mqtt = requireServer('mqtt');
  const client = mqtt.connect(`mqtt://127.0.0.1:${process.env.E2E_MQTT_PORT}`, { reconnectPeriod: 0 });
  const messages = [];
  client.on('message', (topic, buf, packet) => {
    const text = buf.toString();
    let payload = text;
    try {
      payload = JSON.parse(text);
    } catch {
      /* plain text */
    }
    messages.push({ topic, payload, retain: packet.retain });
  });
  await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.subscribe(filter, (err) => (err ? reject(err) : resolve()));
  });
  return {
    messages,
    close: () => new Promise((resolve) => client.end(true, {}, resolve))
  };
}

// ---- extra servers ---------------------------------------------------------------------

/**
 * A tiny HTTP server standing in for a Timebase historian (POST /api/datasets/<name>/data).
 * It is a STUB: it records what it receives and answers 200, or `status` while `fail(status)` is set.
 * Returns { url, received: [{ url, body }], fail(status|null), close() }.
 */
export async function startHistorianStub() {
  const received = [];
  let failing = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep text */
      }
      received.push({ url: req.url, body });
      res.statusCode = failing || 200;
      res.end(failing ? 'stub failure' : '{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    fail: (status) => {
      failing = status;
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * A second, real backend with authentication on (admin token + viewer token) serving the built client,
 * on its own data directory and port. Returns { url, admin, viewer, stop() }.
 */
export async function startAuthBackend() {
  const admin = 'e2e-admin-token';
  const viewer = 'e2e-viewer-token';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-e2e-auth-'));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), MANIFOLD_DATA_DIR: dataDir, MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1', MANIFOLD_AUTH_TOKEN: admin, MANIFOLD_VIEWER_TOKEN: viewer },
    stdio: 'ignore'
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    url,
    admin,
    viewer,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

// ---- Devices page ----------------------------------------------------------------------

/** The table row of a device on /devices (found by its name button). */
export const deviceRow = (page, name) => page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });

/**
 * Open a device's detail drawer from the table, optionally on one of its tabs ("Overview", "Tags", "Probe").
 * Returns the drawer (a dialog named after the device).
 */
export async function openDevice(page, name, tab) {
  await page.getByRole('button', { name, exact: true }).click();
  const drawer = page.getByRole('dialog', { name });
  await drawer.waitFor();
  if (tab) await drawer.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
  return drawer;
}

// ---- OPC UA ----------------------------------------------------------------------------

/**
 * The real OPC UA test server from server/test/support/opcuaTestServer.js (node-opcua, a server
 * devDependency), started IN the test worker on 127.0.0.1 with an OS-chosen port. Endpoints None,
 * Sign and SignAndEncrypt (Basic256Sha256); users operator/secret and viewer/viewer. Returns the
 * server's helper API: endpointUrl, nodeId(name), set(name, value), setStatus(name, status),
 * restart(), stop(), start(), close() — see that file's header.
 */
export async function startOpcua(options = {}) {
  const { startOpcuaTestServer } = requireServer('./test/support/opcuaTestServer.js');
  return startOpcuaTestServer({ largeCount: 40, ...options });
}

/** Remove OPC UA connections (by name) and UNS mounts (by label) a test created; never throws. */
export async function cleanupOpcua({ connections = [], mounts = [] } = {}) {
  const { json } = await api.get('/api/opcua/connections').catch(() => ({ json: null }));
  for (const c of json?.connections || []) {
    if (connections.includes(c.name)) await api.del(`/api/opcua/connections/${encodeURIComponent(c.id)}`).catch(() => {});
  }
  const m = await api.get('/api/uns/mounts').catch(() => ({ json: null }));
  for (const x of m.json?.mounts || []) {
    if (mounts.includes(x.label)) await api.del(`/api/uns/mounts/${x.id}`).catch(() => {});
}

  }
/**
 * A publisher on the e2e broker: { publish(topic, payload, { retain }), close() }. Objects are sent as JSON.
 */
export async function publisher() {
  const mqtt = requireServer('mqtt');
  const client = mqtt.connect(`mqtt://127.0.0.1:${process.env.E2E_MQTT_PORT}`, { reconnectPeriod: 0 });
  await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('connect', resolve);
  });
  return {
    publish: (topic, payload, opts = {}) =>
      new Promise((resolve, reject) => client.publish(topic, typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), { qos: 1, ...opts }, (e) => (e ? reject(e) : resolve()))),
    close: () => new Promise((resolve) => client.end(true, {}, resolve))
  };
}

/** Remove a binding by name and every pipeline route whose JSON contains `marker` (best effort). */
export async function cleanupRoutes(marker) {
  const { json } = await api.get('/api/pipelines').catch(() => ({ json: null }));
  for (const r of json?.routes || []) if (JSON.stringify(r).includes(marker)) await api.del(`/api/pipelines/${r.id}`).catch(() => {});
}

/** The repo's Sparkplug B decoder (server/services/sparkplugDecoder.js): decode(buffer) -> { metrics, ... }. */
export function sparkplugDecoder() {
  const SparkplugDecoder = requireServer('./services/sparkplugDecoder.js');
  return new SparkplugDecoder();
}

/** Like subscribe(), but payloads stay Buffers (Sparkplug protobuf). */
export async function subscribeRaw(filter, port = process.env.E2E_MQTT_PORT) {
  const mqtt = requireServer('mqtt');
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0 });
  const messages = [];
  client.on('message', (topic, buf, packet) => messages.push({ topic, payload: buf, retain: packet.retain }));
  await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.subscribe(filter, (err) => (err ? reject(err) : resolve()));
  });
  return { messages, close: () => new Promise((resolve) => client.end(true, {}, resolve)) };
}

/**
 * An extra in-process MQTT broker (aedes). `pause()` drops every client and stops listening while
 * keeping the retained store; `resume()` listens on the same port again.
 * Returns { port, retained(topic) -> Promise<Buffer|null>, pause(), resume(), close() }.
 */
export async function startBroker() {
  const aedesModule = requireServer('aedes');
  const Aedes = aedesModule.Aedes || aedesModule;
  const broker = Aedes.createBroker ? await Aedes.createBroker() : new Aedes();
  let server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const sockets = new Set();
  const track = (srv) =>
    srv.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
  track(server);
  return {
    port,
    retained: (topic) =>
      new Promise((resolve) => {
        const stream = broker.persistence.createRetainedStream(topic);
        let hit = null;
        stream.on('data', (p) => (hit = p.payload));
        stream.on('end', () => resolve(hit && hit.length ? hit : null));
      }),
    async pause() {
      await new Promise((resolve) => {
        server.close(resolve);
        for (const s of sockets) s.destroy();
      });
    },
    async resume() {
      server = net.createServer(broker.handle);
      track(server);
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => broker.close(resolve));
    }
  };
}

// ---- discovery lab -----------------------------------------------------------------------

/**
 * Everything a Discovery scan can find on 127.0.0.1, in this worker (server/test/support/discoveryLab.js):
 * Modbus / S7 / EtherNet/IP simulators, an MQTT broker (TCP and WebSocket), a UA-TCP server, plus a silent
 * port, a tarpit and a resetting port. Returns { modbus, s7, eip, mqttPort, mqttWsPort, opcua, silent, tarpit,
 * reset, closedPort, openSockets(), totalOpen(), writes(), close() }.
 */
export function startDiscoveryLab() {
  return requireServer('./test/support/discoveryLab.js').startDiscoveryLab({ withWs: true });
}

// ---- a large namespace broker (canvas / Trends specs) -------------------------------------

/**
 * A second, in-worker MQTT broker with a realistic, large namespace, registered with the backend
 * as broker `id` (default 'e2e-big'): ~300 plant topics with units (`{ value, unit }` and TVQ
 * envelopes carrying `u`), a Sparkplug B edge node with a device (metrics with EngUnit), and one
 * long branch `big/fleet` with `branchSize` children (`unit0001` ...). Everything is retained, so
 * it is all there as soon as the backend subscribes. Resolves once the backend has seen every
 * topic. Returns { id, port, publish(topic, body), close() }; close() removes the broker profile.
 */
export async function startBigBroker({ id = 'e2e-big', branchSize = 2000 } = {}) {
  const aedesModule = requireServer('aedes');
  const Aedes = aedesModule.Aedes || aedesModule;
  const broker = Aedes.createBroker ? await Aedes.createBroker() : new Aedes();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const publish = (topic, body, retain = true) =>
    new Promise((resolve) => broker.publish({ cmd: 'publish', qos: 0, dup: false, retain, topic, payload: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) }, resolve));

  const topics = [];
  const units = { temperature: 'C', pressure: 'bar', speed: 'rpm', power: 'kW' };
  for (let a = 1; a <= 3; a++) {
    for (let l = 1; l <= 5; l++) {
      for (let c = 1; c <= 5; c++) {
        for (const [m, u] of Object.entries(units)) {
          const v = Math.round((a * 10 + l * 3 + c + Object.keys(units).indexOf(m) * 20) * 10) / 10;
          topics.push([`acme/area${a}/line${l}/cell${c}/${m}`, c % 2 ? { value: v, unit: u } : { v, q: 192, u }]);
        }
      }
    }
  }
  for (let i = 1; i <= branchSize; i++) topics.push([`big/fleet/unit${String(i).padStart(4, '0')}`, { value: i % 97, unit: 'A' }]);
  for (const [t, body] of topics) await publish(t, body);

  const { encodePayload } = requireServer('./services/sparkplugEncoder.js');
  const metric = (name, value, unit) => ({ name, value, properties: unit ? { engUnit: unit } : undefined });
  await publish('spBv1.0/Acme/NBIRTH/Edge1', encodePayload({ seq: 0, metrics: [{ name: 'bdSeq', value: 0, isBdSeq: true }, metric('Node Uptime', 12, 's')] }));
  await publish('spBv1.0/Acme/DBIRTH/Edge1/Press1', encodePayload({ seq: 1, metrics: [metric('Temperature', 71.5, 'degF'), metric('Pressure', 2.5, 'bar'), metric('Running', true)] }));
  await publish('spBv1.0/Acme/DDATA/Edge1/Press1', encodePayload({ seq: 2, metrics: [metric('Temperature', 72.25, 'degF'), metric('Pressure', 2.6, 'bar')] }));

  const reg = await api.post('/api/mqtt/brokers', { id, name: 'Big namespace', host: '127.0.0.1', port, protocol: 'mqtt', autoSubscribe: true, reconnect: true, reconnectPeriod: 2000 });
  if (!reg.ok && !/already connected/.test(reg.text)) throw new Error(`register broker failed: ${reg.status} ${reg.text}`);
  const want = topics.length;
  for (let i = 0; i < 300; i++) {
    const r = await api.get(`/api/mqtt/brokers/${id}/topics?limit=100000`).catch(() => null);
    if ((r?.json?.topics || []).length >= want) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    id,
    port,
    topicCount: want,
    publish,
    async close() {
      await api.del(`/api/mqtt/brokers/${id}`).catch(() => {});
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/**
 * A file recording on the big broker with deterministic samples. The broker tap coalesces plain
 * topics to the latest value per 100 ms flush, but queues Sparkplug messages un-coalesced, so the
 * samples travel as Sparkplug DDATA batches (several timestamped values of a metric per message,
 * as Sparkplug allows), recorded under the filter `spBv1.0/<group>/DDATA/Edge1/Dev1`:
 *   .../Temperature  `count` samples, one per second ending now, unit C (EngUnit), with a run of
 *                    30 Bad samples (a gap) and an isolated Bad sample every 97 (a partial bucket
 *                    once downsampled to fewer points than samples);
 *   .../Pressure     the same span, unit bar, all Good.
 * Resolves once the recorder has written them all. Returns { id, group, tags: [temp, press], start, end, remove() }.
 */
export async function createQualityRecording(bigBroker, { count = 1500 } = {}) {
  const group = unique('rec');
  const topic = `spBv1.0/${group}/DDATA/Edge1/Dev1`;
  const res = await api.post('/api/recorder', { name: `Quality ${group}`, brokerId: bigBroker.id, filter: topic, target: { type: 'file' } });
  if (!res.ok) throw new Error(`create recording failed: ${res.status} ${res.text}`);
  const id = res.json.id; // armed at once: the recorder reads its table from the profiles on every message
  const { encodePayload } = requireServer('./services/sparkplugEncoder.js');
  const end = Date.now() - 1000;
  const start = end - (count - 1) * 1000;
  const BATCH = 100;
  for (let from = 0, seq = 0; from < count; from += BATCH, seq++) {
    const metrics = [];
    for (let i = from; i < Math.min(count, from + BATCH); i++) {
      const ts = start + i * 1000;
      const bad = (i >= 600 && i < 630) || i % 97 === 50;
      metrics.push({ name: 'Temperature', value: bad ? 999 : 20 + 5 * Math.sin(i / 60), ts, properties: { engUnit: 'C', Quality: bad ? 0 : 192 } });
      metrics.push({ name: 'Pressure', value: 2 + 0.2 * Math.cos(i / 90), ts, properties: { engUnit: 'bar', Quality: 192 } });
    }
    await bigBroker.publish(topic, encodePayload({ seq: seq % 256, ts: start + from * 1000, metrics }), false);
  }
  const tags = [`${topic}/Temperature`, `${topic}/Pressure`];
  for (let i = 0; i < 200; i++) {
    const r = await api.get(`/api/recorder/${id}/data?limit=1`);
    if ((r.json?.total || 0) >= Math.ceil(count / BATCH)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { id, group, tags, start, end, remove: () => api.del(`/api/recorder/${id}`).catch(() => {}) };
}
