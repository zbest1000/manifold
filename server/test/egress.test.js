const { test } = require('node:test');
const assert = require('node:assert');

delete process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;
delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;

const eg = require('../services/egressGuard');

// [address, class] — class as returned by classifyAddress.
const CLASS_TABLE = [
  // IPv4
  ['8.8.8.8', 'public'],
  ['10.1.2.3', 'private'],
  ['172.16.0.1', 'private'],
  ['172.32.0.1', 'public'],
  ['192.168.1.1', 'private'],
  ['127.0.0.1', 'hard-blocked'],
  ['169.254.169.254', 'hard-blocked'],
  ['168.63.129.16', 'hard-blocked'],
  ['100.100.100.200', 'hard-blocked'],
  ['0.0.0.0', 'hard-blocked'],
  ['224.0.0.1', 'hard-blocked'],
  // IPv6 basics
  ['::', 'hard-blocked'],
  ['::1', 'hard-blocked'],
  ['0:0:0:0:0:0:0:1', 'hard-blocked'],
  ['2606:4700:4700::1111', 'public'],
  ['fe80::1', 'hard-blocked'],
  ['febf::1', 'hard-blocked'],
  ['fec0::1', 'hard-blocked'],
  ['ff02::1', 'hard-blocked'],
  ['fc00::1', 'private'],
  ['fd12:3456::1', 'private'],
  ['fd00:ec2::254', 'hard-blocked'], // AWS IPv6 metadata
  ['2001:db8::1', 'hard-blocked'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'hard-blocked'], // Teredo
  // IPv4-mapped: dotted AND hex
  ['::ffff:127.0.0.1', 'hard-blocked'],
  ['::ffff:7f00:1', 'hard-blocked'],
  ['::ffff:a9fe:a9fe', 'hard-blocked'], // 169.254.169.254
  ['::ffff:10.0.0.1', 'private'],
  ['::ffff:a00:1', 'private'],
  ['::ffff:c0a8:101', 'private'], // 192.168.1.1
  ['::ffff:8.8.8.8', 'public'],
  ['::ffff:808:808', 'public'],
  ['0:0:0:0:0:ffff:7f00:1', 'hard-blocked'],
  // SIIT
  ['::ffff:0:7f00:1', 'hard-blocked'],
  ['::ffff:0:808:808', 'public'],
  // IPv4-compatible (deprecated)
  ['::7f00:1', 'hard-blocked'],
  ['::127.0.0.1', 'hard-blocked'],
  ['::808:808', 'hard-blocked'],
  // NAT64
  ['64:ff9b::7f00:1', 'hard-blocked'],
  ['64:ff9b::127.0.0.1', 'hard-blocked'],
  ['64:ff9b::a9fe:a9fe', 'hard-blocked'],
  ['64:ff9b::a00:1', 'private'],
  ['64:ff9b::808:808', 'public'],
  ['64:ff9b:1::808:808', 'hard-blocked'], // local-use /48
  ['64:ff9b:1:2:3:4:5:6', 'hard-blocked'],
  // 6to4
  ['2002:7f00:1::1', 'hard-blocked'],
  ['2002:a9fe:a9fe::1', 'hard-blocked'],
  ['2002:a00:1::1', 'private'],
  ['2002:c0a8:101::', 'private'],
  ['2002:808:808::1', 'public'],
  // zone ids
  ['fe80::1%eth0', 'invalid'] // net.isIP rejects a zone id on the raw string? (see below)
];

test('classifyAddress table (v4 + every v6 form)', () => {
  for (const [ip, expected] of CLASS_TABLE) {
    const actual = eg.classifyAddress(ip);
    // net.isIP accepts zone ids on some Node versions; accept either 'invalid' or the right class
    if (ip.includes('%')) {
      assert.ok(['invalid', 'hard-blocked'].includes(actual), `${ip} -> ${actual}`);
      continue;
    }
    assert.strictEqual(actual, expected, `${ip}`);
  }
});

test('isAllowedAddress: private is opt-in, hard-blocked is never allowed', () => {
  assert.strictEqual(eg.isAllowedAddress('8.8.8.8'), true);
  assert.strictEqual(eg.isAllowedAddress('10.0.0.1'), false);
  assert.strictEqual(eg.isAllowedAddress('::ffff:7f00:1'), false);
  assert.strictEqual(eg.isAllowedAddress('not-an-ip'), false);
  process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS = '1';
  try {
    assert.strictEqual(eg.isAllowedAddress('10.0.0.1'), true);
    assert.strictEqual(eg.isAllowedAddress('::ffff:a00:1'), true);
    assert.strictEqual(eg.isAllowedAddress('fd00::1'), true);
    assert.strictEqual(eg.isAllowedAddress('127.0.0.1'), false);
    assert.strictEqual(eg.isAllowedAddress('169.254.169.254'), false);
  } finally {
    delete process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;
  }
});

