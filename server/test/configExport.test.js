const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ProfileStore = require('../services/profileStore');
const { buildExport, validateImport, restoreSecrets } = require('../routes/system');
const { redactSecrets } = require('../services/secrets');
const { redact, AuditLog } = require('../services/auditLog');

const SECRETS = [
  'S3CR3T-influx-token', 'S3CR3T-pg-pass', 'S3CR3T-broker-pass', 'S3CR3T-opcua-pass', 'S3CR3T-webhook-path',
  'S3CR3T-apikey', 'S3CR3T-cert-pem', 'S3CR3T-key-pem', 'S3CR3T-ca-pem', 'S3CR3T-url-pass', 'S3CR3T-device-pw',
  'S3CR3T-nested-secret', 'S3CR3T-mount-token', 'S3CR3T-array-token'
];

function sampleStore() {
  const store = new ProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cfgexp-')));
  store.upsertIn('historians', 'h1', {
    name: 'influx', type: 'influxdb', url: 'http://u:S3CR3T-url-pass@influx:8086', token: 'S3CR3T-influx-token'
  });
  store.upsertIn('historians', 'h2', {
    name: 'pg', type: 'timescale', host: 'pg', password: 'S3CR3T-pg-pass', ssl: { ca: 'S3CR3T-ca-pem', cert: 'S3CR3T-cert-pem', key: 'S3CR3T-key-pem' }
  });
  store.upsertIn('pipelines', 'p1', { name: 'p', transforms: [{ type: 'http', headers: { Authorization: 'S3CR3T-array-token' } }] });
  store.upsertIn('models', 'm1', { name: 'm' });
  store.upsertIn('recordings', 'r1', { name: 'r' });
  store.upsertIn('contracts', 'c1', { name: 'c' });
  store.upsertIn('bindings', 'b1', { name: 'b', source: { type: 'opcua', credentials: { user: 'u', pass: 'S3CR3T-opcua-pass' } } });
  store.upsertIn('devices', 'd1', { name: 'plc', host: '10.0.0.5', auth: { password: 'S3CR3T-device-pw' }, options: { deep: { apiSecret: 'S3CR3T-nested-secret' } } });
  store.upsertIn('deviceProfiles', 'dp1', { name: 'dp', apiKey: 'S3CR3T-apikey' });
  store.upsertMount('mnt1', { name: 'mount', token: 'S3CR3T-mount-token' });
  store.upsertAlertRule('a1', { type: 'branch-silent', webhookUrl: 'https://hooks.example/S3CR3T-webhook-path' });
  // brokers / opcua endpoints live outside the export, but must also be safe if one is ever added
  store.upsertBroker('mq1', { host: 'h', password: 'S3CR3T-broker-pass' });
  return store;
}

test('export walks every collection and leaks no credential-like value', () => {
  const store = sampleStore();
  const out = buildExport(store);
  const blob = JSON.stringify(out);
  for (const s of SECRETS) {
    if (s === 'S3CR3T-broker-pass') continue; // brokers are not part of the config export at all
    assert.ok(!blob.includes(s), `export leaked ${s}`);
  }
  assert.ok(!blob.includes('S3CR3T-broker-pass'));
  // structure survives: ids, non-secret fields, every collection incl. devices
  assert.strictEqual(out.historians.find((h) => h.id === 'h1').url, 'http://u:***@influx:8086');
  assert.strictEqual(out.historians.find((h) => h.id === 'h1').token, null);
  assert.strictEqual(out.devices[0].host, '10.0.0.5');
  assert.strictEqual(out.deviceProfiles[0].apiKey, null);
  assert.strictEqual(out.alertRules[0].webhookUrl, null);
  assert.strictEqual(out.alertRules[0].type, 'branch-silent');
  assert.strictEqual(out.mounts[0].token, null);
  assert.ok(!('icons' in out));
});

test('redactSecrets: shared by audit and export; no raw leak at depth; null/empty secrets left alone', () => {
  const deep = { a: { b: { c: { d: { e: { f: { token: 'X' } } } } } } };
  const audited = JSON.stringify(redact(deep));
  assert.ok(!audited.includes('"X"'), 'deep values must be truncated, not leaked raw');
  assert.strictEqual(redactSecrets({ token: '' }).token, '');
  assert.strictEqual(redactSecrets({ token: null }).token, null);
  assert.deepStrictEqual(redactSecrets([{ pass: 'x' }, 1, 'plain']), [{ pass: null }, 1, 'plain']);
  const r = redact({ cert: 'c', key: 'k', ca: 'a', password: 'p', token: 't', secret: 's', webhookUrl: 'u', topic: 'ok' });
  assert.deepStrictEqual(Object.values(r).filter((v) => v !== '[redacted]'), ['ok']);
});

