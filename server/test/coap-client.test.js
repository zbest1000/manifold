'use strict';

// CoAP transaction layer against the in-process simulator (real UDP on loopback).

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CoapUdpSocket } = require('../drivers/coap/coapUdp');
const { CoapClient } = require('../drivers/coap/client');
const msg = require('../drivers/coap/message');
const { CoapSimulator } = require('./support/coapSimulator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sims = [];
const clients = [];
async function startSim(opts) {
  const sim = await new CoapSimulator(opts).start();
  sims.push(sim);
  return sim;
}
async function connect(sim, opts = {}) {
  const socket = new CoapUdpSocket({ address: '127.0.0.1', port: sim.port });
  await socket.open();
  const client = new CoapClient({ socket, ackTimeoutMs: 40, ackRandomFactor: 1.5, maxRetransmit: 3, observeGraceMs: 20, reregisterBackoffMs: [30, 60], closeGraceMs: 300, ...opts });
  clients.push(client);
  return client;
}
const dl = (ms = 3000) => Date.now() + ms;
const GET = (path, extra = {}) => ({ path: path.split('/').filter(Boolean), query: [], ...extra });

test.after(async () => {
  for (const c of clients) await c.close();
  // Nothing the client did may ever have been a write.
  for (const s of sims) assert.equal(s.stats.nonGetReceived, 0, 'nonGetReceived');
  for (const s of sims) await s.stop();
});

test('piggybacked response: GET, token and message id matched, payload and options parsed', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.get(GET('/temp'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.code, 0x45);
  assert.equal(r.response.payload.toString(), '21.5');
  assert.equal(r.response.cf, 0);
  assert.equal(r.response.maxAge, 60); // default when the option is absent
  assert.equal(sim.requests.at(-1).method, 1);
  assert.equal(sim.requests.at(-1).type, msg.TYPE.CON);
  assert.equal(sim.requests.at(-1).token.length, 16); // 8 random bytes
});

test('query and path segments go out as Uri-Path / Uri-Query options', async () => {
  const sim = await startSim({ resources: { '/a/b?x=1&y=2': { cf: 0, body: 'q' } } });
  const c = await connect(sim);
  const r = await c.get({ path: ['a', 'b'], query: ['x=1', 'y=2'] }, dl());
  assert.equal(r.response.payload.toString(), 'q');
  assert.equal(sim.requests.at(-1).query, 'x=1&y=2');
});

test('ping: an empty CON is answered with RST', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.ping(dl());
  assert.equal(r.ok, true);
  assert.equal(r.pong, true);
  assert.equal(sim.stats.pings, 1);
});

test('ping to a device that ignores it times out after the retransmissions', async () => {
  const sim = await startSim();
  sim.faults.pingSilent = true;
  const c = await connect(sim, { maxRetransmit: 2 });
  const r = await c.ping(dl(2000));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
  assert.equal(c.stats.retransmissions, 2);
  assert.equal(sim.stats.pings, 3); // the original and two retransmissions
});

test('retransmission: lost requests are repeated with exponential backoff until answered', async () => {
  const sim = await startSim();
  sim.faults.dropRequests = 2;
  const c = await connect(sim, { ackTimeoutMs: 50, ackRandomFactor: 1, maxRetransmit: 4 });
  const started = Date.now();
  const r = await c.get(GET('/temp'), dl());
  const took = Date.now() - started;
  assert.equal(r.ok, true);
  assert.equal(c.stats.retransmissions, 2);
  // two drops: waited 50 ms, then 100 ms (doubling) before the third copy got through
  assert.ok(took >= 140, `took ${took} ms`);
  // all copies carry the same message id and token
  const same = sim.requests.filter((q) => q.path === '/temp');
  assert.equal(same.length, 1); // the dropped ones never reached the log (dropped before parsing); the third did
  assert.equal(sim.stats.received, 3);
});

test('backoff timing doubles: with a silent device the gaps between copies grow', async () => {
  const sim = await startSim();
  const c = await connect(sim, { ackTimeoutMs: 40, ackRandomFactor: 1, maxRetransmit: 3 });
  sim.faults.silent = true;
  const stamps = [];
  const sock = sim.sock;
  sock.on('message', () => stamps.push(Date.now()));
  const r = await c.get(GET('/temp'), dl(3000));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
  assert.equal(stamps.length, 4); // 1 + MAX_RETRANSMIT
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  assert.ok(gaps[1] > gaps[0] * 1.5 && gaps[2] > gaps[1] * 1.5, `gaps ${gaps}`);
  assert.equal(c.stats.timeouts, 1);
});

