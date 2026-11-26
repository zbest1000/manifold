'use strict';

// Security audit, API surface (server booted with admin + viewer tokens):
//  1. a mechanical role table built from the mounted routers: every route refuses an
//     unauthenticated client, every state-changing route refuses a viewer unless it is on the
//     reviewed read-only allowlist, and each route added for alerts/codecs/IoT/trends/presets/
//     posture/broken references sits in the class it should;
//  2. one canary secret per kind of stored credential, then every outlet is grepped for it:
//     GET answers (both roles), save answers, 409 `current` bodies, config export, audit log,
//     metrics, socket events, application log lines, and the files in the data directory
//     other than the profile store itself.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { io: ioClient } = require('socket.io-client');

process.env.PORT = '0';
process.env.MANIFOLD_AUTH_TOKEN = 'audit-admin-token';
process.env.MANIFOLD_VIEWER_TOKEN = 'audit-viewer-token';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_RATE_MAX = '1000000';
process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-audit-api-'));
process.env.MANIFOLD_DATA_DIR = DATA_DIR;

const ADMIN = 'audit-admin-token';
const VIEWER = 'audit-viewer-token';

// One canary per kind of secret. Each is unique so a hit names the leak.
const CANARY = {
  brokerPassword: 'CNRY-broker-pw-7f3a',
  brokerKey: 'CNRY-broker-pki-key-91c2',
  brokerAdminSecret: 'CNRY-broker-admin-secret-0d4e',
  brokerAdminUrlPw: 'CNRY-broker-admin-urlpw-5b8f',
  historianToken: 'CNRY-historian-token-2e6a',
  historianUrlPw: 'CNRY-historian-urlpw-c71d',
  webhookPath: 'CNRY-webhook-path-48aa',
  deviceToken: 'CNRY-device-bearer-3c9b',
  snmpCommunity: 'CNRY-snmp-community-6e1f',
  snmpAuth: 'CNRY-snmp-v3-auth-a2d7',
  opcuaPassword: 'CNRY-opcua-pw-8b0c',
  cesmiiSecret: 'CNRY-cesmii-secret-1f5e'
};
const CANARIES = Object.entries(CANARY);
const findCanaries = (text) => CANARIES.filter(([, v]) => String(text).includes(v)).map(([k]) => k);

let server;
let services;
let app;
let baseUrl;
const logLines = [];
const socketEvents = [];
const sockets = [];
const origConsole = {};

before(async () => {
  for (const m of ['log', 'warn', 'error', 'info', 'debug']) {
    origConsole[m] = console[m];
    console[m] = (...args) => {
      logLines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  const mod = require('../index');
  server = mod.server;
  app = mod.app;
  services = app.locals.services;
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const token of [ADMIN, VIEWER]) {
    const s = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.onAny((event, ...args) => socketEvents.push({ token, event, data: JSON.stringify(args) }));
    await new Promise((resolve, reject) => {
      s.once('connect', resolve);
      s.once('connect_error', reject);
    });
    sockets.push(s);
  }
});

after(async () => {
  for (const s of sockets) s.close();
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models', 'outbox', 'bindings', 'iot']) services?.[s]?.stop?.();
  await services?.devices?.stop?.().catch(() => {});
  services?.audit?.close();
  server?.close();
  Object.assign(console, origConsole);
});

const call = async (p, { method = 'GET', token = ADMIN, body, headers = {} } = {}) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
};

// ---- the route table, read from the mounted routers ----------------------------------------

function routeTable() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const files = Object.fromEntries([...src.matchAll(/const (\w+) = require\('\.\/routes\/(\w+)'\)/g)].map((m) => [m[1], m[2]]));
  const rows = [];
  for (const m of src.matchAll(/app\.use\('(\/api\/[\w-]+)', (\w+)\)/g)) {
    const router = require(`../routes/${files[m[2]]}`);
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        rows.push({ method: method.toUpperCase(), path: `${m[1]}${layer.route.path === '/' ? '' : layer.route.path}` });
      }
    }
  }
  for (const m of src.matchAll(/app\.(get|post|put|delete)\('(\/api\/[\w/-]+)'/g)) rows.push({ method: m[1].toUpperCase(), path: m[2] });
  return rows;
}
const concrete = (p) => p.replace(/:(\w+)/g, 'zz-$1');

