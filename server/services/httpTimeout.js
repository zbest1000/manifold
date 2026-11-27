'use strict';

/**
 * fetch with a hard deadline. A dead-but-listening peer (TCP accepts, never
 * responds) hangs a plain fetch forever — every outbound HTTP call in the
 * server goes through here so a peer outage becomes an error, never a hang.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return 'the server';
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      // Name the origin only: a URL's path and query can be the credential (webhook paths, ?token=).
      throw new Error(`request to ${originOf(url)} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