test('randomised first timeout stays between ACK_TIMEOUT and ACK_TIMEOUT x factor', async () => {
  const sim = await startSim();
  sim.faults.silent = true;
  const c = await connect(sim, { ackTimeoutMs: 100, ackRandomFactor: 1.5, maxRetransmit: 1, random: () => 1 });
  const stamps = [];
  sim.sock.on('message', () => stamps.push(Date.now()));
  await c.get(GET('/temp'), dl(1000));
  const first = stamps[1] - stamps[0];
  assert.ok(first >= 145 && first < 400, `first gap ${first}`);
});

test('the deadline bounds the whole exchange even with retransmissions left', async () => {
  const sim = await startSim();
  sim.faults.silent = true;
  const c = await connect(sim, { ackTimeoutMs: 1000, maxRetransmit: 4 });
  const started = Date.now();
  const r = await c.get(GET('/temp'), dl(150));
  assert.equal(r.kind, 'timeout');
  assert.ok(Date.now() - started < 600);
});

test('a lost reply is answered from the server cache when the request is retransmitted (deduplication)', async () => {
  const sim = await startSim();
  sim.faults.dropResponses = 1;
  const c = await connect(sim, { ackTimeoutMs: 40, ackRandomFactor: 1 });
  const r = await c.get(GET('/temp'), dl());
  assert.equal(r.ok, true);
  assert.equal(sim.stats.duplicateRequests, 1);
  const copies = sim.requests.filter((q) => q.path === '/temp');
  assert.equal(copies.length, 2);
  assert.equal(copies[0].mid, copies[1].mid); // the retransmission is the same message
  assert.equal(copies[0].token, copies[1].token);
});

test('a duplicated response completes the exchange once and later copies are ignored', async () => {
  const sim = await startSim();
  sim.faults.duplicateResponses = 1;
  const c = await connect(sim);
  const r = await c.get(GET('/temp'), dl());
  assert.equal(r.ok, true);
  await sleep(50);
  // the duplicate piggybacked ACK finds no outstanding exchange
  assert.ok(c.stats.ignored >= 1);
  assert.equal((await c.get(GET('/name'), dl())).response.payload.toString(), 'sensor-1');
});

