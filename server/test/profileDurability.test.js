const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ProfileStore = require('../services/profileStore');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-profdur-'));
const tick = () => new Promise((r) => setImmediate(r));

async function quiet(fn) {
  const orig = console.error;
  const logged = [];
  console.error = (...x) => logged.push(x.join(' '));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = orig;
  }
}

test('writes in one tick coalesce into a single disk write; rev bumps per mutation; view is synchronous', async () => {
  const dir = tmpDir();
  const store = new ProfileStore(dir);
  let writes = 0;
  const orig = store._writeDurably.bind(store);
  store._writeDurably = (json) => {
    writes++;
    return orig(json);
  };
  const rev0 = store.rev;
  for (let i = 0; i < 50; i++) store.upsertIn('pipelines', `p${i}`, { n: i });
  assert.strictEqual(store.rev, rev0 + 50);
  assert.strictEqual(store.listIn('pipelines').length, 50); // in-memory view is immediate
  assert.strictEqual(writes, 0);
  await tick();
  await tick();
  assert.strictEqual(writes, 1);
  assert.strictEqual(new ProfileStore(dir).listIn('pipelines').length, 50);
});

test('flush() is synchronous, idempotent, leaves no tmp file; file stays 0600; devices collections persist', () => {
  const dir = tmpDir();
  const store = new ProfileStore(dir);
  store.upsertIn('devices', 'd1', { host: 'plc' });
  store.upsertIn('deviceProfiles', 'dp1', { name: 'x' });
  store.flush();
  store.flush();
  assert.ok(!fs.existsSync(path.join(dir, 'profiles.json.tmp')));
  assert.strictEqual(fs.statSync(path.join(dir, 'profiles.json')).mode & 0o777, 0o600);
  const again = new ProfileStore(dir);
  assert.strictEqual(again.getIn('devices', 'd1').host, 'plc');
  assert.strictEqual(again.getIn('deviceProfiles', 'dp1').name, 'x');
});

test('rotating backups: .bak.1..N keep older generations, capped at N, mode 0600', () => {
  const dir = tmpDir();
  const store = new ProfileStore(dir, { backups: 3, backupIntervalMs: 0 });
  for (let i = 1; i <= 6; i++) {
    store.upsertIn('models', 'm', { gen: i });
    store.flush();
  }
  const gen = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).models.m.gen;
  assert.strictEqual(gen('profiles.json'), 6);
  assert.strictEqual(gen('profiles.json.bak.1'), 5);
  assert.strictEqual(gen('profiles.json.bak.2'), 4);
  assert.strictEqual(gen('profiles.json.bak.3'), 3);
  assert.ok(!fs.existsSync(path.join(dir, 'profiles.json.bak.4')));
  assert.strictEqual(fs.statSync(path.join(dir, 'profiles.json.bak.1')).mode & 0o777, 0o600);
});

test('backup interval throttles rotation so a burst cannot evict every good copy', () => {
  const dir = tmpDir();
  const store = new ProfileStore(dir, { backups: 3, backupIntervalMs: 60_000 });
  for (let i = 1; i <= 5; i++) {
    store.upsertIn('models', 'm', { gen: i });
    store.flush();
  }
  assert.ok(fs.existsSync(path.join(dir, 'profiles.json.bak.1')));
  assert.ok(!fs.existsSync(path.join(dir, 'profiles.json.bak.2')));
});

test('zero-length main file recovers from the newest valid backup, loudly, and rewrites main', async () => {
  const dir = tmpDir();
  const a = new ProfileStore(dir, { backupIntervalMs: 0 });
  a.upsertBroker('b1', { host: 'one' });
  a.flush();
  a.upsertBroker('b2', { host: 'two' });
  a.flush(); // bak.1 now holds the b1-only generation
  fs.writeFileSync(path.join(dir, 'profiles.json'), ''); // crash left an empty file
  const { result: b, logged } = await quiet(() => new ProfileStore(dir));
  assert.deepStrictEqual(b.brokers().map((x) => x.config.id), ['b1']);
  assert.strictEqual(b.lastLoad.source, 'backup.1');
  assert.ok(logged.some((l) => /RECOVERED/.test(l)));
  b.flush();
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8')).mqtt.b1, 'a good main file is rewritten');
});

test('a corrupt newest backup is skipped in favour of an older valid one', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{bad');
  fs.writeFileSync(path.join(dir, 'profiles.json.bak.1'), '{also bad');
  fs.writeFileSync(path.join(dir, 'profiles.json.bak.2'), JSON.stringify({ mqtt: { x: { config: { id: 'x' } } } }));
  const { result: s } = await quiet(() => new ProfileStore(dir));
  assert.strictEqual(s.brokers()[0].config.id, 'x');
  assert.strictEqual(s.lastLoad.source, 'backup.2');
});

test('prototype-polluting ids are rejected by every upsert', () => {
  const store = new ProfileStore(tmpDir());
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => store.upsertIn('pipelines', id, {}), /invalid id/);
    assert.throws(() => store.upsertBroker(id, {}), /invalid id/);
    assert.throws(() => store.upsertAlertRule(id, {}), /invalid id/);
    assert.strictEqual(store.getIn('pipelines', id), null);
  }
  assert.strictEqual({}.polluted, undefined);
});