test('device targets: loopback only with MANIFOLD_ALLOW_LOOPBACK_DEVICES; metadata never; private still needs its own flag', async () => {
  const blocked = (p) => assert.rejects(p, (e) => e.code === 'EGRESS_BLOCKED');
  // default: everything blocked
  await blocked(eg.assertAllowedDeviceTarget('127.0.0.1'));
  await blocked(eg.assertAllowedDeviceTarget('opc.tcp://[::1]:4840'));

  process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
  try {
    await eg.assertAllowedDeviceTarget('127.0.0.1');
    await eg.assertAllowedDeviceTarget('127.0.0.1:502');
    await eg.assertAllowedDeviceTarget('opc.tcp://[::1]:4840');
    await eg.assertAllowedDeviceTarget('::ffff:7f00:1');
    await blocked(eg.assertAllowedDeviceTarget('169.254.169.254'));
    await blocked(eg.assertAllowedDeviceTarget('::ffff:a9fe:a9fe'));
    await blocked(eg.assertAllowedDeviceTarget('fd00:ec2::254'));
    await blocked(eg.assertAllowedDeviceTarget('10.0.0.5')); // private needs ALLOW_PRIVATE
    // the generic (non-device) helper never relaxes loopback
    await blocked(eg.assertAllowedTarget('127.0.0.1', { purpose: 'historian' }));
    await blocked(eg.assertAllowedTarget('http://localhost:8086'));
  } finally {
    delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  }
});

test('assertAllowedTarget: parses URLs / host:port, names the purpose, checks resolved names', async () => {
  const lookup = async (host) => (host === 'evil.example' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  await eg.assertAllowedTarget('https://ok.example:8086/write', { lookup });
  await eg.assertAllowedTarget('ok.example:5432', { lookup });
  await assert.rejects(eg.assertAllowedTarget('http://evil.example/x', { purpose: 'historian', lookup }), /\(historian\).*blocked/);
  await assert.rejects(eg.assertAllowedTarget('', { lookup }), (e) => e.code === 'EGRESS_BLOCKED');
  assert.strictEqual(eg.hostFromTarget('[::1]:1883'), '::1');
  assert.strictEqual(eg.hostFromTarget('broker.local:1883'), 'broker.local');
  assert.strictEqual(eg.hostFromTarget('opc.tcp://plc:4840/x'), 'plc');
});

function fakeRes(status, location) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location || null : null) },
    body: { cancel: async () => {} }
  };
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('guardedFetch re-validates every redirect hop', async () => {
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push([url, opts.redirect]);
    return url.startsWith('http://good.example/') ? fakeRes(302, 'http://169.254.169.254/latest/meta-data/') : fakeRes(200);
  };
  await assert.rejects(eg.guardedFetch('http://good.example/hook', {}, 5000, { fetch, lookup: publicLookup }), (e) => e.code === 'EGRESS_BLOCKED');
  assert.strictEqual(seen.length, 1, 'the metadata hop must never be fetched');
  assert.strictEqual(seen[0][1], 'manual');
});

test('guardedFetch follows safe redirects, resolves relative Location, drops body/credentials as appropriate', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, ...opts });
    if (calls.length === 1) return fakeRes(302, '/next');
    if (calls.length === 2) return fakeRes(307, 'https://other.example/final');
    return fakeRes(200);
  };
  const res = await eg.guardedFetch(
    'http://a.example/start',
    { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer x' } },
    5000,
    { fetch, lookup: publicLookup }
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[1].url, 'http://a.example/next');
  assert.strictEqual(calls[1].method, 'GET'); // 302 on POST -> GET
  assert.strictEqual(calls[1].body, undefined);
  assert.strictEqual(calls[1].headers.authorization, 'Bearer x'); // same origin keeps it
  assert.strictEqual(calls[2].url, 'https://other.example/final');
  assert.strictEqual(calls[2].headers.authorization, undefined); // cross-origin drops it
});

test('guardedFetch bounds redirect hops', async () => {
  let n = 0;
  const fetch = async () => {
    n++;
    return fakeRes(302, `http://a.example/${n}`);
  };
  await assert.rejects(eg.guardedFetch('http://a.example/0', {}, 5000, { fetch, lookup: publicLookup }), /too many redirects/);
  assert.strictEqual(n, eg.MAX_REDIRECTS + 1);
});

test('connect-time pinned lookup re-validates the addresses the socket would use', async () => {
  const call = (host, opts) => new Promise((resolve) => eg._pinnedLookup(host, opts, (err) => resolve(err)));
  assert.strictEqual((await call('localhost', {}))?.code, 'EGRESS_BLOCKED');
  assert.strictEqual((await call('localhost', { all: true }))?.code, 'EGRESS_BLOCKED');
});

test('guardedFetch rejects non-http schemes and literal metadata IPs without fetching', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return fakeRes(200);
  };
  await assert.rejects(eg.guardedFetch('file:///etc/passwd', {}, 1000, { fetch }), (e) => e.code === 'EGRESS_BLOCKED');
  await assert.rejects(eg.guardedFetch('http://[::ffff:a9fe:a9fe]/', {}, 1000, { fetch }), (e) => e.code === 'EGRESS_BLOCKED');
  assert.strictEqual(called, false);
});
