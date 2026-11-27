const express = require('express');
const router = express.Router();
const { prepareExport, writeCsv } = require('../services/trendsExport');

const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

// GET /api/trends/export.csv?source=live|historian|recording&id=&tag=a&tag=b&unit=V&unit=&from=ms&to=ms&mode=raw|bucketed
// Streams the CSV (see services/trendsExport.js). `tag` and `unit` repeat, in chart order.
router.get('/export.csv', async (req, res) => {
  const { profiles, recorder, mqttManager } = req.app.locals.services;
  const q = req.query;
  let plan;
  try {
    plan = await prepareExport(
      { source: String(q.source || ''), id: String(q.id || ''), tags: list(q.tag), units: list(q.unit), from: Number(q.from), to: Number(q.to), mode: String(q.mode || 'bucketed') },
      { profiles, recorder, mqttManager }
    );
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.message });
  }
  // Pull the first sample before the headers go out, so an unreachable historian is a 502, not a broken file.
  const it = plan.samples[Symbol.asyncIterator] ? plan.samples[Symbol.asyncIterator]() : plan.samples[Symbol.iterator]();
  let first;
  try {
    first = await it.next();
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
  const samples = (async function* () {
    if (first.done) return;
    yield first.value;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  })();
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"`);
  res.setHeader('X-Manifold-Export-Mode', plan.mode);
  res.setHeader('Cache-Control', 'no-store');
  // The client went away (download cancelled): stop reading the source.
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) closed = true;
  });
  const write = (text) =>
    new Promise((resolve) => {
      if (closed || res.write(text)) return resolve();
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
    });
  try {
    await writeCsv({ write, comments: plan.comments, columns: plan.columns, samples, aborted: () => closed });
  } catch (error) {
    // Headers are gone: say so in the file instead of cutting it silently.
    if (!closed) res.write(`# Error: the export stopped early: ${String(error.message).replace(/[\r\n]+/g, ' ')}\n`);
  }
  res.end();
});

module.exports = router;
