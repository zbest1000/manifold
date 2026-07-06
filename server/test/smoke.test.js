const request = require('supertest');
const { app } = require('../index');

// Boot smoke test: every route below regressed at some point in the audit
// (missing modules, the isScanning collision, phantom methods). This pins the
// happy path so those classes of failure are caught in CI.
describe('server smoke test', () => {
  it('GET /health returns healthy (public)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  it('GET /api/status returns 200 in open mode (no APP_ACCESS_TOKEN)', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.server).toBe('running');
  });

  it('GET /api/metrics returns 200 (exercises networkScanner.isScanning)', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
  });

  it('GET /api/ai/suggestions returns 200 (previously a phantom method)', async () => {
    const res = await request(app).get('/api/ai/suggestions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  it('POST /api/mqtt/connect rejects a malformed target', async () => {
    const res = await request(app).post('/api/mqtt/connect').send({ host: 'bad host!', port: 1883 });
    expect(res.status).toBe(500);
  });
});
