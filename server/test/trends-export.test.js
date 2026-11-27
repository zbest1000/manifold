const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = '0';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-trends-export-'));

const historians = require('../services/historians');
const Recorder = require('../services/recorder');
const { writeCsv, csvField, exportFilename, prepareExport } = require('../services/trendsExport');

async function csvOf(opts) {
  let text = '';
  const r = await writeCsv({ write: (t) => (text += t), ...opts });
  return { text, ...r };
}
const dataLines = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

test('CSV: rows merge per time, gaps stay empty, Bad has no value, partial buckets are marked', async () => {
  const t0 = Date.UTC(2026, 10, 26, 0, 0, 0);
  const samples = [
    { tag: 'a', t: t0, value: 1.5, quality: 192 },
    { tag: 'b', t: t0, value: 7, quality: 192 },
    { tag: 'a', t: t0 + 1000, value: 2, quality: 0 }, // Bad: empty value, quality kept
    { tag: 'b', t: t0 + 2000, value: 8, quality: 64, partial: true },
    { tag: 'a', t: t0 + 3000, value: null, quality: null } // no quality stored
  ];
  const { text, rows } = await csvOf({ comments: ['# hello'], columns: [{ tag: 'a', unit: '°C' }, { tag: 'b', unit: '' }], samples });
  assert.strictEqual(rows, 4);
  assert.deepStrictEqual(text.split('\n').slice(0, 2), ['# hello', 'time,a (°C),a quality,b,b quality']);
  assert.deepStrictEqual(dataLines(text).slice(1), [
    '2026-11-26T00:00:00.000Z,1.5,192,7,192',
    '2026-11-26T00:00:01.000Z,,0,,',
    '2026-11-26T00:00:02.000Z,,,8,64 partial',
    '2026-11-26T00:00:03.000Z,,,,'
  ]);
});

