'use strict';

/**
 * Quality and units on the read path (Trends): the recorder's file format 2
 * (qc / u / m fields), reading format 1 files, the bucket-quality rules shared
 * by recordings and historians, and the historian query metadata.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const historians = require('../services/historians');
const Recorder = require('../services/recorder');
const Replayer = require('../services/replayer');
const MqttManager = require('../services/mqttManager');

const { bucketSeries } = historians;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeProfiles(data = {}) {
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null
  };
}

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
function msg(topic, payload, extra = {}) {
  return { brokerId: 'b1', topic, payload, qos: 1, retain: false, timestamp: new Date(T0).toISOString(), ...extra };
}

// ---- bucket rules ------------------------------------------------------------------

test('bucketSeries: samples that fit come back one-to-one, a Bad sample becomes a gap', () => {
  const out = bucketSeries(
    [
      [1000, 10, 192],
      [2000, 11, 64],
      [3000, 99, 0],
      [4000, 12, null]
    ],
    { maxPoints: 10 }
  );
  assert.deepStrictEqual(out, [
    [1000, 10, 192],
    [2000, 11, 64], // Uncertain keeps its value
    [3000, null, 0], // Bad: no value, a gap
    [4000, 12, 192] // unknown quality counts as Good
  ]);
});

test('bucketSeries: worst quality per bucket, Bad-only bucket = gap, mixed bucket = mean of the usable samples + partial', () => {
  const pts = [
    // bucket 0 (0..999): all Good
    [0, 10, 192],
    [500, 20, 192],
    // bucket 1 (1000..1999): Good + Bad -> mean of the Good, worst = Bad, partial
    [1000, 30, 192],
    [1500, 1e9, 0],
    // bucket 2: Bad only -> gap
    [2000, 5, 0],
    [2500, null, 8],
    // bucket 3: Good + Uncertain -> mean of both, quality Uncertain, NOT partial
    [3000, 40, 192],
    [3500, 50, 64]
  ];
  const out = bucketSeries(pts, { start: 0, end: 3999, maxPoints: 4 });
  assert.deepStrictEqual(out, [
    [0, 15, 192],
    [1000, 30, 0, 1],
    [2000, null, 0],
    [3000, 45, 64]
  ]);
});

test('bucketSeries: a fixed width (Timebase) and an empty input', () => {
  assert.deepStrictEqual(bucketSeries([], { maxPoints: 5 }), []);
  const out = bucketSeries(
    [
      [100, 1, 192],
      [200, 3, 192]
    ],
    { start: 0, end: 1000, maxPoints: 10, always: true, width: 100 }
  );
  assert.deepStrictEqual(out, [
    [100, 1, 192],
    [200, 3, 192]
  ]);
});

// ---- recorder format 2 -------------------------------------------------------------------

test('recorder writes quality and unit with each sample (TVQ q / u, value+unit, Sparkplug metrics) and reads them back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-recq-'));
  const m = new MqttManager({ emit() {} });
  const rec = { id: 'q1', brokerId: 'b1', filter: '#', enabled: true, target: { type: 'file' } };
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles({ recordings: { q1: rec } }), dir });
  r.start();
  // The intake sets msg.quality / sourceTimestamp for a v/t/q envelope.
  m.emit('message', msg('plant/tvq', { v: 21.5, t: T0 + 1000, q: 192 }, { quality: 192, sourceTimestamp: T0 + 1000 }));
  m.emit('message', msg('plant/tvq', { v: 99, t: T0 + 2000, q: 0 }, { quality: 0, sourceTimestamp: T0 + 2000 }));
  // An envelope with a unit: the intake does not treat it as TVQ, the recorder does.
  m.emit('message', msg('plant/tvqu', { v: 3.5, q: 64, u: 'bar' }));
  m.emit('message', msg('plant/temp', { value: 46.2, unit: 'C' }));
  m.emit('message', msg('plant/plain', 7));
  m.emit('message', msg('plant/text', 'running'));
  m.emit('message', msg('plant/broken', 'AAAA', { sparkplugError: 'decode failed' }));
  m.emit('message', msg('spBv1.0/G/DDATA/E/D', 'base64==', {
    sparkplug: {
      metrics: [
        { name: 'Temperature', value: 71.5, properties: { EngUnit: 'degF' }, quality: 192 },
        { name: 'Pressure', value: 2.5, properties: { engUnit: 'bar' }, quality: 0 },
        { name: 'Mode', value: 'auto', properties: {} },
        { name: 'Running', value: true, properties: {} }
      ]
    }
  }));

  await r.sync('q1');
  const lines = fs.readFileSync(r.filePath('q1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 8);
  assert.deepStrictEqual(
    lines.map((l) => [l.topic, l.qc, l.u ?? null, l.q]),
    [
      ['plant/tvq', 192, null, 1],
      ['plant/tvq', 0, null, 1],
      ['plant/tvqu', 64, 'bar', 1],
      ['plant/temp', 192, 'C', 1],
      ['plant/plain', 192, null, 1],
      ['plant/text', 192, null, 1],
      ['plant/broken', 0, null, 1],
      ['spBv1.0/G/DDATA/E/D', 192, null, 1]
    ]
  );
  assert.strictEqual(lines[0].t, T0 + 1000, 'source time from the envelope');
  assert.deepStrictEqual(lines[0].v, { v: 21.5, t: T0 + 1000, q: 192 }, 'the payload is kept as received (replay source)');
  assert.deepStrictEqual(lines[7].m, [
    { n: 'Temperature', v: 71.5, u: 'degF' },
    { n: 'Pressure', v: 2.5, qc: 0, u: 'bar' },
    { n: 'Running', v: 1 }
  ]);

  const out = await r.series('q1', { maxPoints: 100 });
  const by = Object.fromEntries(out.series.map((s) => [s.tag, s]));
  assert.deepStrictEqual(by['plant/tvq'].points, [
    [T0 + 1000, 21.5, 192],
    [T0 + 2000, null, 0]
  ]);
  assert.deepStrictEqual(by['plant/tvqu'], { tag: 'plant/tvqu', unit: 'bar', points: [[T0, 3.5, 64]] });
  assert.deepStrictEqual(by['plant/temp'], { tag: 'plant/temp', unit: 'C', points: [[T0, 46.2, 192]] });
  assert.deepStrictEqual(by['plant/plain'].points, [[T0, 7, 192]]);
  assert.strictEqual(by['plant/text'], undefined, 'text does not chart');
  assert.strictEqual(by['plant/broken'], undefined, 'a tag with no number at all does not chart');
  assert.deepStrictEqual(by['spBv1.0/G/DDATA/E/D/Temperature'], { tag: 'spBv1.0/G/DDATA/E/D/Temperature', unit: 'degF', points: [[T0, 71.5, 192]] });
  assert.deepStrictEqual(by['spBv1.0/G/DDATA/E/D/Pressure'].points, [[T0, null, 0]]);
  assert.strictEqual(out.meta.quality, 'stored');

  const tags = await r.tags('q1', {});
  assert.deepStrictEqual(tags, ['plant/plain', 'plant/temp', 'plant/tvq', 'plant/tvqu', 'spBv1.0/G/DDATA/E/D/Pressure', 'spBv1.0/G/DDATA/E/D/Running', 'spBv1.0/G/DDATA/E/D/Temperature']);

  const read = await r.read('q1', { topic: 'plant/temp' });
  assert.strictEqual(read.points[0].quality, 192);
  assert.strictEqual(read.points[0].unit, 'C');

  r.stop();
  r.remove('q1');
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recorder downsamples long recordings with the bucket-quality rules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-recq-'));
  const m = new MqttManager({ emit() {} });
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles(), dir });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  const lines = [];
  // 40 samples, 1 s apart; samples 10-19 Bad, sample 25 Bad (inside a Good bucket).
  for (let i = 0; i < 40; i++) {
    const bad = (i >= 10 && i < 20) || i === 25;
    lines.push({ t: T0 + i * 1000, topic: 'a/x', v: { v: bad ? -1 : i, q: bad ? 0 : 192 }, q: 0, qc: bad ? 0 : 192 });
  }
  fs.writeFileSync(r.filePath('long'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = await r.series('long', { from: T0, to: T0 + 39_999, maxPoints: 4 }); // 10 s buckets
  assert.deepStrictEqual(out.series[0].points, [
    [T0, 4.5, 192],
    [T0 + 10_000, null, 0],
    [T0 + 20_000, (20 + 21 + 22 + 23 + 24 + 26 + 27 + 28 + 29) / 9, 0, 1],
    [T0 + 30_000, 34.5, 192]
  ]);
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- format 1 files ---------------------------------------------------------------------

const OLD_FORMAT = [
  // Exactly what the recorder wrote before quality capture: t / topic / v / q (= MQTT QoS).
  { t: T0, topic: 'plant/temp', v: { value: 20, unit: 'C' }, q: 0 },
  { t: T0 + 1000, topic: 'plant/temp', v: { value: 21, unit: 'C' }, q: 0 },
  { t: T0 + 2000, topic: 'plant/tvq', v: { v: 5, t: T0 + 2000, q: 0 }, q: 1 },
  { t: T0 + 3000, topic: 'plant/tvq', v: { v: 6, t: T0 + 3000, q: 192 }, q: 1 },
  { t: T0 + 4000, topic: 'plant/plain', v: 42, q: 2 }
];

test('a format 1 recording (no quality / unit fields) still loads: quality and unit derived from the payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-recq-'));
  const m = new MqttManager({ emit() {} });
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles(), dir });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  fs.writeFileSync(r.filePath('old'), OLD_FORMAT.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const out = await r.series('old', { maxPoints: 100 });
  const by = Object.fromEntries(out.series.map((s) => [s.tag, s]));
  assert.deepStrictEqual(by['plant/temp'], { tag: 'plant/temp', unit: 'C', points: [[T0, 20, 192], [T0 + 1000, 21, 192]] });
  assert.deepStrictEqual(by['plant/tvq'].points, [[T0 + 2000, null, 0], [T0 + 3000, 6, 192]], 'a TVQ q in an old payload is honoured');
  assert.deepStrictEqual(by['plant/plain'].points, [[T0 + 4000, 42, 192]], 'the old q (MQTT QoS 2) is NOT read as a quality');
  assert.match(out.meta.qualityNote, /5 samples were recorded before quality capture/);

  const read = await r.read('old', {});
  assert.deepStrictEqual(read.points.map((p) => p.quality), [192, 192, 0, 192, 192]);
  assert.deepStrictEqual(await r.tags('old', {}), ['plant/plain', 'plant/temp', 'plant/tvq']);
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a format 1 recording still replays, with its original QoS; a format 2 file replays the same way', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-recq-'));
  const m = new MqttManager({ emit() {} });
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles(), dir });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  fs.writeFileSync(r.filePath('old'), OLD_FORMAT.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(r.filePath('new'), OLD_FORMAT.map((l) => JSON.stringify({ ...l, qc: 192, u: 'C' })).join('\n') + '\n');
  m.requireClient = () => ({});
  for (const id of ['old', 'new']) {
    const published = [];
    m.publish = async (brokerId, topic, payload, opts) => {
      published.push({ topic, payload, qos: opts.qos });
    };
    const rep = new Replayer({ mqttManager: m, recorder: r });
    await rep.start({ recordingId: id, brokerId: 'b1', speed: 100 });
    const deadline = Date.now() + 5000;
    while (rep.getStatus().running && Date.now() < deadline) await sleep(20);
    assert.strictEqual(published.length, OLD_FORMAT.length, `${id}: every message replayed`);
    assert.deepStrictEqual(published.map((p) => p.qos), [0, 0, 1, 1, 2]);
    assert.deepStrictEqual(published[0].payload, { value: 20, unit: 'C' }, `${id}: payload as recorded`);
  }
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- historians ---------------------------------------------------------------------

test('timescale querySeries maps Bad-only buckets to gaps and mixed buckets to partial points', async () => {
  const fakePool = {
    query: async () => ({
      rows: [
        { topic: 'a', bucket: new Date(T0), value: 10, quality: 192, bad: '0', usable: '3' },
        { topic: 'a', bucket: new Date(T0 + 5000), value: 12, quality: 0, bad: '1', usable: '2' },
        { topic: 'a', bucket: new Date(T0 + 10_000), value: null, quality: 0, bad: '3', usable: '0' },
        { topic: 'a', bucket: new Date(T0 + 15_000), value: 14, quality: 64, bad: '0', usable: '1' }
      ]
    })
  };
  const conn = { type: 'timescaledb', host: 'h', database: 'd', user: 'u', __pool: fakePool };
  const out = await historians.querySeries(conn, { tags: ['a'], start: T0, end: T0 + 3600_000, maxPoints: 720 });
  assert.deepStrictEqual(out.series[0].points, [
    [T0, 10, 192],
    [T0 + 5000, 12, 0, 1],
    [T0 + 10_000, null, 0],
    [T0 + 15_000, 14, 64]
  ]);
  assert.deepStrictEqual(out.meta.quality, 'stored');
});

test('timebase querySeries carries the TVQ q through the bucket rules', async () => {
  const start = T0;
  const end = T0 + 40_000;
  const d = [
    { t: new Date(start + 1000).toISOString(), v: 10, q: 192 },
    { t: new Date(start + 2000).toISOString(), v: 12, q: 192 },
    { t: new Date(start + 11_000).toISOString(), v: 999, q: 0 },
    { t: new Date(start + 11_500).toISOString(), v: 14, q: 192 },
    { t: new Date(start + 21_000).toISOString(), v: null, q: 0 }
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tl: [{ t: { n: 'a' }, d }] }) });
  const out = await historians.querySeries({ type: 'timebase', url: 'http://h:4511', dataset: 'x' }, { tags: ['a'], start, end, maxPoints: 10 }, fetchImpl);
  assert.deepStrictEqual(out.series[0].points, [
    [start, 11, 192],
    [start + 8000, 14, 0, 1],
    [start + 20_000, null, 0]
  ]);
  assert.strictEqual(out.meta.quality, 'stored');
});

test('influx querySeries says it has no quality instead of faking Good', async () => {
  const csv = [',result,table,_time,_value,topic', ',_result,0,2026-11-01T12:00:00Z,21.5,a', ''].join('\n');
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => csv });
  const out = await historians.querySeries({ type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'b' }, { tags: ['a'], start: T0 - 1000, end: T0 + 1000, maxPoints: 100 }, fetchImpl);
  assert.deepStrictEqual(out.series[0].points, [[T0, 21.5]]);
  assert.strictEqual(out.meta.quality, 'unavailable');
  assert.match(out.meta.qualityNote, /no quality/);
});

// ---- route ------------------------------------------------------------------------

test('GET /api/recorder/:id/series returns units, quality and the quality metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-recq-'));
  const m = new MqttManager({ emit() {} });
  const profiles = fakeProfiles({ recordings: { rt: { id: 'rt', brokerId: 'b1', filter: '#' } } });
  const r = new Recorder({ mqttManager: m, profiles, dir });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  fs.writeFileSync(r.filePath('rt'), OLD_FORMAT.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const app = express();
  app.locals.services = { profiles, recorder: r };
  app.use('/api/recorder', require('../routes/recorder'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/recorder/rt/series?tags=plant/temp,plant/tvq`);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.series.find((s) => s.tag === 'plant/temp').unit, 'C');
    assert.deepStrictEqual(body.series.find((s) => s.tag === 'plant/tvq').points[0], [T0 + 2000, null, 0]);
    assert.strictEqual(body.meta.quality, 'stored');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    m.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordLine: an envelope carrying a unit keeps its source time and quality (the intake only reads v/t/q envelopes)', () => {
  const t = T0 + 5000;
  const line = Recorder.recordLine(msg('plant/u', { v: 1.5, t, q: 0, u: 'bar' }));
  assert.strictEqual(line.t, t);
  assert.strictEqual(line.qc, 0);
  assert.strictEqual(line.u, 'bar');
  // An implausible device clock falls back to arrival time, as messageTime does.
  assert.strictEqual(Recorder.recordLine(msg('plant/u', { v: 1, t: 5, u: 'bar' })).t, T0);
});
