/**
 * Boots everything the UI suite needs, once, before any test:
 *
 *   - an in-process MQTT broker (aedes, from server/node_modules) fed with a
 *     handful of topics that keep ticking;
 *   - the Modbus TCP simulator from server/test/support (a register that counts up);
 *   - the REAL Manifold backend on a random port with a throwaway
 *     MANIFOLD_DATA_DIR and MANIFOLD_ALLOW_LOOPBACK_DEVICES=1, serving the built
 *     client (client/dist) and pre-wired to that broker.
 *
 * The backend port comes from E2E_PORT (picked in playwright.config.js); the
 * simulator port is handed to the tests as E2E_MODBUS_PORT and the broker port as E2E_MQTT_PORT
 * (workers inherit both). Tests that need their own device simulators (S7, EtherNet/IP, a Modbus
 * unit they can switch off) start them in-process through e2e/support.js.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const serverDir = path.join(root, 'server');
const requireServer = createRequire(path.join(serverDir, 'package.json'));

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((resolve) => s.close(resolve));
  return port;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function globalSetup() {
  if (!fs.existsSync(path.join(root, 'client/dist/index.html'))) {
    throw new Error('client/dist is missing - run `npm run build` in client/ before the e2e suite.');
  }
  const cleanups = [];

  // ---- MQTT broker with a few live topics -------------------------------------------------
  const aedesModule = requireServer('aedes');
  const Aedes = aedesModule.Aedes || aedesModule;
  const broker = Aedes.createBroker ? await Aedes.createBroker() : new Aedes();
  const mqttServer = net.createServer(broker.handle);
  const mqttPort = await listen(mqttServer);
  let tick = 0;
  const topics = (n) => ({
    'plant/line1/temperature': { value: 20 + (n % 5), unit: 'C' },
    'plant/line1/pressure': { value: 100 + (n % 7), unit: 'kPa' },
    'plant/line2/status': { state: n % 2 ? 'running' : 'idle' },
    'plant/line2/count': { value: n },
    'plant/energy/kwh': { value: 1000 + n },
    // a value/time/quality envelope, as many gateways (and Manifold's own bindings) publish it
    'plant/env/tvq': { v: 12.5 + (n % 3), t: Date.now(), q: 192 }
  });
  const publishAll = () => {
    tick += 1;
    for (const [topic, body] of Object.entries(topics(tick))) {
      broker.publish({ cmd: 'publish', qos: 0, dup: false, retain: true, topic, payload: Buffer.from(JSON.stringify(body)) }, () => {});
    }
  };
  publishAll();
  const feed = setInterval(publishAll, 1000);
  cleanups.push(async () => {
    clearInterval(feed);
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => mqttServer.close(resolve));
  });

  // ---- Modbus simulator ----------------------------------------------------------------
  const { startSimulator } = requireServer('./test/support/modbusSimulator.js');
  const modbus = await startSimulator({ port: 0, units: { 1: { holding: {} } } });
  let mb = 40;
  modbus.setRegister(1, 'holding', 102, mb);
  const mbTicker = setInterval(() => modbus.setRegister(1, 'holding', 102, ++mb), 500);
  cleanups.push(async () => {
    clearInterval(mbTicker);
    await modbus.close();
  });

  // ---- the backend ----------------------------------------------------------------------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-e2e-'));
  fs.writeFileSync(
    path.join(dataDir, 'profiles.json'),
    JSON.stringify({
      mqtt: {
        'e2e-broker': {
          config: { id: 'e2e-broker', name: 'E2E broker', host: '127.0.0.1', port: mqttPort, protocol: 'mqtt', autoSubscribe: true, reconnect: true, reconnectPeriod: 2000 }
        }
      },
      opcua: {},
      cesmii: null,
      i3x: null
    })
  );
  const port = Number(process.env.E2E_PORT) || (await freePort());
  const backend = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), MANIFOLD_DATA_DIR: dataDir, MANIFOLD_ALLOW_LOOPBACK_DEVICES: '1', MANIFOLD_AUTH_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  backend.stdout.on('data', (d) => (log += d));
  backend.stderr.on('data', (d) => (log += d));
  cleanups.push(async () => {
    backend.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => backend.once('exit', resolve)), sleep(5000)]);
    backend.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (backend.exitCode !== null) break;
    try {
      ready = (await fetch(`${baseUrl}/health`)).ok;
    } catch {
      await sleep(200);
    }
  }
  if (!ready) {
    await Promise.all(cleanups.map((c) => c().catch(() => {})));
    throw new Error(`backend did not become healthy:\n${log}`);
  }
  // Wait until the broker is connected and its topics were seen, so every page renders real data.
  let seeded = false;
  for (let i = 0; i < 100 && !seeded; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/mqtt/brokers/e2e-broker/topics`);
      if (res.ok) seeded = ((await res.json()).topics || []).length >= 5;
    } catch {
      /* not up yet */
    }
    if (!seeded) await sleep(200);
  }
  if (!seeded) {
    const brokers = await fetch(`${baseUrl}/api/mqtt/brokers`).then((r) => r.text()).catch((e) => String(e));
    log += `\nGET /api/mqtt/brokers -> ${brokers.slice(0, 600)}`;
    await Promise.all(cleanups.map((c) => c().catch(() => {})));
    throw new Error(`the broker never delivered its topics to the backend:\n${log}`);
  }

  process.env.E2E_MODBUS_PORT = String(modbus.port);
  process.env.E2E_MQTT_PORT = String(mqttPort);

  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  };
}
