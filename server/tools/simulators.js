#!/usr/bin/env node
'use strict';

/**
 * Device simulators for demos and manual testing: Modbus TCP, Siemens S7
 * (S7comm) and EtherNet/IP (Logix), each seeded with plausible values that
 * change over time.
 *
 *   node server/tools/simulators.js                       # all three, default ports
 *   node server/tools/simulators.js --modbus 5020 --s7 10102 --eip 44818 --host 0.0.0.0
 *   node server/tools/simulators.js --modbus               # only Modbus, default port
 *
 * Options
 *   --modbus [port]   Modbus TCP server (default 5020)
 *   --s7 [port]       S7comm server (default 10102)
 *   --eip [port]      EtherNet/IP server (default 44818)
 *   --host <addr>     bind address (default 127.0.0.1; use 0.0.0.0 in a container)
 *   --interval <ms>   how often values change (default 1000)
 *   --quiet           do not log value changes
 *
 * With no protocol flag, all three start. The environment variables
 * SIM_MODBUS_PORT, SIM_S7_PORT, SIM_EIP_PORT and SIM_HOST are used as defaults
 * for the flags (handy with `docker run -e`; the compose service uses flags).
 *
 * These are the SAME simulators the test suite uses (server/test/support/*).
 * They are test doubles, not real devices: they accept write function codes so
 * the tests can prove the driver never sends one, and they say nothing about how
 * real firmware behaves. Do not point production tooling at them.
 *
 * The S7 and EtherNet/IP simulators can only listen on 127.0.0.1 with an
 * OS-chosen port, and the support files are not modified for this tool, so for
 * those two a small TCP forwarder listens on the requested host:port and pipes
 * every connection to the loopback simulator.
 *
 * Address map (what to enter in the Devices page):
 *
 *   Modbus TCP, unit id 1 or 255 (both answer), base 0, byte order big:
 *     holding:0   int16   temperature x10 (use scale 0.1)
 *     holding:1   uint16  rpm
 *     holding:2   float32 flow, ABCD (word order big)
 *     holding:4   float32 pressure, CDAB (word order little: the word-swapped layout)
 *     holding:6   uint32  part counter
 *     holding:8   string  "PUMP-1" (8 registers)
 *     input:0     int16   supply temperature x10
 *     coil:0      bool    running
 *     discrete:0  bool    alarm
 *
 *   S7 (rack 0, slot 1), DB1:
 *     DB1.DBW0 INT temperature x10      DB1.DBD2 REAL pressure
 *     DB1.DBX6.0 BOOL running           DB1.DBD8 DINT counter
 *     DB1.DBB12 STRING length 16 "PUMP-1"   DB1.DBD30 REAL flow
 *     MW0 INT level
 *
 *   EtherNet/IP: RealTag (REAL), DintTag (DINT), BoolTag (BOOL), Motor (UDT)
 *     with Motor.Speed / Motor.Count / Motor.Running, Program:MainProgram.LocalReal.
 *     Browse the device in the UI to see the full list.
 */

const net = require('node:net');
const path = require('node:path');

const support = path.join(__dirname, '..', 'test', 'support');
const { startSimulator } = require(path.join(support, 'modbusSimulator.js'));
const { createS7Simulator } = require(path.join(support, 's7Simulator.js'));
const { EipSimulator } = require(path.join(support, 'eipSimulator.js'));

const DEFAULTS = { modbus: 5020, s7: 10102, eip: 44818 };

