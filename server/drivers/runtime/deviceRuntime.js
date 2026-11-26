'use strict';

/**
 * DeviceRuntime: protocol-agnostic runtime for ONE device (see
 * docs/design/southbound-drivers.md sections 3, 4.1-4.3).
 *
 * Owns the connection state machine (connecting -> online -> backoff -> ...),
 * the poll scheduler (one cycle per group, overruns skipped never queued, all
 * groups sharing the device's single connection one request at a time),
 * bisect/quarantine, per-unit circuit breakers and adaptive slowdown.
 * It never throws into its caller: a misbehaving driver is a fatal transport
 * error, which means close, mark every tag Bad and reconnect with backoff.
 */

const Q_BAD = 0;

function errMsg(e) {
  return e && e.message ? String(e.message) : String(e);
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    now: () => Date.now()
  };
}

class DeviceRuntime {
  constructor(opts) {
    const o = opts || {};
    this.device = o.device;
    this.driver = o.driver;
    this.deviceId = this.device.id;
    this._onSamples = o.onSamples || (() => {});
    this._onState = o.onState || (() => {});
    this._timers = Object.assign(defaultTimers(), o.timers || {});
    this._random = o.random || Math.random;
    this._backoff = Object.assign({ initialMs: 1000, maxMs: 60000 }, o.backoff || {});
    this._opt = Object.assign(
      {
        quarantineRetryMs: 60000,
        unitProbeMs: 30000,
        unitFailThreshold: 3,
        stopWaitMs: 2000,
        startDelayMs: 0,
        slowdownAfter: 5,
        restoreAfter: 20,
        maxMultiplier: 8
      },
      o.options || {}
    );
    const lim = this.device.limits || {};
    this.limits = {
      requestDeadlineMs: lim.requestDeadlineMs || 2000,
      connectTimeoutMs: lim.connectTimeoutMs || 5000,
      interRequestDelayMs: lim.interRequestDelayMs || 0
    };

    this._timerSet = new Set();
    this._gen = 0;
    this._phase = 'idle';
    this._lastState = null;
    this._since = this._now();
    this._lastError = null;
    this._attempt = 0;
    this._started = false;
    this._stopping = false;
    this._lock = Promise.resolve();
    this._inflight = null;
    this._nextAllowed = 0;
    this._backoffTimer = null;
    this._quarantine = new Map(); // key -> { since, nextTry, code, message }
    this._units = new Map(); // unitId -> { fails, open, lastProbe, emitted:Set }
    this._lastSampleAt = null;

    this.stats = { connects: 0, requests: 0, timeouts: 0, exceptions: {} };

    this._tags = new Map();
    this._groups = new Map();
    this._buildGroups();
  }

  // ---------------------------------------------------------------- setup

  _buildGroups() {
    const defs =
      Array.isArray(this.device.pollGroups) && this.device.pollGroups.length
        ? this.device.pollGroups
        : [{ id: 'default', intervalMs: 1000 }];
    for (const d of defs) {
      this._groups.set(d.id, this._newGroup(d.id, d.intervalMs));
    }
    for (const tag of this.device.tags || []) {
      let gid = tag.pollGroup || 'default';
      if (!this._groups.has(gid)) {
        if (!this._groups.has('default')) this._groups.set('default', this._newGroup('default', 1000));
        gid = 'default';
      }
      this._tags.set(tag.key, tag);
      this._groups.get(gid).keys.push(tag.key);
    }
  }

  _newGroup(id, intervalMs) {
    return {
      id,
      intervalMs: intervalMs > 0 ? intervalMs : 1000,
      mult: 1,
      keys: [],
      plan: null,
      timer: null,
      due: 0,
      running: false,
      overruns: 0,
      cycles: 0,
      overrunCycles: 0,
      cleanCycles: 0,
      lastCycleMs: 0,
      cycleTimes: []
    };
  }

  // ---------------------------------------------------------------- timers

  _now() {
    return this._timers.now();
  }

  _setTimer(fn, ms) {
    const entry = { handle: null };
    entry.handle = this._timers.setTimeout(() => {
      this._timerSet.delete(entry);
      try {
        fn();
      } catch (_) {
        /* never throw from a timer */
      }
    }, Math.max(0, ms));
    if (entry.handle && typeof entry.handle.unref === 'function') entry.handle.unref();
    this._timerSet.add(entry);
    return entry;
  }

