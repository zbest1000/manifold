'use strict';

/**
 * Driver host: child-process entry (child_process.fork). One host runs every
 * device of one protocol (or a single isolated device). It speaks JSON IPC to
 * server/services/driverSupervisor.js:
 *
 *   parent -> child: init, configure, probe, browse, test, ping, shutdown
 *   child -> parent: ready, samples, state, status, result, pong, device-error
 *
 * Anything uncaught is fatal on purpose: log, exit(1), the supervisor restarts us.
 */

const { isDeepStrictEqual } = require('util');
const { DeviceRuntime } = require('./runtime/deviceRuntime');

const STATUS_EVERY_MS = 2000;
const TEST_TIMEOUT_MS = 10000;
const STAGGER_MS = 25;
const STAGGER_MAX_MS = 5000;

if (typeof process.send !== 'function') {
  // Not forked: nothing to talk to.
  if (require.main === module) {
    process.stderr.write('driver host must be started with child_process.fork\n');
    process.exit(2);
  }
}

let driverPaths = {};
const modules = new Map(); // protocol -> loaded module
const running = new Map(); // deviceId -> { device, runtime }
let configureChain = Promise.resolve();
let shuttingDown = false;
let statusTimer = null;

function log(msg) {
  process.stderr.write(`[driver-host ${process.pid}] ${msg}\n`);
}

// JSON IPC cannot carry bigint; the contract says they travel as strings.
function jsonSafe(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

function send(msg) {
  if (!process.connected || typeof process.send !== 'function') return;
  try {
    process.send(JSON.parse(JSON.stringify(msg, jsonSafe)));
  } catch (e) {
    log(`send failed: ${e && e.message}`);
  }
}

function loadModule(protocol) {
  if (modules.has(protocol)) return modules.get(protocol);
  const p = driverPaths[protocol];
  if (!p) throw new Error(`unknown protocol '${protocol}'`);
  const mod = require(p);
  if (!mod || typeof mod.createDriver !== 'function') throw new Error(`driver module for '${protocol}' has no createDriver`);
  modules.set(protocol, mod);
  return mod;
}

function startDevice(device, index) {
  let driver;
  try {
    driver = loadModule(device.protocol).createDriver(device);
    if (!driver) throw new Error('createDriver returned nothing');
  } catch (e) {
    send({ t: 'device-error', deviceId: device.id, error: e && e.message ? e.message : String(e), details: e && e.details });
    return;
  }
  const runtime = new DeviceRuntime({
    device,
    driver,
    // Spread first connects: 25 ms apart, up to 5 s, so 200 devices do not open 200 sockets in one tick.
    options: { startDelayMs: Math.min(index * STAGGER_MS, STAGGER_MAX_MS) },
    onSamples: (b) => send({ t: 'samples', deviceId: b.deviceId, group: b.group, tRead: b.tRead, samples: b.samples }),
    onState: (s) =>
      send({ t: 'state', deviceId: s.deviceId, state: s.state, phase: s.phase, reason: s.reason, since: s.since })
  });
  running.set(device.id, { device, runtime });
  runtime.start();
}

async function stopDevice(id) {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  try {
    await r.runtime.stop();
  } catch (e) {
    log(`stop ${id}: ${e && e.message}`);
  }
}

async function configure(devices) {
  const want = new Map();
  for (const d of Array.isArray(devices) ? devices : []) if (d && d.id) want.set(d.id, d);
  for (const id of Array.from(running.keys())) {
    const cur = running.get(id);
    const next = want.get(id);
    if (!next || !isDeepStrictEqual(cur.device, next)) await stopDevice(id);
  }
  let i = 0;
  for (const [id, d] of want) {
    if (!running.has(id)) startDevice(d, i++);
  }
  sendStatus();
}

function sendStatus() {
  const devices = {};
  for (const [id, r] of running) {
    try {
      devices[id] = r.runtime.getStatus();
    } catch (_) {
      /* skip */
    }
  }
  send({ t: 'status', devices });
}

function fail(reqId, e) {
  send({ t: 'result', reqId, ok: false, error: e && e.message ? e.message : String(e) });
}

async function handleBrowse(msg) {
  const r = running.get(msg.deviceId);
  if (!r) return fail(msg.reqId, new Error(`unknown device '${msg.deviceId}'`));
  try {
    send({ t: 'result', reqId: msg.reqId, ok: true, data: await r.runtime.browse(msg.node) });
  } catch (e) {
    fail(msg.reqId, e);
  }
}

async function handleProbe(msg) {
  const r = running.get(msg.deviceId);
  if (!r) return fail(msg.reqId, new Error(`unknown device '${msg.deviceId}'`));
  try {
    send({ t: 'result', reqId: msg.reqId, ok: true, data: await r.runtime.probe(msg.args) });
  } catch (e) {
    fail(msg.reqId, e);
  }
}

async function handleTest(msg) {
  let driver;
  let timer;
  const started = Date.now();
  try {
    driver = loadModule(msg.device.protocol).createDriver(msg.device);
    const limit = (msg.device.limits && msg.device.limits.connectTimeoutMs) || 5000;
    const info = await Promise.race([
      driver.connect(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('connect timed out')), Math.min(limit + 500, TEST_TIMEOUT_MS));
      })
    ]);
    send({ t: 'result', reqId: msg.reqId, ok: true, data: { info, latencyMs: Date.now() - started } });
  } catch (e) {
    fail(msg.reqId, e);
  } finally {
    clearTimeout(timer);
    if (driver) {
      try {
        await Promise.race([driver.close(), new Promise((r) => setTimeout(r, 2000).unref())]);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(statusTimer);
  try {
    await configureChain.catch(() => {});
    await Promise.all(Array.from(running.keys()).map(stopDevice));
  } finally {
    const done = () => process.exit(0);
    if (process.connected) {
      try {
        process.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    setImmediate(done);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'init':
      driverPaths = Object.assign({}, msg.drivers || {});
      send({ t: 'ready' });
      break;
    case 'configure':
      configureChain = configureChain
        .then(() => configure(msg.devices))
        .catch((e) => log(`configure failed: ${e && e.stack}`));
      break;
    case 'probe':
      handleProbe(msg);
      break;
    case 'browse':
      handleBrowse(msg);
      break;
    case 'test':
      handleTest(msg);
      break;
    case 'ping':
      send({ t: 'pong', n: msg.n });
      break;
    case 'shutdown':
      shutdown();
      break;
    default:
      break;
  }
});

process.on('disconnect', () => {
  // Parent died or closed the channel: nothing left to report to.
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log(`uncaughtException: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log(`unhandledRejection: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

statusTimer = setInterval(sendStatus, STATUS_EVERY_MS);
if (statusTimer.unref) statusTimer.unref();