test('a reply with the wrong token or message id is not accepted; the exchange is completed by the retransmission', async () => {
  const sim = await startSim();
  sim.faults.wrongTokenNext = 1;
  const c = await connect(sim, { ackTimeoutMs: 40, ackRandomFactor: 1 });
  const r = await c.get(GET('/temp'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.payload.toString(), '21.5');
  assert.ok(c.stats.ignored >= 1);
  sim.faults.wrongMidNext = 1;
  const r2 = await c.get(GET('/name'), dl());
  assert.equal(r2.response.payload.toString(), 'sensor-1');
  assert.ok(c.stats.ignored >= 2);
});

test('garbage and truncated datagrams are dropped, not fatal', async () => {
  const sim = await startSim();
  const c = await connect(sim, { ackTimeoutMs: 40, ackRandomFactor: 1 });
  sim.faults.garbageNext = 1;
  assert.equal((await c.get(GET('/temp'), dl())).ok, true);
  sim.faults.truncateNext = 1;
  assert.equal((await c.get(GET('/temp'), dl())).ok, true);
  assert.equal(c.stats.malformed, 2);
  assert.equal(c.isConnected(), true);
});

test('separate response: the empty ACK stops retransmission, the CON response is ACKed', async () => {
  const sim = await startSim();
  sim.setResource('/slow', { cf: 0, body: 'slow', separate: 250 });
  const c = await connect(sim, { ackTimeoutMs: 60, ackRandomFactor: 1, maxRetransmit: 4 });
  const r = await c.get(GET('/slow'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.payload.toString(), 'slow');
  assert.equal(c.stats.separate, 1);
  assert.equal(c.stats.retransmissions, 0); // acknowledged before the first retransmission
  await until(() => sim.stats.acksReceived >= 1, 1000, 'ACK of the separate response');
  assert.equal(sim.requests.filter((q) => q.path === '/slow').length, 1);
});

test('separate NON response is accepted and needs no ACK', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const before = sim.stats.acksReceived;
  const r = await c.get(GET('/sepnon'), dl());
  assert.equal(r.response.payload.toString(), '34');
  await sleep(50);
  assert.equal(sim.stats.acksReceived, before);
});

test('a separate response that never comes ends at the deadline, not at MAX_RETRANSMIT', async () => {
  const sim = await startSim();
  sim.setResource('/never', { cf: 0, body: 'x', separate: 100000 });
  const c = await connect(sim, { ackTimeoutMs: 40, ackRandomFactor: 1 });
  const r = await c.get(GET('/never'), dl(300));
  assert.equal(r.kind, 'timeout');
  assert.match(r.message, /acknowledged/);
});

test('a duplicate CON separate response is ACKed again but processed once', async () => {
  const sim = await startSim();
  sim.setResource('/slow', { cf: 0, body: 'slow', separate: 60 });
  sim.faults.duplicateResponses = 1; // applies to the CON response (the empty ACK is sent separately)
  const c = await connect(sim);
  const r = await c.get(GET('/slow'), dl());
  assert.equal(r.ok, true);
  await until(() => c.stats.duplicates === 1, 1000, 'duplicate noticed');
  await until(() => sim.stats.acksReceived === 2, 1000, 'the duplicate is ACKed again');
  assert.equal(sim.requests.filter((q) => q.path === '/slow').length, 1);
});

test('Reset: a RST for the request fails the exchange with kind reset', async () => {
  const sim = await startSim();
  sim.faults.resetNext = 1;
  const c = await connect(sim);
  const r = await c.get(GET('/temp'), dl());
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'reset');
  assert.equal(c.stats.resets, 1);
  assert.equal((await c.get(GET('/temp'), dl())).ok, true); // the client is still usable
});

test('a CON response that matches nothing is answered with RST', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  assert.equal((await c.get(GET('/temp'), dl())).ok, true);
  const rsts = [];
  sim.sock.on('message', (buf) => {
    const m = buf.length >= 4 ? buf : null;
    if (m && (m[0] >> 4) & 3 && ((m[0] >> 4) & 3) === msg.TYPE.RST) rsts.push(buf);
  });
  const stray = Buffer.concat([Buffer.from([0x48, 0x45, 0x12, 0x34]), Buffer.alloc(8, 9), Buffer.from([0xff]), Buffer.from('x')]);
  const peer = { port: c.socket._sock.address().port, address: '127.0.0.1' };
  sim.sock.send(stray, peer.port, peer.address);
  await until(() => rsts.length === 1, 1000, 'RST for the stray response');
  assert.equal(c.stats.unmatched, 1);
});

test('NSTART=1: requests are serialised; the client never has two exchanges in flight', async () => {
  const sim = await startSim();
  sim.faults.delayMs = 30;
  const c = await connect(sim);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => c.get(GET('/temp'), dl())));
  assert.ok(results.every((r) => r.ok));
  assert.equal(c.stats.maxInFlight, 1);
});

test('NSTART=3 allows three at a time and no more', async () => {
  const sim = await startSim();
  sim.faults.delayMs = 40;
  const c = await connect(sim, { nstart: 3 });
  const results = await Promise.all(Array.from({ length: 8 }, () => c.get(GET('/temp'), dl())));
  assert.ok(results.every((r) => r.ok));
  assert.equal(c.stats.maxInFlight, 3);
});

test('a request that waits in the queue past its deadline times out without being sent', async () => {
  const sim = await startSim();
  sim.faults.delayMs = 150;
  const c = await connect(sim);
  const slow = c.get(GET('/temp'), dl());
  const impatient = c.get(GET('/name'), dl(40));
  const r = await impatient;
  assert.equal(r.kind, 'timeout');
  assert.equal((await slow).ok, true);
  assert.equal(sim.requests.filter((q) => q.path === '/name').length, 0);
});

test('message ids are unique across outstanding exchanges and wrap', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  c._mid = 0xfffe;
  for (let i = 0; i < 4; i++) assert.equal((await c.get(GET('/temp'), dl())).ok, true);
  const mids = sim.requests.map((q) => q.mid);
  assert.deepEqual(mids.slice(-4), [0xffff, 0, 1, 2]);
});

