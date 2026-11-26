'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');

const { WsClient, FrameParser, encodeFrame, formatHostHeader } = require('../drivers/common/wsClient');
const { wsTarget } = require('../drivers/common/wsTarget');
const { startWsServer, frame } = require('./support/wsTestServer');
const { KEY, CERT } = require('./support/tlsFixture');

const servers = [];
async function server(opts) {
  const s = await startWsServer(opts);
  servers.push(s);
  return s;
}
test.after(async () => {
  for (const s of servers) await s.close();
});

function client(port, extra = {}) {
  return new WsClient({ address: '127.0.0.1', hostname: 'localhost', port, path: '/', connectTimeoutMs: 1000, ...extra });
}
const once = (em, evt) => new Promise((r) => em.once(evt, (...a) => r(a)));

test('frame encoding: masked, 7/16/64-bit lengths, mask applied', () => {
  const key = Buffer.from([1, 2, 3, 4]);
  const small = encodeFrame(1, 'hi', { maskKey: key });
  assert.equal(small[0], 0x81);
  assert.equal(small[1], 0x80 | 2);
  assert.deepEqual(small.subarray(2, 6), key);
  assert.equal(small[6] ^ 1, 'h'.charCodeAt(0));
  const mid = encodeFrame(1, Buffer.alloc(300), { maskKey: key });
  assert.equal(mid[1], 0x80 | 126);
  assert.equal(mid.readUInt16BE(2), 300);
  const big = encodeFrame(2, Buffer.alloc(70000), { maskKey: key });
  assert.equal(big[1], 0x80 | 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70000);
});

test('frame parser rejects masked server frames, RSV bits, oversized and bad control frames', () => {
  const frames = [];
  const mk = (max = 1000) => new FrameParser({ maxFrameBytes: max, onFrame: (f) => frames.push(f) });
  assert.throws(() => mk().push(encodeFrame(1, 'x')), /must not be masked/);
  assert.throws(() => mk().push(frame(1, 'x', { rsv: 4 })), /reserved bits/);
  assert.throws(() => mk(10).push(frame(1, 'x'.repeat(11))), (e) => e.code === 1009);
  assert.throws(() => mk().push(frame(9, 'x', { fin: false })), /fragmented control/);
  assert.throws(() => mk(100000).push(frame(9, 'x'.repeat(126))), /longer than 125/);
  assert.throws(() => mk().push(Buffer.from([0x83, 0])), /unknown opcode/);
  // 64-bit length announced beyond the cap is refused before any payload is buffered
  const h = Buffer.alloc(10);
  h[0] = 0x81;
  h[1] = 127;
  h.writeBigUInt64BE(2n ** 40n, 2);
  assert.throws(() => mk().push(h), (e) => e.code === 1009);
  // byte-by-byte delivery still parses
  const p = mk();
  for (const b of frame(1, 'hello')) p.push(Buffer.from([b]));
  assert.equal(frames.at(-1).payload.toString(), 'hello');
});

test('host header and target validation', () => {
  assert.equal(formatHostHeader('ha.local', 5580, false), 'ha.local:5580');
  assert.equal(formatHostHeader('ha.local', 443, true), 'ha.local');
  assert.equal(formatHostHeader('fd00::1', 3000, false), '[fd00::1]:3000');
  const t = wsTarget({ host: 'ha.local', port: 5580, pinned: { addresses: ['10.0.0.5'] }, authToken: 'abc' }, { defaultPort: 5580, defaultPath: '/ws' });
  assert.equal(t.address, '10.0.0.5');
  assert.equal(t.hostname, 'ha.local');
  assert.equal(t.url, 'ws://ha.local:5580/ws');
  assert.equal(t.headers.Authorization, 'Bearer abc');
  assert.equal(t.tls.rejectUnauthorized, true);
  assert.equal(wsTarget({ host: 'x', scheme: 'wss', tlsInsecure: true }, { defaultPort: 1, defaultPath: '/' }).tls.rejectUnauthorized, false);
  assert.equal(wsTarget({ host: 'x', scheme: 'ws', tlsInsecure: true }, { defaultPort: 1, defaultPath: '/' }).tls.rejectUnauthorized, true);
  assert.throws(() => wsTarget({ host: 'x', scheme: 'http' }, { defaultPort: 1, defaultPath: '/' }), /scheme/);
  assert.throws(() => wsTarget({ host: 'x', path: '/a b' }, { defaultPort: 1, defaultPath: '/' }), /path/);
  assert.throws(() => wsTarget({ host: 'x', authToken: 'a\r\nX-Evil: 1' }, { defaultPort: 1, defaultPath: '/' }), /authToken/);
});

