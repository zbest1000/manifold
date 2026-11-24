const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Fake `pg` so pool-cache behaviour is observable without a database. Must be
// installed before historians.js lazily requires it.
const fakePools = [];
class FakePool {
  constructor(opts) {
    this.opts = opts;
    this.ended = false;
    this.queries = [];
    fakePools.push(this);
  }
  async query(text, values) {
    this.queries.push({ text, values });
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
}
require.cache[require.resolve('pg')] = { id: 'pg', filename: 'pg', loaded: true, exports: { Pool: FakePool } };

const historians = require('../services/historians');
const HistorianOutbox = require('../services/historianOutbox');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-hob-'));
const profilesOf = (historiansById) => ({
  listIn: (c) => Object.values(c === 'historians' ? historiansById : {}),
  getIn: (c, id) => (c === 'historians' ? historiansById[id] || null : null)
});
const influx = (extra = {}) => ({ type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'b', ...extra });
const ok = { ok: true, status: 204, text: async () => '' };
const fail = (status, text = 'x') => ({ ok: false, status, text: async () => text });

// ---- 1. line protocol injection ------------------------------------------------

test('line protocol: control characters in topics can never split a line', () => {
  const body = historians.toLineProtocol(
    [
      { tag: 'a\nb value=1 1\nc', ts: 1, value: 1 },
      { tag: 'a\rb', ts: 2, value: 2 },
      { tag: 'tab\tb', ts: 3, value: 3 },
      { tag: 'good/topic', ts: 4, value: 'line1\nline2\r\u0000"q"\\' },
      { tag: 'ends-with-backslash\\', ts: 5, value: 5 }
    ],
    'm'
  );
  const lines = body.split('\n');
  assert.strictEqual(lines.length, 2, 'only representable points are emitted, one line each');
  assert.strictEqual(lines[0], 'm,topic=good/topic raw="line1\\nline2\\r\\x00\\"q\\"\\\\" 4');
  assert.strictEqual(lines[1], 'm,topic=ends-with-backslash\\\\ value=5 5', 'trailing backslash cannot escape the delimiter');
  assert.throws(() => historians.toLineProtocol([{ tag: 't', ts: 1, value: 1 }], 'bad\nmeasurement'), /control characters/);
});

test('line protocol: rejected points are counted as skipped, not silently lost', async () => {
  let body;
  const fetchImpl = async (u, o) => ((body = o.body), ok);
  const res = await historians.writePoints(
    influx(),
    [
      { tag: 'x\ny', ts: 1, value: 1 },
      { tag: 'ok', ts: 2, value: 2 }
    ],
    fetchImpl
  );
  assert.deepStrictEqual(res, { written: 1, skipped: 1 });
  assert.strictEqual(body, 'manifold,topic=ok value=2 2');
});

// ---- 2. numeric classification -------------------------------------------------

test('value classification: only real numbers and unambiguous numeric strings are value=', () => {
  const lp = (value) => historians.toLineProtocol([{ tag: 't', ts: 1, value }], 'm');
  for (const [v, field] of [
    [21.5, 'value=21.5'],
    [0, 'value=0'],
    [-3, 'value=-3'],
    ['21.5', 'value=21.5'],
    ['-0.5e3', 'value=-500'],
    ['+7', 'value=7'],
    ['', 'raw=""'],
    [' ', 'raw=" "'],
    [' 5 ', 'raw=" 5 "'],
    ['0x10', 'raw="0x10"'],
    ['Infinity', 'raw="Infinity"'],
    ['NaN', 'raw="NaN"'],
    [NaN, 'raw="NaN"'],
    [Infinity, 'raw="Infinity"'],
    [true, 'raw="true"'],
    [false, 'raw="false"'],
    [[], 'raw="[]"'],
    [{ a: 1 }, 'raw="{\\"a\\":1}"'],
    ['running', 'raw="running"']
  ]) {
    assert.strictEqual(lp(v), `m,topic=t ${field} 1`, `value ${JSON.stringify(v)}`);
  }
  // null/undefined: nothing to write
  assert.strictEqual(lp(null), '');
  assert.strictEqual(lp(undefined), '');
});

test('null values are skipped and counted; an all-null batch makes no request', async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, ok);
  const res = await historians.writePoints(influx(), [{ tag: 't', ts: 1, value: null }, { tag: 't', ts: 2 }], fetchImpl);
  assert.deepStrictEqual(res, { written: 0, skipped: 2 });
  assert.strictEqual(calls, 0);

