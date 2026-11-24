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
