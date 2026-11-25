const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const OpcuaManager = require('../services/opcuaManager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(2);
  }
  throw new Error('timed out waiting for condition');
}

/** Fake node-opcua world: clients created by the factory, scripted failures. */
function makeWorld({ failFirst = 0 } = {}) {
  const world = {
    clients: [],
    connectAttempts: 0,
    subscriptions: 0,
    items: [],
    failRemaining: failFirst
  };
  world.factory = () => {
    const client = new EventEmitter();
    client.disconnected = false;
    client.connect = async () => {
      world.connectAttempts++;
      await sleep(1);
      if (world.failRemaining > 0) {
        world.failRemaining--;
        throw new Error('ECONNREFUSED');
      }
    };
    client.createSession = async () => ({
      close: async () => {},
      createSubscription2: async () => {
        world.subscriptions++;
        await sleep(5); // widen the race window
        return {
          terminate: async () => {},
          monitor: async (item) => {
            await sleep(2);
            const mi = new EventEmitter();
            mi.nodeId = item.nodeId;
            mi.terminate = async () => {};
            world.items.push(mi);
            return mi;
          }
        };
      }
    });
    client.disconnect = async () => {
      client.disconnected = true;
    };
    world.clients.push(client);
    return client;
  };
  return world;
}

function makeManager(world, extra = {}) {
  const emitted = [];
  const io = { emit: (name, payload) => emitted.push([name, payload]) };
  const mgr = new OpcuaManager(io, {
    clientFactory: world.factory,
    backoff: { initialMs: 5, maxMs: 20 },
    random: () => 1,
    valueFlushMs: 10,
    ...extra
  });
  const states = [];
  mgr.on('connection-state', (s) => states.push(`${s.state}:${s.reason}`));
  return { mgr, io, emitted, states };
}

test('supervised connect retries with backoff until success', async () => {
  const world = makeWorld({ failFirst: 3 });
  const { mgr, states } = makeManager(world);
  const res = await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x:4840' }, { supervise: true });
  assert.strictEqual(res.status, 'reconnecting');
  assert.strictEqual(mgr.getConnections()[0].status, 'reconnecting');
  await until(() => mgr.getConnections()[0].status === 'connected');
  assert.strictEqual(world.connectAttempts, 4);
  // a fresh client per attempt, dead ones disposed
  assert.ok(world.clients.slice(0, 3).every((c) => c.disconnected));
  assert.deepStrictEqual(
    states.map((s) => s.split(':')[0]),
    ['offline', 'online']
  );
  await mgr.shutdown();
});

