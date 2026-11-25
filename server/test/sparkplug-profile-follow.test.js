'use strict';

/**
 * Running Sparkplug sessions follow broker profile edits and removals on their
 * own: host STATE sessions and edge-node sessions publish a clean offline
 * message (retained offline STATE / DDEATH + NDEATH) on the OLD connection and
 * reconnect with the new settings, without startHost/updateDevice being called
 * again. Two real in-process aedes brokers.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const Aedes = require('aedes');
const mqtt = require('mqtt');
const SparkplugPublisher = require('../services/sparkplugPublisher');
const SparkplugDecoder = require('../services/sparkplugDecoder');

const decoder = new SparkplugDecoder();

async function startBroker() {
  const AedesClass = Aedes.Aedes || Aedes;
  const aedes = AedesClass.createBroker ? await AedesClass.createBroker() : new AedesClass();
  const users = [];
  aedes.authenticate = (client, username, password, done) => {
    users.push(username || null);
    done(null, true);
  };
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    users,
    close: async () => {
      await new Promise((r) => aedes.close(r));
      await new Promise((r) => server.close(r));
    }
  };
}

/** A subscriber recording every frame on spBv1.0/# (STATE as JSON, the rest decoded). */
async function witness(port) {
  const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: `w_${Math.random().toString(36).slice(2)}` });
  const frames = [];
  c.on('message', (topic, payload, packet) => {
    if (!payload.length) return;
    const kind = topic.split('/')[1] === 'STATE' ? 'STATE' : topic.split('/')[2];
    const body = kind === 'STATE' ? JSON.parse(payload.toString()) : decoder.decode(payload);
    frames.push({ topic, kind, body, retain: packet.retain });
  });
  await new Promise((resolve) => c.on('connect', resolve));
  await new Promise((resolve) => c.subscribe('spBv1.0/#', { qos: 1 }, resolve));
  return { frames, kinds: () => frames.map((f) => f.kind), close: () => c.end(true) };
}

async function retainedState(port, hostId) {
  const w = await witness(port);
  try {
    await until(() => w.frames.some((f) => f.kind === 'STATE' && f.topic.endsWith(hostId)), 3000, 'retained STATE');
    return w.frames.find((f) => f.kind === 'STATE').body;
  } finally {
    w.close();
  }
}

async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Profile store double with the same contract the publisher uses: brokers() and rev. */
function store(config) {
  const s = {
    rev: 1,
    data: { bk: { config: { id: 'bk', host: '127.0.0.1', ...config } } },
    brokers: () => Object.values(s.data),
    edit(patch) {
      s.data.bk = { config: { ...s.data.bk.config, ...patch } };
      s.rev++;
    },
    remove() {
      delete s.data.bk;
      s.rev++;
    }
  };
  return s;
}

const bdSeqOf = (frame) => Number(frame.body.metrics.find((m) => m.name === 'bdSeq').value);

test('host STATE session follows a broker edit: offline STATE on the old broker, online on the new one', async () => {
  const a = await startBroker();
  const b = await startBroker();
  const wa = await witness(a.port);
  const wb = await witness(b.port);
  const profiles = store({ port: a.port });
  const pub = new SparkplugPublisher({ profiles, watchMs: 50 });
  try {
    pub.startHost({ brokerId: 'bk', hostId: 'scada' });
    await until(() => wa.frames.some((f) => f.kind === 'STATE' && f.body.online === true), 5000, 'online on A');

    profiles.edit({ port: b.port }); // nothing else is called
    await until(() => wb.frames.some((f) => f.kind === 'STATE' && f.body.online === true), 5000, 'online on B');
    const onA = wa.frames.filter((f) => f.kind === 'STATE').map((f) => f.body.online);
    assert.deepStrictEqual(onA, [true, false], 'a clean offline STATE on the old broker, not left online');
    assert.strictEqual((await retainedState(a.port, 'scada')).online, false, 'the old broker retains offline');
    assert.strictEqual((await retainedState(b.port, 'scada')).online, true);
    assert.strictEqual(pub.getStatus().hosts['bk scada'].online, true);
  } finally {
    await pub.stop();
    wa.close();
    wb.close();
    await a.close();
    await b.close();
  }
});

test('host STATE session follows a credential edit on the same broker: offline before online, retained online at the end', async () => {
  const a = await startBroker();
  const w = await witness(a.port);
  const profiles = store({ port: a.port, username: 'old' });
  const pub = new SparkplugPublisher({ profiles, watchMs: 50 });
  try {
    pub.startHost({ brokerId: 'bk', hostId: 'scada' });
    await until(() => w.frames.some((f) => f.body.online === true), 5000, 'online');
    profiles.edit({ username: 'new', password: 'pw' });
    await until(() => w.frames.filter((f) => f.body.online === true).length === 2, 5000, 'online again');
    assert.deepStrictEqual(w.frames.map((f) => f.body.online), [true, false, true]);
    assert.deepStrictEqual(a.users.filter((u) => u === 'old' || u === 'new'), ['old', 'new'], 'reconnected with the new credentials');
    assert.strictEqual((await retainedState(a.port, 'scada')).online, true);
  } finally {
    await pub.stop();
    w.close();
    await a.close();
  }
});

