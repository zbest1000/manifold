const { test } = require('node:test');
const assert = require('node:assert');

const TopicTrie = require('../services/topicTrie');
const { evaluate, validateModel, collectTopics } = require('../services/namespaceModel');

// Shorthand model builder: levels as [name, kind, arg] triples.
function model({ appliesTo = '', allowDeeper = false, levels }) {
  return {
    name: 't',
    appliesTo,
    allowDeeper,
    levels: levels.map(([name, kind, arg]) => ({
      name,
      rule: kind === 'enum' ? { kind, values: arg } : kind === 'pattern' ? { kind, pattern: arg } : { kind: 'any' }
    }))
  };
}

// ---- rules ------------------------------------------------------------------

test('enum rule: matching values conform, others violate with the value list', () => {
  const m = model({ levels: [['site', 'enum', ['plant-a', 'plant-b']], ['metric', 'any']] });
  const r = evaluate(['plant-a/temp', 'plant-b/press', 'warehouse/temp'], m);
  assert.strictEqual(r.checked, 3);
  assert.strictEqual(r.conforming, 2);
  assert.strictEqual(r.violations.length, 1);
  assert.strictEqual(r.violations[0].topic, 'warehouse/temp');
  assert.strictEqual(r.violations[0].level, 'site');
  assert.match(r.violations[0].reason, /"warehouse" is not one of \[plant-a, plant-b\]/);
});

test('pattern rule: anchored to the whole segment', () => {
  const m = model({ levels: [['line', 'pattern', 'line[0-9]+']] });
  const r = evaluate(['line1', 'line42', 'mainline1', 'line'], m);
  assert.strictEqual(r.conforming, 2); // "mainline1" and "line" must NOT match
  const bad = r.violations.map((v) => v.topic).sort();
  assert.deepStrictEqual(bad, ['line', 'mainline1']);
  assert.match(r.violations[0].reason, /does not match \/line\[0-9\]\+\//);
});

test('any rule: every segment passes', () => {
  const m = model({ levels: [['a', 'any'], ['b', 'any']] });
  const r = evaluate(['x/y', 'weird segment/8'], m);
  assert.strictEqual(r.conforming, 2);
  assert.strictEqual(r.score, 100);
});

// ---- depth handling ---------------------------------------------------------

test('too-shallow topics violate at the first missing level', () => {
  const m = model({ levels: [['site', 'any'], ['area', 'any'], ['metric', 'any']] });
  const r = evaluate(['plant/press'], m);
  assert.strictEqual(r.conforming, 0);
  assert.strictEqual(r.violations[0].level, 'metric');
  assert.match(r.violations[0].reason, /level "metric" is missing/);
});

test('deeper topics violate when allowDeeper is off, conform when on', () => {
  const topics = ['site/area/metric', 'site/area/metric/extra/deep'];
  const strict = evaluate(topics, model({ levels: [['site', 'any'], ['area', 'any'], ['metric', 'any']] }));
  assert.strictEqual(strict.conforming, 1);
  assert.strictEqual(strict.violations[0].level, null); // depth violations belong to no declared level
  assert.match(strict.violations[0].reason, /2 level\(s\) deeper/);

  const loose = evaluate(
    topics,
    model({ allowDeeper: true, levels: [['site', 'any'], ['area', 'any'], ['metric', 'any']] })
  );
  assert.strictEqual(loose.conforming, 2);
  assert.strictEqual(loose.score, 100);
});

// ---- prefix scoping ---------------------------------------------------------

test('appliesTo prefix: only topics under the prefix are checked, levels apply after it', () => {
  const m = model({ appliesTo: 'factory', levels: [['site', 'enum', ['plant-a']], ['metric', 'any']] });
  const r = evaluate(
    ['factory/plant-a/temp', 'factory/plant-x/temp', 'building/b1/temp', 'factoryannex/plant-a/temp', 'factory'],
    m
  );
  // building/... and factoryannex/... are out of scope; "factory" alone is in
  // scope (at the prefix) but ends before level "site".
  assert.strictEqual(r.checked, 3);
  assert.strictEqual(r.conforming, 1);
  assert.deepStrictEqual(
    r.violations.map((v) => [v.topic, v.level]).sort(),
    [['factory', 'site'], ['factory/plant-x/temp', 'site']]
  );
});

// ---- system namespace exemption --------------------------------------------

test('$SYS and spBv1.0 topics are exempt from grading', () => {
  const m = model({ levels: [['only', 'enum', ['good']]] });
  const r = evaluate(
    ['good', '$SYS/broker/uptime', '$share/g/whatever', 'spBv1.0/GroupA/DDATA/Edge1/Dev1', 'spBv1.0'],
    m
  );
  assert.strictEqual(r.checked, 1);
  assert.strictEqual(r.conforming, 1);
  assert.strictEqual(r.score, 100);
});

// ---- score math -------------------------------------------------------------

test('score is round(100 * conforming / checked); empty scope scores 100', () => {
  const m = model({ levels: [['v', 'enum', ['ok']]] });
  const r = evaluate(['ok', 'ok', 'bad'], m);
  assert.strictEqual(r.checked, 3);
  assert.strictEqual(r.conforming, 2);
  assert.strictEqual(r.score, 67); // 66.67 rounds to 67
  assert.strictEqual(r.violationsTotal, 1);

  const empty = evaluate(['$SYS/x', 'outside/topic'], model({ appliesTo: 'factory', levels: [['v', 'any']] }));
  assert.strictEqual(empty.checked, 0);
  assert.strictEqual(empty.score, 100);
});

test('violations cap keeps totals and per-level counts exact', () => {
  const topics = [];
  for (let i = 0; i < 50; i++) topics.push(`bad${i}/x`);
  topics.push('ok/x');
  const m = model({ levels: [['site', 'enum', ['ok']], ['metric', 'any']] });
  const r = evaluate(topics, m, { maxViolations: 10 });
  assert.strictEqual(r.violations.length, 10);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.violationsTotal, 50);
  assert.strictEqual(r.checked, 51);
  assert.deepStrictEqual(r.perLevel, [{ name: 'site', failures: 50 }, { name: 'metric', failures: 0 }]);
});

