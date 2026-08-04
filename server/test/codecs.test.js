const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Hermetic data dir so nothing here reads or litters the repo's data dir.
process.env.MANIFOLD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-codecs-'));

const express = require('express');
const protobuf = require('protobufjs');
const avsc = require('avsc');
const MqttManager = require('../services/mqttManager');
const TopicStore = require('../services/topicStore');
const ProfileStore = require('../services/profileStore');
const { PayloadCodecs, compileCodec } = require('../services/payloadCodecs');
const codecRoutes = require('../routes/codecs');

// ---- fixtures -------------------------------------------------------------

const PROTO = `
syntax = "proto3";
package plant;
message Telemetry {
  double temperature = 1;
  int32 rpm = 2;
  string status = 3;
}`;

const Telemetry = protobuf.parse(PROTO, { keepCase: true }).root.lookupType('plant.Telemetry');
const protoBuf = () =>
  Buffer.from(Telemetry.encode(Telemetry.create({ temperature: 21.5, rpm: 1450, status: 'running' })).finish());

const AVRO = JSON.stringify({
  type: 'record',
  name: 'Reading',
  fields: [
    { name: 'value', type: 'double' },
    { name: 'unit', type: 'string' }
  ]
});
const avroType = avsc.Type.forSchema(JSON.parse(AVRO));

// The registry only needs `listIn('codecs')` + `rev` from the profile store.
// A static rev means compiledView builds the matcher table exactly once.
function fakeProfiles(codecs) {
  return { rev: 1, listIn: (c) => (c === 'codecs' ? codecs : []) };
}

// ---- registry: round-trips ------------------------------------------------

test('protobuf round-trip: encode with protobufjs, decode via the registry', () => {
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([
      { id: 'c1', name: 'telemetry', type: 'protobuf', filter: 'plant/+/telemetry', messageType: 'plant.Telemetry', schemaText: PROTO }
    ])
  });
  const out = codecs.decode('b1', 'plant/line1/telemetry', protoBuf());
  assert.ok(out, 'matching binary message must decode');
  assert.strictEqual(out.codecName, 'telemetry');
  assert.strictEqual(out.value.temperature, 21.5);
  assert.strictEqual(out.value.rpm, 1450);
  assert.strictEqual(out.value.status, 'running');
  assert.deepStrictEqual(codecs.getCounters().c1, { decoded: 1, errors: 0, lastError: null });
});

test('avro round-trip: encode with avsc, decode via the registry', () => {
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([{ id: 'a1', type: 'avro', filter: 'plant/#', schemaText: AVRO }])
  });
  const out = codecs.decode('b1', 'plant/line2/pressure', avroType.toBuffer({ value: 3.14, unit: 'bar' }));
  assert.ok(out);
  assert.strictEqual(out.value.value, 3.14);
  assert.strictEqual(out.value.unit, 'bar');
  assert.strictEqual(codecs.getCounters().a1.decoded, 1);
});

// ---- registry: matching ---------------------------------------------------

test('brokerId and filter both gate the codec; misses never touch counters', () => {
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([
      { id: 'p1', type: 'protobuf', brokerId: 'b1', filter: 'plant/+/telemetry', messageType: 'plant.Telemetry', schemaText: PROTO }
    ])
  });
  assert.strictEqual(codecs.decode('b2', 'plant/line1/telemetry', protoBuf()), null, 'wrong broker');
  assert.strictEqual(codecs.decode('b1', 'plant/line1/other', protoBuf()), null, 'filter miss');
  assert.strictEqual(codecs.decode('b1', 'plant/line1/telemetry/extra', protoBuf()), null, 'deeper than filter');
  assert.strictEqual(codecs.getCounters().p1, undefined, 'non-matches must not create counters');
  assert.ok(codecs.decode('b1', 'plant/line1/telemetry', protoBuf()), 'right broker + filter decodes');
});

