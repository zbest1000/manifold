'use strict';

// Alarms: acknowledgement lifecycle, the durable history journal (rotation, torn lines), what a restart
// does to alarms that were active, history paging / filters / CSV, the routes and the Prometheus series.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { EventEmitter } = require('events');

const { AlertEngine, alarmKey } = require('../services/alertEngine');
const { AlertHistory, parseQuery, queryEvents, toCsv } = require('../services/alertHistory');
const ProfileStore = require('../services/profileStore');
const metricsExporter = require('../services/metricsExporter');
const { roleAllows } = require('../services/authConfig');

const tmp = (p = 'manifold-alarms-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeIo = () => {
  const events = [];
  return { emit: (ev, data) => events.push({ ev, data }), events, alerts: () => events.filter((e) => e.ev === 'alert').map((e) => e.data) };
};
const msg = (topic, payload, brokerId = 'b1') => ({ brokerId, topic, payload });

/** An engine over an in-memory rule list and a bare EventEmitter as the manager's message tap. */
function engineWith(rules, { journal = null, manager = new EventEmitter() } = {}) {
  const io = fakeIo();
  if (!manager.stores) manager.stores = new Map();
  manager.getConnection = () => ({});
  const profiles = { alertRules: () => rules, getBroker: () => ({}) };
  const eng = new AlertEngine({ io, profiles, mqttManager: manager, fetchImpl: null, journal });
  eng.start();
  return { eng, io, manager, rules };
}

const valueRule = (over = {}) => ({ id: 'hot', name: 'Hot pump', type: 'value-threshold', brokerId: 'b1', topic: 'plant/+/temp', op: '>', value: 80, severity: 'critical', ...over });

// ---- acknowledge -------------------------------------------------------------------------------

test('acknowledge: records who/when/note, holds until the alarm clears, and a re-fire starts unacknowledged', () => {
  const { eng, io } = engineWith([valueRule()]);
  const t0 = 1_700_000_000_000;
  eng.onMessage(msg('plant/A/temp', 90), t0);
  let [a] = eng.getActive();
  assert.strictEqual(a.state, 'firing');
  assert.strictEqual(a.severity, 'critical');
  assert.strictEqual(a.acknowledged, false);
  assert.strictEqual(a.id, alarmKey('hot', 'plant/A/temp'));

  const r = eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp', by: 'alice', note: '  checking the cooling loop  ', now: t0 + 5000 });
  assert.strictEqual(r.acknowledged.length, 1);
  assert.deepStrictEqual(r.acknowledged[0], { id: 'hot|plant/A/temp', ruleId: 'hot', topic: 'plant/A/temp', by: 'alice', at: t0 + 5000, note: 'checking the cooling loop' });
  [a] = eng.getActive();
  assert.strictEqual(a.acknowledged, true);
  assert.deepStrictEqual(a.ack, { by: 'alice', at: t0 + 5000, note: 'checking the cooling loop' });
  const ackEvt = io.alerts().find((e) => e.status === 'acknowledged');
  assert.strictEqual(ackEvt.ackBy, 'alice');
  assert.strictEqual(ackEvt.since, t0, 'the acknowledgement names the occurrence it belongs to');
  assert.ok(io.events.some((e) => e.ev === 'alert-state' && e.data.ruleId === 'hot' && e.data.unacknowledged === 0));

  // A second acknowledgement keeps the first one.
  const again = eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp', by: 'bob' });
  assert.strictEqual(again.acknowledged.length, 0);
  assert.strictEqual(again.already, 1);
  assert.strictEqual(eng.getActive()[0].ack.by, 'alice');

  // Still breaching: the acknowledgement holds (no re-fire, no reset).
  eng.onMessage(msg('plant/A/temp', 95), t0 + 6000);
  assert.strictEqual(eng.getActive()[0].acknowledged, true);

  // Clears: the alarm and its acknowledgement are gone.
  eng.onMessage(msg('plant/A/temp', 20), t0 + 7000);
  assert.deepStrictEqual(eng.getActive(), []);

  // Fires again: a new occurrence, unacknowledged. Acknowledging never suppressed it.
  eng.onMessage(msg('plant/A/temp', 99), t0 + 8000);
  [a] = eng.getActive();
  assert.strictEqual(a.acknowledged, false);
  assert.strictEqual(a.since, t0 + 8000);
  assert.strictEqual(io.alerts().filter((e) => e.status === 'firing').length, 2);
  eng.stop();
});

