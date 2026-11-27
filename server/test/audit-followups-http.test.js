'use strict';

// Security follow-ups to the API review (server booted with an admin token). Each test names the
// flaw it pins: a stored secret following an endpoint change, link-local/metadata targets for the
// connection kinds outside the egress guard, webhook URLs as secrets, the broker canary topic.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.PORT = '0';
process.env.MANIFOLD_AUTH_TOKEN = 'followup-admin-token';
process.env.MANIFOLD_VIEWER_TOKEN = 'followup-viewer-token';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_RATE_MAX = '1000000';
process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-followups-'));
process.env.MANIFOLD_DATA_DIR = DATA_DIR;

const ADMIN = 'followup-admin-token';

let server;
let services;
let baseUrl;
const origConsole = {};

before(async () => {
  for (const m of ['log', 'warn', 'info']) {
    origConsole[m] = console[m];
    console[m] = () => {};
  }
  const mod = require('../index');
  server = mod.server;
  services = mod.app.locals.services;
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models', 'outbox', 'bindings', 'iot']) services?.[s]?.stop?.();
  await services?.devices?.stop?.().catch(() => {});
  services?.audit?.close();
  server?.close();
  Object.assign(console, origConsole);
});

const call = async (p, { method = 'GET', token = ADMIN, body } = {}) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json };
};

const secretRequired = (r, field) => {
  assert.strictEqual(r.status, 400, r.text);
  assert.strictEqual(r.json.code, 'secret-required', r.text);
  assert.strictEqual(r.json.field, field, r.text);
  assert.match(r.json.error, /address changed/i);
};

// ---- 1. a stored secret never follows an endpoint change ----------------------------------------

test('broker: a host or port change with the password left blank is refused; a name/path change keeps it', async () => {
  const pw = 'stored-broker-pw';
  const b = await call('/api/mqtt/brokers', { method: 'POST', body: { name: 'sec-b', host: '127.0.0.1', port: 11, protocol: 'ws', wsPath: '/mqtt', username: 'u', password: pw, reconnect: false } });
  assert.strictEqual(b.status, 202, b.text);
  const id = b.json.brokerId;
  const stored = () => services.profiles.getBroker(id).config;
  const base = { name: 'sec-b', host: '127.0.0.1', port: 11, protocol: 'ws', wsPath: '/mqtt', username: 'u', reconnect: false };

  secretRequired(await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...base, host: 'attacker.example' } }), 'password');
  secretRequired(await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...base, port: 12 } }), 'password');
  secretRequired(await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...base, protocol: 'wss' } }), 'password');
  assert.strictEqual(stored().host, '127.0.0.1');
  assert.strictEqual(stored().password, pw);

  const renamed = await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...base, name: 'sec-b2', wsPath: '/other' } });
  assert.strictEqual(renamed.status, 202, renamed.text);
  assert.strictEqual(stored().password, pw);
  const sameHostOtherCase = await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...base, host: '127.0.0.1.' } });
  assert.strictEqual(sameHostOtherCase.status, 202, sameHostOtherCase.text);
  assert.strictEqual(stored().password, pw);

  const moved = await call(`/api/mqtt/brokers/${id}`, { method: 'PUT', body: { ...base, host: '127.0.0.2', password: 'new-pw' } });
  assert.strictEqual(moved.status, 202, moved.text);
  assert.strictEqual(stored().password, 'new-pw');
});

test('broker admin API: a masked URL password saved against another host is refused, a path change keeps it', async () => {
  const b = await call('/api/mqtt/brokers', { method: 'POST', body: { name: 'sec-admin', host: '127.0.0.1', port: 13, reconnect: false } });
  const id = b.json.brokerId;
  await call(`/api/mqtt/brokers/${id}/admin`, { method: 'POST', body: { type: 'emqx', url: 'http://k:admin-pw@127.0.0.1:1/api/v5', apiKey: 'k', apiSecret: 's' } });
  const shown = (await call(`/api/mqtt/brokers/${id}/admin`)).json;
  secretRequired(await call(`/api/mqtt/brokers/${id}/admin`, { method: 'POST', body: { type: 'emqx', url: shown.url.replace('127.0.0.1:1', 'attacker.example:1') } }), 'url');
  assert.strictEqual(services.mqttManager.admin.get(id).url, 'http://k:admin-pw@127.0.0.1:1/api/v5');
  const pathOnly = await call(`/api/mqtt/brokers/${id}/admin`, { method: 'POST', body: { type: 'emqx', url: shown.url.replace('/api/v5', '/api/v6') } });
  assert.strictEqual(pathOnly.status, 200, pathOnly.text);
  assert.strictEqual(services.mqttManager.admin.get(id).url, 'http://k:admin-pw@127.0.0.1:1/api/v6');
});

