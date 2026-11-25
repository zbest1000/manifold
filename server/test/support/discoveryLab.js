'use strict';

/**
 * Everything a real Discovery scan needs to find (or not find) on 127.0.0.1, started
 * in-process on OS-chosen ports, with the counters the tests assert on:
 *
 *   modbus / s7 / eip   the three device simulators (write counters stay 0 under a scan)
 *   mqtt                aedes broker, raw TCP port and a WebSocket port
 *   opcua               a minimal UA-TCP server that answers Hello with Acknowledge
 *   silent              accepts and never sends a byte (an "open port that speaks nothing")
 *   tarpit              accepts and holds the connection, drip-feeding nothing useful
 *   reset               accepts and immediately resets the connection
 *   closedPort          a port nobody listens on
 *
 * `openSockets()` is the number of client connections currently open against the
 * silent/tarpit/reset/opcua fakes and the simulators; it must return to 0 once a scan
 * is over or cancelled (a leaking scanner exhausts PLC connection tables).
 */

const net = require('node:net');
const http = require('node:http');
const { startSimulator } = require('./modbusSimulator');
const { createS7Simulator } = require('./s7Simulator');
const { EipSimulator } = require('./eipSimulator');

const listen = (server, host = '127.0.0.1', port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

/** A listening fake that tracks live and peak concurrent connections. `onConnection(sock)` decides what it does. */
async function fake(onConnection, host = '127.0.0.1', requestedPort = 0) {
  const sockets = new Set();
  const stats = { connections: 0, peak: 0 };
  const server = net.createServer((sock) => {
    stats.connections++;
    sockets.add(sock);
    stats.peak = Math.max(stats.peak, sockets.size);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    sock.resume(); // read (and discard) so the peer's FIN is noticed and the socket really closes
    onConnection(sock);
  });
  const port = await listen(server, host, requestedPort);
  return {
    port,
    host,
    stats,
    get open() {
      return sockets.size;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await closeServer(server);
    }
  };
}

/** UA-TCP: answer a Hello ('HELF') with an Acknowledge ('ACKF'). */
function opcuaServer(host) {
  return fake((sock) => {
    sock.once('data', (buf) => {
      if (buf.toString('latin1', 0, 4) !== 'HELF') return sock.destroy();
      const ack = Buffer.alloc(28);
      ack.write('ACKF', 0, 'latin1');
      ack.writeUInt32LE(28, 4);
      ack.writeUInt32LE(0, 8);
      ack.writeUInt32LE(65536, 12);
      ack.writeUInt32LE(65536, 16);
      sock.write(ack);
    });
  }, host);
}

async function startDiscoveryLab({ withWs = true } = {}) {
  const lab = {};
  const cleanups = [];

  const modbus = await startSimulator({ port: 0, units: { 1: { holding: { 0: 7 } } } });
  lab.modbus = modbus;
  cleanups.push(() => modbus.close());

  const s7 = createS7Simulator({ dbs: { 1: Buffer.alloc(4) } });
  await s7.start();
  lab.s7 = s7;
  cleanups.push(() => s7.stop());

  const eip = await new EipSimulator().start();
  lab.eip = eip;
  cleanups.push(() => eip.stop());

  const aedesModule = require('aedes');
  const Aedes = aedesModule.Aedes || aedesModule;
  const broker = Aedes.createBroker ? await Aedes.createBroker() : new Aedes();
  const mqttServer = net.createServer(broker.handle);
  lab.mqttPort = await listen(mqttServer);
  lab.broker = broker;
  cleanups.push(async () => {
    await new Promise((resolve) => broker.close(resolve));
    await closeServer(mqttServer);
  });

  if (withWs) {
    const { WebSocketServer, createWebSocketStream } = require('ws');
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer, handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false) });
    wss.on('connection', (ws) => broker.handle(createWebSocketStream(ws)));
    lab.mqttWsPort = await listen(httpServer);
    cleanups.push(async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise((resolve) => wss.close(resolve));
      httpServer.closeAllConnections?.();
      await closeServer(httpServer);
    });
  }

  lab.opcua = await opcuaServer();
  cleanups.push(() => lab.opcua.close());
  lab.silent = await fake(() => {});
  cleanups.push(() => lab.silent.close());
  lab.tarpit = await fake((sock) => {
    // Never answers; a trickle of bytes keeps the connection looking alive.
    const t = setInterval(() => sock.write(Buffer.from([0])), 400);
    sock.on('close', () => clearInterval(t));
  });
  cleanups.push(() => lab.tarpit.close());
  lab.reset = await fake((sock) => sock.resetAndDestroy());
  cleanups.push(() => lab.reset.close());

  const probe = net.createServer();
  lab.closedPort = await listen(probe);
  await closeServer(probe);

  /** Client connections currently open against every fake and simulator. */
  lab.openSockets = () => ({
    modbus: modbus.stats.openConnections,
    s7: s7.openConnections,
    eip: eip.sockets.size,
    opcua: lab.opcua.open,
    silent: lab.silent.open,
    tarpit: lab.tarpit.open,
    reset: lab.reset.open,
    mqtt: broker.connectedClients
  });
  lab.totalOpen = () => Object.values(lab.openSockets()).reduce((a, b) => a + b, 0);
  /** Writes any simulator received (must stay 0). */
  lab.writes = () => ({ modbus: modbus.stats.writesReceived, s7: s7.stats.writesReceived + s7.stats.controlReceived, eip: eip.stats.writesReceived });
  lab.close = async () => {
    for (const c of cleanups.reverse()) await c().catch(() => {});
  };
  return lab;
}

module.exports = { startDiscoveryLab, fake, listen, closeServer, opcuaServer };
