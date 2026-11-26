'use strict';

// Open mode (no token: the default, bound to loopback). Any web page the operator opens can try to
// reach http://127.0.0.1:5000: a WebSocket is not covered by CORS, so without an Origin check a
// hostile page could open the Socket.IO connection and publish to brokers or start scans; and a
// DNS-rebinding page (evil.example resolving to 127.0.0.1) is same-origin to the browser and can
// call the REST API too. The server must refuse foreign Origins on the socket and foreign Host
// names while it runs open on loopback.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: ioClient } = require('socket.io-client');

process.env.PORT = '0';
delete process.env.MANIFOLD_AUTH_TOKEN;
delete process.env.MANIFOLD_VIEWER_TOKEN;
delete process.env.MANIFOLD_TOKENS;
delete process.env.MANIFOLD_HOST;
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-origin-test-'));

let server;
let services;
let port;

before(async () => {
  const mod = require('../index');
  server = mod.server;
  services = mod.app.locals.services;
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  port = server.address().port;
});

after(() => {
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models', 'outbox', 'bindings', 'iot']) services?.[s]?.stop?.();
  services?.audit?.close();
  server?.close();
});

function tryConnect(headers) {
  return new Promise((resolve) => {
    const s = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, extraHeaders: headers, timeout: 2000 });
    s.once('connect', () => {
      s.close();
      resolve('connected');
    });
    s.once('connect_error', () => {
      s.close();
      resolve('refused');
    });
  });
}

test('socket: a foreign Origin is refused; no Origin (tools), the dev client and same-origin are accepted', async () => {
  assert.strictEqual(await tryConnect({ Origin: 'http://evil.example' }), 'refused');
  assert.strictEqual(await tryConnect({ Origin: 'null' }), 'refused');
  assert.strictEqual(await tryConnect({}), 'connected');
  assert.strictEqual(await tryConnect({ Origin: 'http://localhost:3000' }), 'connected');
  assert.strictEqual(await tryConnect({ Origin: `http://127.0.0.1:${port}` }), 'connected');
});

test('open on loopback: a request naming a foreign Host (DNS rebinding) is refused, socket included', async () => {
  const http = require('http');
  const get = (host) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/system/status', headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  assert.strictEqual(await get(`evil.example:${port}`), 421);
  assert.strictEqual(await get(`localhost:${port}`), 200);
  assert.strictEqual(await get(`127.0.0.1:${port}`), 200);
  assert.strictEqual(await get(`[::1]:${port}`), 200);
  assert.strictEqual(await tryConnect({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }), 'refused');
});
