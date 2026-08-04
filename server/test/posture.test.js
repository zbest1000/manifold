const { test } = require('node:test');
const assert = require('node:assert');

const { assess, isInternalHost, CERT_WARN_DAYS } = require('../services/brokerPosture');
const MqttManager = require('../services/mqttManager');

const DAY_MS = 24 * 60 * 60 * 1000;

test('plaintext transport to an external broker is a high finding with a low grade', () => {
  const r = assess({ protocol: 'mqtt', host: 'broker.emqx.io', port: 1883, username: null });
  const plaintext = r.findings.find((f) => f.id === 'plaintext-transport');
  assert.ok(plaintext, 'plaintext-transport finding expected');
  assert.strictEqual(plaintext.severity, 'high');
  assert.ok(plaintext.fix.includes('mqtts://'), 'fix should point at TLS');
  // 100 - 35 (plaintext) - 12 (anonymous) = 53 → D
  assert.strictEqual(r.score, 53);
  assert.strictEqual(r.grade, 'D');
  const anon = r.findings.find((f) => f.id === 'anonymous');
  assert.strictEqual(anon.severity, 'medium');
});

test('mqtts with CA verification and credentials grades A with no findings', () => {
  const r = assess({
    protocol: 'mqtts',
    host: 'broker.example.com',
    port: 8883,
    username: 'ops',
    mqttVersion: 5,
    rejectUnauthorized: true
  });
  assert.strictEqual(r.grade, 'A');
  assert.strictEqual(r.score, 100);
  assert.deepStrictEqual(r.findings, []);
});

test('rejectUnauthorized: false on TLS is flagged high and caps the grade at C', () => {
  const r = assess({
    protocol: 'mqtts',
    host: 'broker.example.com',
    port: 8883,
    username: 'ops',
    rejectUnauthorized: false
  });
  const f = r.findings.find((x) => x.id === 'tls-no-verify');
  assert.ok(f, 'tls-no-verify finding expected');
  assert.strictEqual(f.severity, 'high');
  assert.match(f.detail, /MITM/);
  assert.strictEqual(r.score, 70);
  assert.strictEqual(r.grade, 'C', 'a high finding must never grade above C');
});

test('expired peer certificate is flagged high; expiring-soon is medium', () => {
  const base = { protocol: 'mqtts', host: 'broker.example.com', port: 8883, username: 'ops', rejectUnauthorized: true };

  const expired = assess(base, {
    peerCert: { subject: { CN: 'broker.example.com' }, valid_to: new Date(Date.now() - DAY_MS).toUTCString() }
  });
  const fExpired = expired.findings.find((f) => f.id === 'cert-expired');
  assert.ok(fExpired, 'cert-expired finding expected');
  assert.strictEqual(fExpired.severity, 'high');
  assert.strictEqual(expired.grade, 'C');

  const expiring = assess(base, {
    peerCert: { subject: { CN: 'broker.example.com' }, valid_to: new Date(Date.now() + 10 * DAY_MS).toUTCString() }
  });
  const fExpiring = expiring.findings.find((f) => f.id === 'cert-expiring');
  assert.ok(fExpiring, 'cert-expiring finding expected');
  assert.strictEqual(fExpiring.severity, 'medium');
  assert.match(fExpiring.title, /9 days|10 days/);
  assert.strictEqual(expiring.grade, 'B');

  // Comfortably valid cert → clean
  const fine = assess(base, {
    peerCert: { subject: { CN: 'broker.example.com' }, valid_to: new Date(Date.now() + (CERT_WARN_DAYS + 60) * DAY_MS).toUTCString() }
  });
  assert.strictEqual(fine.grade, 'A');
  assert.deepStrictEqual(fine.findings, []);
});

test('internal hosts soften plaintext + anonymous to info notes (grade A)', () => {
  // Compose service name (the demo's in-cluster brokers) and localhost.
  for (const host of ['mqtt', 'mqtt2', 'localhost', '127.0.0.1', 'host.docker.internal']) {
    const r = assess({ protocol: 'mqtt', host, port: 1883, username: null });
    assert.strictEqual(r.grade, 'A', `${host} should grade A`);
    assert.strictEqual(r.score, 100);
    assert.ok(r.findings.every((f) => f.severity === 'info'), `${host} findings must all be info`);
    assert.ok(r.findings.some((f) => f.id === 'plaintext-internal'), `${host} should carry the plaintext info note`);
    assert.ok(r.findings.some((f) => f.id === 'anonymous-internal'), `${host} should carry the anonymous info note`);
  }
  assert.strictEqual(isInternalHost('broker.emqx.io'), false);
  assert.strictEqual(isInternalHost('192.168.1.50'), false, 'LAN IPs are NOT internal — plaintext there is real');
});