test('CSV: the same series twice at one time starts a new row; the row cap truncates with a note', async () => {
  const t = Date.UTC(2026, 0, 1);
  const { text } = await csvOf({ comments: [], columns: [{ tag: 'a' }], samples: [{ tag: 'a', t, value: 1, quality: 192 }, { tag: 'a', t, value: 2, quality: 192 }] });
  assert.strictEqual(dataLines(text).length, 3);
  const many = Array.from({ length: 50 }, (_, i) => ({ tag: 'a', t: t + i, value: i, quality: 192 }));
  const cut = await csvOf({ comments: [], columns: [{ tag: 'a' }], samples: many, limit: 10 });
  assert.strictEqual(cut.rows, 10);
  assert.strictEqual(cut.truncated, true);
  assert.match(cut.text, /# Truncated: stopped at 10 rows/);
  assert.strictEqual(dataLines(cut.text).length, 11);
});

test('CSV: fields are quoted and header cells cannot run as spreadsheet formulas', () => {
  assert.strictEqual(csvField('plain'), 'plain');
  assert.strictEqual(csvField('a,b'), '"a,b"');
  assert.strictEqual(csvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvField('=HYPERLINK("x")', { header: true }), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(csvField('-5'), '-5', 'values are not altered');
  assert.strictEqual(exportFilename('raw', Date.UTC(2026, 10, 26, 1, 2, 3), Date.UTC(2026, 10, 26, 2, 0, 0)), 'manifold-trends-raw-20261126T010203Z-20261126T020000Z.csv');
});

test('CSV: a large export streams in chunks and honours backpressure', async () => {
  const t = Date.UTC(2026, 0, 1);
  async function* gen() {
    for (let i = 0; i < 200_000; i++) yield { tag: 'a', t: t + i, value: i, quality: 192 };
  }
  let chunks = 0;
  let max = 0;
  let total = 0;
  const r = await writeCsv({
    comments: [],
    columns: [{ tag: 'a' }],
    samples: gen(),
    write: async (s) => {
      chunks++;
      max = Math.max(max, s.length);
      total += s.length;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  assert.strictEqual(r.rows, 200_000);
  assert.ok(chunks > 50, `${chunks} chunks`);
  assert.ok(max < 70 * 1024, 'no chunk holds the whole file');
  assert.ok(total > 5_000_000);
});

test('historian raw: TimescaleDB pages by (ts, topic) keyset with bound parameters only', async () => {
  const queries = [];
  const page = (n, startAt) => Array.from({ length: n }, (_, i) => ({ ts: new Date(startAt + i), topic: 'plant/temp', value: i, quality: i === 0 ? 0 : null }));
  const pages = [page(10_000, 1000), page(3, 20_000)];
  const fakePool = {
    query: async (text, values) => {
      queries.push({ text: text.replace(/\s+/g, ' '), values });
      return { rows: pages.shift() || [] };
    }
  };
  const conn = { type: 'timescaledb', host: 'h', database: 'd', user: 'u', __pool: fakePool };
  const out = [];
  for await (const s of historians.queryRaw(conn, { tags: ["plant/temp'; DROP TABLE x;--"], start: 1000, end: 100_000 })) out.push(s);
  assert.strictEqual(out.length, 10_003);
  assert.deepStrictEqual(out[0], { tag: 'plant/temp', t: 1000, value: null, quality: 0 }, 'Bad sample: no value');
  assert.deepStrictEqual(out[1], { tag: 'plant/temp', t: 1001, value: 1, quality: 192 }, 'no quality stored = Good');
  assert.strictEqual(queries.length, 2);
  assert.match(queries[0].text, /WHERE topic = ANY\(\$1\) AND ts BETWEEN \$2 AND \$3 AND \(ts, topic\) > \(\$4, \$5\) ORDER BY ts, topic LIMIT 10000/);
  assert.ok(!queries[0].text.includes('DROP'));
  assert.deepStrictEqual(queries[1].values[3], new Date(10_999), 'next page starts after the last row');
  assert.strictEqual(queries[1].values[4], 'plant/temp');
});

test('historian raw: InfluxDB and Timebase read in hour windows, merged in time order', async () => {
  const start = Date.parse('2026-11-26T00:00:00Z');
  const end = start + 2.5 * 3_600_000;
  const fluxBodies = [];
  const influx = { type: 'influxdb', url: 'http://influx:8086', org: 'o', bucket: 'b' };
  const csv = (rows) => [',result,table,_time,_value,topic', ...rows.map((r) => `,_result,0,${r[0]},${r[1]},${r[2]}`), ''].join('\n');
  const influxFetch = async (url, opts) => {
    fluxBodies.push(opts.body);
    const w = fluxBodies.length;
    return { ok: true, status: 200, text: async () => (w === 1 ? csv([['2026-11-26T00:00:02Z', 2, 'b'], ['2026-11-26T00:00:01Z', 1, 'a']]) : csv([])) };
  };
  const got = [];
  for await (const s of historians.queryRaw(influx, { tags: ['a', 'b'], start, end }, influxFetch)) got.push(s);
  assert.strictEqual(fluxBodies.length, 3, 'three windows for 2.5 h');
  assert.ok(!fluxBodies[0].includes('aggregateWindow'), 'raw: nothing averaged');
  assert.deepStrictEqual(got.map((s) => [s.tag, s.value, s.quality]), [['a', 1, null], ['b', 2, null]]);

  const urls = [];
  const tb = { type: 'timebase', url: 'http://tb:4511', dataset: 'D' };
  const edge = new Date(start + 3_600_000).toISOString();
  const tbFetch = async (url) => {
    urls.push(url);
    // every window answers with the boundary sample: it must be exported once
    return { ok: true, status: 200, json: async () => ({ tl: [{ t: { n: 'a' }, d: [{ t: edge, v: 5, q: 192 }, { t: new Date(start + 10).toISOString(), v: null, q: 0 }] }] }) };
  };
  const tbOut = [];
  for await (const s of historians.queryRaw(tb, { tags: ['a'], start, end }, tbFetch)) tbOut.push(s);
  assert.strictEqual(urls.length, 3);
  assert.strictEqual(tbOut.filter((s) => s.t === start + 3_600_000).length, 1, 'boundary sample once');
  assert.deepStrictEqual(tbOut[0], { tag: 'a', t: start + 10, value: null, quality: 0 });
});

test('recording raw: samples stream from the file in time order, Sparkplug metrics as topic/metric', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rec-raw-'));
  const profiles = { rev: 1, listIn: () => [], getIn: () => ({ id: 'r1', name: 'rec' }) };
  const rec = new Recorder({ mqttManager: { on() {}, off() {} }, profiles, dir });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  const lines = [];
  const t0 = Date.UTC(2026, 10, 26);
  for (let i = 0; i < 12_000; i++) lines.push({ t: t0 + (i % 2 ? i - 1 : i + 1), topic: 'x/temp', v: { value: i, unit: 'C' }, q: 0, qc: 192 });
  lines.push({ t: t0 + 20_000, topic: 'x/temp', v: 'oops', q: 0, qc: 0 });
  lines.push({ t: t0 + 30_000, topic: 'spBv1.0/G/DDATA/E/D', v: null, q: 0, qc: 192, m: [{ n: 'rpm', v: 900 }] });
  lines.push({ t: t0 + 40_000, topic: 'other', v: 1, q: 0, qc: 192 });
  fs.writeFileSync(rec.filePath('r1'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = [];
  for await (const s of rec.rawSamples('r1', { tags: ['x/temp', 'spBv1.0/G/DDATA/E/D/rpm'], from: t0, to: t0 + 60_000 })) out.push(s);
  assert.strictEqual(out.length, 12_002);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t, 'time order');
  assert.deepStrictEqual(out[out.length - 2], { tag: 'x/temp', t: t0 + 20_000, value: null, quality: 0, unit: undefined });
  assert.strictEqual(out[out.length - 1].tag, 'spBv1.0/G/DDATA/E/D/rpm');
  assert.strictEqual(out[0].unit, 'C');
});

test('prepareExport validates the request and states raw vs bucketed', async () => {
  const ctx = { profiles: { getIn: () => null }, recorder: {}, mqttManager: { getConnection: () => null } };
  const base = { source: 'historian', id: 'h', tags: ['a'], from: 1, to: 2, mode: 'raw' };
  await assert.rejects(() => prepareExport({ ...base, source: 'x' }, ctx), /source must be/);
  await assert.rejects(() => prepareExport({ ...base, mode: 'x' }, ctx), /mode must be/);
  await assert.rejects(() => prepareExport({ ...base, tags: [] }, ctx), /tags must be/);
  await assert.rejects(() => prepareExport({ ...base, to: 1 }, ctx), /to after from/);
  await assert.rejects(() => prepareExport(base, ctx), (e) => e.status === 404);
  const influx = { getIn: () => ({ id: 'h', name: 'Influx', type: 'influxdb', url: 'http://i', bucket: 'b' }) };
  const plan = await prepareExport({ ...base, from: 0, to: 3_600_000, units: ['V'] }, { ...ctx, profiles: influx, fetchImpl: async () => ({ ok: true, text: async () => '' }) });
  assert.strictEqual(plan.mode, 'raw');
  assert.match(plan.comments.join('\n'), /raw samples/);
  assert.match(plan.comments.join('\n'), /stores no quality/);
  assert.deepStrictEqual(plan.columns, [{ tag: 'a', unit: 'V' }]);
  const bucketed = await prepareExport({ ...base, mode: 'bucketed', from: 0, to: 3_600_000 }, { ...ctx, profiles: influx, fetchImpl: async () => ({ ok: true, text: async () => '' }) });
  assert.match(bucketed.comments.join('\n'), /bucketed as charted.*about 3\.6 s/);
  assert.match(bucketed.filename, /^manifold-trends-bucketed-/);
});

// ---- the route, on the real app ------------------------------------------------

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

test('GET /api/trends/export.csv streams a recording, raw and bucketed', async () => {
  const { profiles, recorder } = services;
  profiles.upsertIn('recordings', 'rexp', { name: 'Export test', brokerId: 'b', filter: 'x/#', target: { type: 'file' }, enabled: false });
  fs.mkdirSync(path.dirname(recorder.filePath('rexp')), { recursive: true });
  const t0 = Date.UTC(2026, 10, 26, 10);
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push({ t: t0 + i * 1000, topic: 'x/temp', v: { value: i % 50, unit: 'C' }, q: 0, qc: i === 5 ? 0 : 192 });
  fs.writeFileSync(recorder.filePath('rexp'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const qs = (mode) => `source=recording&id=rexp&tag=x%2Ftemp&from=${t0}&to=${t0 + 3_600_000}&mode=${mode}`;

  const raw = await fetch(`${baseUrl}/api/trends/export.csv?${qs('raw')}`);
  assert.strictEqual(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /text\/csv/);
  assert.match(raw.headers.get('content-disposition'), /manifold-trends-raw-20261126T100000Z-20261126T110000Z\.csv/);
  const rawText = await raw.text();
  assert.match(rawText, /^# Manifold Trends export\n# Source: recording "Export test"/);
  const rawRows = dataLines(rawText);
  assert.strictEqual(rawRows[0], 'time,x/temp,x/temp quality');
  assert.strictEqual(rawRows.length, 3001);
  assert.strictEqual(rawRows[6], '2026-11-26T10:00:05.000Z,,0', 'Bad sample kept as a gap with its quality');

  const bucketed = await (await fetch(`${baseUrl}/api/trends/export.csv?${qs('bucketed')}`)).text();
  const rows = dataLines(bucketed);
  assert.strictEqual(rows[0], 'time,x/temp (C),x/temp quality', 'unit from the recording');
  assert.ok(rows.length <= 1001);
  assert.match(bucketed, /bucketed as charted/);
  assert.ok(rows.some((r) => r.endsWith('partial')), 'a bucket holding the Bad sample is partial');

  const bad = await fetch(`${baseUrl}/api/trends/export.csv?source=recording&id=nope&tag=a&from=1&to=2&mode=raw`);
  assert.strictEqual(bad.status, 404);
  const badQ = await fetch(`${baseUrl}/api/trends/export.csv?source=recording&id=rexp&from=1&to=2&mode=raw`);
  assert.strictEqual(badQ.status, 400);
});

test('GET /api/trends/export.csv: an unreachable historian is an HTTP error, not a broken file', async () => {
  services.profiles.upsertIn('historians', 'hdown', { name: 'down', type: 'timebase', url: 'http://127.0.0.1:1', dataset: 'D' });
  const res = await fetch(`${baseUrl}/api/trends/export.csv?source=historian&id=hdown&tag=a&from=${Date.now() - 60_000}&to=${Date.now()}&mode=raw`);
  assert.ok(res.status >= 400, `status ${res.status}`);
});
