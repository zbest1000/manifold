'use strict';

/**
 * Shared helpers for the tests that run against the real OPC UA test server:
 * a throwaway MANIFOLD_DATA_DIR (the client PKI lives there), a polling
 * `until`, and a manager with test-sized timings.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function useTempDataDir(prefix = 'manifold-opcua-test-') {
  if (!process.env.MANIFOLD_DATA_DIR) {
    process.env.MANIFOLD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.on('exit', () => fs.rmSync(process.env.MANIFOLD_DATA_DIR, { recursive: true, force: true }));
  }
  return process.env.MANIFOLD_DATA_DIR;
}

/** Poll `fn` until it returns truthy; fail with `what` after `ms`. */
async function until(fn, ms = 10_000, what = 'condition') {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}`);
}

/** Fast timings so reconnect / watchdog paths finish in about a second. */
const FAST = {
  backoff: { initialMs: 50, maxMs: 400 },
  random: () => 1,
  valueFlushMs: 10,
  subscription: { publishingInterval: 100, maxKeepAliveCount: 5, lifetimeCount: 60 },
  watchdogMs: 100,
  sessionTimeoutMs: 20_000
};

function makeIo() {
  const emitted = [];
  const io = { emit: (name, payload) => emitted.push([name, payload]) };
  return { io, emitted };
}

module.exports = { useTempDataDir, until, FAST, makeIo };
