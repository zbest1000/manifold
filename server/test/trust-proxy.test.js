'use strict';

// Behind a reverse proxy every request arrives from the proxy's address. Without `trust proxy` the
// rate limiter (and the auth-failure throttle, and the audit log) see one client: the first user to
// hit the limit locks everyone out. MANIFOLD_TRUST_PROXY (default off) names the proxy.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTrustProxy } = require('../services/trustProxy');

test('parseTrustProxy: off by default; hop counts and address lists; never "trust everything"', () => {
  for (const v of [undefined, '', '0', 'false', 'off', 'no']) assert.strictEqual(parseTrustProxy(v).value, false, String(v));
  assert.strictEqual(parseTrustProxy('1').value, 1);
  assert.strictEqual(parseTrustProxy('2').value, 2);
  assert.strictEqual(parseTrustProxy('loopback').value, 'loopback');
  assert.strictEqual(parseTrustProxy('10.0.0.5, 10.0.1.0/24').value, '10.0.0.5,10.0.1.0/24');
  // true would let any client choose its own address with X-Forwarded-For.
  const all = parseTrustProxy('true');
  assert.strictEqual(all.value, false);
  assert.match(all.warning, /MANIFOLD_TRUST_PROXY/);
  assert.match(parseTrustProxy('not an address!').warning, /MANIFOLD_TRUST_PROXY/);
});

/** Boot the real server in a child process with `env`; resolves { port, stop }. */
function boot(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-proxy-'));
  const script = "const m = require('./index'); const go = () => process.stdout.write('PORT ' + m.server.address().port + '\\n'); m.server.listening ? go() : m.server.once('listening', go);";
  const child = spawn(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', MANIFOLD_NO_RESTORE: '1', MANIFOLD_DATA_DIR: dir, MANIFOLD_RATE_MAX: '3', MANIFOLD_AUTH_TOKEN: '', MANIFOLD_VIEWER_TOKEN: '', MANIFOLD_TOKENS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /PORT (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({
          port: Number(m[1]),
          stop: () =>
            new Promise((r) => {
              child.once('exit', r);
              child.kill('SIGKILL');
            })
        });
      }
    });
    child.stderr.on('data', (d) => (out += d));
  });
}

const hit = (port, ip) => fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.status);

test('default (no MANIFOLD_TRUST_PROXY): clients behind one proxy share one rate-limit bucket', async () => {
  const s = await boot({ MANIFOLD_TRUST_PROXY: '' });
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual(await hit(s.port, '203.0.113.10'), 200);
    assert.strictEqual(await hit(s.port, '203.0.113.10'), 429);
    // X-Forwarded-For is not trusted, so another client is limited too (and cannot dodge the limit).
    assert.strictEqual(await hit(s.port, '203.0.113.99'), 429);
  } finally {
    await s.stop();
  }
});

test('MANIFOLD_TRUST_PROXY=1: each client behind the proxy gets its own bucket', async () => {
  const s = await boot({ MANIFOLD_TRUST_PROXY: '1' });
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual(await hit(s.port, '203.0.113.10'), 200);
    assert.strictEqual(await hit(s.port, '203.0.113.10'), 429);
    assert.strictEqual(await hit(s.port, '203.0.113.99'), 200);
  } finally {
    await s.stop();
  }
});
