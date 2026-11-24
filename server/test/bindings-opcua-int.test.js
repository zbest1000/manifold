const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const OpcuaManager = require('../services/opcuaManager');
const { TagBindings } = require('../services/tagBindings');

// Integration of the real OpcuaManager (fake node-opcua client) with the real
// TagBindings: the two were built against a shared event contract, this proves
// they agree on it end to end.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(2);
  }
  throw new Error('timed out waiting for condition');
}

const NODE = 'ns=2;s=Motor.RPM';
const dataValue = (value, status = 'Good') => ({
  value: { value, dataType: 11 }, // node-opcua DataType.Double
  statusCode: { toString: () => status },
  sourceTimestamp: new Date()
});

function makeWorld({ failFirst = 0 } = {}) {
  const world = { clients: [], items: [], failRemaining: failFirst };
  world.factory = () => {
    const client = new EventEmitter();
    client.connect = async () => {
      if (world.failRemaining > 0) {
        world.failRemaining--;
        throw new Error('ECONNREFUSED');
      }
    };
    client.createSession = async () => ({
      close: async () => {},
      createSubscription2: async () => ({
        terminate: async () => {},
        monitor: async (item) => {
          const mi = new EventEmitter();
          mi.nodeId = item.nodeId;
          mi.terminate = async () => {};
          world.items.push(mi);
          return mi;
        }
      })
    });
    client.disconnect = async () => {};
    world.clients.push(client);
    return client;
  };
  world.lastItem = () => world.items[world.items.length - 1];
  return world;
}

function setup(world) {
  const mgr = new OpcuaManager(
    { emit: () => {} },
    { clientFactory: world.factory, backoff: { initialMs: 5, maxMs: 20 }, random: () => 1, valueFlushMs: 5 }
  );
  const binding = {
    id: 'b1',
    enabled: true,
    source: { type: 'opcua', connectionId: 'c1', tags: [{ address: NODE, name: 'rpm' }] },
    target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'uns/line1/{name}', format: 'envelope' }
  };
  const profiles = {
    data: { bindings: { b1: binding } },
    listIn: (c) => Object.values(profiles.data[c] || {}),
    getIn: (c, id) => (profiles.data[c] || {})[id] || null
  };
  const mqtt = new EventEmitter();
  mqtt.published = [];
  mqtt.publish = async (brokerId, topic, payload, opts) => {
    mqtt.published.push({ topic, payload, opts });
  };
  const tb = new TagBindings({ mqttManager: mqtt, opcuaManager: mgr, profiles, sparkplugPublisher: null });
  const values = () => mqtt.published.filter((p) => p.topic === 'uns/line1/rpm').map((p) => p.payload);
  const status = () => mqtt.published.filter((p) => p.topic === 'uns/line1/_status').map((p) => p.payload);
  return { mgr, tb, mqtt, values, status };
}

test('binding created before the connection exists starts flowing once it connects', async () => {
  const world = makeWorld({ failFirst: 2 });
  const { mgr, tb, values, status } = setup(world);
  tb.start(); // server start order: bindings first, restore afterwards
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://plc:4840' }, { supervise: true });
  await until(() => world.items.length === 1);

  world.lastItem().emit('changed', dataValue(1500));
  await until(() => values().length === 1);
  assert.strictEqual(values()[0].v, 1500);
  assert.strictEqual(values()[0].q, 192);
  assert.ok(status().some((s) => s.online === true));

  tb.stop();
  await mgr.shutdown();
});

test('connection loss publishes Bad once, recovery re-monitors and publishes Good again', async () => {
  const world = makeWorld();
  const { mgr, tb, values, status } = setup(world);
  tb.start();
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://plc:4840' }, { supervise: true });
  await until(() => world.items.length === 1);
  world.lastItem().emit('changed', dataValue(1500));
  await until(() => values().length === 1);

  // node-opcua gives up on the connection for good
  world.clients[0].emit('close');
  await until(() => values().length === 2);
  assert.strictEqual(values()[1].v, 1500);
  assert.strictEqual(values()[1].q, 0);
  assert.ok(status().some((s) => s.online === false));

  // supervised retry builds a new client and the monitor comes back
  await until(() => world.clients.length === 2 && world.items.length === 2);
  world.lastItem().emit('changed', dataValue(1500)); // same value as before the outage
  await until(() => values().length === 3);
  assert.strictEqual(values()[2].q, 192);
  assert.strictEqual(status()[status().length - 1].online, true);
  assert.strictEqual(values().filter((v) => v.q === 0).length, 1);

  tb.stop();
  await mgr.shutdown();
});

test('quality-only change from the server is published', async () => {
  const world = makeWorld();
  const { mgr, tb, values } = setup(world);
  tb.start();
  await mgr.connect({ id: 'c1', endpointUrl: 'opc.tcp://plc:4840' });
  await until(() => world.items.length === 1);
  world.lastItem().emit('changed', dataValue(7));
  world.lastItem().emit('changed', dataValue(7, 'BadSensorFailure (0x808d0000)'));
  await until(() => values().length === 2);
  assert.deepStrictEqual(values().map((v) => v.q), [192, 0]);

  tb.stop();
  await mgr.shutdown();
});