// The reviewed list of non-GET routes a viewer may call: each only reads (checked by hand in the
// audit). Adding a route to VIEWER_READ_ONLY_POSTS without adding it here fails this test.
const VIEWER_POSTS = new Set([
  'POST /api/historians/:id/query',
  'POST /api/pipelines/preview',
  'POST /api/mqtt/brokers/:brokerId/subscriptions/resolve',
  'POST /api/devices/validate-tags',
  'POST /api/tags/bindings/preview',
  'POST /api/tags/bindings/suggest',
  'POST /api/contracts/infer',
  'POST /api/codecs/test',
  'POST /api/i3x/related',
  'POST /api/i3x/value',
  'POST /api/i3x/history',
  'POST /api/cesmii/history'
]);
// GETs a viewer may not read.
const ADMIN_ONLY_GETS = new Set(['GET /api/audit']);

test('role table: unauthenticated is 401 everywhere; viewers are 403 on every state-changing route', async () => {
  const rows = routeTable();
  assert.ok(rows.length > 120, `route table looks incomplete (${rows.length})`);
  const problems = [];
  for (const r of rows) {
    const key = `${r.method} ${r.path}`;
    const p = concrete(r.path);
    const anon = await call(p, { method: r.method, token: null, body: r.method === 'GET' ? undefined : {} });
    // 429 is the brute-force throttle answering instead of 401 (still a refusal).
    if (anon.status !== 401 && anon.status !== 429) problems.push(`${key}: unauthenticated got ${anon.status}`);
    const bad = await call(p, { method: r.method, token: 'not-a-token', body: r.method === 'GET' ? undefined : {} });
    if (bad.status !== 401 && bad.status !== 429) problems.push(`${key}: wrong token got ${bad.status}`);
    const viewer = await call(p, { method: r.method, token: VIEWER, body: r.method === 'GET' ? undefined : {} });
    const mayRead = r.method === 'GET' ? !ADMIN_ONLY_GETS.has(key) : VIEWER_POSTS.has(key);
    if (mayRead && viewer.status === 403) problems.push(`${key}: viewer refused a read (${viewer.text.slice(0, 80)})`);
    if (!mayRead && viewer.status !== 403) problems.push(`${key}: viewer got ${viewer.status}, expected 403`);
  }
  assert.deepStrictEqual(problems, []);
});

test('role table: routes added in this change sit in the right class', async () => {
  const expect = [
    // [method, path, viewer may call]
    ['GET', '/api/alerts/rules', true],
    ['POST', '/api/alerts/rules', false],
    ['DELETE', '/api/alerts/rules/x', false],
    ['GET', '/api/alerts/active', true],
    ['POST', '/api/alerts/ack', false],
    ['GET', '/api/alerts/history', true],
    ['GET', '/api/alerts/history?format=csv', true],
    ['GET', '/api/codecs', true],
    ['POST', '/api/codecs', false],
    ['DELETE', '/api/codecs/x', false],
    ['POST', '/api/codecs/test', true],
    ['GET', '/api/iot/conventions', true],
    ['GET', '/api/iot/brokers', true],
    ['PUT', '/api/iot/brokers/x', false],
    ['GET', '/api/iot/devices', true],
    ['GET', '/api/trends/export.csv', true],
    ['GET', '/api/mqtt/presets', true],
    ['GET', '/api/mqtt/brokers/x/posture', true],
    ['GET', '/api/mqtt/brokers/x/canary', true],
    ['PUT', '/api/mqtt/brokers/x', false], // the canary is configured through the broker
    ['GET', '/api/system/broken-references', true],
    ['POST', '/api/system/discovery/plan', false],
    ['POST', '/api/system/discovery/start', false],
    ['POST', '/api/devices/test', false],
    ['POST', '/api/devices/x/probe', false],
    ['POST', '/api/devices/bulk', false],
    ['PUT', '/api/devices/x', false],
    ['POST', '/api/tags/bindings/cleanup-retained', false]
  ];
  for (const [method, p, viewerOk] of expect) {
    const anon = await call(p, { method, token: null, body: method === 'GET' ? undefined : {} });
    assert.ok([401, 429].includes(anon.status), `${method} ${p} unauthenticated got ${anon.status}`);
    const v = await call(p, { method, token: VIEWER, body: method === 'GET' ? undefined : {} });
    if (viewerOk) assert.notStrictEqual(v.status, 403, `${method} ${p} viewer should be allowed`);
    else assert.strictEqual(v.status, 403, `${method} ${p} viewer must be refused`);
  }
});