test('historian: a URL/host change with the token or password left blank is refused; a path change keeps it', async () => {
  const h = await call('/api/historians', { method: 'POST', body: { name: 'sec-h', type: 'influxdb', url: 'http://127.0.0.1:8086', org: 'o', bucket: 'b', token: 'stored-token' } });
  assert.strictEqual(h.status, 201, h.text);
  const id = h.json.id;
  const base = { id, name: 'sec-h', type: 'influxdb', url: 'http://127.0.0.1:8086', org: 'o', bucket: 'b' };
  secretRequired(await call('/api/historians', { method: 'POST', body: { ...base, url: 'http://attacker.example:8086' } }), 'token');
  secretRequired(await call('/api/historians', { method: 'POST', body: { ...base, url: 'https://127.0.0.1:8086' } }), 'token');
  assert.strictEqual(services.profiles.getIn('historians', id).token, 'stored-token');
  assert.strictEqual(services.profiles.getIn('historians', id).url, 'http://127.0.0.1:8086');
  const pathOnly = await call('/api/historians', { method: 'POST', body: { ...base, url: 'http://127.0.0.1:8086/influx' } });
  assert.strictEqual(pathOnly.status, 201, pathOnly.text);
  assert.strictEqual(services.profiles.getIn('historians', id).token, 'stored-token');

  // A password inside the URL: the masked form saved against another host is refused, not stored as "***".
  const u = await call('/api/historians', { method: 'POST', body: { name: 'sec-hu', type: 'timebase', url: 'http://u:url-pw@127.0.0.1:4511', dataset: 'd' } });
  secretRequired(await call('/api/historians', { method: 'POST', body: { ...u.json, url: 'http://u:***@attacker.example:4511' } }), 'url');
  const kept = await call('/api/historians', { method: 'POST', body: { ...u.json, url: 'http://u:***@127.0.0.1:4511/base' } });
  assert.strictEqual(kept.status, 201, kept.text);
  assert.strictEqual(services.profiles.getIn('historians', u.json.id).url, 'http://u:url-pw@127.0.0.1:4511/base');

  const t = await call('/api/historians', { method: 'POST', body: { name: 'sec-ts', type: 'timescaledb', host: '127.0.0.1', port: 5432, database: 'd', user: 'u', password: 'db-pw' } });
  const tb = { id: t.json.id, name: 'sec-ts', type: 'timescaledb', host: '127.0.0.1', database: 'd', user: 'u' };
  secretRequired(await call('/api/historians', { method: 'POST', body: { ...tb, host: 'attacker.example', port: 5432 } }), 'password');
  secretRequired(await call('/api/historians', { method: 'POST', body: { ...tb, port: 6432 } }), 'password');
  const dbOnly = await call('/api/historians', { method: 'POST', body: { ...tb, port: 5432, database: 'other' } });
  assert.strictEqual(dbOnly.status, 201, dbOnly.text);
  assert.strictEqual(services.profiles.getIn('historians', t.json.id).password, 'db-pw');
});

test('OPC UA: an endpoint change with the password left blank is refused before anything connects', async () => {
  services.profiles.upsertOpcua('sec-ua', { id: 'sec-ua', name: 'sec-ua', endpointUrl: 'opc.tcp://127.0.0.1:4840/ua', username: 'op', password: 'ua-pw' });
  const r = await call('/api/opcua/connections/sec-ua', { method: 'PUT', body: { name: 'sec-ua', endpointUrl: 'opc.tcp://attacker.example:4840/ua', username: 'op' } });
  secretRequired(r, 'password');
  assert.strictEqual(services.profiles.opcuaEndpoints().find((c) => c.id === 'sec-ua').password, 'ua-pw');
  secretRequired(await call('/api/opcua/connections/sec-ua', { method: 'PUT', body: { endpointUrl: 'opc.tcp://127.0.0.1:4841/ua', username: 'op' } }), 'password');
});

