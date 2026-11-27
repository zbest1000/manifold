const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const tls = require('tls');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const express = require('express');
const Aedes = require('aedes');

const MqttManager = require('../services/mqttManager');
const { assess } = require('../services/brokerPosture');
const { presetList, WARNING } = require('../services/brokerPresets');
const { assertAllowedTarget } = require('../services/egressGuard');

const NOW = Date.UTC(2026, 10, 1);
const ids = (r) => r.findings.map((f) => f.id);
const base = { protocol: 'mqtts', host: 'broker.plant.example', port: 8883, tls: true, tlsVerify: true, username: 'manifold', hasPassword: true, mqttVersion: 5, subscribeFilter: 'plant1/#', autoSubscribe: true };

test('a clean TLS connection with a user and a narrow filter has no findings', () => {
  const r = assess(base, { now: NOW });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.summary.worst, 'none');
  assert.strictEqual(r.facts.transport, 'TLS');
  assert.strictEqual(r.facts.authentication, 'username and password');
});

test('plaintext with a password to a non-loopback host: high, worst first, each finding explains and says what to change', () => {
  const r = assess({ ...base, protocol: 'mqtt', port: 1883, tls: false, host: '10.1.2.3', subscribeFilter: '#', mqttVersion: 4, sysReadable: true }, { now: NOW });
  assert.deepStrictEqual(ids(r), ['password-plaintext', 'plaintext-transport', 'wildcard-root', 'sys-readable', 'mqtt-version']);
  assert.deepStrictEqual(r.findings.map((f) => f.severity), ['high', 'medium', 'low', 'low', 'info']);
  for (const f of r.findings) {
    assert.ok(f.title && f.detail.length > 20 && f.fix.length > 10, f.id);
  }
  assert.strictEqual(r.summary.high, 1);
  assert.strictEqual(r.summary.worst, 'high');
  assert.ok(!('score' in r) && !('grade' in r), 'no scoring');
});

test('loopback lowers the findings about traffic crossing a network, a LAN address does not', () => {
  const plain = { ...base, protocol: 'mqtt', tls: false, username: undefined, hasPassword: false, subscribeFilter: 'a/#' };
  const loop = assess({ ...plain, host: '127.0.0.1' }, { now: NOW });
  assert.deepStrictEqual(loop.findings.map((f) => `${f.id}:${f.severity}`), ['anonymous:low', 'plaintext-transport:info']);
  const lan = assess({ ...plain, host: '192.168.1.5' }, { now: NOW });
  assert.deepStrictEqual(lan.findings.map((f) => `${f.id}:${f.severity}`), ['plaintext-transport:medium', 'anonymous:medium']);
  const pw = assess({ ...plain, host: 'localhost', username: 'u', hasPassword: true }, { now: NOW });
  assert.ok(pw.findings.some((f) => f.id === 'password-plaintext' && f.severity === 'info'));
});

test('TLS: verification off is high; certificate expiry is reported in days', () => {
  assert.deepStrictEqual(ids(assess({ ...base, tlsVerify: false }, { now: NOW })), ['tls-verify-off']);
  const cert = (days) => ({ validTo: new Date(NOW + days * 86400000 + 3600000).toUTCString(), subject: 'broker.plant.example' });
  const at = (days) => assess({ ...base, certificate: cert(days) }, { now: NOW });
  assert.strictEqual(at(90).findings.length, 0);
  assert.strictEqual(at(90).facts.certificateDaysLeft, 90);
  assert.deepStrictEqual(at(20).findings.map((f) => `${f.id}:${f.severity}`), ['cert-expiring:medium']);
  assert.match(at(20).findings[0].title, /20 days/);
  assert.deepStrictEqual(at(3).findings.map((f) => `${f.id}:${f.severity}`), ['cert-expiring:high']);
  const expired = at(-4);
  assert.deepStrictEqual(expired.findings.map((f) => `${f.id}:${f.severity}`), ['cert-expired:high']);
  assert.match(expired.findings[0].detail, /4 days ago/);
  // Certificate facts are reported for TLS only.
  assert.strictEqual(assess({ ...base, tls: false, protocol: 'mqtt', host: 'x.example', certificate: cert(1) }, { now: NOW }).facts.certificateDaysLeft, null);
});