test('round trip: export -> import keeps stored secrets; supplied secrets override', () => {
  const store = sampleStore();
  const doc = JSON.parse(JSON.stringify(buildExport(store)));
  assert.deepStrictEqual(validateImport(doc), []);
  for (const h of doc.historians) store.upsertIn('historians', h.id, restoreSecrets(h, store.getIn('historians', h.id)));
  assert.strictEqual(store.getIn('historians', 'h2').ssl.key, 'S3CR3T-key-pem');
  assert.strictEqual(store.getIn('historians', 'h1').token, 'S3CR3T-influx-token');
  // pipelines: array element matched by position
  const p = restoreSecrets(doc.pipelines[0], store.getIn('pipelines', 'p1'));
  assert.strictEqual(p.transforms[0].headers.Authorization, 'S3CR3T-array-token');
  // an explicit new secret wins
  const updated = restoreSecrets({ id: 'h1', token: 'new' }, store.getIn('historians', 'h1'));
  assert.strictEqual(updated.token, 'new');
  // webhook restored for alert rules
  const rule = restoreSecrets(doc.alertRules[0], store.alertRules()[0]);
  assert.strictEqual(rule.webhookUrl, 'https://hooks.example/S3CR3T-webhook-path');
});

test('import validation rejects bad structure, ids, sizes and prototype-polluting keys anywhere', () => {
  const ok = { manifoldConfig: 1, pipelines: [{ id: 'good-id_1.x', name: 'p' }] };
  assert.deepStrictEqual(validateImport(ok), []);

  const bad = (doc, re) => {
    const errs = validateImport(doc);
    assert.ok(errs.length, `expected rejection: ${JSON.stringify(doc).slice(0, 80)}`);
    if (re) assert.match(errs.join('\n'), re);
  };
  bad({ manifoldConfig: 1, pipelines: 'nope' }, /must be an array/);
  bad({ manifoldConfig: 1, pipelines: [null] }, /must be an object/);
  bad({ manifoldConfig: 1, pipelines: [{ name: 'no id' }] }, /id must match/);
  bad({ manifoldConfig: 1, pipelines: [{ id: '../etc' }] }, /id must match/);
  bad({ manifoldConfig: 1, pipelines: [{ id: 'a'.repeat(129) }] }, /id must match/);
  bad({ manifoldConfig: 1, pipelines: [{ id: 'a' }, { id: 'a' }] }, /duplicate id/);
  bad({ manifoldConfig: 1, pipelines: [{ id: 'a', big: 'x'.repeat(300 * 1024) }] }, /larger than/);
  bad({ manifoldConfig: 1, nonsense: [] }, /unknown top-level key/);
  bad({ manifoldConfig: 1, alertRules: [{ id: 'r', webhookUrl: 'javascript:alert(1)' }] }, /webhookUrl/);
  bad({ manifoldConfig: 1, pipelines: new Array(5001).fill(0).map((_, i) => ({ id: `p${i}` })) }, /more than/);

  // JSON.parse creates own "__proto__" properties — the realistic attack shape
  bad(JSON.parse('{"manifoldConfig":1,"pipelines":[{"id":"a","__proto__":{"polluted":true}}]}'), /forbidden key "__proto__"/);
  bad(JSON.parse('{"manifoldConfig":1,"devices":[{"id":"a","x":{"y":[{"constructor":{"prototype":{"p":1}}}]}}]}'), /forbidden key "constructor"/);
  bad(JSON.parse('{"manifoldConfig":1,"mounts":[{"id":"a","prototype":1}]}'), /forbidden key "prototype"/);
  bad(JSON.parse('{"manifoldConfig":1,"__proto__":{"x":1}}'), /forbidden key "__proto__"/);
  bad(JSON.parse('{"manifoldConfig":1,"pipelines":[{"id":"__proto__"}]}'), /id must match|forbidden/);
  assert.strictEqual({}.polluted, undefined);
});

test('restoreSecrets never copies a __proto__ key', () => {
  const evil = JSON.parse('{"id":"a","__proto__":{"polluted":true},"n":1}');
  const out = restoreSecrets(evil, { id: 'a' });
  assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
  assert.strictEqual(out.polluted, undefined);
  assert.strictEqual({}.polluted, undefined);
});

test('audit log rotates by size and keeps N files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-auditrot-'));
  const audit = new AuditLog(dir, { maxBytes: 600, keep: 3 });
  for (let i = 0; i < 60; i++) audit.record({ role: 'admin', method: 'POST', path: `/api/x/${i}`, status: 200 });
  await audit.close();
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('audit.jsonl')).sort();
  assert.deepStrictEqual(files, ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2', 'audit.jsonl.3']);
  for (const f of files) {
    assert.ok(fs.statSync(path.join(dir, f)).size <= 600 + 200, `${f} stays near the cap`);
    assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  }
  // newest data is in audit.jsonl; every line is valid JSON
  const last = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).pop();
  assert.strictEqual(last.path, '/api/x/59');
});