  _clearTimer(entry) {
    if (!entry) return;
    this._timerSet.delete(entry);
    try {
      this._timers.clearTimeout(entry.handle);
    } catch (_) {
      /* ignore */
    }
  }

  /** Number of live timers (test hook). */
  pendingTimers() {
    return this._timerSet.size;
  }

  _sleep(ms) {
    return new Promise((resolve) => this._setTimer(resolve, ms));
  }

  /** Run fn(), rejecting if it does not settle within ms. Sync throws become rejections. */
  _race(fn, ms, label) {
    return new Promise((resolve, reject) => {
      const t = this._setTimer(() => reject(new Error(`${label} watchdog timeout`)), ms);
      let p;
      try {
        p = Promise.resolve(fn());
      } catch (e) {
        this._clearTimer(t);
        reject(e);
        return;
      }
      p.then(
        (v) => {
          this._clearTimer(t);
          resolve(v);
        },
        (e) => {
          this._clearTimer(t);
          reject(e);
        }
      );
    });
  }

  // ---------------------------------------------------------------- events

  _emitState(state, reason) {
    if (state === this._lastState) return;
    this._lastState = state;
    this._since = this._now();
    try {
      this._onState({
        deviceId: this.deviceId,
        state,
        phase: this._phase,
        reason: reason || null,
        since: this._since
      });
    } catch (_) {
      /* consumer errors are not ours */
    }
  }

