'use strict';

// Connect-time refusal of link-local and cloud-metadata addresses for MQTT brokers, OPC UA endpoints
// and historians (these three are deliberately outside the egress guard so LAN/loopback work).

const { test } = require('node:test');
const assert = require('node:assert');
const dns = require('dns');
const { EventEmitter } = require('events');
const egress = require('../services/egressGuard');

test('isLinkLocalOrMetadata: link-local, metadata helpers and their v6 spellings; never LAN or loopback', () => {
  for (const ip of ['169.254.169.254', '169.254.0.1', '168.63.129.16', '100.100.100.200', '192.0.0.192', 'fe80::1', 'febf::1', 'fd00:ec2::254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1']) {
    assert.strictEqual(egress.isLinkLocalOrMetadata(ip), true, ip);
  }
  for (const ip of ['127.0.0.1', '::1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '100.64.0.1', 'fd12::1', '8.8.8.8', '2001:4860::1']) {
    assert.strictEqual(egress.isLinkLocalOrMetadata(ip), false, ip);
  }
});

test('the connect-time lookup refuses a name that resolves to a metadata address and passes a LAN one', async () => {
  const orig = dns.lookup;
  dns.lookup = (host, opts, cb) => cb(null, host === 'evil.example' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '10.0.0.5', family: 4 }]);
  try {
    const lookup = egress.linkLocalGuardLookup('MQTT broker');
    const run = (h, o = {}) => new Promise((resolve) => lookup(h, o, (err, a, f) => resolve({ err, a, f })));
    const bad = await run('evil.example');
    assert.strictEqual(bad.err?.code, 'EGRESS_BLOCKED');
    assert.match(bad.err.message, /link-local|metadata/);
    const meta = await run('metadata.google.internal');
    assert.strictEqual(meta.err?.code, 'EGRESS_BLOCKED');
    const good = await run('broker.lan');
    assert.ifError(good.err);
    assert.strictEqual(good.a, '10.0.0.5');
    const all = await run('broker.lan', { all: true });
    assert.deepStrictEqual(all.a, [{ address: '10.0.0.5', family: 4 }]);
  } finally {
    dns.lookup = orig;
  }
});

test('MQTT: every transport connects through the guarded lookup; a stored metadata literal is refused at connect', () => {
  const MqttManager = require('../services/mqttManager');
  const m = new MqttManager({ emit() {} });
  const seen = [];
  m._mqttConnect = (url, options) => {
    seen.push({ url, options });
    const c = new EventEmitter();
    c.end = () => {};
    c.subscribe = () => {};
    return c;
  };
  for (const protocol of ['mqtt', 'mqtts', 'ws', 'wss']) {
    m.connectToBroker({ id: `b-${protocol}`, host: 'broker.lan', port: 8883, protocol, reconnect: false });
  }
  const opt = (p) => seen.find((s) => s.url.startsWith(`${p}://`)).options;
  assert.strictEqual(typeof opt('mqtts').lookup, 'function', 'tls.connect gets the guarded lookup');
  assert.strictEqual(typeof opt('ws').wsOptions?.lookup, 'function', 'ws gets the guarded lookup');
  assert.strictEqual(typeof opt('wss').wsOptions?.lookup, 'function');
  // Plain TCP: mqtt.js does not pass `lookup` to net.createConnection, so Manifold builds the stream itself.
  assert.strictEqual(typeof opt('mqtt').lookup, 'function');
  assert.strictEqual(typeof opt('mqtt').customStream, 'function');
  assert.throws(() => m.connectToBroker({ id: 'b-meta', host: '169.254.169.254', port: 1883, reconnect: false }), /link-local|metadata/);
  assert.throws(() => m.connectToBroker({ id: 'b-meta2', host: 'metadata.google.internal', port: 1883, reconnect: false }), /link-local|metadata/);
  m.shutdown();
});

test('MQTT over plain TCP really resolves through the guard (a name resolving to 169.254.169.254 never connects)', async () => {
  const MqttManager = require('../services/mqttManager');
  const m = new MqttManager({ emit() {} });
  const orig = dns.lookup;
  dns.lookup = (host, opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
  try {
    m.connectToBroker({ id: 'b-rebind', host: 'rebind.example', port: 1883, reconnect: false, timeout: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    const info = m.getConnection('b-rebind');
    assert.match(String(info.lastError), /link-local|metadata/, String(info.lastError));
  } finally {
    dns.lookup = orig;
    m.shutdown();
  }
});

test('OPC UA: connect refuses a metadata endpoint before opening a session', async () => {
  const OpcuaManager = require('../services/opcuaManager');
  const m = new OpcuaManager({ emit() {} });
  await assert.rejects(m.connect({ endpointUrl: 'opc.tcp://169.254.169.254:4840' }), /link-local|metadata/);
  await assert.rejects(m.connect({ endpointUrl: 'opc.tcp://metadata.google.internal:4840' }), /link-local|metadata/);
  assert.strictEqual(m.getConnections().length, 0);
});

test('historians: writes and queries refuse a metadata target at connect time', async () => {
  const historians = require('../services/historians');
  let fetched = 0;
  const fetchImpl = async () => {
    fetched++;
    return new Response('', { status: 204 });
  };
  await assert.rejects(historians.writePoints({ type: 'influxdb', url: 'http://169.254.169.254:8086', org: 'o', bucket: 'b', token: 't' }, [{ tag: 'a', ts: 1, value: 1 }], fetchImpl), /link-local|metadata/);
  await assert.rejects(historians.writePoints({ type: 'timebase', url: 'http://metadata.google.internal', dataset: 'd' }, [{ tag: 'a', ts: 1, value: 1 }], fetchImpl), /link-local|metadata/);
  await assert.rejects(historians.writePoints({ type: 'timescaledb', host: '169.254.169.254', database: 'd', user: 'u' }, [{ tag: 'a', ts: 1, value: 1 }]), /link-local|metadata/);
  await assert.rejects(historians.queryTags({ type: 'influxdb', url: 'http://[fe80::1]:8086', org: 'o', bucket: 'b', token: 't' }, { search: '', limit: 10 }, fetchImpl), /link-local|metadata/);
  assert.strictEqual(fetched, 0);
});