test('credentials over plaintext grade worse than anonymous plaintext', () => {
  const anonymous = assess({ protocol: 'mqtt', host: 'broker.emqx.io', port: 1883 });
  const withCreds = assess({ protocol: 'mqtt', host: 'broker.emqx.io', port: 1883, username: 'plant-user' });

  const f = withCreds.findings.find((x) => x.id === 'credentials-over-plaintext');
  assert.ok(f, 'credentials-over-plaintext finding expected');
  assert.strictEqual(f.severity, 'high');
  assert.ok(
    withCreds.score < anonymous.score,
    `credentials in the clear (${withCreds.score}) must score below anonymous plaintext (${anonymous.score})`
  );
  assert.strictEqual(withCreds.grade, 'D');
});

test('ws counts as plaintext; wss counts as TLS', () => {
  const ws = assess({ protocol: 'ws', host: 'broker.example.com', port: 8083, username: 'u' });
  assert.ok(ws.findings.some((f) => f.id === 'plaintext-transport'));
  assert.ok(ws.findings.some((f) => f.id === 'credentials-over-plaintext'));

  const wss = assess({ protocol: 'wss', host: 'broker.example.com', port: 8084, username: 'u', rejectUnauthorized: true });
  assert.strictEqual(wss.grade, 'A');
});

test('legacy MQTT 3.1 protocol level is flagged medium', () => {
  const r = assess({ protocol: 'mqtts', host: 'broker.example.com', username: 'u', rejectUnauthorized: true, mqttVersion: 3 });
  const f = r.findings.find((x) => x.id === 'legacy-protocol');
  assert.ok(f, 'legacy-protocol finding expected');
  assert.strictEqual(f.severity, 'medium');
  // Levels 4 and 5 are fine.
  for (const v of [4, 5]) {
    const ok = assess({ protocol: 'mqtts', host: 'broker.example.com', username: 'u', rejectUnauthorized: true, mqttVersion: v });
    assert.ok(!ok.findings.some((x) => x.id === 'legacy-protocol'));
  }
});

test('broker admin API over http:// is medium externally, info internally, silent on https', () => {
  const base = { protocol: 'mqtts', host: 'broker.example.com', username: 'u', rejectUnauthorized: true };

  const external = assess(base, { adminConfig: { configured: true, type: 'emqx', url: 'http://emqx.example.com:18083' } });
  const f = external.findings.find((x) => x.id === 'admin-http');
  assert.ok(f, 'admin-http finding expected');
  assert.strictEqual(f.severity, 'medium');
  assert.strictEqual(external.grade, 'B'); // 100 - 12 = 88

  const internal = assess(base, { adminConfig: { configured: true, type: 'emqx', url: 'http://localhost:18083' } });
  assert.ok(internal.findings.some((x) => x.id === 'admin-http-internal' && x.severity === 'info'));
  assert.strictEqual(internal.grade, 'A');

  const https = assess(base, { adminConfig: { configured: true, type: 'emqx', url: 'https://emqx.example.com:18084' } });
  assert.deepStrictEqual(https.findings, []);

  const unconfigured = assess(base, { adminConfig: { configured: false } });
  assert.deepStrictEqual(unconfigured.findings, []);
});

test('getTransportSecurity reads TLS options + peer cert off the live client, read-only', () => {
  const m = new MqttManager({ emit() {} });
  m.clients.set('bT', {
    end() {}, // shutdown() tears fakes down like real clients
    options: { rejectUnauthorized: false },
    stream: {
      authorized: false,
      getPeerCertificate: () => ({
        subject: { CN: 'broker.example.com' },
        issuer: { CN: 'Test CA' },
        valid_from: 'Jan  1 00:00:00 2026 GMT',
        valid_to: 'Jan  1 00:00:00 2027 GMT',
        fingerprint256: 'AB:CD',
        raw: Buffer.alloc(1024) // must NOT be forwarded
      })
    }
  });
  const t = m.getTransportSecurity('bT');
  assert.strictEqual(t.rejectUnauthorized, false);
  assert.strictEqual(t.authorized, false);
  assert.strictEqual(t.peerCert.subject.CN, 'broker.example.com');
  assert.strictEqual(t.peerCert.valid_to, 'Jan  1 00:00:00 2027 GMT');
  assert.strictEqual(t.peerCert.raw, undefined, 'raw cert buffers must be projected away');

  // Plaintext client: no getPeerCertificate anywhere → cert stays null.
  m.clients.set('bP', { end() {}, options: { rejectUnauthorized: true }, stream: {} });
  const p = m.getTransportSecurity('bP');
  assert.strictEqual(p.rejectUnauthorized, true);
  assert.strictEqual(p.peerCert, null);

  assert.strictEqual(m.getTransportSecurity('missing'), null);
  m.shutdown();
});