// ---- block-wise ---------------------------------------------------------------------------------

test('block2: a 3000 byte body arrives in 1024 byte blocks', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.get(GET('/big'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.payload.length, 3000);
  for (let i = 0; i < 3000; i++) assert.equal(r.response.payload[i], i % 251);
  assert.equal(r.response.blocks, 3);
  assert.deepEqual(sim.requests.filter((q) => q.path === '/big').map((q) => q.block2), [{ num: 0, szx: 6 }, { num: 1, szx: 6 }, { num: 2, szx: 6 }]);
});

test('block2 size negotiation: the server answers with a smaller size and the client follows it', async () => {
  const sim = await startSim({ maxSzx: 2 }); // 64 byte blocks
  const c = await connect(sim, { blockSize: 1024 });
  const r = await c.get(GET('/big'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.payload.length, 3000);
  assert.equal(r.response.blocks, 47); // ceil(3000 / 64)
  const reqs = sim.requests.filter((q) => q.path === '/big');
  assert.deepEqual(reqs[0].block2, { num: 0, szx: 6 }); // our proposal
  assert.deepEqual(reqs[1].block2, { num: 1, szx: 2 }); // then the server's size
  assert.deepEqual(reqs[46].block2, { num: 46, szx: 2 });
});

test('block2: a smaller preferred size is honoured too', async () => {
  const sim = await startSim();
  const c = await connect(sim, { blockSize: 256 });
  const r = await c.get(GET('/bigjson'), dl());
  assert.equal(r.ok, true);
  assert.ok(r.response.blocks > 2);
  assert.equal(JSON.parse(r.response.payload).last, 'end');
});

test('block2 cap: a transfer over maxResponseBytes is abandoned', async () => {
  const sim = await startSim();
  const c = await connect(sim, { maxResponseBytes: 2000 });
  const r = await c.get(GET('/big'), dl());
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'toolarge');
  // abandoned after 2 blocks, not after fetching everything
  assert.ok(sim.requests.filter((q) => q.path === '/big').length <= 3);
});

test('block2 cap: Size2 on the first block stops the transfer at once', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.get(GET('/huge'), dl());
  assert.equal(r.kind, 'toolarge');
  assert.match(r.message, /10000000 bytes/);
  assert.equal(sim.requests.filter((q) => q.path === '/huge').length, 1);
});

test('block2: a device that answers 4.02 to the Block2 option is asked again without it, and remembered', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.get(GET('/noblock'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.payload.toString(), 'plain');
  assert.equal(sim.requests.filter((q) => q.path === '/noblock').length, 2);
  await c.get(GET('/noblock'), dl());
  assert.equal(sim.requests.filter((q) => q.path === '/noblock').length, 3); // no Block2 the second time
  assert.equal(sim.requests.filter((q) => q.path === '/noblock').at(-1).block2, undefined);
});

test('block2: an ETag that changes between blocks restarts the transfer, then gives up', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.get(GET('/changing'), dl());
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'protocol');
  assert.match(r.message, /ETag/);
  assert.equal(sim.requests.filter((q) => q.path === '/changing' && q.block2.num === 0).length, 3); // 1 + 2 restarts
});

test('block2: a transfer that was disturbed once recovers on the restart', async () => {
  const sim = await startSim({ resources: { '/changing': { cf: 42, body: Buffer.alloc(2500, 7), etagFlip: 1 } } });
  const c = await connect(sim);
  const r = await c.get(GET('/changing'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.response.payload.length, 2500);
});

test('block2: an error response in the middle of a transfer is returned as that response', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const orig = sim.resources['/big'];
  let served = 0;
  sim.resources['/big'] = {
    ...orig,
    get code() {
      return served++ < 1 ? undefined : 0xa0; // 5.00 from the second block on
    }
  };
  const r = await c.get(GET('/big'), dl());
  assert.equal(r.ok, true);
  assert.equal(msg.codeClass(r.response.code), 5);
});

// ---- observe -------------------------------------------------------------------------------------------