test('acknowledge: refuses an alarm that is not firing, and an occurrence that fired again since (stale)', () => {
  const { eng } = engineWith([valueRule({ sustainMs: 60_000 })]);
  const t0 = 1_700_000_000_000;
  assert.deepStrictEqual(eng.acknowledge({ ruleId: 'nope' }), { error: 'not-found' });
  eng.onMessage(msg('plant/A/temp', 90), t0); // breached, not firing yet
  assert.strictEqual(eng.getActive()[0].state, 'breached');
  assert.deepStrictEqual(eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp' }), { error: 'not-firing' });
  eng.onMessage(msg('plant/A/temp', 90), t0 + 60_000);
  assert.strictEqual(eng.getActive()[0].state, 'firing');
  assert.deepStrictEqual(eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp', since: t0 - 1 }), { error: 'stale' });
  assert.strictEqual(eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp', since: t0 + 60_000 }).acknowledged.length, 1);
  eng.stop();
});

test('acknowledge all: every firing alarm of a rule, skipping breached and already-acknowledged ones', () => {
  const { eng, io } = engineWith([valueRule()]);
  eng.onMessage(msg('plant/A/temp', 90));
  eng.onMessage(msg('plant/B/temp', 91));
  eng.onMessage(msg('plant/C/temp', 92));
  eng.acknowledge({ ruleId: 'hot', topic: 'plant/B/temp', by: 'alice' });
  const r = eng.acknowledge({ ruleId: 'hot', all: true, by: 'operator', note: 'shift handover' });
  assert.deepStrictEqual(r.acknowledged.map((a) => a.topic).sort(), ['plant/A/temp', 'plant/C/temp']);
  assert.strictEqual(r.already, 1);
  assert.ok(eng.getActive().every((a) => a.acknowledged));
  assert.strictEqual(eng.getActive().find((a) => a.topic === 'plant/B/temp').ack.by, 'alice');
  assert.strictEqual(io.alerts().filter((e) => e.status === 'acknowledged').length, 3);
  eng.stop();
});

test('silence rules: one alarm per rule, acknowledgeable without a topic, cleared on resolve', () => {
  const manager = new EventEmitter();
  let last = Date.now();
  manager.branchLastActivity = () => last;
  const rules = [{ id: 's1', name: 'Line quiet', type: 'branch-silent', brokerId: 'b1', path: 'plant', thresholdMs: 1000 }];
  const { eng } = engineWith(rules, { manager });
  eng.evaluate(last + 5000);
  let [a] = eng.getActive();
  assert.strictEqual(a.state, 'firing');
  assert.strictEqual(a.severity, 'warning', 'a rule without a severity is a warning');
  assert.strictEqual(a.topic, 'plant');
  assert.strictEqual(eng.acknowledge({ ruleId: 's1', by: 'op' }).acknowledged.length, 1);
  assert.strictEqual(eng.getRuleState(rules[0]).unacknowledged, 0);
  last = Date.now() + 10_000;
  eng.evaluate(last);
  assert.deepStrictEqual(eng.getActive(), []);
  eng.evaluate(last + 5000);
  [a] = eng.getActive();
  assert.strictEqual(a.acknowledged, false);
  eng.stop();
});

test('deleting or disabling a rule ends its active alarms instead of leaving them open', () => {
  const rules = [valueRule(), valueRule({ id: 'other', name: 'Other' })];
  const { eng, io } = engineWith(rules);
  eng.onMessage(msg('plant/A/temp', 90));
  eng.reconcileRules(); // remember the rules as they are
  rules[1].enabled = false;
  rules.splice(0, 1); // delete 'hot'
  eng.reconcileRules();
  const ended = io.alerts().filter((e) => e.status === 'ended');
  assert.deepStrictEqual(ended.map((e) => [e.ruleId, e.detail]).sort(), [
    ['hot', 'Rule deleted while the alarm was active'],
    ['other', 'Rule disabled while the alarm was active']
  ]);
  assert.deepStrictEqual(eng.getActive(), []);
  eng.stop();
});

// ---- journal -----------------------------------------------------------------------------------

test('journal: appends are queued off the caller and flushed; a fresh instance reads them back', async () => {
  const dir = tmp();
  const j = new AlertHistory({ dir, flushMs: 5 });
  j.load();
  j.append({ seq: 1, ts: 1, status: 'firing' });
  assert.strictEqual(fs.existsSync(path.join(dir, 'alerts.jsonl')), false, 'append() itself never touches the disk');
  assert.strictEqual(j.events().length, 1, 'a queued event is already visible to queries');
  await j.flush();
  const back = new AlertHistory({ dir });
  assert.deepStrictEqual(back.load(), [{ seq: 1, ts: 1, status: 'firing' }]);
  assert.strictEqual(back.lastSeq(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journal: rotation keeps two segments, bounds the size, and memory matches the files', async () => {
  const dir = tmp();
  const maxBytes = 4000;
  const j = new AlertHistory({ dir, maxBytes, flushMs: 1 });
  j.load();
  for (let i = 1; i <= 300; i++) {
    j.append({ seq: i, ts: i, status: i % 2 ? 'firing' : 'resolved', ruleId: 'r', detail: `event number ${i}` });
    if (i % 37 === 0) await j.flush(); // several batches, rotations inside and between them
  }
  await j.flush();
  const cur = path.join(dir, 'alerts.jsonl');
  assert.ok(fs.existsSync(`${cur}.1`), 'the previous segment exists');
  assert.ok(!fs.existsSync(`${cur}.2`), 'only two segments are kept');
  const total = fs.statSync(cur).size + fs.statSync(`${cur}.1`).size;
  assert.ok(total <= maxBytes, `both segments together stay within the cap (${total} <= ${maxBytes})`);
  assert.ok(j.stats.rollovers > 3);
  assert.strictEqual(j.bytes(), total);

  const onDisk = new AlertHistory({ dir, maxBytes }).load();
  assert.deepStrictEqual(j.events().map((e) => e.seq), onDisk.map((e) => e.seq), 'what queries see is exactly what is on disk');
  assert.strictEqual(onDisk[onDisk.length - 1].seq, 300, 'the newest event is kept');
  assert.ok(onDisk[0].seq > 1, 'the oldest were dropped');
  const seqs = onDisk.map((e) => e.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.strictEqual(new Set(seqs).size, seqs.length, 'no duplicates across segments');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journal: a torn last line is skipped and cut off, and the next append is a clean line', async () => {
  const dir = tmp();
  const file = path.join(dir, 'alerts.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ seq: 1, ts: 1, status: 'firing' })}\nnot json at all\n${JSON.stringify({ seq: 2, ts: 2, status: 'resolved' })}\n{"seq":3,"ts":3,"sta`);
  const j = new AlertHistory({ dir, flushMs: 1 });
  const events = j.load();
  assert.deepStrictEqual(events.map((e) => e.seq), [1, 2]);
  assert.strictEqual(j.stats.tornLines, 2, 'the damaged middle line and the torn tail are counted');
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'the torn tail was truncated away');
  j.append({ seq: 3, ts: 3, status: 'firing' });
  await j.flush();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepStrictEqual(JSON.parse(lines[lines.length - 1]), { seq: 3, ts: 3, status: 'firing' });
  assert.deepStrictEqual(new AlertHistory({ dir }).load().map((e) => e.seq), [1, 2, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journal: a write failure is counted and never thrown at the engine', async () => {
  const dir = tmp();
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x'); // a FILE where the data directory should be
  const j = new AlertHistory({ dir: blocker, flushMs: 1 });
  j.load();
  j.append({ seq: 1, ts: 1, status: 'firing' });
  await j.flush();
  assert.strictEqual(j.stats.writeErrors, 1);
  assert.ok(j.stats.lastError);
  assert.strictEqual(j.events().length, 1, 'the event stays visible in memory');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- restart -----------------------------------------------------------------------------------

test('restart: alarms active at shutdown are ended by restart, history survives, live data re-fires a new occurrence', async () => {
  const dir = tmp();
  const manager1 = new EventEmitter();
  manager1.branchLastActivity = () => 1; // silent since forever
  const rules = [valueRule(), { id: 'quiet', name: 'Quiet line', type: 'branch-silent', brokerId: 'b1', path: 'plant', thresholdMs: 1000 }];
  const first = engineWith(rules, { journal: new AlertHistory({ dir, flushMs: 1 }), manager: manager1 });
  first.eng.onMessage(msg('plant/A/temp', 90));
  first.eng.evaluate();
  first.eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp', by: 'alice' });
  assert.strictEqual(first.eng.getActive().length, 2);
  first.eng.stop();
  await first.eng.flush();

  // New process: new engine, new journal, same directory.
  const manager2 = new EventEmitter();
  manager2.branchLastActivity = () => Date.now(); // the line came back while the server was down
  const second = engineWith(rules, { journal: new AlertHistory({ dir, flushMs: 1 }), manager: manager2 });
  assert.deepStrictEqual(second.eng.restored, { loaded: 3, ended: 2, tornLines: 0 });
  assert.deepStrictEqual(second.eng.getActive(), [], 'nothing is restored as firing: state comes from live data');
  const ended = second.io.alerts().filter((e) => e.status === 'ended');
  assert.strictEqual(ended.length, 2);
  assert.ok(ended.every((e) => /Ended by restart/.test(e.detail)));
  assert.deepStrictEqual(ended.map((e) => e.ruleId).sort(), ['hot', 'quiet']);
  assert.strictEqual(ended.find((e) => e.ruleId === 'hot').topic, 'plant/A/temp');
  // seq continues where the journal left off
  assert.ok(ended.every((e) => e.seq > 3));
  // the ring (GET /api/alerts/events, rule lastTransition) is seeded from the journal
  assert.strictEqual(second.eng.getRuleState(rules[0]).lastTransition.status, 'ended');

  second.eng.evaluate(); // the line is not silent any more: no alarm
  assert.deepStrictEqual(second.eng.getActive(), []);
  second.eng.onMessage(msg('plant/A/temp', 95)); // still hot: a NEW occurrence, unacknowledged
  const [a] = second.eng.getActive();
  assert.strictEqual(a.acknowledged, false);
  second.eng.stop();
  await second.eng.flush();

  // A third start finds nothing left open but the new occurrence.
  const third = engineWith(rules, { journal: new AlertHistory({ dir, flushMs: 1 }) });
  assert.strictEqual(third.eng.restored.ended, 1);
  const statuses = third.eng.queryHistory({ limit: 50 }).events.map((e) => `${e.ruleId}:${e.status}`).reverse();
  assert.deepStrictEqual(statuses, ['hot:firing', 'quiet:firing', 'hot:acknowledged', 'hot:ended', 'quiet:ended', 'hot:firing', 'hot:ended']);
  third.eng.stop();
  await third.eng.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- queries -----------------------------------------------------------------------------------

const sample = () =>
  Array.from({ length: 25 }, (_, i) => ({
    seq: i + 1,
    ts: 1000 + i * 10,
    ruleId: i % 2 ? 'r-odd' : 'r-even',
    ruleName: i % 2 ? 'Odd rule' : 'Even rule',
    severity: ['info', 'warning', 'critical'][i % 3],
    status: ['firing', 'resolved', 'acknowledged', 'ended', 'event'][i % 5],
    topic: `plant/${i}/temp`,
    detail: i === 7 ? 'Pump SEVEN overheated' : `detail ${i}`
  }));

test('history paging: newest first, cursor pages are disjoint and complete, stable while events arrive', () => {
  const events = sample();
  const seen = [];
  let cursor = null;
  for (let pages = 0; pages < 10; pages++) {
    const page = queryEvents(events, parseQuery({ limit: 10, cursor }));
    seen.push(...page.events.map((e) => e.seq));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    events.push({ seq: events.length + 1, ts: 9999, ruleId: 'new', status: 'firing' }); // new arrivals do not shift pages
  }
  assert.deepStrictEqual(seen, Array.from({ length: 25 }, (_, i) => 25 - i));
  assert.strictEqual(parseQuery({ limit: 99999 }).limit, 500, 'the page size is capped');
});

test('history filters: rule, state list, severity list, text, time range', () => {
  const events = sample();
  const q = (query) => queryEvents(events, parseQuery({ limit: 500, ...query })).events.map((e) => e.seq);
  assert.ok(q({ ruleId: 'r-odd' }).every((s) => s % 2 === 0));
  assert.deepStrictEqual(q({ state: 'ended,event' }), [25, 24, 20, 19, 15, 14, 10, 9, 5, 4]);
  assert.ok(q({ severity: 'critical' }).length > 0);
  assert.ok(events.filter((e) => q({ severity: 'critical' }).includes(e.seq)).every((e) => e.severity === 'critical'));
  assert.deepStrictEqual(q({ q: 'seven' }), [8], 'text search is case-insensitive over name, topic, detail');
  assert.deepStrictEqual(q({ q: 'plant/3/' }), [4]);
  assert.deepStrictEqual(q({ from: 1100, to: 1120 }), [13, 12, 11]);
  assert.deepStrictEqual(q({ from: new Date(1100).toISOString(), to: new Date(1120).toISOString() }), [13, 12, 11], 'ISO times work too');
  assert.deepStrictEqual(q({ ruleId: 'r-even', state: 'firing', severity: 'info' }), [1]);
});

test('CSV export: header, quoting, and spreadsheet formula injection neutralised', () => {
  const csv = toCsv([
    { seq: 1, ts: 0, status: 'firing', severity: 'critical', ruleName: 'Hot, "very"', ruleId: 'r', type: 'value-threshold', brokerId: 'b', topic: 't', value: -5, detail: 'line1\nline2' },
    { seq: 2, ts: 0, status: 'acknowledged', ruleName: '=HYPERLINK("x")', ruleId: 'r', ackBy: '@bob', note: '+1 call me', detail: '-' }
  ]);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines[0], 'time,seq,state,severity,rule,ruleId,type,broker,topic,value,acknowledgedBy,note,detail');
  assert.ok(lines[1].startsWith('1970-01-01T00:00:00.000Z,1,firing,critical,"Hot, ""very""",r,value-threshold,b,t,-5,'), lines[1]);
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)));
  assert.ok(lines.some((l) => l.includes(",'@bob,'+1 call me,'-")));
  assert.ok(lines.some((l) => l.includes(',warning,')), 'a missing severity exports as warning');
});

// ---- routes ------------------------------------------------------------------------------------

async function routeApp({ tokenName = 'open', role = 'admin' } = {}) {
  const dir = tmp('manifold-alarm-routes-');
  const profiles = new ProfileStore(dir);
  const manager = new EventEmitter();
  manager.stores = new Map();
  manager.getConnection = (id) => (id === 'b1' ? {} : null);
  const journal = new AlertHistory({ dir, flushMs: 1 });
  const alerts = new AlertEngine({ io: fakeIo(), profiles, mqttManager: manager, fetchImpl: null, journal });
  alerts.start();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.role = role;
    req.tokenName = tokenName;
    next();
  });
  app.locals.services = { profiles, mqttManager: manager, alerts };
  app.use('/api/alerts', require('../routes/alerts'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // CSV
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const close = async () => {
    alerts.stop();
    await alerts.flush();
    profiles.flush?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { call, alerts, manager, close };
}

test('routes: severity is validated and stored; rule edits keep optimistic concurrency', async () => {
  const { call, close } = await routeApp();
  try {
    let r = await call('/api/alerts/rules', { name: 'x', type: 'value-threshold', brokerId: 'b1', topic: 't', op: '>', value: 1, severity: 'urgent' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /severity must be one of: info, warning, critical/);
    r = await call('/api/alerts/rules', { name: 'x', type: 'topic-silent', brokerId: 'b1', topic: 't' });
    assert.strictEqual(r.json.severity, 'warning');
    const saved = await call('/api/alerts/rules', { id: r.json.id, rev: r.json.rev, name: 'x', type: 'topic-silent', brokerId: 'b1', topic: 't', severity: 'critical' });
    assert.strictEqual(saved.status, 201);
    assert.strictEqual(saved.json.severity, 'critical');
    const stale = await call('/api/alerts/rules', { id: r.json.id, rev: r.json.rev, name: 'y', type: 'topic-silent', brokerId: 'b1', topic: 't' });
    assert.strictEqual(stale.status, 409);
    const listed = await call('/api/alerts/rules');
    assert.strictEqual(listed.json.rules[0].state.severity, 'critical');
  } finally {
    await close();
  }
});

test('routes: active -> ack (operator on an open server) -> clear -> history, with CSV export', async () => {
  const { call, manager, alerts, close } = await routeApp();
  try {
    const rule = (await call('/api/alerts/rules', { name: 'Hot', type: 'value-threshold', brokerId: 'b1', topic: 'plant/+/temp', op: '>', value: 80, severity: 'critical' })).json;
    manager.emit('message', msg('plant/A/temp', 90));
    manager.emit('message', msg('plant/B/temp', 91));
    let active = await call('/api/alerts/active');
    assert.strictEqual(active.json.alarms.length, 2);
    assert.deepStrictEqual(active.json.counts, { firing: 2, breached: 0, unacknowledged: 2, unacknowledgedCritical: 2 });
    const [first] = active.json.alarms;

    assert.strictEqual((await call('/api/alerts/ack', {})).status, 400);
    assert.strictEqual((await call('/api/alerts/ack', { ruleId: rule.id, note: 'x'.repeat(501) })).status, 400);
    assert.strictEqual((await call('/api/alerts/ack', { ruleId: 'missing' })).status, 404);
    const stale = await call('/api/alerts/ack', { ruleId: rule.id, topic: first.topic, since: first.since - 1 });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.code, 'stale');

    const ack = await call('/api/alerts/ack', { ruleId: rule.id, topic: first.topic, since: first.since, note: 'on it' });
    assert.strictEqual(ack.status, 200);
    assert.strictEqual(ack.json.acknowledged[0].by, 'operator', 'an open server cannot tell people apart');
    active = await call('/api/alerts/active');
    assert.strictEqual(active.json.counts.unacknowledgedCritical, 1);
    const bulk = await call('/api/alerts/ack', { ruleId: rule.id, all: true });
    assert.strictEqual(bulk.json.acknowledged.length, 1);
    assert.strictEqual(bulk.json.already, 1);

    manager.emit('message', msg('plant/A/temp', 10));
    const notFiring = await call('/api/alerts/ack', { ruleId: rule.id, topic: 'plant/A/temp' });
    assert.strictEqual(notFiring.status, 409);
    assert.strictEqual(notFiring.json.code, 'not-firing');

    await alerts.flush();
    const hist = await call('/api/alerts/history?limit=2');
    assert.strictEqual(hist.json.events.length, 2);
    assert.ok(hist.json.nextCursor);
    assert.ok(hist.json.journal.bytes > 0);
    const rest = await call(`/api/alerts/history?limit=50&cursor=${hist.json.nextCursor}`);
    const all = [...hist.json.events, ...rest.json.events].map((e) => e.status);
    assert.deepStrictEqual(all, ['resolved', 'acknowledged', 'acknowledged', 'firing', 'firing']);
    const acks = await call('/api/alerts/history?state=acknowledged&q=on%20it');
    assert.strictEqual(acks.json.events.length, 1);
    assert.strictEqual(acks.json.events[0].note, 'on it');

    const csv = await call('/api/alerts/history?format=csv&severity=critical');
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="manifold-alert-history-/);
    const rows = csv.text.trim().split('\r\n');
    assert.strictEqual(rows.length, 6, 'header + every matching event, not just one page');
  } finally {
    await close();
  }
});

test('routes: with authentication the acknowledgement names the token; viewers cannot acknowledge', async () => {
  const { call, manager, close } = await routeApp({ tokenName: 'alice' });
  try {
    const rule = (await call('/api/alerts/rules', { name: 'Hot', type: 'value-threshold', brokerId: 'b1', topic: 't', op: '>', value: 1 })).json;
    manager.emit('message', msg('t', 5));
    const ack = await call('/api/alerts/ack', { ruleId: rule.id, topic: 't' });
    assert.strictEqual(ack.json.acknowledged[0].by, 'alice');
  } finally {
    await close();
  }
  assert.strictEqual(roleAllows('viewer', 'POST', '/alerts/ack'), false, 'acknowledging is a change: viewers are refused');
  assert.strictEqual(roleAllows('viewer', 'GET', '/alerts/history'), true);
});

// ---- metrics -----------------------------------------------------------------------------------

test('metrics: active alarms by state and severity, unacknowledged, transitions and journal health', async () => {
  const dir = tmp();
  const rules = [valueRule(), valueRule({ id: 'slow', name: 'Slow', topic: 'slow', severity: 'info', sustainMs: 60_000 })];
  const { eng } = engineWith(rules, { journal: new AlertHistory({ dir, flushMs: 1 }) });
  eng.onMessage(msg('plant/A/temp', 90));
  eng.onMessage(msg('plant/B/temp', 90));
  eng.onMessage(msg('slow', 100)); // breached
  eng.acknowledge({ ruleId: 'hot', topic: 'plant/A/temp', by: 'x' });
  await eng.flush();
  const text = metricsExporter.render({ alerts: eng });
  const value = (series) => {
    const m = text.split('\n').find((l) => l.startsWith(`${series} `));
    return m ? Number(m.split(' ').pop()) : null;
  };
  assert.strictEqual(value('manifold_alerts_active{state="firing",severity="critical"}'), 2);
  assert.strictEqual(value('manifold_alerts_active{state="breached",severity="info"}'), 1);
  assert.strictEqual(value('manifold_alerts_active{state="firing",severity="warning"}'), 0, 'zero series are present');
  assert.strictEqual(value('manifold_alerts_unacknowledged{severity="critical"}'), 1);
  assert.strictEqual(value('manifold_alert_transitions_total{state="firing",severity="critical"}'), 2);
  assert.strictEqual(value('manifold_alert_transitions_total{state="acknowledged",severity="critical"}'), 1);
  assert.ok(value('manifold_alert_history_bytes') > 0);
  assert.strictEqual(value('manifold_alert_history_write_errors_total'), 0);
  // every HELP/TYPE header is followed by its own series (the exposition format groups them)
  const gaugeAt = text.indexOf('# TYPE manifold_alerts_active gauge');
  const unackAt = text.indexOf('# HELP manifold_alerts_unacknowledged');
  assert.ok(text.slice(gaugeAt, unackAt).includes('manifold_alerts_active{state="firing"'));
  eng.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
