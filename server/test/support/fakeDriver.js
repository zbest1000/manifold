'use strict';

/**
 * Fake driver module (contract: docs/design/southbound-drivers.md 4.1), used by
 * driver-supervisor.test.js through the real host process. Behaviour is
 * controlled by device.fake:
 *   failConnect: true          connect() throws
 *   values: { key: value }     value returned for a tag (default: incrementing counter)
 *   crashAfterMs: n            process.exit(1) n ms after createDriver
 *   crashOnceFile: path        only crash if this file does not exist yet (creates it)
 *   hangAfterMs: n             block the event loop n ms after createDriver
 *   throwOnCreate: true        createDriver throws (invalid config)
 *   intervalExecuteMs: n       delay inside execute
 */

const fs = require('fs');

function createDriver(device) {
  const f = device.fake || {};
  if (f.throwOnCreate) throw new Error('invalid tags: fake config rejected');
  if (f.crashAfterMs !== undefined) {
    let crash = true;
    if (f.crashOnceFile) {
      if (fs.existsSync(f.crashOnceFile)) crash = false;
      else fs.writeFileSync(f.crashOnceFile, '1');
    }
    if (crash) setTimeout(() => process.exit(1), f.crashAfterMs);
  }
  if (f.hangAfterMs !== undefined) {
    setTimeout(() => {
      for (;;) {
        /* block the event loop forever */
      }
    }, f.hangAfterMs);
  }
  let connected = false;
  let n = 0;
  return {
    protocol: 'fake',
    capabilities: { browse: false, subscribe: false, maxInFlight: 1 },
    async connect() {
      if (f.failConnect) throw new Error('connection refused (fake)');
      connected = true;
      return { fake: true, id: device.id };
    },
    isConnected: () => connected,
    plan(keys) {
      const ks = keys || (device.tags || []).map((t) => t.key);
      return ks.length ? [{ id: 'r0', items: ks.map((key) => ({ key })) }] : [];
    },
    async execute(req) {
      if (f.intervalExecuteMs) await new Promise((r) => setTimeout(r, f.intervalExecuteMs));
      n++;
      return {
        ok: true,
        results: req.items.map((it) => ({
          key: it.key,
          v: f.values && it.key in f.values ? f.values[it.key] : n,
          type: 'int32',
          q: 192
        }))
      };
    },
    bisect: () => null,
    async probe(args) {
      return { echo: args, device: device.id };
    },
    async close() {
      connected = false;
    }
  };
}

module.exports = { protocol: 'fake', createDriver };