test('device: a host/port/scheme change with a stored token or community left blank is refused (save and test)', async () => {
  const d = await call('/api/devices', {
    method: 'POST',
    body: { name: 'sec-http', protocol: 'http-json', host: '127.0.0.1', port: 1, enabled: false, authType: 'bearer', authToken: 'dev-token', tags: [{ key: 'k', address: '/m#$.a', type: 'number' }] }
  });
  assert.strictEqual(d.status, 201, d.text);
  const stored = () => services.profiles.getIn('devices', d.json.id);
  const body = { ...d.json, authToken: null };
  secretRequired(await call(`/api/devices/${d.json.id}`, { method: 'PUT', body: { ...body, host: '127.0.0.2' } }), 'authToken');
  secretRequired(await call(`/api/devices/${d.json.id}`, { method: 'PUT', body: { ...body, port: 2 } }), 'authToken');
  secretRequired(await call(`/api/devices/${d.json.id}`, { method: 'PUT', body: { ...body, scheme: 'https' } }), 'authToken');
  // The connection test with the stored id must not carry the stored token to another host either.
  secretRequired(await call('/api/devices/test', { method: 'POST', body: { device: { ...body, host: '127.0.0.2' } } }), 'authToken');
  assert.strictEqual(stored().authToken, 'dev-token');
  assert.strictEqual(stored().host, '127.0.0.1');
  const renamed = await call(`/api/devices/${d.json.id}`, { method: 'PUT', body: { ...body, name: 'sec-http-2', path: '/other' } });
  assert.strictEqual(renamed.status, 200, renamed.text);
  assert.strictEqual(stored().authToken, 'dev-token');
  // Switching to no authentication while moving needs no secret: the stale one is dropped.
  const noAuth = await call(`/api/devices/${d.json.id}`, { method: 'PUT', body: { ...renamed.json, authToken: null, host: '127.0.0.2', authType: 'none' } });
  assert.strictEqual(noAuth.status, 200, noAuth.text);
  assert.ok(!stored().authToken);

  const s = await call('/api/devices', {
    method: 'POST',
    body: { name: 'sec-snmp', protocol: 'snmp', host: '127.0.0.1', port: 1, enabled: false, version: '2c', community: 'stored-community', tags: [{ key: 'k', address: 'sysName.0' }] }
  });
  assert.strictEqual(s.status, 201, s.text);
  secretRequired(await call(`/api/devices/${s.json.id}`, { method: 'PUT', body: { ...s.json, community: null, host: '127.0.0.3' } }), 'community');
  assert.strictEqual(services.profiles.getIn('devices', s.json.id).community, 'stored-community');
});

