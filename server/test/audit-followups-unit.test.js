'use strict';

// Robustness items a review suspected, each proven here before it was fixed: a recording series read
// without tags (or of one huge tag) held the whole recording in memory, an alert journal line without a
// valid `ts` made the CSV export answer 500, and Prometheus label values let a carriage return through.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

function fakeProfiles(data = {}) {
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    upsertIn: (c, id, v) => ((data[c] ||= {})[id] = { ...v, id, rev: 1 }),
    assertRev() {}
  };
}

async function withApp(services, mount, fn) {
  const app = express();
  app.use(express.json());
  app.locals.services = services;
  app.use(mount.at, mount.router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('recording series: tags are required (1-10) and a recording size cap has an upper bound', async () => {
  const MqttManager = require('../services/mqttManager');
  const Recorder = require('../services/recorder');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-recser-'));
  const m = new MqttManager({ emit() {} });
  const data = { recordings: { r1: { id: 'r1', brokerId: 'b1', filter: '#' } } };
  const profiles = fakeProfiles(data);
  const recorder = new Recorder({ mqttManager: m, profiles, dir });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  const T0 = Date.UTC(2026, 10, 1);
  fs.writeFileSync(recorder.filePath('r1'), Array.from({ length: 50 }, (_, i) => JSON.stringify({ t: T0 + i, topic: `t/${i % 5}`, v: i, q: 0 })).join('\n') + '\n');
  try {
    await withApp({ profiles, recorder, mqttManager: { getConnection: () => ({}) } }, { at: '/api/recorder', router: require('../routes/recorder') }, async (base) => {
      let r = await fetch(`${base}/api/recorder/r1/series`);
      assert.strictEqual(r.status, 400, 'a series without tags would load the whole recording');
      r = await fetch(`${base}/api/recorder/r1/series?tags=${Array.from({ length: 11 }, (_, i) => `t/${i}`).join(',')}`);
      assert.strictEqual(r.status, 400);
      r = await fetch(`${base}/api/recorder/r1/series?tags=t/1`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).series[0].points.length, 10);

      const big = await fetch(`${base}/api/recorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brokerId: 'b1', filter: '#', maxBytes: 1e15 }) });
      assert.strictEqual(big.status, 400, await big.text());
    });
    // One tag that is the whole recording: the samples held are bounded and the answer says it was cut.
    recorder.seriesSampleCap = 20;
    const out = await recorder.series('r1', { tags: ['t/0', 't/1', 't/2', 't/3', 't/4'], from: 0, to: Infinity, maxPoints: 1000 });
    const held = out.series.reduce((n, s) => n + s.points.length, 0);
    assert.ok(held <= 20, `held ${held}`);
    assert.strictEqual(out.meta.truncated, true);
    assert.match(out.meta.truncatedNote, /narrow/i);
  } finally {
    m.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('alert CSV export: a journal line without a valid ts does not fail the export', () => {
  const { toCsv } = require('../services/alertHistory');
  const csv = toCsv([
    { seq: 1, ts: Date.UTC(2026, 0, 1), status: 'firing', ruleName: 'ok' },
    { seq: 2, status: 'firing', ruleName: 'no ts' },
    { seq: 3, ts: 'garbage', status: 'resolved', ruleName: 'bad ts' }
  ]);
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 4);
  assert.ok(lines[1].startsWith('2026-01-01T00:00:00.000Z,1,'));
  assert.ok(lines[2].startsWith(',2,'), lines[2]);
  assert.ok(lines[3].startsWith(',3,'), lines[3]);
});

test('Prometheus label values never carry a raw carriage return', () => {
  const { render } = require('../services/metricsExporter');
  const mqttManager = {
    getConnections: () => [{ id: 'b1', name: 'line1\r# HELP fake injected', metrics: { messagesReceived: 1, topicCount: 1 } }],
    canary: null,
    getPosture: () => null
  };
  const out = render({ mqttManager });
  assert.ok(!out.includes('\r'), 'a CR inside a label value splits the line for CR-aware parsers');
  assert.match(out, /manifold_broker_messages_received_total\{broker="line1 # HELP fake injected"\} 1/);
});