test('socket: a viewer socket cannot fire any state-changing event; no token means no socket', async () => {
  const { io } = require('../index');
  void io;
  await assert.rejects(
    new Promise((resolve, reject) => {
      const s = ioClient(baseUrl, { auth: {}, transports: ['websocket'], reconnection: false });
      s.once('connect', () => {
        s.close();
        resolve();
      });
      s.once('connect_error', (e) => {
        s.close();
        reject(e);
      });
    }),
    /Unauthorized|Too many failed/
  );
  const viewer = sockets[1];
  const seen = [];
  const orig = { publish: services.mqttManager.publish, connect: services.mqttManager.connectToBroker, scan: services.discovery.startScan };
  services.mqttManager.publish = async () => seen.push('publish');
  services.mqttManager.connectToBroker = () => seen.push('connect');
  services.discovery.startScan = async () => seen.push('scan');
  try {
    viewer.emit('publish-message', { brokerId: 'x', topic: 't', payload: '1' });
    viewer.emit('connect-mqtt', { host: '127.0.0.1' });
    viewer.emit('start-discovery', {});
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    Object.assign(services.mqttManager, { publish: orig.publish, connectToBroker: orig.connect });
    services.discovery.startScan = orig.scan;
  }
  assert.deepStrictEqual(seen, []);
});

// ---- canary secrets --------------------------------------------------------------------------