test('client-id collisions: a taken-over session is high, repeated drops are a medium storm signal', () => {
  const t = (n) => NOW - n * 1000;
  assert.deepStrictEqual(ids(assess({ ...base, clientId: 'm1', sessionTakenOver: 3 }, { now: NOW })), ['client-id-collision']);
  assert.deepStrictEqual(ids(assess({ ...base, drops: [t(10), t(20), t(30), t(40)] }, { now: NOW })), []);
  assert.deepStrictEqual(ids(assess({ ...base, drops: [t(10), t(20), t(30), t(40), t(50)] }, { now: NOW })), ['reconnect-storm']);
  assert.deepStrictEqual(ids(assess({ ...base, drops: [t(1000), t(1100), t(1200), t(1300), t(1400)] }, { now: NOW })), [], 'old drops fall out of the window');
});

test('the effective subscription wins over the configured one, and auto-subscribe off has no wildcard finding', () => {
  assert.deepStrictEqual(ids(assess({ ...base, subscribeFilter: '#', effectiveFilters: ['+/+/#'] }, { now: NOW })), []);
  assert.deepStrictEqual(ids(assess({ ...base, subscribeFilter: '#', autoSubscribe: false, effectiveFilters: [] }, { now: NOW })), []);
  assert.deepStrictEqual(ids(assess({ ...base, subscribeFilter: '#', effectiveFilters: ['#'] }, { now: NOW })), ['wildcard-root']);
});

// ---- from a live manager ------------------------------------------------------------------------------------

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
  }
  subscribe(topic, opts, cb) {
    setImmediate(() => cb(null, [{ topic, qos: opts.qos }]));
  }
  publish() {}
  end() {}
}
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('manager: posture comes from the connection facts; no password or secret is exposed', async () => {
  const manager = new MqttManager({ emit() {} });
  const client = new FakeClient();
  manager._mqttConnect = () => client;
  manager.connectToBroker({ id: 'p', host: 'broker.example', port: 1883, username: 'u', password: 'hunter2', subscribeFilter: '#', mqttVersion: 4, clientId: 'fixed-id' });
  client.connected = true;
  client.emit('connect');
  await settle();
  const posture = manager.getPosture('p');
  assert.deepStrictEqual(ids(posture), ['password-plaintext', 'plaintext-transport', 'wildcard-root', 'mqtt-version']);
  assert.ok(!JSON.stringify(manager.getConnection('p')).includes('hunter2'));
  assert.strictEqual(manager.getConnection('p').hasPassword, true);

  // $SYS readable once its topics arrive.
  manager.handleMessage('p', '$SYS/broker/version', Buffer.from('mosquitto 2.0'), { qos: 0, retain: false });
  assert.ok(ids(manager.getPosture('p')).includes('sys-readable'));

  // A v5 DISCONNECT 0x8E (session taken over) is a client-id collision.
  client.emit('disconnect', { reasonCode: 142 });
  assert.ok(ids(manager.getPosture('p')).includes('client-id-collision'));

  // Five unexpected drops in a row (no DISCONNECT reason): a reconnect storm.
  const m2 = new MqttManager({ emit() {} });
  const c2 = new FakeClient();
  m2._mqttConnect = () => c2;
  m2.connectToBroker({ id: 'q', host: 'broker.example', username: 'u', password: 'x', subscribeFilter: 'a/#' });
  for (let i = 0; i < 5; i++) {
    c2.connected = true;
    c2.emit('connect');
    c2.connected = false;
    c2.emit('close');
  }
  assert.ok(ids(m2.getPosture('q')).includes('reconnect-storm'));
  assert.strictEqual(m2.getPosture('nope'), null);
  manager.shutdown();
  m2.shutdown();
});