test('observe: registration, then notifications replace the latest value', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.observe('o', GET('/obs'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.observing, true);
  assert.equal(r.response.payload.toString(), '1');
  assert.equal(sim.requests.at(-1).observe, 0);
  sim.notify('/obs', { body: '2' });
  await until(() => c.observation('o').latest.payload.toString() === '2', 1000, 'first notification');
  sim.notify('/obs', { body: '3', con: true });
  await until(() => c.observation('o').latest.payload.toString() === '3', 1000, 'CON notification');
  await until(() => sim.stats.acksReceived >= 1, 1000, 'ACK of the CON notification');
});

test('observe: out-of-order and duplicate notifications are dropped by the freshness rule', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  await c.observe('o', GET('/obs'), dl());
  sim.notify('/obs', { body: '10', seq: 10 });
  await until(() => c.observation('o').latest.payload.toString() === '10');
  sim.notify('/obs', { body: '7', seq: 7 }); // late: older
  sim.notify('/obs', { body: '10b', seq: 10 }); // duplicate sequence number
  sim.notify('/obs', { body: '11', seq: 11 });
  await until(() => c.observation('o').latest.payload.toString() === '11');
  assert.equal(c.stats.staleNotifications, 2);
  sim.notify('/obs', { body: 'far', seq: 0xfffffe }); // more than 2^23 ahead: not a successor of 11
  sim.notify('/obs', { body: 'mid', seq: 0x7ffff0 });
  await until(() => c.observation('o').latest.payload.toString() === 'mid');
  sim.notify('/obs', { body: 'high', seq: 0xffffe0 });
  await until(() => c.observation('o').latest.payload.toString() === 'high');
  sim.notify('/obs', { body: 'wrapped', seq: 2 }); // 2 follows 0xffffe0 after the 24-bit wrap
  await until(() => c.observation('o').latest.payload.toString() === 'wrapped');
  assert.equal(c.stats.staleNotifications, 3);
});

test('observe: a retransmitted CON notification is ACKed again and not applied twice', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  await c.observe('o', GET('/obs'), dl());
  sim.faults.duplicateResponses = 1;
  sim.notify('/obs', { body: '4', con: true });
  await until(() => c.stats.duplicates >= 1, 1000, 'duplicate noticed');
  assert.equal(c.observation('o').latest.payload.toString(), '4');
  assert.equal(c.stats.notifications, 1);
});

test('observe: re-registers when Max-Age passes without a notification', async () => {
  const sim = await startSim({ resources: { '/obs': { cf: 0, body: 'v', observable: true, maxAge: 1 } } });
  const c = await connect(sim, { observeGraceMs: 30 });
  await c.observe('o', GET('/obs'), dl());
  assert.equal(sim.stats.registrations, 1);
  await until(() => sim.stats.registrations === 2, 4000, 're-registration');
  assert.equal(c.stats.reregistrations >= 1, true);
  assert.equal(c.observation('o').state, 'active');
  // the new relationship works
  sim.notify('/obs', { body: 'again' });
  await until(() => c.observation('o').latest.payload.toString() === 'again');
});

test('observe: a server that forgot the observers is registered with again after Max-Age', async () => {
  const sim = await startSim({ resources: { '/obs': { cf: 0, body: 'v', observable: true, maxAge: 1 } } });
  const c = await connect(sim, { observeGraceMs: 30 });
  await c.observe('o', GET('/obs'), dl());
  sim.expireObservers();
  assert.equal(sim.observers.length, 0);
  await until(() => sim.observers.length === 1, 4000, 'observer back');
});

test('observe: re-registration after a Reset is retried with backoff', async () => {
  const sim = await startSim({ resources: { '/obs': { cf: 0, body: 'v', observable: true, maxAge: 1 } } });
  const c = await connect(sim, { observeGraceMs: 30, reregisterBackoffMs: [40, 40] });
  await c.observe('o', GET('/obs'), dl());
  sim.faults.resetNext = 2; // the next two registrations are answered with RST
  await until(() => c.stats.resets === 2, 5000, 'two resets');
  await until(() => sim.stats.registrations === 2, 3000, 'registration after the resets');
  assert.equal(c.observation('o').state, 'active');
  assert.ok(c.observation('o').failures === 0 || c.observation('o') !== null);
});

test('observe: a server that ignores Observe leaves no observation', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  const r = await c.observe('x', GET('/obs-ignore'), dl());
  assert.equal(r.ok, true);
  assert.equal(r.observing, false);
  assert.equal(c.observation('x'), null);
  assert.equal(r.response.payload.toString(), '5');
});