test('edge-node session follows a broker edit: DDEATH + NDEATH (old bdSeq) on the old broker, NBIRTH + DBIRTH with last values on the new one', async () => {
  const a = await startBroker();
  const b = await startBroker();
  const wa = await witness(a.port);
  const wb = await witness(b.port);
  const profiles = store({ port: a.port });
  const pub = new SparkplugPublisher({ profiles, watchMs: 50 });
  const dev = { brokerId: 'bk', group: 'G', edge: 'E', device: 'D' };
  try {
    pub.updateDevice({ ...dev, metrics: [{ name: 'speed', value: 7, type: 'int32' }] });
    await until(() => wa.kinds().includes('DBIRTH'), 5000, 'DBIRTH on A');
    const nbirthA = wa.frames.find((f) => f.kind === 'NBIRTH');

    profiles.edit({ port: b.port });
    await until(() => wb.kinds().includes('DBIRTH'), 5000, 'DBIRTH on B');
    assert.deepStrictEqual(wa.kinds(), ['NBIRTH', 'DBIRTH', 'DDEATH', 'NDEATH']);
    assert.strictEqual(bdSeqOf(wa.frames.at(-1)), bdSeqOf(nbirthA), 'NDEATH carries the old session bdSeq');
    assert.deepStrictEqual(wb.kinds(), ['NBIRTH', 'DBIRTH']);
    const dbirth = wb.frames.find((f) => f.kind === 'DBIRTH');
    assert.strictEqual(Number(dbirth.body.metrics[0].value), 7, 'last value re-birthed on the new broker');
    assert.strictEqual(dbirth.body.metrics[0].datatypeName, 'Int32');
    assert.strictEqual(Number(wb.frames[0].body.seq), 0);

    pub.updateDevice({ ...dev, metrics: [{ name: 'speed', value: 8 }] });
    await until(() => wb.kinds().includes('DDATA'), 5000, 'DDATA on B');
    assert.strictEqual(wa.kinds().length, 4, 'nothing more on the old broker');
  } finally {
    await pub.stop();
    wa.close();
    wb.close();
    await a.close();
    await b.close();
  }
});

test('profile removed: clean offline STATE and NDEATH, the sessions end; later updates fail clearly', async () => {
  const a = await startBroker();
  const w = await witness(a.port);
  const profiles = store({ port: a.port });
  const pub = new SparkplugPublisher({ profiles, watchMs: 50 });
  const dev = { brokerId: 'bk', group: 'G', edge: 'E', device: 'D' };
  try {
    pub.startHost({ brokerId: 'bk', hostId: 'scada' });
    pub.updateDevice({ ...dev, metrics: [{ name: 'speed', value: 1, type: 'int32' }] });
    await until(() => w.kinds().includes('DBIRTH') && w.frames.some((f) => f.body.online === true), 5000, 'births');

    profiles.remove();
    await until(() => w.kinds().includes('NDEATH') && w.frames.some((f) => f.body.online === false), 5000, 'clean deaths');
    await until(() => Object.keys(pub.getStatus()).length === 1 && Object.keys(pub.getStatus().hosts).length === 0, 3000, 'sessions dropped');
    assert.throws(() => pub.updateDevice({ ...dev, metrics: [{ name: 'speed', value: 2 }] }), /no saved profile/);
    assert.strictEqual((await retainedState(a.port, 'scada')).online, false);
  } finally {
    await pub.stop();
    w.close();
    await a.close();
  }
});

test('an unchanged revision costs nothing; an edit of an unrelated field keeps the session', async () => {
  const a = await startBroker();
  const w = await witness(a.port);
  const profiles = store({ port: a.port });
  const pub = new SparkplugPublisher({ profiles, watchMs: 50 });
  try {
    const h = pub.startHost({ brokerId: 'bk', hostId: 'scada' });
    await until(() => w.frames.some((f) => f.body.online === true), 5000, 'online');
    const client = h.client;
    profiles.edit({ name: 'renamed' }); // not a connection setting
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(h.client, client);
    assert.strictEqual(pub.startHost({ brokerId: 'bk', hostId: 'scada' }), h);
    assert.deepStrictEqual(w.frames.map((f) => f.body.online), [true]);
  } finally {
    await pub.stop();
    w.close();
    await a.close();
  }
});