test('the $SYS subscription is quiet when the broker refuses it, and the intake grant is reported', async () => {
  const events = [];
  const manager = new MqttManager({ emit: (name, body) => events.push([name, body]) });
  const client = new FakeClient();
  client.subscribe = (topic, opts, cb) =>
    setImmediate(() => cb(null, [{ topic, qos: topic.startsWith('$SYS') ? 128 : opts.qos }]));
  manager._mqttConnect = () => client;
  manager.connectToBroker({ id: 'q', host: 'h', subscribeFilter: 'testtopic/#', subscribeQos: 0 });
  client.connected = true;
  client.emit('connect');
  await settle();
  assert.strictEqual(events.filter(([n]) => n === 'subscription-error').length, 0, 'an expected $SYS refusal is not an error');
  assert.strictEqual(manager.getConnection('q').sysSubscription, 'refused');
  assert.deepStrictEqual(manager.getConnection('q').intake, { requested: 'testtopic/#', granted: 'testtopic/#', qos: 0, via: 'requested' });
  manager.shutdown();
});

test('a refused root wildcard walks the fallback ladder and says what was granted', async () => {
  const events = [];
  const manager = new MqttManager({ emit: (name, body) => events.push([name, body]) });
  const client = new FakeClient();
  const asked = [];
  client.subscribe = (topic, opts, cb) => {
    asked.push(`${topic}@${opts.qos}`);
    const deny = topic === '#' || topic === '+/#';
    setImmediate(() => cb(null, [{ topic, qos: deny ? 128 : opts.qos }]));
  };
  manager._mqttConnect = () => client;
  manager.connectToBroker({ id: 'f', host: 'h', subscribeFilter: '#', subscribeQos: 1 });
  client.connected = true;
  client.emit('connect');
  await settle();
  await settle();
  await settle();
  await settle();
  assert.deepStrictEqual(
    asked.filter((a) => !a.startsWith('$SYS')),
    ['#@1', '#@0', '+/#@1', '+/#@0', '+/+/#@1'],
    'each rung retries at the intake QoS, then QoS 0, before the next rung'
  );
  assert.deepStrictEqual(events.filter(([n]) => n === 'subscription-fallback').map(([, b]) => [b.topic, b.fallback]), [['#', '+/#'], ['+/#', '+/+/#']]);
  assert.deepStrictEqual(manager.getConnection('f').intake, { requested: '#', granted: '+/+/#', qos: 1, via: 'fallback' });
  assert.deepStrictEqual(manager.getSubscriptions('f').filter((t) => !t.startsWith('$')), ['+/+/#']);
  assert.strictEqual(events.filter(([n]) => n === 'subscription-error').length, 0);
  // The ladder is for the intake filter only: a narrow filter that is refused is reported, not widened.
  manager.shutdown();

  const m2 = new MqttManager({ emit: (name, body) => events.push([name, body]) });
  const c2 = new FakeClient();
  c2.subscribe = (topic, opts, cb) => setImmediate(() => cb(null, [{ topic, qos: 128 }]));
  m2._mqttConnect = () => c2;
  m2.connectToBroker({ id: 'g', host: 'h', subscribeFilter: 'testtopic/#', subscribeQos: 0 });
  c2.connected = true;
  c2.emit('connect');
  await settle();
  assert.strictEqual(m2.getConnection('g').intake.via, 'refused');
  assert.ok(events.some(([n, b]) => n === 'subscription-error' && b.topic === 'testtopic/#'));
  m2.shutdown();
});

// ---- TLS: certificate expiry read from the live session ----------------------------------------------------------

function selfSigned(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posture-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-subj', '/CN=localhost', '-keyout', key, '-out', crt], { stdio: 'ignore' });
  const out = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('a TLS broker: the certificate expiry (days left) and verification state come from the live session', async () => {
  const pair = selfSigned(10);
  const AedesClass = Aedes.Aedes || Aedes;
  const aedes = AedesClass.createBroker ? await AedesClass.createBroker() : new AedesClass();
  const server = tls.createServer(pair, aedes.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const manager = new MqttManager({ emit() {} });
  manager.connectToBroker({ id: 't', host: '127.0.0.1', port: server.address().port, protocol: 'mqtts', rejectUnauthorized: false, ca: pair.cert.toString(), username: 'u', password: 'p', subscribeFilter: 'a/#' });
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && manager.getConnection('t').status !== 'connected') await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(manager.getConnection('t').status, 'connected');
    const posture = manager.getPosture('t');
    assert.ok(posture.facts.certificateDaysLeft >= 9 && posture.facts.certificateDaysLeft <= 10, `days left ${posture.facts.certificateDaysLeft}`);
    assert.strictEqual(posture.facts.certificateVerified, false);
    assert.deepStrictEqual(ids(posture), ['tls-verify-off', 'cert-expiring', 'mqtt-version']);
    assert.strictEqual(posture.findings[1].severity, 'medium');
    assert.strictEqual(manager.getConnection('t').tls.certificate.selfSigned, true);
  } finally {
    manager.shutdown();
    await new Promise((r) => aedes.close(r));
    await new Promise((r) => server.close(r));
  }
});