test('unsupervised initial failure throws and keeps nothing', async () => {
  const world = makeWorld({ failFirst: 1 });
  const { mgr, states } = makeManager(world);
  await assert.rejects(mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' }), /ECONNREFUSED/);
  assert.strictEqual(mgr.getConnections().length, 0);
  assert.deepStrictEqual(states.map((s) => s.split(':')[0]), ['offline']);
  await sleep(30);
  assert.strictEqual(world.connectAttempts, 1);
});

test('lost-for-good connection is retried; state sequence has no duplicates; monitors recovered', async () => {
  const world = makeWorld();
  const { mgr, states } = makeManager(world);
  // a listener that monitors on 'online', like the tag binding engine
  mgr.on('connection-state', ({ connectionId, state }) => {
    if (state === 'online') mgr.monitor(connectionId, 'ns=2;s=B', 100).catch(() => {});
  });
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' });
  await mgr.monitor('c1', 'ns=2;s=A', 250);
  await until(() => mgr.getConnections()[0].monitoredCount === 2);
  assert.strictEqual(world.items.length, 2);

  const first = world.clients[0];
  first.emit('connection_lost'); // node-opcua retrying internally
  first.emit('connection_lost'); // duplicate must not duplicate the state
  first.emit('close');
  // node-opcua's own reconnection is off: the manager owns the retry; the two nodes wait for the next session
  assert.strictEqual(mgr.getConnections()[0].status, 'reconnecting');
  assert.strictEqual(mgr.connections.get('c1').monitored.size, 0);
  assert.strictEqual(mgr.getConnections()[0].monitoredCount, 2);

  await until(() => mgr.getConnections()[0].status === 'connected');
  await until(() => states.length === 3 && mgr.connections.get('c1').monitored.size === 2);
  assert.deepStrictEqual(
    states.map((s) => s.split(':')[0]),
    ['online', 'offline', 'online']
  );
  assert.strictEqual(world.items.length, 4); // A and B re-created exactly once
  assert.deepStrictEqual(mgr.getConnections()[0].monitoredNodes.sort(), ['ns=2;s=A', 'ns=2;s=B']);
  await mgr.shutdown();
});

test('connection_lost hands over to the supervisor: fresh client, monitors recovered once, online once', async () => {
  const world = makeWorld();
  const { mgr, states } = makeManager(world);
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' });
  await mgr.monitor('c1', 'ns=2;s=A');
  const c = world.clients[0];
  c.emit('connection_lost');
  c.emit('connection_reestablished'); // a stale event of the old client changes nothing
  await until(() => states.length === 3);
  assert.deepStrictEqual(states.map((s) => s.split(':')[0]), ['online', 'offline', 'online']);
  assert.strictEqual(world.clients.length, 2);
  assert.ok(c.disconnected);
  assert.strictEqual(world.items.length, 2);
  await mgr.shutdown();
});

test('monitor() is serialized and idempotent under concurrency', async () => {
  const world = makeWorld();
  const { mgr } = makeManager(world);
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' });
  const results = await Promise.all([
    mgr.monitor('c1', 'ns=2;s=A'),
    mgr.monitor('c1', 'ns=2;s=A'),
    mgr.monitor('c1', 'ns=2;s=B'),
    mgr.monitor('c1', 'ns=2;s=A')
  ]);
  assert.strictEqual(world.subscriptions, 1);
  assert.strictEqual(world.items.length, 2);
  assert.deepStrictEqual(results.map((r) => r.status), [
    'monitoring',
    'already-monitored',
    'monitoring',
    'already-monitored'
  ]);
  assert.strictEqual(mgr.getConnections()[0].monitoredCount, 2);
  await mgr.shutdown();
});

test('no retry after user disconnect; offline reason is removed; no leaked timers', async () => {
  const world = makeWorld({ failFirst: 1000 });
  const { mgr, states } = makeManager(world, { backoff: { initialMs: 20, maxMs: 20 } });
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' }, { supervise: true });
  await until(() => world.connectAttempts >= 2);
  await mgr.disconnect('c1');
  const attempts = world.connectAttempts;
  await sleep(80);
  assert.strictEqual(world.connectAttempts, attempts);
  assert.strictEqual(mgr.getConnections().length, 0);
  // already offline from the failed connect: no duplicate emitted
  assert.deepStrictEqual(states.map((s) => s.split(':')[0]), ['offline']);
});

test('disconnect of an online connection emits offline/removed; update emits offline then online', async () => {
  const world = makeWorld();
  const { mgr, states } = makeManager(world);
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' });
  await mgr.updateConnection('c1', { endpointUrl: 'opc.tcp://y' });
  assert.deepStrictEqual(states, ['online:connected', 'offline:updated', 'online:connected']);
  await mgr.disconnect('c1');
  assert.strictEqual(states[states.length - 1], 'offline:removed');
  await mgr.shutdown();
});

test('shutdown clears retry and flush timers', async () => {
  const world = makeWorld({ failFirst: 1000 });
  const { mgr } = makeManager(world, { backoff: { initialMs: 10, maxMs: 10 } });
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' }, { supervise: true });
  await mgr.shutdown();
  const attempts = world.connectAttempts;
  await sleep(50);
  assert.strictEqual(world.connectAttempts, attempts);
  assert.strictEqual(mgr._flushTimer, null);
  assert.strictEqual(mgr.connections.size, 0);
});

test('socket values are coalesced per node; in-process value event is immediate', async () => {
  const world = makeWorld();
  const { mgr, emitted } = makeManager(world, { valueFlushMs: 30 });
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://x' });
  await mgr.monitor('c1', 'ns=2;s=A');
  const direct = [];
  mgr.on('value', (e) => direct.push(e));
  const dv = (v) => ({
    value: { value: v, dataType: 11 },
    statusCode: { toString: () => 'Good' },
    sourceTimestamp: null,
    serverTimestamp: null
  });
  for (let i = 1; i <= 5; i++) world.items[0].emit('changed', dv(i));
  assert.strictEqual(direct.length, 5); // immediate, unchanged
  assert.deepStrictEqual(Object.keys(direct[0]).sort(), [
    'arrayType', 'connectionId', 'dataType', 'nodeId', 'serverTimestamp', 'sourceTimestamp', 'status', 'statusCode', 'value'
  ]);
  assert.strictEqual(emitted.filter(([n]) => n === 'opcua-value').length, 0);
  await sleep(60);
  const vals = emitted.filter(([n]) => n === 'opcua-value');
  assert.strictEqual(vals.length, 1);
  assert.strictEqual(vals[0][1].value, 5);
  await mgr.shutdown();
});