  const dir = tmp();
  const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl });
  outbox.enqueue('h', [{ tag: 't', ts: 1, value: null }, { tag: 't', ts: 2, value: 1 }]);
  await outbox.flush();
  const st = outbox.getStats().h;
  assert.strictEqual(st.skipped, 1);
  assert.strictEqual(st.written, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('timescaledb: booleans/empty strings never become numbers; null+quality stores a Bad sample', async () => {
  const queries = [];
  const pool = { query: async (t, v) => (queries.push({ t, v }), { rows: [] }) };
  const conn = { type: 'timescaledb', host: 'h', database: 'd', user: 'u', __pool: pool, __schemaReady: new Set(['manifold_samples']) };
  const res = await historians.writePoints(conn, [
    { tag: 'b', ts: 1, value: true },
    { tag: 'e', ts: 2, value: '' },
    { tag: 'n', ts: 3, value: '4.5' },
    { tag: 'bad', ts: 4, value: null, quality: 0 },
    { tag: 'gone', ts: 5, value: null }
  ]);
  assert.deepStrictEqual(res, { written: 4, skipped: 1 });
  const v = queries[0].v;
  assert.strictEqual(v[2], null, 'true is not 1');
  assert.strictEqual(v[3], 'true');
  assert.strictEqual(v[7], null, '"" is not 0');
  assert.strictEqual(v[12], 4.5);
  assert.strictEqual(v[17], null);
  assert.strictEqual(v[18], null);
  assert.strictEqual(v[19], 0, 'Bad quality preserved');
});

// ---- 8 / 6b. Timebase writer ---------------------------------------------------

test('timebase: carries quality (incl. 0), sends null for Bad samples, sorts per tag oldest-first', async () => {
  let body;
  const fetchImpl = async (u, o) => ((body = JSON.parse(o.body)), ok);
  const conn = { type: 'timebase', url: 'http://t:4511', dataset: 'D' };
  const res = await historians.writePoints(
    conn,
    [
      { tag: 'a', ts: 3000, value: 3, quality: 192 },
      { tag: 'a', ts: 1000, value: 1, quality: 0 },
      { tag: 'b', ts: 2000, value: 'x' },
      { tag: 'a', ts: 2000, value: null, quality: 0 },
      { tag: 'c', ts: 1, value: null }, // no quality + no value: nothing to say
      { tag: 'a', ts: 2000, value: 9, quality: 64 } // same ts keeps arrival order
    ],
    fetchImpl
  );
  assert.deepStrictEqual(res, { written: 5, skipped: 1 });
  assert.deepStrictEqual(
    body.a.map((x) => [Date.parse(x.t), x.v, x.q]),
    [
      [1000, 1, 0],
      [2000, null, 0],
      [2000, 9, 64],
      [3000, 3, 192]
    ]
  );
  assert.strictEqual(body.b[0].q, 192, 'default Good only when the source gave no quality');
  assert.ok(!('c' in body));
});

// ---- 3. dead-lettering ---------------------------------------------------------

test('poison batch: bad points are bisected into the dead-letter file, good points still deliver', async () => {
  const dir = tmp();
  const delivered = [];
  const fetchImpl = async (u, o) => {
    if (o.body.includes('POISON')) return fail(400, 'field type conflict');
    delivered.push(...o.body.split('\n').map((l) => l.split(' ')[0]));
    return ok;
  };
  const profiles = profilesOf({ h: { id: 'h', ...influx() } });
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl });
  const pts = Array.from({ length: 40 }, (_, i) => ({ tag: i === 17 ? 'POISON' : `t${i}`, ts: i + 1, value: i }));
  outbox.enqueue('h', pts);
  await outbox.flush();
  const st = outbox.getStats().h;
  assert.strictEqual(st.written, 39);
  assert.strictEqual(st.deadLettered, 1);
  assert.strictEqual(st.deadLetterDropped, 0);
  assert.ok(st.deadLetterBytes > 0);
  assert.strictEqual(st.spillBytes, 0, 'nothing left blocking the spill');
  assert.match(st.lastDeadLetter, /dead-lettered 1 point/);
  const dl = fs.readFileSync(outbox.deadLetterPath('h'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(dl.length, 1);
  assert.strictEqual(dl[0].point.tag, 'POISON');
  assert.match(dl[0].error, /400/);
  assert.ok(!delivered.some((l) => l.includes('POISON')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('poison batch at the head of the spill no longer blocks the backlog behind it', async () => {
  const dir = tmp();
  let down = true;
  const seen = [];
  const fetchImpl = async (u, o) => {
    if (down) return fail(503);
    if (o.body.includes('POISON')) return fail(422, 'bad');
    seen.push(...o.body.split('\n').map((l) => Number(l.split(' ')[2])));
    return ok;
  };
  const profiles = profilesOf({ h: { id: 'h', ...influx() } });
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl, batchSize: 3 });
  outbox.enqueue('h', [
    { tag: 'POISON', ts: 1, value: 1 },
    ...[2, 3, 4, 5, 6, 7].map((n) => ({ tag: 'ok', ts: n, value: n }))
  ]);
  await outbox.flush(); // down → everything spilled
  down = false;
  await outbox.flush();
  assert.deepStrictEqual(seen, [2, 3, 4, 5, 6, 7]);
  const st = outbox.getStats().h;
  assert.strictEqual(st.deadLettered, 1);
  assert.strictEqual(st.spillBytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transient failures (network, 5xx, 408, 429) and credential errors (401/403) are retried, never dead-lettered', async () => {
  for (const mode of [503, 408, 429, 401, 403, 'network']) {
    const dir = tmp();
    let failing = true;
    const fetchImpl = async () => {
      if (!failing) return ok;
      if (mode === 'network') throw new Error('ECONNRESET');
      return fail(mode);
    };
    const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl });
    outbox.enqueue('h', [{ tag: 't', ts: 1, value: 1 }]);
    await outbox.flush();
    assert.strictEqual(outbox.getStats().h.deadLettered, 0, `mode ${mode}`);
    assert.ok(outbox.getStats().h.spillBytes > 0, `mode ${mode} spilled`);
    failing = false;
    await outbox.flush();
    assert.strictEqual(outbox.getStats().h.written, 1, `mode ${mode} recovered`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-retryable SQL errors (class 22/23) dead-letter; connection errors do not', async () => {
  const dir = tmp();
  const mk = (code) => Object.assign(new Error('boom'), { code });
  let err = mk('22003');
  const pool = {
    query: async (text) => {
      if (/INSERT/.test(text) && err) throw err;
      return { rows: [] };
    }
  };
  const conn = { id: 'pg', type: 'timescaledb', host: 'h', database: 'd', user: 'u', __pool: pool, __schemaReady: new Set(['manifold_samples']) };
  const outbox = new HistorianOutbox({ profiles: profilesOf({ pg: conn }), dir });
  outbox.enqueue('pg', [{ tag: 't', ts: 1, value: 1 }]);
  await outbox.flush();
  assert.strictEqual(outbox.getStats().pg.deadLettered, 1);
  err = mk('08006'); // connection failure: transient
  outbox.enqueue('pg', [{ tag: 't', ts: 2, value: 1 }]);
  await outbox.flush();
  assert.strictEqual(outbox.getStats().pg.deadLettered, 1);
  assert.ok(outbox.getStats().pg.spillBytes > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dead-letter file is size-capped; evictions are counted', async () => {
  const dir = tmp();
  const fetchImpl = async () => fail(400, 'nope');
  const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl, deadLetterMaxBytes: 2000 });
  for (let i = 0; i < 30; i++) {
    outbox.enqueue('h', [{ tag: `t${i}`, ts: i + 1, value: i }]);
    await outbox.flush();
  }
  const st = outbox.getStats().h;
  assert.strictEqual(st.deadLettered, 30);
  assert.ok(st.deadLetterDropped > 0);
  const size = fs.statSync(outbox.deadLetterPath('h')).size;
  assert.ok(size <= 2000, `dead letter ${size} <= cap`);
  assert.strictEqual(st.deadLetterBytes, size);
  const lines = fs.readFileSync(outbox.deadLetterPath('h'), 'utf8').trim().split('\n');
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).point.tag, 't29', 'newest is kept');
  assert.strictEqual(lines.length + st.deadLetterDropped, 30);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 4. spill format ------------------------------------------------------------

test('spill: append-only segments rotate, drain oldest-first across segments, files are cleaned up', async () => {
  const dir = tmp();
  let down = true;
  const seen = [];
  const fetchImpl = async (u, o) => {
    if (down) return fail(503);
    seen.push(...o.body.split('\n').map((l) => Number(l.split(' ')[2])));
    return ok;
  };
  const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl, segmentBytes: 300, batchSize: 7 });
  const total = 60;
  for (let i = 1; i <= total; i++) {
    outbox.enqueue('h', [{ tag: 't', ts: i, value: i }]);
    await outbox.flush(); // down: each point is its own append
  }
  const files = () => fs.readdirSync(path.join(dir, 'outbox'));
  assert.ok(files().filter((f) => f.endsWith('.seg')).length > 3, 'rotated into several segments');
  down = false;
  await outbox.flush();
  assert.deepStrictEqual(seen, Array.from({ length: total }, (_, i) => i + 1));
  assert.deepStrictEqual(files(), [], 'segments and cursor removed after drain');
  assert.strictEqual(outbox.getStats().h.spillBytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spill: the committed offset survives a restart (no re-send of delivered batches)', async () => {
  const dir = tmp();
  let mode = 'down';
  let sends = 0;
  const seen = [];
  const fetchImpl = async (u, o) => {
    if (mode === 'down') return fail(503);
    if (mode === 'second-batch-fails' && sends++ >= 1) return fail(503);
    seen.push(...o.body.split('\n').map((l) => Number(l.split(' ')[2])));
    return ok;
  };
  const profiles = profilesOf({ h: { id: 'h', ...influx() } });
  const a = new HistorianOutbox({ profiles, dir, fetchImpl, batchSize: 4 });
  a.enqueue('h', Array.from({ length: 10 }, (_, i) => ({ tag: 't', ts: i + 1, value: i + 1 })));
  await a.flush();
  mode = 'second-batch-fails';
  await a.flush();
  assert.deepStrictEqual(seen, [1, 2, 3, 4]);
  // "restart": a fresh outbox over the same directory resumes at the cursor
  mode = 'up';
  const b = new HistorianOutbox({ profiles, dir, fetchImpl, batchSize: 4 });
  await b.flush();
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spill: torn cursor, stray tmp file and a truncated final line do not lose or wedge the spill', async () => {
  const dir = tmp();
  const od = path.join(dir, 'outbox');
  fs.mkdirSync(od, { recursive: true });
  const seg = path.join(od, 'h.0000000000001.seg');
  fs.writeFileSync(seg, JSON.stringify({ tag: 't', ts: 1, value: 1 }) + '\n' + '{"tag":"t","ts":2,"val'); // crash mid-append
  fs.writeFileSync(path.join(od, 'h.cursor'), '{"seg":"h.000000'); // torn cursor write
  fs.writeFileSync(path.join(od, 'h.cursor.tmp'), 'garbage');
  const seen = [];
  const fetchImpl = async (u, o) => (seen.push(...o.body.split('\n').map((l) => Number(l.split(' ')[2]))), ok);
  const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl });
  outbox.enqueue('h', [{ tag: 't', ts: 3, value: 3 }]);
  await outbox.flush();
  assert.deepStrictEqual(seen, [1, 3], 'point 1 delivered, torn point skipped (counted), live point after');
  assert.strictEqual(outbox.getStats().h.corrupt, 1);
  assert.strictEqual(outbox.getStats().h.spillBytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration: an old-format <id>.jsonl spill is drained first, oldest-first, then removed', async () => {
  const dir = tmp();
  const od = path.join(dir, 'outbox');
  fs.mkdirSync(od, { recursive: true });
  const legacy = [1, 2, 3, 4, 5].map((n) => JSON.stringify({ tag: 't', ts: n, value: n })).join('\n') + '\n';
  fs.writeFileSync(path.join(od, 'h.jsonl'), legacy);
  let down = true;
  const seen = [];
  const fetchImpl = async (u, o) => {
    if (down) return fail(503);
    seen.push(...o.body.split('\n').map((l) => Number(l.split(' ')[2])));
    return ok;
  };
  const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl, batchSize: 2 });
  outbox.enqueue('h', [{ tag: 't', ts: 6, value: 6 }]);
  await outbox.flush(); // down: live point spills BEHIND the legacy file
  assert.ok(outbox.getStats().h.spillBytes >= Buffer.byteLength(legacy));
  assert.ok(fs.existsSync(path.join(od, 'h.jsonl')), 'legacy file untouched while down');
  down = false;
  await outbox.flush();
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(fs.readdirSync(od), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spill: draining reads the file once (O(n)), not once per batch', async () => {
  const dir = tmp();
  let down = true;
  const fetchImpl = async () => (down ? fail(503) : ok);
  const outbox = new HistorianOutbox({ profiles: profilesOf({ h: { id: 'h', ...influx() } }), dir, fetchImpl, batchSize: 100, segmentBytes: 1 << 30 });
  outbox.enqueue('h', Array.from({ length: 2000 }, (_, i) => ({ tag: 't', ts: i + 1, value: i })));
  await outbox.flush();
  down = false;
  const fsp = require('fs/promises');
  const origOpen = fsp.open;
  let bytesRead = 0;
  fsp.open = async (...a) => {
    const fh = await origOpen.apply(fsp, a);
    if (!String(a[0]).endsWith('.seg')) return fh;
    const read = fh.read.bind(fh);
    fh.read = async (...r) => {
      const res = await read(...r);
      bytesRead += res.bytesRead;
      return res;
    };
    return fh;
  };
  try {
    const size = outbox.getStats().h.spillBytes;
    await outbox.flush();
    assert.strictEqual(outbox.getStats().h.written, 2000);
    // 20 batches over a ~70KB spill: the old implementation re-read the whole
    // remainder per batch (~10MB); one pass is ~size (+ small chunk slack).
    assert.ok(bytesRead < size * 3, `read ${bytesRead} bytes for a ${size}-byte spill`);
  } finally {
    fsp.open = origOpen;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spill cap with dropPolicy oldest advances past whole lines across segments', async () => {
  const dir = tmp();
  const fetchImpl = async () => fail(503);
  const line = JSON.stringify({ tag: 'a/t', ts: 1, value: 1 }).length + 1;
  const outbox = new HistorianOutbox({
    profiles: profilesOf({ h: { id: 'h', ...influx({ dropPolicy: 'oldest' }) } }),
    dir,
    fetchImpl,
    spillMaxBytes: line * 6,
    segmentBytes: line * 2
  });
  for (let i = 1; i <= 9; i++) {
    outbox.enqueue('h', [{ tag: 'a/t', ts: i, value: i }]);
    await outbox.flush();
  }
  const st = outbox.getStats().h;
  assert.strictEqual(st.spillBytes, line * 6);
  assert.strictEqual(st.dropped, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 5. independent flushing ---------------------------------------------------

test('a wedged historian does not delay the healthy ones; one in-flight flush per historian', async () => {
  const dir = tmp();
  let release;
  const gate = new Promise((r) => (release = r));
  const writes = { slow: 0, fast: 0 };
  let slowConcurrent = 0;
  let slowMax = 0;
  const fetchImpl = async (url) => {
    if (url.includes('slow')) {
      writes.slow++;
      slowConcurrent++;
      slowMax = Math.max(slowMax, slowConcurrent);
      await gate;
      slowConcurrent--;
      return ok;
    }
    writes.fast++;
    return ok;
  };
  const profiles = profilesOf({
    slow: { id: 'slow', ...influx({ url: 'http://slow:8086' }) },
    fast: { id: 'fast', ...influx({ url: 'http://fast:8086' }) }
  });
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl });
  outbox.enqueue('slow', [{ tag: 't', ts: 1, value: 1 }]);
  outbox.enqueue('fast', [{ tag: 't', ts: 1, value: 1 }]);
  const f1 = outbox.flush();
  const f2 = outbox.flush(); // overlapping tick joins the in-flight flush
  await sleep(50);
  assert.strictEqual(writes.fast, 1, 'healthy historian delivered while the other is wedged');
  assert.strictEqual(outbox.getStats().fast.written, 1);
  assert.strictEqual(writes.slow, 1);
  assert.strictEqual(slowMax, 1, 'one in-flight flush per historian');
  release();
  await Promise.all([f1, f2]);
  assert.strictEqual(outbox.getStats().slow.written, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 6. per-tag ordering --------------------------------------------------------

test('ordering: live points never overtake a spilled backlog (memory + spill + recovery)', async () => {
  const dir = tmp();
  const log = []; // every point in the order the historian received it
  let mode = 'down';
  let okBatches = 0;
  const fetchImpl = async (u, o) => {
    const batch = o.body.split('\n').map((l) => Number(l.split(' ')[2]));
    if (mode === 'down') return fail(503);
    if (mode === 'flaky' && okBatches++ >= 1) return fail(503); // first batch ok, then down again
    log.push(...batch);
    return ok;
  };
  const profiles = profilesOf({ h: { id: 'h', ...influx() } });
  const mk = () => new HistorianOutbox({ profiles, dir, fetchImpl, batchSize: 3, memMax: 4 });
  let outbox = mk();
  let n = 0;
  const live = (k) => outbox.enqueue('h', Array.from({ length: k }, () => ({ tag: 't', ts: ++n, value: n })));

  live(5); // overflows memMax -> oldest spill to disk, rest in memory
  await outbox.flush(); // down: all on disk
  live(4); // new live points while a backlog exists
  mode = 'flaky';
  await outbox.flush(); // drains one batch, then the historian fails again: live must NOT be sent ahead
  assert.deepStrictEqual(log, [1, 2, 3]);
  live(3);
  outbox = mk(); // process restart: fresh outbox over the same spill dir
  n = 12;
  live(2); // 13, 14 in memory of the new process
  mode = 'up';
  await outbox.flush();
  // 10..12 sat only in the old process's memory (lost with it, by design); everything else arrives in order
  assert.deepStrictEqual(log, [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14]);
  for (let i = 1; i < log.length; i++) assert.ok(log[i] > log[i - 1], `order violated at ${i}: ${log.join(',')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ordering: points that overflow memory during an in-flight batch stay behind it when it fails', async () => {
  const dir = tmp();
  const log = [];
  let release;
  let first = true;
  let up = false;
  const fetchImpl = async (u, o) => {
    const batch = o.body.split('\n').map((l) => Number(l.split(' ')[2]));
    if (first) {
      first = false;
      await new Promise((r) => (release = r));
      return fail(503); // the in-flight batch fails after the overflow happened
    }
    if (!up) return fail(503);
    log.push(...batch);
    return ok;
  };
  const profiles = profilesOf({ h: { id: 'h', ...influx() } });
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl, batchSize: 3, memMax: 3 });
  outbox.enqueue('h', [1, 2, 3].map((n) => ({ tag: 't', ts: n, value: n })));
  const f = outbox.flush(); // batch [1,2,3] in flight
  await sleep(20);
  outbox.enqueue('h', [4, 5, 6, 7, 8].map((n) => ({ tag: 't', ts: n, value: n }))); // overflow while in flight
  release();
  await f;
  up = true;
  await outbox.flush();
  assert.deepStrictEqual(log, [1, 2, 3, 4, 5, 6, 7, 8]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 7. pg pool cache -----------------------------------------------------------

test('pg pool cache keys on the full connection config and closes replaced pools', async () => {
  fakePools.length = 0;
  const base = { id: 'pg1', type: 'timescaledb', host: 'h', port: 5432, database: 'd', user: 'u', password: 'one' };
  const pt = [{ tag: 't', ts: 1, value: 1 }];
  await historians.writePoints(base, pt);
  await historians.writePoints({ ...base }, pt);
  assert.strictEqual(fakePools.length, 1, 'same config reuses the pool');
  await historians.writePoints({ ...base, password: 'two' }, pt);
  assert.strictEqual(fakePools.length, 2, 'edited password gets a new pool');
  assert.strictEqual(fakePools[1].opts.password, 'two');
  assert.strictEqual(fakePools[0].ended, true, 'replaced pool is closed');
  await historians.writePoints({ ...base, password: 'two', ssl: true, sslRootCert: 'CA' }, pt);
  assert.strictEqual(fakePools.length, 3, 'SSL options are part of the key');
  assert.strictEqual(fakePools[1].ended, true);
  await historians.closePools();
  assert.strictEqual(fakePools[2].ended, true);
});
