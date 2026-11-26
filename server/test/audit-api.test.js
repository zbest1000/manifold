'use strict';

// Security audit regressions for the API services (no server boot): each test names the flaw it pins.

const { test } = require('node:test');
const assert = require('node:assert');

test('binding select globs: a hostile pattern cannot stall the event loop (ReDoS)', () => {
  const { compileSelect, selectTag } = require('../services/bindingContext');
  // Compiled to a RegExp (`.*a.*a…b`) this took over a minute on a 40-character key.
  const cs = compileSelect({ include: ['*a'.repeat(60) + 'b'] });
  const t0 = Date.now();
  const r = selectTag(cs, { key: 'a'.repeat(4000) });
  assert.strictEqual(r.matched, false);
  assert.ok(Date.now() - t0 < 500, `glob match took ${Date.now() - t0} ms`);
  // Semantics kept: * any run, ? one character, whole string, case-insensitive, regex chars literal.
  const m = (pattern, key) => selectTag(compileSelect({ include: [pattern] }), { key }).matched;
  assert.ok(m('temp*', 'Temperature'));
  assert.ok(m('*ture', 'temperature'));
  assert.ok(m('t?mp', 'TEMP'));
  assert.ok(!m('t?mp', 'tmp'));
  assert.ok(m('a.b(c)', 'A.B(C)'));
  assert.ok(!m('a.b', 'axb'));
  assert.ok(m('*', ''));
  assert.ok(m('a*b*c', 'aXXbYYc'));
  assert.ok(!m('a*b*c', 'aXXbYY'));
});

test('alert webhook failures never quote the webhook URL (its path is the credential; every role sees the error)', async () => {
  const { AlertEngine } = require('../services/alertEngine');
  const { guardedFetch } = require('../services/egressGuard');
  const secret = 'T000/B000/CNRY-webhook-secret';
  const url = `https://hooks.example.com/services/${secret}`;
  const rules = [{ id: 'r1', type: 'new-topic', brokerId: 'b1', webhookUrl: url }];
  const profiles = { alertRules: () => rules, getBroker: () => ({}), brokers: () => [{ config: { id: 'b1' } }] };
  const manager = { getConnection: () => ({}), on() {}, off() {}, stores: new Map() };
  // The production path: guardedFetch with a peer that never answers, so the deadline fires.
  const hang = (u, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)));
  const fetchImpl = (u, o) => guardedFetch(u, o, 50, { fetch: hang, lookup: async () => [{ address: '93.184.215.14', family: 4 }] });
  const eng = new AlertEngine({ io: { emit() {} }, profiles, mqttManager: manager, fetchImpl });
  eng._emit(rules[0], 'firing', { detail: 'x' });
  await new Promise((r) => setTimeout(r, 300));
  const state = eng.getRuleState(rules[0]);
  assert.ok(state.webhook.lastError, 'the failure is recorded');
  assert.match(state.webhook.lastError, /hooks\.example\.com/, 'the origin is still named');
  assert.ok(!JSON.stringify(state).includes(secret), state.webhook.lastError);
  assert.ok(!String(eng.lastWebhookError).includes(secret), eng.lastWebhookError);
});

test('fetchWithTimeout names only the origin when a request times out', async () => {
  const http = require('http');
  const { fetchWithTimeout } = require('../services/httpTimeout');
  const srv = http.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${srv.address().port}/write?token=CNRY-q`, {}, 100), (e) => {
      assert.match(e.message, /timed out/);
      assert.ok(!e.message.includes('CNRY-q'), e.message);
      return true;
    });
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('Trends CSV comments: a source name with a line break cannot start a CSV line', () => {
  const { headerComments } = require('../services/trendsExport');
  const lines = headerComments({ sourceLabel: 'recording "a\r\n=HYPERLINK(""http://x"")"', from: 0, to: 1000, mode: 'raw', quality: 'stored' });
  for (const l of lines) assert.ok(!/[\r\n]/.test(l), JSON.stringify(l));
  assert.ok(lines.join('\n').split('\n').every((l) => l.startsWith('#')));
});

test('an unwritable data directory is reported by GET /api/system/status, not only logged', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const express = require('express');
  const ProfileStore = require('../services/profileStore');
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-ro-')), 'file');
  fs.writeFileSync(blocker, 'x');
  const profiles = new ProfileStore(path.join(blocker, 'data')); // a directory under a file: ENOTDIR
  const origError = console.error;
  console.error = () => {};
  try {
    profiles.upsertIn('historians', 'h1', { name: 'h', type: 'influxdb' });
    profiles.flush();
  } finally {
    console.error = origError;
  }
  assert.ok(profiles.persistError, 'the failure is kept');
  const app = express();
  const stub = { getConnections: () => [], isScanning: () => false, status: () => ({}) };
  app.locals.services = { mqttManager: stub, opcuaManager: stub, discovery: stub, cesmii: stub, i3x: stub, profiles, alerts: null };
  app.use('/api/system', require('../routes/system'));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/system/status`)).json();
    assert.strictEqual(body.status, 'degraded');
    assert.strictEqual(body.storage.profiles.ok, false);
    assert.match(body.storage.profiles.error, /ENOTDIR|EEXIST|not a directory/);
  } finally {
    srv.close();
  }
});

test('outbound client errors do not quote a URL password (broker admin API, i3X, CESMII)', async () => {
  // fetch refuses a URL with credentials and quotes it whole; these errors reach viewer-callable routes.
  const brokerAdmin = require('../services/brokerAdmin');
  const I3xClient = require('../services/i3xClient');
  const CesmiiClient = require('../services/cesmiiClient');
  const pw = 'CNRY-outbound-pw';
  const errors = [];
  await brokerAdmin.fetchPubSub({ type: 'emqx', url: `http://k:${pw}@93.184.215.14`, apiKey: 'k', apiSecret: 's' }).catch((e) => errors.push(e.message));
  await new I3xClient().request('/namespaces', { baseUrl: `http://u:${pw}@93.184.215.14` }).catch((e) => errors.push(e.message));
  const c = new CesmiiClient();
  c.configure({ endpoint: `http://u:${pw}@93.184.215.14/graphql`, authenticator: 'a', role: 'r', userName: 'u', secret: 's' });
  await c.post({}).catch((e) => errors.push(e.message));
  assert.strictEqual(errors.length, 3, JSON.stringify(errors));
  for (const m of errors) assert.ok(!m.includes(pw), m);
});

test('URL passwords are stripped wherever the URL sits in a string', () => {
  const { stripUrlCredentials, redactSecrets } = require('../services/secrets');
  assert.strictEqual(stripUrlCredentials('http://u:pw@h/x'), 'http://u:***@h/x');
  assert.strictEqual(stripUrlCredentials('cannot fetch http://u:pw@h/x: refused'), 'cannot fetch http://u:***@h/x: refused');
  assert.strictEqual(redactSecrets({ note: 'a postgres://a:b@db and mqtt://c:d@e' }).note, 'a postgres://a:***@db and mqtt://c:***@e');
  assert.strictEqual(stripUrlCredentials('no url here: a:b@c'), 'no url here: a:b@c');
});
