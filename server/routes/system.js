const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const parquet = require('@dsnp/parquetjs');
const router = express.Router();

// GET /api/system/status
router.get('/status', (req, res) => {
  const { mqttManager, opcuaManager, discovery, i3x } = req.app.locals.services;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mqtt: {
      connections: mqttManager.getConnections().length,
      brokers: mqttManager.getConnections().map((c) => ({ id: c.id, name: c.name, status: c.status }))
    },
    opcua: {
      connections: opcuaManager.getConnections().length,
      endpoints: opcuaManager.getConnections().map((c) => ({ id: c.id, name: c.name, status: c.status }))
    },
    discovery: {
      scanning: discovery.isScanning()
    },
    i3x: i3x.status()
  });
});

// GET /api/system/canary — per-broker publish→deliver round-trip stats
router.get('/canary', (req, res) => {
  const { canary } = req.app.locals.services;
  res.json(canary ? canary.getStats() : { brokers: {} });
});

// POST /api/system/discovery/start { range, mqttPorts, opcuaPorts }
router.post('/discovery/start', async (req, res) => {
  const { discovery } = req.app.locals.services;
  try {
    const result = await discovery.startScan(req.body || {});
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/system/discovery/stop
router.post('/discovery/stop', (req, res) => {
  const { discovery } = req.app.locals.services;
  res.json(discovery.stopScan());
});

// GET /api/system/discovery/results
router.get('/discovery/results', (req, res) => {
  const { discovery } = req.app.locals.services;
  res.json({ scanning: discovery.isScanning(), results: discovery.getLastResults() });
});

// POST /api/system/export/parquet { series: [{ tag, points: [[tsMs, value]] }] }
// → a wide-format Parquet file (timestamp + one DOUBLE column per tag, rows on
// the union of timestamps). Wide + Parquet is what DuckDB/Athena/pandas ingest
// directly — the lakehouse handoff CSV can't provide. The client sends the
// series it already charted, so this works for live, historian, and recording
// sources alike.
router.post('/export/parquet', async (req, res) => {
  const series = req.body?.series;
  if (!Array.isArray(series) || series.length === 0 || !series.every((s) => s && typeof s.tag === 'string' && Array.isArray(s.points))) {
    return res.status(400).json({ error: 'series must be a non-empty array of { tag, points }' });
  }

  // Parquet column names: keep them recognizable but safe, and unique.
  const seen = new Set(['timestamp']);
  const cols = series.map((s) => {
    let name = s.tag.replace(/[^\w./-]/g, '_') || 'series';
    while (seen.has(name)) name += '_';
    seen.add(name);
    return name;
  });

  const fields = { timestamp: { type: 'TIMESTAMP_MILLIS' } };
  for (const c of cols) fields[c] = { type: 'DOUBLE', optional: true };

  const byTs = new Map();
  series.forEach((s, i) => {
    for (const [ts, v] of s.points) {
      if (!Number.isFinite(ts) || !Number.isFinite(Number(v))) continue;
      let row = byTs.get(ts);
      if (!row) {
        row = { timestamp: new Date(ts) };
        byTs.set(ts, row);
      }
      row[cols[i]] = Number(v);
    }
  });
  if (byTs.size === 0) return res.status(400).json({ error: 'no numeric points to export' });

  const tmp = path.join(os.tmpdir(), `manifold-parquet-${process.pid}-${Date.now()}.parquet`);
  try {
    const writer = await parquet.ParquetWriter.openFile(new parquet.ParquetSchema(fields), tmp);
    for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
      await writer.appendRow(byTs.get(ts));
    }
    await writer.close();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="manifold-series.parquet"');
    fs.createReadStream(tmp)
      .on('close', () => fs.unlink(tmp, () => {}))
      .pipe(res);
  } catch (error) {
    fs.unlink(tmp, () => {});
    res.status(500).json({ error: `parquet export failed: ${error.message}` });
  }
});

// ---- config as code -----------------------------------------------------------
// Export/import the DataOps configuration (routes, models, historians,
// recordings, contracts, bindings, mounts, alert rules) as one JSON document —
// reviewable in git, promotable between environments. Secrets are STRIPPED on
// export (a config file in a repo must never carry credentials); re-enter them
// after import.

const EXPORT_COLLECTIONS = ['historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings', 'codecs'];
const SECRET_FIELDS = ['token', 'apiKey', 'apiSecret', 'password', 'secret'];

// GET /api/system/config/export
router.get('/config/export', (req, res) => {
  const { profiles } = req.app.locals.services;
  const out = { manifoldConfig: 1, exportedAt: new Date().toISOString() };
  for (const c of EXPORT_COLLECTIONS) {
    out[c] = profiles.listIn(c).map((item) => {
      const copy = { ...item };
      for (const f of SECRET_FIELDS) if (f in copy) copy[f] = null;
      return copy;
    });
  }
  out.mounts = profiles.mounts();
  out.alertRules = profiles.alertRules().map((r) => ({ ...r, webhookUrl: r.webhookUrl || null }));
  res.setHeader('Content-Disposition', 'attachment; filename="manifold-config.json"');
  res.json(out);
});

// POST /api/system/config/import — merge by id (existing ids are overwritten,
// everything else is left alone; nothing is deleted)
router.post('/config/import', (req, res) => {
  const { profiles } = req.app.locals.services;
  const body = req.body || {};
  if (body.manifoldConfig !== 1) {
    return res.status(400).json({ error: 'not a Manifold config export (missing manifoldConfig: 1)' });
  }
  const imported = {};
  for (const c of EXPORT_COLLECTIONS) {
    if (!Array.isArray(body[c])) continue;
    let n = 0;
    for (const item of body[c]) {
      if (!item || !item.id) continue;
      // keep an existing stored secret if the import carries none
      const existing = profiles.getIn(c, item.id);
      const merged = { ...item };
      for (const f of SECRET_FIELDS) {
        if ((merged[f] === null || merged[f] === undefined) && existing?.[f]) merged[f] = existing[f];
      }
      profiles.upsertIn(c, item.id, merged);
      n++;
    }
    imported[c] = n;
  }
  if (Array.isArray(body.mounts)) {
    for (const m of body.mounts) if (m?.id) profiles.upsertMount(m.id, m);
    imported.mounts = body.mounts.length;
  }
  if (Array.isArray(body.alertRules)) {
    for (const r of body.alertRules) if (r?.id) profiles.upsertAlertRule(r.id, r);
    imported.alertRules = body.alertRules.length;
  }
  res.json({ imported });
});

module.exports = router;