function parseArgs(argv, env = process.env) {
  const out = { host: env.SIM_HOST || '127.0.0.1', intervalMs: 1000, quiet: false, protocols: {} };
  const envPorts = { modbus: env.SIM_MODBUS_PORT, s7: env.SIM_S7_PORT, eip: env.SIM_EIP_PORT };
  for (const [name, v] of Object.entries(envPorts)) {
    if (v !== undefined && v !== '') out.protocols[name] = Number(v);
  }
  const isValue = (s) => s !== undefined && !String(s).startsWith('--');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--interval') out.intervalMs = Number(argv[++i]);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--modbus' || a === '--s7' || a === '--eip') {
      const name = a.slice(2);
      out.protocols[name] = isValue(argv[i + 1]) ? Number(argv[++i]) : DEFAULTS[name];
    } else throw new Error(`unknown argument "${a}" (try --help)`);
  }
  if (!out.help && Object.keys(out.protocols).length === 0) out.protocols = { ...DEFAULTS };
  for (const [name, port] of Object.entries(out.protocols)) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--${name}: invalid port "${port}"`);
  }
  if (!out.host) throw new Error('--host needs a value');
  if (!(out.intervalMs >= 100)) throw new Error('--interval must be at least 100 (ms)');
  return out;
}

/** Forward host:port -> 127.0.0.1:targetPort. Returns { server, port }. */
function forwarder(host, port, targetPort) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client).add(upstream);
    const done = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', done).on('close', done);
    upstream.on('error', done).on('close', done);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          })
      })
    );
  });
}

// ---- value generators (pure, so they are easy to eyeball) ---------------------

const wave = (t, mid, amp, periodS) => mid + amp * Math.sin((2 * Math.PI * t) / periodS);

async function startModbus({ host, port }) {
  const unitCfg = () => ({ holding: {}, input: {}, coils: {}, discrete: {} });
  const sim = await startSimulator({ host, port, units: { 1: unitCfg(), 255: unitCfg() } });
  let counter = 1000;
  const tick = (t) => {
    const temp = wave(t, 21.5, 1.5, 60);
    const values = {
      temp,
      rpm: Math.round(wave(t, 1450, 40, 20)),
      flow: wave(t, 12.5, 2, 45),
      pressure: wave(t, 4.2, 0.3, 30),
      counter: (counter += 1 + Math.floor(Math.random() * 3)),
      running: Math.sin(t / 25) > -0.8,
      alarm: Math.sin(t / 40) > 0.97
    };
    for (const unit of [1, 255]) {
      sim.setRegister(unit, 'holding', 0, Math.round(values.temp * 10) & 0xffff);
      sim.setRegister(unit, 'holding', 1, values.rpm);
      sim.setFloat32(unit, 'holding', 2, values.flow);
      sim.setFloat32(unit, 'holding', 4, values.pressure, { wordOrder: 'little' });
      sim.setUInt32(unit, 'holding', 6, values.counter);
      sim.setString(unit, 'holding', 8, 'PUMP-1', 8);
      sim.setRegister(unit, 'input', 0, Math.round((values.temp - 3) * 10) & 0xffff);
      sim.setRegister(unit, 'coil', 0, values.running ? 1 : 0);
      sim.setRegister(unit, 'discrete', 0, values.alarm ? 1 : 0);
    }
    return `temp=${values.temp.toFixed(1)} rpm=${values.rpm} flow=${values.flow.toFixed(2)} counter=${values.counter}`;
  };
  tick(0);
  return { name: 'modbus', port: sim.port, tick, close: () => sim.close() };
}

async function startS7({ host, port }) {
  const db1 = Buffer.alloc(64);
  const marker = Buffer.alloc(64);
  const sim = createS7Simulator({ dbs: { 1: db1 }, M: marker });
  const loopbackPort = await sim.start();
  const front = await forwarder(host, port, loopbackPort);
  let counter = 5000;
  const tick = (t) => {
    const temp = wave(t, 64.0, 4, 50);
    const pressure = wave(t, 6.0, 0.4, 35);
    const flow = wave(t, 30, 5, 40);
    counter += 1;
    db1.writeInt16BE(Math.round(temp * 10), 0);
    db1.writeFloatBE(pressure, 2);
    db1[6] = Math.sin(t / 30) > -0.7 ? 1 : 0; // DBX6.0
    db1.writeInt32BE(counter, 8);
    db1[12] = 16; // STRING[16]: max length, actual length, characters
    db1[13] = 6;
    db1.fill(0, 14, 30);
    db1.write('PUMP-1', 14, 'latin1');
    db1.writeFloatBE(flow, 30);
    marker.writeInt16BE(Math.round(wave(t, 500, 100, 90)), 0);
    return `temp=${temp.toFixed(1)} pressure=${pressure.toFixed(2)} counter=${counter}`;
  };
  tick(0);
  return { name: 's7', port: front.port, tick, close: async () => { await front.close(); await sim.stop(); } };
}

async function startEip({ host, port }) {
  const sim = await new EipSimulator().start();
  const front = await forwarder(host, port, sim.port);
  const tag = (name) => sim.db.controller.find((x) => x.name === name);
  const real = tag('RealTag').data;
  const dint = tag('DintTag').data;
  const bool = tag('BoolTag').data;
  const motor = tag('Motor').data; // MotorType layout: Speed REAL @4, Count DINT @8, Running = bit 0 of byte 0
  const local = sim.db.programs.MainProgram.find((x) => x.name === 'LocalReal').data;
  let counter = 100;
  const tick = (t) => {
    const temp = wave(t, 72.5, 3, 55);
    const speed = wave(t, 1450, 60, 25);
    counter += 1;
    real.writeFloatLE(temp, 0);
    dint.writeInt32LE(counter, 0);
    bool[0] = Math.sin(t / 20) > -0.6 ? 1 : 0;
    motor.writeFloatLE(speed, 4);
    motor.writeInt32LE(counter, 8);
    motor[0] = (motor[0] & ~1) | bool[0];
    local.writeFloatLE(wave(t, 1.25, 0.25, 15), 0);
    return `RealTag=${temp.toFixed(1)} DintTag=${counter} Motor.Speed=${speed.toFixed(0)}`;
  };
  tick(0);
  return { name: 'eip', port: front.port, tick, close: async () => { await front.close(); await sim.stop(); } };
}

const STARTERS = { modbus: startModbus, s7: startS7, eip: startEip };

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(4, 23).map((l) => l.replace(/^ ?\*? ?/, '')).join('\n'));
    return null;
  }
  const running = [];
  try {
    for (const [name, port] of Object.entries(opts.protocols)) {
      const sim = await STARTERS[name]({ host: opts.host, port });
      running.push(sim);
      console.log(`[device-sim] ${name} listening on ${opts.host}:${sim.port}`);
    }
  } catch (error) {
    console.error(`[device-sim] failed to start: ${error.message}`);
    await Promise.all(running.map((s) => s.close().catch(() => {})));
    process.exitCode = 1;
    return null;
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - startedAt) / 1000;
    for (const s of running) {
      const line = s.tick(t);
      if (!opts.quiet) console.log(`[device-sim] ${s.name} ${line}`);
    }
  }, opts.intervalMs);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[device-sim] ${signal}: shutting down`);
    clearInterval(timer);
    await Promise.all(running.map((s) => s.close().catch(() => {})));
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  console.log(`[device-sim] ready (values change every ${opts.intervalMs} ms; SIGTERM or Ctrl-C to stop)`);
  return { running, stop };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[device-sim] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