test('handshake, echo, fragmented message with interleaved ping, server ping answered', async () => {
  let peer;
  const s = await server({ onConnection: (p) => (peer = p) });
  const c = client(s.port, { headers: { Authorization: 'Bearer t0k' } });
  await c.connect();
  assert.equal(s.requests[0].headers.host, 'localhost:' + s.port);
  assert.equal(s.requests[0].headers.authorization, 'Bearer t0k');
  assert.equal(s.requests[0].headers['sec-websocket-extensions'], undefined, 'no extension is offered');
  const got = once(c, 'message');
  c.send('{"a":1}');
  const [text] = await once(peer, 'message');
  assert.equal(text, '{"a":1}');
  peer.sendFragmented(JSON.stringify({ big: 'é'.repeat(5000) }), 5);
  const [m] = await got;
  assert.equal(JSON.parse(m).big.length, 5000);
  const pong = new Promise((r) => peer.on('pong', (b) => b.toString() === 'hey' && r(b)));
  peer.ping('hey');
  assert.equal((await pong).toString(), 'hey');
  assert.equal(peer.unmaskedFrames, 0);
  const closed = once(c, 'close');
  await c.close();
  assert.equal((await closed)[0].code, 1000);
});

test('handshake failures: wrong accept, extension, subprotocol, HTTP error, timeout', async () => {
  for (const [hs, re] of [
    [{ badAccept: true }, /Accept does not match/],
    [{ extensions: 'permessage-deflate' }, /extension/],
    [{ protocol: 'chat' }, /subprotocol/],
    [{ status: 401 }, /HTTP 401.*authentication/],
  ]) {
    const s = await server({ onConnection: () => {}, handshake: () => hs });
    await assert.rejects(client(s.port).connect(), re);
  }
  const s404 = await server({ path: '/ws', onConnection: () => {} });
  await assert.rejects(client(s404.port).connect(), /404.*wrong path/);
  // A TCP server that never answers the upgrade
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  await assert.rejects(client(silent.address().port, { connectTimeoutMs: 200 }).connect(), /no WebSocket handshake within 200 ms/);
  silent.close();
});

test('oversized message closes with 1009; invalid UTF-8 with 1007; unmasked-check on server side', async () => {
  let peer;
  const s = await server({ onConnection: (p) => (peer = p) });
  const c = client(s.port, { maxMessageBytes: 1000, maxFrameBytes: 600 });
  await c.connect();
  const closed = once(c, 'close');
  peer.sendFragmented('x'.repeat(1500), 3); // frames of 500 < 600, message 1500 > 1000
  const [info] = await closed;
  assert.equal(info.code, 1009);

  const c2 = client(s.port);
  await c2.connect();
  const closed2 = once(c2, 'close');
  peer.raw(frame(1, Buffer.from([0xff, 0xfe])));
  assert.equal((await closed2)[0].code, 1007);
});