test('canary secrets never leave through any outlet', async () => {
  const outlets = []; // [name, text]
  const keep = (name, r) => outlets.push([name, typeof r === 'string' ? r : r.text]);

  // Plant one of each kind through the API where the API stores without connecting.
  const broker = await call('/api/mqtt/brokers', {
    method: 'POST',
    body: { name: 'canary-broker', host: '127.0.0.1', port: 1, protocol: 'mqtt', username: 'u', password: CANARY.brokerPassword, key: CANARY.brokerKey, reconnect: false }
  });
  keep('POST /api/mqtt/brokers', broker);
  assert.strictEqual(broker.status, 202, broker.text);
  const brokerId = broker.json.brokerId;
  keep('POST broker admin', await call(`/api/mqtt/brokers/${brokerId}/admin`, { method: 'POST', body: { type: 'emqx', url: `http://k:${CANARY.brokerAdminUrlPw}@127.0.0.1:1`, apiKey: 'k', apiSecret: CANARY.brokerAdminSecret } }));
  const hist = await call('/api/historians', {
    method: 'POST',
    body: { name: 'canary-hist', type: 'influxdb', url: `http://user:${CANARY.historianUrlPw}@127.0.0.1:1`, org: 'o', bucket: 'b', token: CANARY.historianToken }
  });
  keep('POST /api/historians', hist);
  assert.strictEqual(hist.status, 201, hist.text);
  const rule = await call('/api/alerts/rules', {
    method: 'POST',
    body: { name: 'canary-rule', type: 'new-topic', brokerId, webhookUrl: `https://hooks.example.invalid/services/${CANARY.webhookPath}` }
  });
  keep('POST /api/alerts/rules', rule);
  assert.strictEqual(rule.status, 201, rule.text);
  const dev = await call('/api/devices', {
    method: 'POST',
    body: { name: 'canary-http', protocol: 'http-json', host: '127.0.0.1', port: 1, enabled: false, authType: 'bearer', authToken: CANARY.deviceToken, tags: [{ key: 'k', address: '/m#$.a', type: 'number' }] }
  });
  keep('POST /api/devices httpjson', dev);
  const snmp = await call('/api/devices', {
    method: 'POST',
    body: { name: 'canary-snmp', protocol: 'snmp', host: '127.0.0.1', port: 1, enabled: false, version: '2c', community: CANARY.snmpCommunity, tags: [{ key: 'k', address: 'sysName.0' }] }
  });
  keep('POST /api/devices snmp', snmp);
  const snmp3 = await call('/api/devices', {
    method: 'POST',
    body: { name: 'canary-snmp3', protocol: 'snmp', host: '127.0.0.1', port: 1, enabled: false, version: '3', securityName: 'ops', securityLevel: 'authNoPriv', authPassword: CANARY.snmpAuth, tags: [{ key: 'k', address: 'sysName.0' }] }
  });
  keep('POST /api/devices snmp v3', snmp3);
  for (const d of [dev, snmp, snmp3]) assert.ok(d.status === 201 || d.status === 200, d.text);
  // OPC UA and CESMII connect before they store; plant those in the stores directly.
  services.profiles.upsertOpcua('canary-opcua', { id: 'canary-opcua', name: 'canary-opcua', endpointUrl: 'opc.tcp://127.0.0.1:1', username: 'op', password: CANARY.opcuaPassword });
  services.cesmii.configure({ endpoint: 'https://smip.example.invalid/graphql', authenticator: 'a', role: 'r', userName: 'u', secret: CANARY.cesmiiSecret });
  services.profiles.setCesmii({ endpoint: 'https://smip.example.invalid/graphql', authenticator: 'a', role: 'r', userName: 'u', secret: CANARY.cesmiiSecret });

  // 409 bodies: stale edits answer with `current`.
  keep('409 alert rule', await call('/api/alerts/rules', { method: 'POST', body: { ...rule.json, rev: 999 } }));
  keep('409 historian', await call('/api/historians', { method: 'POST', body: { id: hist.json.id, name: 'x', type: 'influxdb', url: 'http://x', org: 'o', bucket: 'b', rev: 999 } }));
  keep('409 broker', await call(`/api/mqtt/brokers/${brokerId}`, { method: 'PUT', body: { host: '127.0.0.1', port: 1, rev: 999 } }));
  keep('409 opcua', await call('/api/opcua/connections/canary-opcua', { method: 'PUT', body: { endpointUrl: 'opc.tcp://127.0.0.1:1', rev: 999 } }));
  keep('409 device', await call(`/api/devices/${dev.json?.id}`, { method: 'PUT', body: { ...dev.json, rev: 999 } }));
  keep('duplicate broker 409', await call('/api/mqtt/brokers', { method: 'POST', body: { name: 'dup', host: '127.0.0.1', port: 1, protocol: 'mqtt', username: 'u', password: 'other' } }));

  // Probes and tests whose error messages could echo configuration.
  keep('historian test', await call(`/api/historians/${hist.json.id}/test`, { method: 'POST', body: {} }));
  keep('historian tags', await call(`/api/historians/${hist.json.id}/tags`));
  keep('historian query (viewer)', await call(`/api/historians/${hist.json.id}/query`, { method: 'POST', token: VIEWER, body: { tags: ['a'], start: 0, end: 1000 } }));
  keep('broker admin pubsub', await call(`/api/mqtt/brokers/${brokerId}/admin/pubsub`));
  keep('trends export historian', await call(`/api/trends/export.csv?source=historian&id=${hist.json.id}&tag=a&from=0&to=1000&mode=raw`));

  // Every GET route, as admin and as viewer, with the real ids filled in.
  const ids = { brokerId, id: hist.json.id, connectionId: 'canary-opcua' };
  for (const r of routeTable().filter((x) => x.method === 'GET')) {
    for (const [role, token] of [['admin', ADMIN], ['viewer', VIEWER]]) {
      let p = r.path.replace(/:(\w+)/g, (_, k) => ids[k] || 'zz');
      if (r.path.startsWith('/api/devices/:id')) p = r.path.replace(':id', dev.json?.id || 'zz');
      keep(`${role} GET ${p}`, await call(p, { token }));
    }
  }
  keep('config export', await call('/api/system/config/export'));
  keep('config export (viewer)', await call('/api/system/config/export', { token: VIEWER }));
  keep('metrics', await call('/metrics'));
  keep('audit', await call('/api/audit?limit=500'));

  await new Promise((r) => setTimeout(r, 400)); // socket events and log lines settle
  for (const e of socketEvents) outlets.push([`socket ${e.event} (${e.token === ADMIN ? 'admin' : 'viewer'})`, e.data]);
  outlets.push(['application log', logLines.join('\n')]);
  await services.alerts.flush?.();
  for (const f of fs.readdirSync(DATA_DIR, { recursive: true })) {
    const full = path.join(DATA_DIR, String(f));
    if (!fs.statSync(full).isFile()) continue;
    if (/^profiles\.json(\.bak(\.\d+)?|\.tmp.*)?$/.test(path.basename(full))) continue; // the store itself holds secrets, mode 0600
    if (full.includes(`${path.sep}pki${path.sep}`)) continue;
    outlets.push([`data file ${f}`, fs.readFileSync(full, 'latin1')]);
  }

  // By design an admin's alert-rule answers carry the webhook URL (the editor shows it); only the
  // viewer role gets `hasWebhook`. Every other outlet must not.
  const adminRuleAnswer = (name) => /^(POST \/api\/alerts\/rules|409 alert rule|admin GET \/api\/alerts\/rules)$/.test(name);
  const leaks = [];
  for (const [name, text] of outlets) {
    const hit = findCanaries(text).filter((k) => !(k === 'webhookPath' && adminRuleAnswer(name)));
    if (hit.length) leaks.push(`${name}: ${hit.join(', ')}`);
  }
  assert.deepStrictEqual(leaks, []);
});