  _emitSamples(group, samples) {
    if (!samples.length) return;
    const tRead = this._now();
    this._lastSampleAt = tRead;
    try {
      this._onSamples({ deviceId: this.deviceId, group, tRead, samples });
    } catch (_) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this._started) return;
    this._started = true;
    this._phase = 'connecting';
    this._emitState('offline', 'connecting');
    if (this._opt.startDelayMs > 0) {
      this._backoffTimer = this._setTimer(() => {
        this._backoffTimer = null;
        this._connect();
      }, this._opt.startDelayMs);
    } else {
      this._connect();
    }
  }

  async stop() {
    if (this._stopping) return;
    this._stopping = true;
    const wasOnline = this._phase === 'online';
    this._gen++;
    this._clearTimer(this._backoffTimer);
    this._backoffTimer = null;
    for (const g of this._groups.values()) {
      this._clearTimer(g.timer);
      g.timer = null;
    }
    this._phase = 'stopped';
    if (wasOnline) this._emitDisconnected();
    // Bounded wait for the in-flight request to drain.
    const inflight = this._inflight;
    if (inflight) {
      await this._race(() => inflight.catch(() => {}), this._opt.stopWaitMs, 'stop').catch(() => {});
    }
    try {
      await this._race(() => this.driver.close(), this._opt.stopWaitMs, 'close');
    } catch (_) {
      /* best effort */
    }
    this._emitState('offline', 'stopped');
    for (const e of Array.from(this._timerSet)) this._clearTimer(e);
  }

  async _connect() {
    if (this._stopping) return;
    const gen = ++this._gen;
    this._phase = 'connecting';
    let info;
    try {
      info = await this._race(
        () => this.driver.connect(),
        this.limits.connectTimeoutMs + Math.max(250, this.limits.connectTimeoutMs * 0.5),
        'connect'
      );
      if (
        gen === this._gen &&
        !this._stopping &&
        typeof this.driver.isConnected === 'function' &&
        !this.driver.isConnected()
      ) {
        throw new Error('driver reports not connected after connect()');
      }
    } catch (e) {
      await this._fail(gen, `connect failed: ${errMsg(e)}`);
      return;
    }
    if (gen !== this._gen || this._stopping) {
      try {
        await this.driver.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    this.info = info;
    this.stats.connects++;
    this._phase = 'online';
    this._lastError = null;
    this._units.clear();
    this._nextAllowed = 0;
    this._emitState('online', 'connected');
    const now = this._now();
    for (const g of this._groups.values()) {
      g.plan = null;
      g.running = false;
      if (!g.keys.length) continue;
      g.due = now;
      this._tick(g);
    }
  }

  /** Connection is gone (fatal result, failed connect, driver misbehaviour). */
  async _fail(gen, reason) {
    if (gen !== this._gen || this._stopping) return;
    this._gen++;
    const wasOnline = this._phase === 'online';
    this._phase = 'backoff';
    this._lastError = reason;
    for (const g of this._groups.values()) {
      this._clearTimer(g.timer);
      g.timer = null;
    }
    if (wasOnline) this._emitDisconnected();
    this._emitState('offline', reason);
    try {
      await this._race(() => this.driver.close(), this._opt.stopWaitMs, 'close');
    } catch (_) {
      /* ignore */
    }
    if (this._stopping) return;
    const n = this._attempt++;
    const base = Math.min(this._backoff.maxMs, this._backoff.initialMs * Math.pow(2, Math.min(n, 30)));
    const delay = Math.round(base * (0.5 + 0.5 * this._random()));
    this._backoffTimer = this._setTimer(() => {
      this._backoffTimer = null;
      this._connect();
    }, delay);
  }

  _emitDisconnected() {
    for (const g of this._groups.values()) {
      if (!g.keys.length) continue;
      const tRead = this._now();
      this._emitSamples(
        g.id,
        g.keys.map((key) => this._bad(key, 'disconnected', tRead))
      );
    }
  }

  _bad(key, qReason, tRead) {
    const tag = this._tags.get(key) || {};
    return { key, v: null, type: tag.type || 'unknown', q: Q_BAD, qReason, tRead };
  }

  // ---------------------------------------------------------------- scheduler

  _alive(gen) {
    return gen === this._gen && this._phase === 'online' && !this._stopping;
  }

  _effective(g) {
    return g.intervalMs * g.mult;
  }

  _tick(g) {
    if (this._phase !== 'online' || this._stopping) return;
    const now = this._now();
    const eff = this._effective(g);
    let next = g.due + eff;
    if (next <= now) next = now + eff;
    g.due = next;
    g.timer = this._setTimer(() => {
      g.timer = null;
      this._tick(g);
    }, next - now);
    if (g.running) {
      g.overruns++;
      return;
    }
    if (typeof this.driver.isConnected === 'function' && this.driver.isConnected() === false) {
      this._fail(this._gen, 'connection lost').catch(() => {});
      return;
    }
    this._cycle(g, this._gen).catch(() => {});
  }

  async _cycle(g, gen) {
    g.running = true;
    const start = this._now();
    const samples = [];
    let ok = true;
    try {
      const reqs = this._planFor(g);
      for (const req of reqs) {
        if (!this._alive(gen)) return;
        await this._process(req, samples, gen);
      }
      if (this._alive(gen)) await this._retryQuarantined(g, samples, gen);
    } catch (e) {
      ok = false;
      await this._fail(gen, `driver error: ${errMsg(e)}`);
    } finally {
      g.running = false;
    }
    if (!ok || !this._alive(gen)) return;
    const dur = this._now() - start;
    this._recordCycle(g, dur);
    this._emitSamples(g.id, samples);
  }

  _recordCycle(g, dur) {
    g.cycles++;
    g.lastCycleMs = dur;
    g.cycleTimes.push(dur);
    if (g.cycleTimes.length > 20) g.cycleTimes.shift();
    const eff = this._effective(g);
    if (dur > eff) {
      g.cleanCycles = 0;
      g.overrunCycles++;
      if (g.overrunCycles >= this._opt.slowdownAfter && g.mult < this._opt.maxMultiplier) {
        g.mult = Math.min(this._opt.maxMultiplier, g.mult * 2);
        g.overrunCycles = 0;
      }
    } else {
      g.overrunCycles = 0;
      // "Clean" also has to fit the next-faster interval, so we do not flap.
      if (g.mult > 1 && dur <= eff / 2) {
        g.cleanCycles++;
        if (g.cleanCycles >= this._opt.restoreAfter) {
          g.mult = Math.max(1, g.mult / 2);
          g.cleanCycles = 0;
        }
      } else {
        g.cleanCycles = 0;
      }
    }
  }

  _planFor(g) {
    if (!g.plan) {
      const keys = g.keys.filter((k) => !this._quarantine.has(k));
      g.plan = keys.length ? this.driver.plan(keys) || [] : [];
    }
    return g.plan;
  }

  // ---------------------------------------------------------------- requests

  /**
   * Execute one request, strictly serialised across all groups. Returns
   * { aborted:true } when the connection generation changed or the result was
   * fatal (the fatal path is handled here), else the driver's ok/exception result.
   */
  _exec(req, gen) {
    const run = async () => {
      if (!this._alive(gen)) return { aborted: true };
      const gap = this._nextAllowed - this._now();
      if (gap > 0) {
        await this._sleep(gap);
        if (!this._alive(gen)) return { aborted: true };
      }
      this.stats.requests++;
      const deadline = this.limits.requestDeadlineMs;
      let res;
      try {
        res = await this._race(
          () => this.driver.execute(req, deadline),
          deadline + Math.max(250, deadline * 0.5),
          'execute'
        );
      } catch (e) {
        res = {
          ok: false,
          kind: /watchdog/.test(errMsg(e)) ? 'timeout' : 'transport',
          fatal: true,
          message: errMsg(e)
        };
      }
      this._nextAllowed = this._now() + this.limits.interRequestDelayMs;
      if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') {
        res = { ok: false, kind: 'framing', fatal: true, message: 'driver returned a malformed result' };
      }
      if (!this._alive(gen)) return { aborted: true };
      if (res.ok === false && (res.fatal || res.kind !== 'exception')) {
        if (res.kind === 'timeout') this.stats.timeouts++;
        await this._fail(gen, `${res.kind || 'transport'}: ${res.message || 'fatal'}`);
        return { aborted: true };
      }
      return res;
    };
    const p = this._lock.then(run, run);
    this._lock = p.then(
      () => {},
      () => {}
    );
    this._inflight = p;
    return p;
  }

  _countException(res) {
    const code = res.code === undefined ? 'unknown' : String(res.code);
    this.stats.exceptions[code] = (this.stats.exceptions[code] || 0) + 1;
  }

  _pushResults(res, samples) {
    const tRead = this._now();
    for (const r of res.results || []) {
      const s = { key: r.key, v: r.v, type: r.type, q: r.q, tRead };
      if (r.qReason) s.qReason = r.qReason;
      if (r.tSource !== undefined) s.tSource = r.tSource; // a driver's own source timestamp (ms), e.g. MTConnect
      samples.push(s);
    }
  }

  async _process(req, samples, gen) {
    const unit = req.unitId;
    const hasUnit = unit !== undefined && unit !== null;
    let br = null;
    if (hasUnit) {
      br = this._units.get(unit) || null;
      if (br && br.open) {
        if (this._now() - br.lastProbe < this._opt.unitProbeMs) {
          for (const it of req.items) {
            if (!br.emitted.has(it.key)) {
              br.emitted.add(it.key);
              samples.push(this._bad(it.key, 'unit-down', this._now()));
            }
          }
          return;
        }
        br.lastProbe = this._now();
      }
    }
    const res = await this._exec(req, gen);
    if (res.aborted) return;
    if (res.ok) {
      this._attempt = 0;
      if (hasUnit) this._units.delete(unit);
      this._pushResults(res, samples);
      return;
    }
    this._countException(res);
    const tRead = this._now();
    const cls = res.classification;
    if (cls === 'permanent') {
      if (req.items.length > 1) {
        const halves = this.driver.bisect(req);
        if (Array.isArray(halves) && halves.length) {
          for (const h of halves) {
            if (!this._alive(gen)) return;
            await this._process(h, samples, gen);
          }
          return;
        }
      }
      for (const it of req.items) this._quarantineKey(it.key, res, samples);
    } else if ((cls === 'unit-down' || cls === 'gateway') && hasUnit) {
      let b = this._units.get(unit);
      if (!b) {
        b = { fails: 0, open: false, lastProbe: 0, emitted: new Set() };
        this._units.set(unit, b);
      }
      if (b.open) {
        b.lastProbe = this._now();
        return;
      }
      b.fails++;
      if (b.fails >= this._opt.unitFailThreshold) {
        b.open = true;
        b.lastProbe = this._now();
        for (const it of req.items) b.emitted.add(it.key);
      }
      for (const it of req.items) samples.push(this._bad(it.key, 'unit-down', tRead));
    } else {
      for (const it of req.items) samples.push(this._bad(it.key, 'device-exception', tRead));
    }
  }

  _quarantineKey(key, res, samples) {
    if (this._quarantine.has(key)) return;
    const now = this._now();
    this._quarantine.set(key, {
      since: now,
      nextTry: now + this._opt.quarantineRetryMs,
      code: res.code,
      message: res.message
    });
    // The reason (e.g. "PUT/GET not permitted") must reach the operator, not
    // only the probe panel.
    this._lastError = `tag ${key}: ${res.message || res.name || `error ${res.code}`}`;
    samples.push(this._bad(key, 'quarantined', now));
    for (const g of this._groups.values()) if (g.keys.includes(key)) g.plan = null;
  }

  async _retryQuarantined(g, samples, gen) {
    if (!this._quarantine.size) return;
    for (const key of g.keys) {
      const q = this._quarantine.get(key);
      if (!q || q.nextTry > this._now()) continue;
      const reqs = this.driver.plan([key]) || [];
      let good = reqs.length > 0;
      const got = [];
      for (const r of reqs) {
        if (!this._alive(gen)) return;
        const res = await this._exec(r, gen);
        if (res.aborted) return;
        if (!res.ok) {
          good = false;
          this._countException(res);
          break;
        }
        this._pushResults(res, got);
      }
      if (good) {
        this._quarantine.delete(key);
        g.plan = null;
        for (const s of got) samples.push(s);
      } else {
        q.nextTry = this._now() + this._opt.quarantineRetryMs;
      }
    }
  }

  // ---------------------------------------------------------------- probe / status

  /** Browse the device's own tag namespace (drivers with capabilities.browse). */
  async browse(node) {
    if (typeof this.driver.browse !== 'function') throw new Error('this driver cannot browse');
    if (this._phase !== 'online') throw new Error('device is offline');
    const gen = this._gen;
    const run = async () => {
      if (!this._alive(gen)) throw new Error('device is offline');
      return this._race(() => this.driver.browse(node), this.limits.requestDeadlineMs * 4 + 2000, 'browse');
    };
    const p = this._lock.then(run, run);
    this._lock = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  /** When the current lastError was first observed (null when there is none). */
  _errorStamp() {
    if (this._lastError !== this._stampedError) {
      this._stampedError = this._lastError;
      this._lastErrorAt = this._lastError ? this._now() : null;
    }
    return this._lastErrorAt ?? null;
  }

  async probe(args) {
    if (this._phase !== 'online') throw new Error('device is offline');
    const gen = this._gen;
    const run = async () => {
      if (!this._alive(gen)) throw new Error('device is offline');
      const deadline = this.limits.requestDeadlineMs;
      return this._race(() => this.driver.probe(args), deadline * 2 + 500, 'probe');
    };
    const p = this._lock.then(run, run);
    this._lock = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  getStatus() {
    const groups = {};
    for (const g of this._groups.values()) {
      const avg = g.cycleTimes.length ? g.cycleTimes.reduce((a, b) => a + b, 0) / g.cycleTimes.length : 0;
      groups[g.id] = {
        intervalMs: g.intervalMs,
        effectiveIntervalMs: this._effective(g),
        lastCycleMs: g.lastCycleMs,
        avgCycleMs: Math.round(avg * 100) / 100,
        overruns: g.overruns,
        cycles: g.cycles
      };
    }
    return {
      deviceId: this.deviceId,
      phase: this._phase,
      state: this._lastState || 'offline',
      since: this._since,
      lastError: this._lastError,
      lastErrorAt: this._errorStamp(),
      connects: this.stats.connects,
      requests: this.stats.requests,
      timeouts: this.stats.timeouts,
      exceptions: Object.assign({}, this.stats.exceptions),
      quarantined: Array.from(this._quarantine.keys()),
      quarantineReasons: Object.fromEntries(
        Array.from(this._quarantine.entries())
          .slice(0, 100)
          .map(([k, q]) => [k, { code: q.code, message: q.message || null, since: q.since }])
      ),
      openUnits: Array.from(this._units.entries())
        .filter(([, b]) => b.open)
        .map(([u]) => u),
      groups,
      tagCount: this._tags.size,
      lastSampleAt: this._lastSampleAt
    };
  }
}

module.exports = { DeviceRuntime };
