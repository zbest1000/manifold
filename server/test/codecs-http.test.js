const { test, before, after } = require('node:test');
const assert = require('node:assert');

// The /api/codecs surface on the real app (ephemeral port, throwaway data dir).
process.env.PORT = '0';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-codecs-http-'));

let baseUrl;
let server;
let services;

before(async () => {
  const app = require('../index');
  server = app.server;
  services = app.app.locals.services;
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  services?.mqttManager?.shutdown();
  for (const s of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models']) services?.[s]?.stop?.();
  services?.devices?.stop?.();
  server?.close();
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const PROTO = 'syntax = "proto3";\npackage plant;\nmessage Pump { double temp = 1; int32 rpm = 2; string state = 3; }\n';

test('create, list, update with rev, test and delete a binding', async () => {
  const created = await call('POST', '/api/codecs', { name: 'Pumps', filter: 'plant/+/pump', codec: 'protobuf', schemaText: PROTO });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.messageType, 'plant.Pump', 'the only message is chosen');
  assert.strictEqual(created.body.rev, 1);
  const id = created.body.id;

  const list = await call('GET', '/api/codecs');
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.codecs.some((c) => c.id === id));
  assert.strictEqual(list.body.autodetect, true);
  assert.strictEqual(list.body.limits.maxSchemaBytes, 128 * 1024);
  assert.ok(list.body.available.find((a) => a.id === 'avro').schema);

  // ingest path uses it
  const msg = services.mqttManager.buildMessage('b1', { topic: 'plant/a/pump', buffer: Buffer.from('0900000000000035401096011a0372756e', 'hex'), qos: 0, retain: false, ts: Date.now(), count: 1 });
  assert.deepStrictEqual(msg.payload, { temp: 21, rpm: 150, state: 'run' });
  assert.strictEqual(msg.codec.bindingId, id);
  const after1 = await call('GET', '/api/codecs');
  assert.strictEqual(after1.body.counters[id].decoded, 1);

  // stale rev refused, current rev accepted
  const stale = await call('POST', '/api/codecs', { id, rev: 0, name: 'x', filter: 'plant/+/pump', codec: 'protobuf', schemaText: PROTO });
  assert.strictEqual(stale.status, 409);
  const updated = await call('POST', '/api/codecs', { id, rev: 1, name: 'Pumps v2', filter: 'plant/+/pump', codec: 'protobuf', schemaText: PROTO, messageType: 'Pump' });
  assert.strictEqual(updated.status, 201);
  assert.strictEqual(updated.body.rev, 2);

  const tested = await call('POST', '/api/codecs/test', { bindingId: id, payload: '10 96 01', encoding: 'hex' });
  assert.strictEqual(tested.status, 200);
  assert.deepStrictEqual(tested.body.value, { temp: 0, rpm: 150, state: '' });

  const removed = await call('DELETE', `/api/codecs/${id}`);
  assert.strictEqual(removed.status, 200);
  assert.strictEqual((await call('DELETE', `/api/codecs/${id}`)).status, 404);
});

test('schema problems are refused with a clear message; nothing is stored', async () => {
  const before1 = (await call('GET', '/api/codecs')).body.codecs.length;
  const badProto = await call('POST', '/api/codecs', { filter: 'a/#', codec: 'protobuf', schemaText: 'syntax = "proto3";\nmessage P {\n  int32 a = \n}' });
  assert.strictEqual(badProto.status, 400);
  assert.strictEqual(badProto.body.schemaError, true);
  assert.match(badProto.body.error, /schema error: \.proto does not parse: .*line 4/);
  const badAvro = await call('POST', '/api/codecs', { filter: 'a/#', codec: 'avro', schemaText: '{"type":"record","name":"R","fields":[{"name":"x","type":"Nope"}]}' });
  assert.strictEqual(badAvro.status, 400);
  assert.match(badAvro.body.error, /unknown type "Nope"/);
  const missing = await call('POST', '/api/codecs', { filter: 'a/#', codec: 'avro' });
  assert.match(missing.body.error, /needs a schema/);
  const huge = await call('POST', '/api/codecs', { filter: 'a/#', codec: 'avro', schemaText: `"${'x'.repeat(130 * 1024)}"` });
  assert.strictEqual(huge.status, 413);
  assert.match(huge.body.error, /limit is 128 KiB/);
  const badFilter = await call('POST', '/api/codecs', { filter: 'a/#/b', codec: 'cbor' });
  assert.match(badFilter.body.error, /filter has a # wildcard/);
  const badCodec = await call('POST', '/api/codecs', { filter: 'a/#', codec: 'xml' });
  assert.match(badCodec.body.error, /codec must be one of/);
  const badBroker = await call('POST', '/api/codecs', { filter: 'a/#', codec: 'cbor', brokerId: 'no-such-broker' });
  assert.match(badBroker.body.error, /broker "no-such-broker"/);
  assert.strictEqual((await call('GET', '/api/codecs')).body.codecs.length, before1);
});

test('test box: auto, hex/base64/text, errors', async () => {
  const auto = await call('POST', '/api/codecs/test', { codec: 'auto', payload: 'a1 64 74656d70 f9 4d80', encoding: 'hex' });
  assert.deepStrictEqual(auto.body, { ok: true, bytes: 9, codec: 'cbor', value: { temp: 22 } });
  const b64 = await call('POST', '/api/codecs/test', { codec: 'msgpack', payload: Buffer.from('81a17401', 'hex').toString('base64'), encoding: 'base64' });
  assert.deepStrictEqual(b64.body.value, { t: 1 });
  const senml = await call('POST', '/api/codecs/test', { codec: 'senml-json', payload: '[{"bn":"d/","bt":1700000000,"n":"t","v":1}]', encoding: 'text' });
  assert.deepStrictEqual(senml.body.value, [{ n: 'd/t', v: 1, t: 1700000000 }]);
  assert.strictEqual(senml.body.sourceTimestamp, 1700000000000);
  const fail = await call('POST', '/api/codecs/test', { codec: 'cbor', payload: 'ff', encoding: 'hex' });
  assert.strictEqual(fail.body.ok, false);
  assert.match(fail.body.error, /break/);
  assert.strictEqual((await call('POST', '/api/codecs/test', { codec: 'cbor', payload: 'zz' })).status, 400);
  assert.strictEqual((await call('POST', '/api/codecs/test', { codec: 'cbor', payload: '' })).status, 400);
  assert.strictEqual((await call('POST', '/api/codecs/test', { bindingId: 'nope', payload: '00' })).status, 404);
});

test('codec bindings travel in the config export and import', async () => {
  const created = await call('POST', '/api/codecs', { name: 'Avro temps', filter: 'avro/#', codec: 'avro', schemaText: '{"type":"record","name":"T","fields":[{"name":"v","type":"double"}]}' });
  assert.strictEqual(created.status, 201);
  const exp = await call('GET', '/api/system/config/export');
  const item = exp.body.codecs.find((c) => c.id === created.body.id);
  assert.ok(item, 'exported');
  assert.match(item.schemaText, /"name":"T"/, 'the schema is config, not a secret');
  const imp = await call('POST', '/api/system/config/import', { manifoldConfig: 1, codecs: [{ ...item, id: 'imported-1', name: 'Imported' }] });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
  assert.ok((await call('GET', '/api/codecs')).body.codecs.some((c) => c.id === 'imported-1'));
});