test('security headers: a script-restricting CSP is served, without upgrade-insecure-requests', async () => {
  const r = await call('/api/whoami');
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/upgrade-insecure-requests/.test(csp), csp);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
});

test('a masked URL password saved back keeps the stored one (historian, broker admin API)', async () => {
  const pw = 'CNRY-roundtrip-pw';
  const h = await call('/api/historians', { method: 'POST', body: { name: 'rt', type: 'influxdb', url: `http://u:${pw}@127.0.0.1:1`, org: 'o', bucket: 'b', token: 't' } });
  assert.strictEqual(h.json.url, 'http://u:***@127.0.0.1:1');
  const again = await call('/api/historians', { method: 'POST', body: { ...h.json, name: 'rt2' } });
  assert.strictEqual(again.status, 201, again.text);
  assert.strictEqual(services.profiles.getIn('historians', h.json.id).url, `http://u:${pw}@127.0.0.1:1`);
  const changed = await call('/api/historians', { method: 'POST', body: { ...again.json, url: 'http://u:new@127.0.0.1:1' } });
  assert.strictEqual(changed.status, 201);
  assert.strictEqual(services.profiles.getIn('historians', h.json.id).url, 'http://u:new@127.0.0.1:1');

  const b = await call('/api/mqtt/brokers', { method: 'POST', body: { name: 'rt-broker', host: '127.0.0.1', port: 2, reconnect: false } });
  const id = b.json.brokerId;
  await call(`/api/mqtt/brokers/${id}/admin`, { method: 'POST', body: { type: 'emqx', url: `http://k:${pw}@127.0.0.1:1`, apiKey: 'k', apiSecret: 's' } });
  const shown = (await call(`/api/mqtt/brokers/${id}/admin`)).json;
  assert.strictEqual(shown.url, 'http://k:***@127.0.0.1:1');
  await call(`/api/mqtt/brokers/${id}/admin`, { method: 'POST', body: { type: 'emqx', url: shown.url, apiKey: 'k', apiSecret: 's' } });
  assert.strictEqual(services.mqttManager.admin.get(id).url, `http://k:${pw}@127.0.0.1:1`);
});