// ---- the routes ------------------------------------------------------------------------------------------------

async function withApp(mqttManager, fn) {
  const app = express();
  app.use(express.json());
  app.locals.services = { mqttManager, profiles: null };
  app.use('/api/mqtt', require('../routes/mqtt'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('routes: list carries the posture summary and canary state; /posture and /canary give the detail', async () => {
  const manager = new MqttManager({ emit() {} });
  manager._mqttConnect = () => new FakeClient();
  manager.connectToBroker({ id: 'r1', host: 'broker.example', subscribeFilter: '#', canary: { enabled: true } });
  await withApp(manager, async (call) => {
    const list = await call('GET', '/api/mqtt/brokers');
    assert.strictEqual(list.body.brokers[0].posture.worst, 'medium');
    assert.strictEqual(list.body.brokers[0].canaryState.state, 'unknown');
    const posture = await call('GET', '/api/mqtt/brokers/r1/posture');
    assert.strictEqual(posture.status, 200);
    assert.ok(posture.body.findings.length && posture.body.facts);
    const canary = await call('GET', '/api/mqtt/brokers/r1/canary');
    assert.strictEqual(canary.body.topic, 'manifold/canary/r1');
    assert.strictEqual((await call('GET', '/api/mqtt/brokers/none/posture')).status, 404);
    assert.strictEqual((await call('GET', '/api/mqtt/brokers/none/canary')).status, 404);
    const bad = await call('POST', '/api/mqtt/brokers', { host: 'h2', canary: { enabled: true, intervalSec: 1 } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /intervalSec/);
  });
  manager.shutdown();
});

// ---- presets ----------------------------------------------------------------------------------------------------

test('presets: public hostnames, narrow default filter, a public-broker warning, no secrets', () => {
  const presets = presetList();
  assert.ok(presets.length >= 3);
  const hosts = presets.map((p) => p.host);
  assert.ok(['broker.emqx.io', 'broker.hivemq.com', 'test.mosquitto.org'].every((h) => hosts.includes(h)));
  for (const p of presets) {
    assert.ok(!net.isIP(p.host), 'hostnames, not address literals');
    assert.notStrictEqual(p.subscribeFilter, '#', `${p.id} starts narrow`);
    assert.ok(!p.subscribeFilter.startsWith('+/'));
    assert.strictEqual(p.warning, WARNING);
    assert.match(WARNING, /visible to everyone/);
    assert.ok(!p.username && !p.password);
    assert.strictEqual(p.protocol === 'mqtts', p.port === 8883);
    assert.strictEqual(p.rejectUnauthorized, true);
  }
  assert.strictEqual(new Set(presets.map((p) => p.id)).size, presets.length);
});

test('presets respect the egress guard (a public name passes, a name that resolves to a private address is refused) and the duplicate refusal', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];
  for (const p of presetList()) {
    await assertAllowedTarget(p.host, { purpose: 'mqtt', lookup: publicLookup });
    await assert.rejects(() => assertAllowedTarget(p.host, { purpose: 'mqtt', lookup: privateLookup }), /EGRESS|blocked|not allowed|private/i);
  }
  // Applying a preset twice is refused by the same duplicate rule as any other broker.
  const manager = new MqttManager({ emit() {} });
  manager._mqttConnect = () => new FakeClient();
  const preset = presetList()[0];
  const body = { name: preset.name, host: preset.host, port: preset.port, protocol: preset.protocol, subscribeFilter: preset.subscribeFilter };
  await withApp(manager, async (call) => {
    assert.strictEqual((await call('POST', '/api/mqtt/brokers', body)).status, 202);
    const again = await call('POST', '/api/mqtt/brokers', { ...body, name: 'again' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'duplicate');
    assert.strictEqual((await call('GET', '/api/mqtt/presets')).body.presets.length, presetList().length);
  });
  manager.shutdown();
});