test('brokerId omitted matches any broker; first matching codec wins', () => {
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([
      { id: 'first', type: 'protobuf', filter: 'plant/#', messageType: 'plant.Telemetry', schemaText: PROTO },
      { id: 'second', type: 'avro', filter: 'plant/#', schemaText: AVRO }
    ])
  });
  const out = codecs.decode('any-broker-at-all', 'plant/x', protoBuf());
  assert.ok(out);
  assert.strictEqual(out.codecId, 'first');
  assert.strictEqual(codecs.getCounters().first.decoded, 1);
  assert.strictEqual(codecs.getCounters().second, undefined, 'later codecs must not run after a win');
});

// ---- registry: resilience -------------------------------------------------

test('garbage buffer counts an error and returns null so ingest falls through', () => {
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([{ id: 'g1', type: 'protobuf', filter: '#', messageType: 'plant.Telemetry', schemaText: PROTO }])
  });
  assert.strictEqual(codecs.decode('b1', 'some/topic', Buffer.from([0xff, 0xff, 0xff])), null);
  const c = codecs.getCounters().g1;
  assert.strictEqual(c.decoded, 0);
  assert.strictEqual(c.errors, 1);
  assert.ok(c.lastError, 'lastError must carry the decode failure');

  const avroCodecs = new PayloadCodecs({
    profiles: fakeProfiles([{ id: 'g2', type: 'avro', filter: '#', schemaText: AVRO }])
  });
  assert.strictEqual(avroCodecs.decode('b1', 'x', Buffer.from([0x01])), null, 'truncated avro buffer');
  assert.strictEqual(avroCodecs.getCounters().g2.errors, 1);
});

test('a codec that fails to compile at load is skipped without breaking others', () => {
  // 'bad' references a message that does not exist in its schema — the kind of
  // entry only a hand-edited profiles.json can produce (the save API compiles
  // first). It must degrade to "this codec is off", not "no codec works".
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([
      { id: 'bad', type: 'protobuf', filter: '#', messageType: 'plant.Missing', schemaText: PROTO },
      { id: 'good', type: 'avro', filter: '#', schemaText: AVRO }
    ])
  });
  const out = codecs.decode('b1', 'x/y', avroType.toBuffer({ value: 1.5, unit: 'psi' }));
  assert.ok(out, 'the healthy codec must still decode');
  assert.strictEqual(out.value.unit, 'psi');
  assert.match(codecs.getCounters().bad.lastError, /failed to compile/);
});

test('compileCodec rejects bad schemas with a usable message', () => {
  assert.throws(() => compileCodec({ type: 'protobuf', messageType: 'X', schemaText: 'message {' }), /./);
  assert.throws(() => compileCodec({ type: 'protobuf', schemaText: PROTO }), /messageType/);
  assert.throws(() => compileCodec({ type: 'protobuf', messageType: 'nope.Missing', schemaText: PROTO }), /no such/i);
  assert.throws(() => compileCodec({ type: 'avro', schemaText: 'not json' }), /./);
  assert.throws(() => compileCodec({ type: 'avro', schemaText: '{"type":"record","name":"R","fields":"nope"}' }), /./);
  assert.throws(() => compileCodec({ type: 'msgpack', schemaText: '{}' }), /type must be one of/);
  assert.throws(() => compileCodec({ type: 'avro' }), /schemaText/);
});

// ---- mqttManager hook -----------------------------------------------------

