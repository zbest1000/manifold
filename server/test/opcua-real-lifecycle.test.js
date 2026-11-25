'use strict';

/**
 * Lifecycle of OPC UA connections against the real test server: 50 abrupt
 * reconnects leave one session, one subscription and a flat heap behind, and a
 * process that used the manager exits by itself after shutdown (no timer,
 * socket or session keeps it alive).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const v8 = require('v8');
const vm = require('vm');
const { useTempDataDir, until, FAST, makeIo } = require('./support/opcuaTestKit');

useTempDataDir();
const { startOpcuaTestServer } = require('./support/opcuaTestServer');
const OpcuaManager = require('../services/opcuaManager');

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

test('50 abrupt reconnects: monitors recovered every time, no session/subscription build-up on the server, heap stays flat', async () => {
  const srv = await startOpcuaTestServer({ largeCount: 20 });
  const { io } = makeIo();
  const mgr = new OpcuaManager(io, { ...FAST, backoff: { initialMs: 10, maxMs: 40 } });
  let online = 0;
  mgr.on('connection-state', (s) => {
    if (s.state === 'online') online++;
  });
  const values = [];
  mgr.on('value', (v) => values.length < 10_000 && values.push(v));
  try {
    await mgr.connect({ id: 'flap', endpointUrl: srv.endpointUrl });
    for (let i = 0; i < 20; i++) await mgr.monitor('flap', srv.nodeId(`Large.Item${String(i).padStart(3, '0')}`), 0);

    const cycle = async (n) => {
      const before = online;
      srv.dropConnections();
      await until(() => online > before && mgr.getConnections()[0].status === 'connected', 10_000, `reconnect ${n}`);
    };
    for (let i = 0; i < 5; i++) await cycle(i); // warm-up (JIT, lazy modules)
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 5; i < 50; i++) await cycle(i);
    values.length = 0;
    gc();
    const heapAfter = process.memoryUsage().heapUsed;

    // the stale session of every dropped connection was taken over and closed
    await until(() => srv.sessionCount() === 1, 5000, 'one session on the server');
    assert.strictEqual(srv.subscriptionCount(), 1);
    assert.strictEqual(srv.monitoredItemCount(), 20);
    assert.strictEqual(mgr.connections.get('flap').monitored.size, 20);
    srv.set('Large.Item007', 777);
    await until(() => values.some((v) => v.nodeId === srv.nodeId('Large.Item007') && v.value === 777), 5000, 'values after 50 reconnects');
    const growth = heapAfter - heapBefore;
    assert.ok(growth < 8 * 1024 * 1024, `heap grew ${(growth / 1048576).toFixed(1)} MB over 45 reconnects`);
  } finally {
    await mgr.shutdown();
    await srv.close();
  }
});

test('a process that used the manager exits on its own after shutdown', async () => {
  const script = `
    const { startOpcuaTestServer } = require(${JSON.stringify(path.join(__dirname, 'support', 'opcuaTestServer.js'))});
    const OpcuaManager = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'opcuaManager.js'))});
    (async () => {
      const srv = await startOpcuaTestServer({ largeCount: 3 });
      const mgr = new OpcuaManager({ emit() {} }, { backoff: { initialMs: 20, maxMs: 50 } });
      await mgr.connect({ id: 'a', endpointUrl: srv.endpointUrl });
      await mgr.connect({ id: 'b', endpointUrl: srv.endpointUrl, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', trustServer: true });
      await mgr.monitor('a', srv.nodeId('Scalars.Double'), 100);
      await mgr.monitor('b', srv.nodeId('Scalars.Int32'), 100);
      // one connection in backoff at shutdown time
      await mgr.connect({ id: 'c', endpointUrl: 'opc.tcp://127.0.0.1:1' }, { supervise: true });
      await mgr.read('a', srv.nodeId('Scalars.String'));
      await mgr.shutdown();
      await srv.close();
      process.stdout.write('shutdown-done ' + Date.now() + '\\n');
    })().catch((e) => { console.error(e); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exit = await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 'killed' });
    }, 20_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, at: Date.now() });
    });
  });
  const done = /shutdown-done (\d+)/.exec(out);
  assert.ok(done, `child did not finish:\n${out}`);
  assert.strictEqual(exit.code, 0, out);
  const lingerMs = exit.at - Number(done[1]);
  assert.ok(lingerMs < 3000, `process stayed alive ${lingerMs} ms after shutdown`);
});