test('config import: an item whose endpoint differs from the stored one never inherits the stored secret', async () => {
  const h = await call('/api/historians', { method: 'POST', body: { name: 'imp-h', type: 'influxdb', url: 'http://127.0.0.1:8087', org: 'o', bucket: 'b', token: 'imp-token' } });
  const d = await call('/api/devices', {
    method: 'POST',
    body: { name: 'imp-http', protocol: 'http-json', host: '127.0.0.1', port: 1, enabled: false, authType: 'bearer', authToken: 'imp-dev-token', tags: [{ key: 'k', address: '/m#$.a', type: 'number' }] }
  });
  const exp = (await call('/api/system/config/export')).json;
  const hist = exp.historians.find((x) => x.id === h.json.id);
  const dev = exp.devices.find((x) => x.id === d.json.id);
  assert.strictEqual(hist.token, null);
  assert.strictEqual(dev.authToken, null);

  // Same endpoint: the stored secrets are kept.
  let r = await call('/api/system/config/import', { method: 'POST', body: { manifoldConfig: 1, historians: [hist], devices: [dev] } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(services.profiles.getIn('historians', h.json.id).token, 'imp-token');
  assert.strictEqual(services.profiles.getIn('devices', d.json.id).authToken, 'imp-dev-token');

  // Another endpoint: imported as is, without the stored secrets.
  r = await call('/api/system/config/import', {
    method: 'POST',
    body: { manifoldConfig: 1, historians: [{ ...hist, url: 'http://attacker.example:8087' }], devices: [{ ...dev, host: '127.0.0.9' }] }
  });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(!services.profiles.getIn('historians', h.json.id).token);
  assert.ok(!services.profiles.getIn('devices', d.json.id).authToken);
  assert.strictEqual(services.profiles.getIn('devices', d.json.id).host, '127.0.0.9');
});

// ---- 2. link-local and cloud-metadata targets for brokers, OPC UA and historians -------------------

test('broker, OPC UA and historian saves refuse link-local and metadata targets; LAN and loopback still pass', async () => {
  const inUrl = (h) => (h.includes(':') ? `[${h}]` : h);
  for (const host of ['169.254.169.254', '169.254.10.1', 'fe80::1', '::ffff:169.254.169.254', 'metadata.google.internal', 'Metadata.Google.Internal.']) {
    const b = await call('/api/mqtt/brokers', { method: 'POST', body: { name: `ll-${host}`, host, port: 1883, reconnect: false } });
    assert.strictEqual(b.status, 403, `broker ${host}: ${b.text}`);
    assert.match(b.json.error, /link-local|metadata/i);
    const h = await call('/api/historians', { method: 'POST', body: { name: `ll-${host}`, type: 'influxdb', url: `http://${inUrl(host)}:8086`, org: 'o', bucket: 'b', token: 't' } });
    assert.strictEqual(h.status, 403, `historian ${host}: ${h.text}`);
    const o = await call('/api/opcua/connections', { method: 'POST', body: { name: `ll-${host}`, endpointUrl: `opc.tcp://${inUrl(host)}:4840` } });
    assert.strictEqual(o.status, 403, `opcua ${host}: ${o.text}`);
  }
  const ts = await call('/api/historians', { method: 'POST', body: { name: 'll-ts', type: 'timescaledb', host: '169.254.169.254', database: 'd', user: 'u' } });
  assert.strictEqual(ts.status, 403, ts.text);
  // An existing broker cannot be moved there either.
  const ok = await call('/api/mqtt/brokers', { method: 'POST', body: { name: 'll-ok', host: '192.168.1.20', port: 1883, reconnect: false } });
  assert.strictEqual(ok.status, 202, ok.text);
  const moved = await call(`/api/mqtt/brokers/${ok.json.brokerId}`, { method: 'PUT', body: { name: 'll-ok', host: '169.254.169.254', port: 1883, reconnect: false } });
  assert.strictEqual(moved.status, 403, moved.text);
  // Loopback and private stay allowed for these three kinds.
  const lan = await call('/api/historians', { method: 'POST', body: { name: 'll-lan', type: 'influxdb', url: 'http://10.1.2.3:8086', org: 'o', bucket: 'b', token: 't' } });
  assert.strictEqual(lan.status, 201, lan.text);
  const local = await call('/api/historians', { method: 'POST', body: { name: 'll-local', type: 'influxdb', url: 'http://localhost:8086', org: 'o', bucket: 'b', token: 't' } });
  assert.strictEqual(local.status, 201, local.text);
});

// ---- 3. webhook URLs are secrets ------------------------------------------------------------------

test('alert webhook: answers carry hasWebhook + origin only; omitted keeps it, empty removes it, a new URL replaces it', async () => {
  const b = await call('/api/mqtt/brokers', { method: 'POST', body: { name: 'wh-b', host: '127.0.0.1', port: 21, reconnect: false } });
  const brokerId = b.json.brokerId;
  const url = 'https://hooks.example.com/services/T0/B0/wh-secret-path?token=q';
  const created = await call('/api/alerts/rules', { method: 'POST', body: { name: 'wh', type: 'new-topic', brokerId, webhookUrl: url } });
  assert.strictEqual(created.status, 201, created.text);
  assert.ok(!created.text.includes('wh-secret-path'), created.text);
  assert.strictEqual(created.json.hasWebhook, true);
  assert.strictEqual(created.json.webhookOrigin, 'https://hooks.example.com');
  const stored = () => services.profiles.alertRules().find((r) => r.id === created.json.id).webhookUrl;
  assert.strictEqual(stored(), url);

  // Saving the rule back as answered (no webhookUrl key, or null as the answer shows it) keeps the stored URL.
  const { webhookUrl: _w, ...noHook } = created.json;
  let r = await call('/api/alerts/rules', { method: 'POST', body: { ...noHook, name: 'wh2' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(stored(), url);
  r = await call('/api/alerts/rules', { method: 'POST', body: { ...r.json, name: 'wh3' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(stored(), url);
  // A new URL replaces it; an empty string removes it.
  r = await call('/api/alerts/rules', { method: 'POST', body: { ...r.json, webhookUrl: 'https://other.example.com/x' } });
  assert.strictEqual(stored(), 'https://other.example.com/x');
  assert.strictEqual(r.json.webhookOrigin, 'https://other.example.com');
  r = await call('/api/alerts/rules', { method: 'POST', body: { ...r.json, webhookUrl: '' } });
  assert.strictEqual(stored(), null);
  assert.strictEqual(r.json.hasWebhook, false);
  // The list never carries it either, for any role.
  await call('/api/alerts/rules', { method: 'POST', body: { ...r.json, webhookUrl: url } });
  for (const token of [ADMIN, 'followup-viewer-token']) {
    const list = await call('/api/alerts/rules', { token });
    assert.ok(!list.text.includes('wh-secret-path'), list.text);
  }
});