function managerWith(brokerId) {
  const m = new MqttManager({ emit() {} });
  m.connections.set(brokerId, { id: brokerId, metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set(brokerId, new TopicStore());
  m.topicMeta.set(brokerId, []);
  return m;
}

test('buildMessage decodes matching binary payloads pre-JSON but never touches Sparkplug', () => {
  const m = managerWith('b1');
  const codecs = new PayloadCodecs({
    profiles: fakeProfiles([{ id: 'c1', name: 'tele', type: 'protobuf', filter: '#', messageType: 'plant.Telemetry', schemaText: PROTO }])
  });
  m.codecs = codecs;
  const store = m.stores.get('b1');

  // Binary payload on a normal topic → decoded to structured JSON.
  store.ingest('plant/line1/telemetry', protoBuf(), 0, false);
  const msg = m.buildMessage('b1', store.getLatest('plant/line1/telemetry'));
  assert.strictEqual(msg.payloadFormat, 'json');
  assert.strictEqual(msg.payload.temperature, 21.5);
  assert.strictEqual(msg.payload.status, 'running');
  assert.strictEqual(msg.codec, 'tele');

  // Sparkplug topic matches the '#' filter but must keep its own decoder.
  store.ingest('spBv1.0/g1/NDATA/edge1', protoBuf(), 0, false);
  const sp = m.buildMessage('b1', store.getLatest('spBv1.0/g1/NDATA/edge1'));
  assert.strictEqual(sp.codec, undefined, 'codecs must not intercept spBv1.0 traffic');
  assert.strictEqual(codecs.getCounters().c1.decoded, 1, 'only the non-Sparkplug message reached the codec');

  // JSON on a matching topic: the codec fails (JSON is not valid protobuf here),
  // the error is counted, and the message falls through to the JSON path intact.
  store.ingest('plant/line1/state', Buffer.from('{"ok":true}'), 0, false);
  const js = m.buildMessage('b1', store.getLatest('plant/line1/state'));
  assert.strictEqual(js.payloadFormat, 'json');
  assert.deepStrictEqual(js.payload, { ok: true });
  assert.strictEqual(js.codec, undefined);

  m.shutdown();
});

test('without a registry attached the manager behaves exactly as before', () => {
  const m = managerWith('b2');
  const store = m.stores.get('b2');
  store.ingest('a/b', protoBuf(), 0, false);
  const msg = m.buildMessage('b2', store.getLatest('a/b'));
  assert.strictEqual(msg.payloadFormat, 'binary', 'undecoded binary still surfaces as base64');
  assert.strictEqual(msg.codec, undefined);
  m.shutdown();
});

// ---- save/list/delete over HTTP ------------------------------------------

async function withServer(t) {
  const profiles = new ProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-codecs-store-')));
  const app = express();
  app.use(express.json());
  const services = { profiles, mqttManager: {} };
  app.locals.services = services;
  app.use('/api/codecs', codecRoutes.init(services));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/codecs`;
  const post = (body) =>
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post, services };
}

test('save validates by compiling: bad schemas 400 with the compiler error', async (t) => {
  const { post } = await withServer(t);

  let res = await post({ type: 'protobuf', filter: 'a/#', messageType: 'X', schemaText: 'message {' });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /schema failed to compile/);

  res = await post({ type: 'protobuf', filter: 'a/#', schemaText: PROTO }); // messageType missing
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /messageType/);

  res = await post({ type: 'protobuf', filter: 'a/#', messageType: 'plant.Missing', schemaText: PROTO });
  assert.strictEqual(res.status, 400);

  res = await post({ type: 'avro', filter: 'a/#', schemaText: 'not json' });
  assert.strictEqual(res.status, 400);

  res = await post({ type: 'msgpack', filter: 'a/#', schemaText: '{}' });
  assert.strictEqual(res.status, 400);

  res = await post({ type: 'avro', schemaText: AVRO }); // filter missing
  assert.strictEqual(res.status, 400);
});

test('save/list/delete round-trip; the mounted registry decodes immediately', async (t) => {
  const { base, post, services } = await withServer(t);
  assert.strictEqual(services.mqttManager.codecs, services.codecs, 'init() must attach the registry to the manager');

  const res = await post({
    name: 'tele',
    type: 'protobuf',
    brokerId: null,
    filter: 'plant/+/telemetry',
    messageType: 'plant.Telemetry',
    schemaText: PROTO
  });
  assert.strictEqual(res.status, 201);
  const saved = await res.json();
  assert.ok(saved.id);

  // profiles.rev bumped on save → the compiledView rebuilds and decodes now.
  const out = services.codecs.decode('any', 'plant/line1/telemetry', protoBuf());
  assert.strictEqual(out.value.rpm, 1450);

  const list = await (await fetch(base)).json();
  assert.strictEqual(list.codecs.length, 1);
  assert.strictEqual(list.codecs[0].name, 'tele');
  assert.strictEqual(list.counters[saved.id].decoded, 1);

  let del = await fetch(`${base}/${saved.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(services.codecs.decode('any', 'plant/line1/telemetry', protoBuf()), null, 'deleted codec stops decoding');

  del = await fetch(`${base}/${saved.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 404);
});