test('perLevel counts first failures at the right level', () => {
  const m = model({
    levels: [['site', 'enum', ['plant']], ['area', 'pattern', 'line[0-9]+'], ['metric', 'any']]
  });
  const r = evaluate(['plant/line1/temp', 'plant/cellX/temp', 'depot/line1/temp'], m);
  assert.deepStrictEqual(r.perLevel, [
    { name: 'site', failures: 1 }, // depot
    { name: 'area', failures: 1 }, // cellX
    { name: 'metric', failures: 0 }
  ]);
});

// ---- validateModel ----------------------------------------------------------

test('validateModel: rejects bad regex naming the pattern, missing fields, empty enums', () => {
  const badRe = validateModel(model({ levels: [['site', 'pattern', '[unclosed']] }));
  assert.strictEqual(badRe.ok, false);
  assert.match(badRe.error, /level "site"/);
  assert.match(badRe.error, /\[unclosed/); // the offending pattern is named verbatim

  assert.strictEqual(validateModel({ name: '', levels: [{ name: 'a', rule: { kind: 'any' } }] }).ok, false);
  assert.strictEqual(validateModel({ name: 'm', levels: [] }).ok, false);
  assert.strictEqual(validateModel(model({ levels: [['site', 'enum', []]] })).ok, false);
  assert.strictEqual(validateModel({ name: 'm', levels: [{ name: 'a', rule: { kind: 'nope' } }] }).ok, false);

  const ok = validateModel({
    name: '  Plant model ',
    appliesTo: '/factory/',
    allowDeeper: 1,
    levels: [{ name: ' site ', rule: { kind: 'enum', values: ['a', ' b ', ''] }, junk: true }]
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.model.name, 'Plant model');
  assert.strictEqual(ok.model.appliesTo, 'factory'); // slashes normalized away
  assert.strictEqual(ok.model.allowDeeper, true);
  assert.deepStrictEqual(ok.model.levels, [{ name: 'site', rule: { kind: 'enum', values: ['a', 'b'] } }]);
});

// ---- collectTopics ----------------------------------------------------------

test('collectTopics flattens the trie, skipping $-rooted branches', () => {
  const t = new TopicTrie();
  ['factory/line1/temp', 'factory/line1', '$SYS/broker/uptime'].forEach((topic, i) => t.insert(topic, i));
  const topics = collectTopics(t).sort();
  assert.deepStrictEqual(topics, ['factory/line1', 'factory/line1/temp']);
});

// ---- API round-trip ---------------------------------------------------------

test('models API: validation 400s, CRUD round-trip, model-report grades a broker', async () => {
  const express = require('express');
  const fsMod = require('fs');
  const os = require('os');
  const path = require('path');
  const ProfileStore = require('../services/profileStore');
  const unsRoutes = require('../routes/uns');

  const trie = new TopicTrie();
  ['factory/plant-a/line1/temp', 'factory/plant-a/line1/press', 'factory/depot/line1/temp', '$SYS/broker/version']
    .forEach((topic, i) => trie.insert(topic, i));
  const mqttManager = {
    getConnection: (id) => (id === 'b1' ? { id } : null),
    getTrie: (id) => (id === 'b1' ? trie : null)
  };

  const app = express();
  app.use(express.json());
  app.locals.services = {
    profiles: new ProfileStore(fsMod.mkdtempSync(path.join(os.tmpdir(), 'manifold-nsmodel-test-'))),
    mqttManager
  };
  app.use('/api/uns', unsRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${base}/api/uns/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    // invalid regex is rejected at save with the bad pattern in the message
    const badRe = await post(model({ levels: [['site', 'pattern', '(oops']] }));
    assert.strictEqual(badRe.status, 400);
    assert.match(badRe.body.error, /\(oops/);
    assert.strictEqual((await post({ name: 'x', levels: [] })).status, 400);

    // create
    const created = await post({
      name: 'Factory model',
      appliesTo: 'factory',
      allowDeeper: false,
      levels: [
        { name: 'site', rule: { kind: 'pattern', pattern: 'plant-[a-z]' } },
        { name: 'area', rule: { kind: 'any' } },
        { name: 'metric', rule: { kind: 'any' } }
      ]
    });
    assert.strictEqual(created.status, 201);
    assert.ok(created.body.id);

    // upsert by id keeps the id and returns 200
    const updated = await post({ ...created.body, name: 'Factory model v2' });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.body.id, created.body.id);

    const list = await (await fetch(`${base}/api/uns/models`)).json();
    assert.strictEqual(list.models.length, 1);
    assert.strictEqual(list.models[0].name, 'Factory model v2');

    // report: 2 of 3 factory topics conform; $SYS exempt; depot fails at "site"
    const report = await (
      await fetch(`${base}/api/uns/brokers/b1/model-report?modelId=${created.body.id}`)
    ).json();
    assert.strictEqual(report.model.id, created.body.id);
    assert.strictEqual(report.checked, 3);
    assert.strictEqual(report.conforming, 2);
    assert.strictEqual(report.score, 67);
    assert.strictEqual(report.violations[0].topic, 'factory/depot/line1/temp');
    assert.strictEqual(report.violations[0].level, 'site');
    assert.deepStrictEqual(report.perLevel[0], { name: 'site', failures: 1 });

    // unknown model / unknown broker → 404
    assert.strictEqual((await fetch(`${base}/api/uns/brokers/b1/model-report?modelId=nope`)).status, 404);
    assert.strictEqual(
      (await fetch(`${base}/api/uns/brokers/nope/model-report?modelId=${created.body.id}`)).status,
      404
    );

    // delete
    assert.strictEqual((await fetch(`${base}/api/uns/models/${created.body.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/uns/models/${created.body.id}`, { method: 'DELETE' })).status, 404);
  } finally {
    server.close();
  }
});
