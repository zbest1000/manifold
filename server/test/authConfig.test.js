const { test } = require('node:test');
const assert = require('node:assert');
const { parseNamedTokens, roleAllows, isViewerAllowedPost } = require('../services/authConfig');

test('MANIFOLD_TOKENS: name:token[:role], role defaults to admin', () => {
  const { tokens, errors, configured } = parseNamedTokens('alice:s3cret:admin, grafana:tok:viewer ,bob:plain');
  assert.deepStrictEqual(errors, []);
  assert.ok(configured);
  assert.deepStrictEqual(tokens, [
    { name: 'alice', token: 's3cret', role: 'admin' },
    { name: 'grafana', token: 'tok', role: 'viewer' },
    { name: 'bob', token: 'plain', role: 'admin' }
  ]);
});

test('MANIFOLD_TOKENS: unrecognised role is rejected (never admin), error never prints the token', () => {
  const { tokens, errors } = parseNamedTokens('eve:topsecretvalue:superuser,ok:tok2:viewer');
  assert.deepStrictEqual(tokens, [{ name: 'ok', token: 'tok2', role: 'viewer' }]);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /"eve".*unrecognised role "superuser"/);
  assert.ok(!errors[0].includes('topsecretvalue'));
});

test('MANIFOLD_TOKENS: a token containing ":" needs an explicit role and is never truncated', () => {
  const ok = parseNamedTokens('bot:ab:cd:viewer');
  assert.deepStrictEqual(ok.tokens, [{ name: 'bot', token: 'ab:cd', role: 'viewer' }]);
  // no explicit role: "cd" would be the role -> rejected, not silently truncated to "ab"
  const bad = parseNamedTokens('bot:ab:cd');
  assert.deepStrictEqual(bad.tokens, []);
  assert.strictEqual(bad.errors.length, 1);
  assert.ok(!bad.errors[0].includes('ab:cd') && !bad.errors[0].includes('"ab"'));
  assert.ok(bad.configured, 'configured flag lets index.js stay fail-closed when every entry is bad');
});

test('MANIFOLD_TOKENS: malformed entries are rejected', () => {
  for (const raw of [':tok:admin', 'nameonly', 'x::admin', 'x:']) {
    const { tokens, errors } = parseNamedTokens(raw);
    assert.deepStrictEqual(tokens, [], raw);
    assert.strictEqual(errors.length, 1, raw);
  }
  assert.deepStrictEqual(parseNamedTokens('').tokens, []);
  assert.strictEqual(parseNamedTokens('').configured, false);
});

test('roleAllows: admin all; viewer reads + allowlisted read-only POSTs only; unknown role denied', () => {
  assert.ok(roleAllows('admin', 'DELETE', '/anything'));
  assert.ok(roleAllows('viewer', 'GET', '/mqtt/brokers'));
  assert.ok(roleAllows('viewer', 'POST', '/historians/h1/query'));
  assert.ok(roleAllows('viewer', 'POST', '/pipelines/preview'));
  assert.ok(roleAllows('viewer', 'POST', '/mqtt/brokers/b1/subscriptions/resolve'));
  assert.ok(roleAllows('viewer', 'POST', '/devices/validate-tags'));
  for (const [m, p] of [
    ['POST', '/pipelines'],
    ['POST', '/historians'],
    ['POST', '/historians/h1/test'],
    ['POST', '/mqtt/brokers/b1/publish'],
    ['POST', '/tags/bindings'],
    ['POST', '/system/config/import'],
    ['POST', '/historians/h1/query/extra'],
    ['POST', '/x/historians/h1/query'],
    ['PUT', '/historians/h1/query'],
    ['DELETE', '/pipelines/preview']
  ]) {
    assert.strictEqual(roleAllows('viewer', m, p), false, `${m} ${p}`);
  }
  assert.strictEqual(roleAllows('operator', 'GET', '/x'), false);
  assert.strictEqual(roleAllows(undefined, 'GET', '/x'), false);
  assert.strictEqual(isViewerAllowedPost('POST', '/pipelines/preview/'), true); // trailing slash tolerated
});