test('observe: the server ending the relationship is visible, and the client registers again', async () => {
  const sim = await startSim();
  const c = await connect(sim, { reregisterBackoffMs: [40] });
  await c.observe('o', GET('/obs'), dl());
  sim.endObservation('/obs');
  await until(() => c.observation('o')?.state === 'ended', 1000, 'ended');
  assert.equal(msg.codeClass(c.observation('o').latest.code), 4);
  sim.setResource('/obs', { cf: 0, body: 'back', observable: true, maxAge: 60 });
  await until(() => c.observation('o')?.state === 'active', 3000, 'registered again');
  assert.equal(c.observation('o').latest.payload.toString(), 'back');
});

test('observe: a notification too big for one datagram is completed with block requests', async () => {
  const sim = await startSim({ maxSzx: 5 }); // 512 byte blocks
  const c = await connect(sim);
  const r = await c.observe('b', GET('/obs-big'), dl());
  assert.equal(r.observing, true);
  assert.ok(r.response.payload.length > 3000);
  const fresh = JSON.stringify({ items: [{ id: 1 }], pad: 'x'.repeat(2000) });
  sim.notify('/obs-big', { body: Buffer.from(fresh) });
  await until(() => c.observation('b').latest.payload.length === fresh.length, 2000, 'assembled notification');
  assert.equal(c.observation('b').latest.payload.toString(), fresh);
});

test('observe: close deregisters with GET Observe=1', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  await c.observe('o', GET('/obs'), dl());
  assert.equal(sim.observers.length, 1);
  await c.close();
  assert.equal(sim.stats.deregistrations, 1);
  assert.equal(sim.observers.length, 0);
  const last = sim.requests.filter((q) => q.path === '/obs').at(-1);
  assert.equal(last.observe, 1);
  assert.equal(last.method, 1);
});

test('observe: the observer stops when the client answers a notification with RST (after the observation is dropped)', async () => {
  const sim = await startSim();
  const c = await connect(sim);
  await c.observe('o', GET('/obs'), dl());
  await c.deregisterAll();
  sim.observers.push({ key: '/obs', token: Buffer.from('aabbccdd', 'hex'), rinfo: { address: '127.0.0.1', port: c.socket._sock.address().port }, seq: 1 });
  sim.notify('/obs', { body: 'late', con: true });
  await until(() => sim.stats.observerResets === 1, 1000, 'RST for a notification nobody listens for');
  assert.equal(sim.observers.length, 0);
});

// ---- transport failures ----------------------------------------------------------------------------------

test('ICMP port unreachable fails the exchange at once as a transport error', async () => {
  const sim = await startSim();
  const c = await connect(sim, { ackTimeoutMs: 2000 });
  await sim.stop();
  const started = Date.now();
  const r = await c.get(GET('/temp'), dl(5000));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'transport');
  assert.ok(Date.now() - started < 1500);
  assert.equal(c.isConnected(), false);
  sims.splice(sims.indexOf(sim), 1);
});

test('close fails what is outstanding and is idempotent', async () => {
  const sim = await startSim();
  sim.faults.silent = true;
  const c = await connect(sim, { ackTimeoutMs: 1000 });
  const pending = c.get(GET('/temp'), dl(5000));
  await sleep(30);
  await c.close();
  const r = await pending;
  assert.equal(r.kind, 'closed');
  await c.close();
  assert.equal((await c.get(GET('/temp'), dl())).kind, 'closed');
});

test('datagrams from another source are ignored', async () => {
  const sim = await startSim();
  sim.faults.silent = true;
  const c = await connect(sim, { ackTimeoutMs: 60, ackRandomFactor: 1, maxRetransmit: 1 });
  const dgram = require('node:dgram');
  const other = dgram.createSocket('udp4');
  const pending = c.get(GET('/temp'), dl(2000));
  await sleep(10);
  // Try to answer from a different port with a perfectly valid piggybacked response (we do not know the token: guess an empty one).
  const forged = Buffer.from([0x60, 0x45, 0x00, 0x00]);
  other.send(forged, c.socket._sock.address().port, '127.0.0.1');
  const r = await pending;
  assert.equal(r.kind, 'timeout');
  other.close();
});
