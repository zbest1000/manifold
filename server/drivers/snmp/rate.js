'use strict';

/**
 * Counter -> per-second rate for tags with `rate: true`.
 *
 *  - time base: the agent's sysUpTime (TimeTicks, 1/100 s) read in the same PDU as
 *    the counter, so retries and network delay do not distort the interval; the
 *    local clock is the fallback when sysUpTime is unavailable;
 *  - wrap: Counter32 that went down wraps modulo 2^32, Counter64 modulo 2^64
 *    (RFC 2578 7.1.6 / 7.1.10: counters only increase and wrap);
 *  - reset: sysUpTime going backwards (other than its own 497-day wrap) means the
 *    agent restarted and every counter is a new baseline: that sample is Bad
 *    `counter-reset`, the next one is a rate again;
 *  - the first sample has no interval yet and is Bad `rate-warmup`.
 */

const TWO32 = 2n ** 32n;
const TWO64 = 2n ** 64n;
const TICKS_WRAP = 4294967296;

class RateTracker {
  constructor() {
    this.state = new Map(); // key -> { raw: bigint, up: number|null, at: number }
  }

  reset() {
    this.state.clear();
  }

  /**
   * @param {string} key
   * @param {'Counter32'|'Counter64'|string} type SNMP type the agent returned
   * @param {number|bigint} raw
   * @param {number|null} upTime sysUpTime in centiseconds from the same PDU, or null
   * @param {number} now local ms
   * @returns {{v:number|null, q:number, qReason?:string}}
   */
  update(key, type, raw, upTime, now) {
    if (type !== 'Counter32' && type !== 'Counter64') {
      this.state.delete(key);
      return { v: null, q: 0, qReason: 'rate-needs-counter' };
    }
    const cur = BigInt(raw);
    const prev = this.state.get(key);
    const up = Number.isFinite(upTime) ? upTime : null;
    this.state.set(key, { raw: cur, up, at: now });
    if (!prev) return { v: null, q: 0, qReason: 'rate-warmup' };

    let seconds = null;
    if (up !== null && prev.up !== null) {
      let ticks = up - prev.up;
      if (ticks < 0) {
        const wrapped = ticks + TICKS_WRAP;
        const expected = Math.max(0, (now - prev.at) / 10); // local elapsed in ticks
        // A genuine sysUpTime wrap lands close to the locally elapsed time; a restart does not.
        if (Math.abs(wrapped - expected) <= Math.max(expected, 6000)) ticks = wrapped;
        else return { v: null, q: 0, qReason: 'counter-reset' };
      }
      seconds = ticks / 100;
    }
    if (seconds === null || seconds <= 0) seconds = (now - prev.at) / 1000;
    if (!(seconds > 0)) return { v: null, q: 0, qReason: 'rate-interval' };

    let delta = cur - prev.raw;
    if (delta < 0n) delta += type === 'Counter64' ? TWO64 : TWO32;
    return { v: Number(delta) / seconds, q: 192 };
  }
}

module.exports = { RateTracker };