test('server close is echoed; keepalive detects a silent peer', async () => {
  let peer;
  const s = await server({ onConnection: (p) => (peer = p) });
  const c = client(s.port);
  await c.connect();
  const echoed = once(peer, 'client-close');
  const closed = once(c, 'close');
  peer.closeWith(4001, 'bye');
  assert.equal((await echoed)[0], 4001);
  const [info] = await closed;
  assert.equal(info.code, 4001);
  assert.equal(info.reason, 'bye');

  const c2 = client(s.port, { pingIntervalMs: 100, pongTimeoutMs: 150 });
  await c2.connect();
  peer.noPong = true;
  const [dead] = await once(c2, 'close');
  assert.match(dead.reason, /keepalive/);
});

test('wss: verified against a CA, refused without it, accepted with the explicit opt-out', async () => {
  const s = await server({ tlsOptions: { key: KEY, cert: CERT }, onConnection: (p) => p.send('hello') });
  await assert.rejects(client(s.port, { secure: true }).connect(), (e) => e.kind === 'tls');
  const ok = client(s.port, { secure: true, tls: { ca: CERT } });
  const msg = once(ok, 'message');
  await ok.connect();
  assert.equal((await msg)[0], 'hello');
  await ok.close();
  // Name mismatch: the pinned address is right, but the certificate is not for this name
  await assert.rejects(new WsClient({ address: '127.0.0.1', hostname: 'bridge.example', port: s.port, secure: true, tls: { ca: CERT }, connectTimeoutMs: 1000 }).connect(), /altname|does not match|Hostname/i);
  const insecure = client(s.port, { secure: true, tls: { rejectUnauthorized: false } });
  await insecure.connect();
  await insecure.close();
});

test('wss: a pinned certificate fingerprint (the TLS option shared with the HTTP drivers) replaces chain validation', async () => {
  const { FINGERPRINT256 } = require('./support/tlsFixture');
  let upgrades = 0;
  const s = await server({ tlsOptions: { key: KEY, cert: CERT }, onConnection: (p) => { upgrades++; p.send('pinned'); } });
  const t = wsTarget({ host: '127.0.0.1', port: s.port, scheme: 'wss', tlsFingerprint256: FINGERPRINT256.toLowerCase() }, { defaultPort: 1, defaultPath: '/' });
  assert.equal(t.tls.rejectUnauthorized, false, 'the pin replaces the chain check');
  const ok = client(s.port, { secure: true, tls: t.tls });
  const msg = once(ok, 'message');
  await ok.connect();
  assert.equal((await msg)[0], 'pinned');
  await ok.close();
  const wrong = wsTarget({ host: '127.0.0.1', port: s.port, scheme: 'wss', tlsFingerprint256: 'AB'.repeat(32) }, { defaultPort: 1, defaultPath: '/' });
  await assert.rejects(client(s.port, { secure: true, tls: wrong.tls }).connect(), (e) => e.kind === 'tls' && /fingerprint/.test(e.message));
  assert.equal(upgrades, 1, 'nothing was sent over the connection whose certificate did not match');
  assert.throws(() => wsTarget({ host: 'x', scheme: 'wss', tlsFingerprint256: 'abc' }, { defaultPort: 1, defaultPath: '/' }), /tlsFingerprint256/);
  // ignored on plain ws, like the HTTP drivers ignore TLS settings on http
  assert.equal(wsTarget({ host: 'x', scheme: 'ws', tlsFingerprint256: 'abc' }, { defaultPort: 1, defaultPath: '/' }).tls.fingerprint, undefined);
});

test('every client frame on the wire is masked with a fresh key', async () => {
  const keys = new Set();
  const s = await server({ onConnection: () => {} });
  const c = client(s.port);
  await c.connect();
  const orig = c.socket.write.bind(c.socket);
  c.socket.write = (buf, ...rest) => {
    if (Buffer.isBuffer(buf) && buf.length > 6) {
      assert.ok(buf[1] & 0x80, 'mask bit set');
      keys.add(buf.subarray(2, 6).toString('hex'));
    }
    return orig(buf, ...rest);
  };
  for (let i = 0; i < 20; i++) c.send(crypto.randomBytes(4).toString('hex'));
  assert.ok(keys.size >= 19);
  await c.close();
});
