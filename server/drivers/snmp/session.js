'use strict';

/**
 * One SNMP session to one agent over one UDP socket: request-id matching,
 * retries within a deadline, and for v3 the USM engine state (engine-ID
 * discovery, boots/time synchronisation, the RFC 3414 time-window check,
 * authentication and privacy).
 *
 * request() never throws for agent or network problems; it resolves
 *   { ok:true, pdu }                                   a Response PDU
 *   { ok:false, kind:'timeout', message }              no valid answer within the deadline
 *   { ok:false, kind:'unreachable', message }          ICMP port/host unreachable
 *   { ok:false, kind:'report', report, message }       a v3 Report the session could not recover from
 *   { ok:false, kind:'transport', message }            socket closed / send failed
 */

const { UdpTransport } = require('../runtime/udpTransport');
const msg = require('./message');
const usm = require('./usm');

const { PDU, VERSION, FLAG } = msg;

const MAX_INT32 = 2147483647;
const TIME_WINDOW_S = 150;
const MAX_RESYNCS = 2;
const UDP_MAX = 65507;

function randomId() {
  return 1 + Math.floor(Math.random() * 0x7ffffff0);
}

class SnmpSession {
  /**
   * @param {object} cfg
   * @param {'1'|'2c'|'3'} cfg.version
   * @param {string} [cfg.community]
   * @param {object} [cfg.v3] { user, level, authProtocol, authPassword, privProtocol, privPassword, contextName, contextEngineId:Buffer|null }
   * @param {string} cfg.address literal IP
   * @param {number} cfg.port
   * @param {string} [cfg.displayHost]
   * @param {boolean} [cfg.allowAnySource]
   * @param {number} [cfg.msgMaxSize] what we accept (v3 msgMaxSize)
   * @param {object} [deps] { createSocket, isAllowed, now }
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.version = cfg.version === '1' ? VERSION.v1 : cfg.version === '3' ? VERSION.v3 : VERSION.v2c;
    this.community = Buffer.from(cfg.community === undefined || cfg.community === null ? 'public' : String(cfg.community), 'utf8');
    this.v3 = cfg.v3 || null;
    this.level = this.v3 ? this.v3.level : 'noAuthNoPriv';
    this.transport = null;
    this.pending = new Map(); // v1/v2c: requestId -> entry; v3: msgId -> entry
    this.nextRequestId = randomId();
    this.nextMsgId = randomId();
    this.salt = BigInt(Math.floor(Math.random() * 0xffffffff)) * 4294967296n + BigInt(Math.floor(Math.random() * 0xffffffff));
    this.engine = null; // { id, boots, time, latest, receivedAt, maxSize }
    this.keys = null; // { engineHex, auth, priv }
    this._ku = null; // { auth, priv } password -> key (engine independent, computed once)
    this.stats = { requests: 0, retries: 0, timeouts: 0, reports: {}, malformed: 0, stale: 0, badDigest: 0, outOfWindow: 0 };
    this.lastNotice = null;
  }

  _now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  isOpen() {
    return !!this.transport && this.transport.isOpen();
  }

  async open() {
    this.close();
    const t = new UdpTransport({
      address: this.cfg.address,
      port: this.cfg.port,
      allowAnySource: this.cfg.allowAnySource,
      displayHost: this.cfg.displayHost,
      createSocket: this.deps.createSocket,
      isAllowed: this.deps.isAllowed,
    });
    t.on('message', (buf, rinfo) => this._onDatagram(buf, rinfo));
    t.on('unreachable', (err) => this._onUnreachable(err));
    t.on('error', (err) => this._failAll('transport', `UDP socket error: ${err.message}`));
    t.on('close', () => this._failAll('transport', 'UDP socket closed'));
    await t.open();
    this.transport = t;
  }

  close() {
    const t = this.transport;
    this.transport = null;
    this._failAll('transport', 'session closed');
    if (t) t.close();
  }

  _failAll(kind, message) {
    for (const e of [...this.pending.values()]) e.finish({ ok: false, kind, message });
  }

  _onUnreachable(err) {
    for (const e of [...this.pending.values()]) {
      e.finish({ ok: false, kind: 'unreachable', message: `${this.cfg.displayHost || this.cfg.address}:${this.cfg.port} is unreachable (${err.code}): no SNMP agent listening on that UDP port, or the host refused it` });
    }
  }

  // ── engine / keys (v3) ─────────────────────────────────────────────────

  _engineTime() {
    const e = this.engine;
    if (!e) return { boots: 0, time: 0 };
    const elapsed = Math.floor((this._now() - e.receivedAt) / 1000);
    return { boots: e.boots, time: Math.min(MAX_INT32, e.time + Math.max(0, elapsed)) };
  }

  _setEngine(id, boots, time) {
    const changedId = !this.engine || !this.engine.id.equals(id);
    this.engine = { id: Buffer.from(id), boots, time, latest: time, receivedAt: this._now(), maxSize: this.engine && !changedId ? this.engine.maxSize : null };
    if (changedId) this.keys = null;
  }

  _localKeys() {
    const v3 = this.v3;
    if (this.level === 'noAuthNoPriv' || !this.engine || !this.engine.id.length) return null;
    const hex = this.engine.id.toString('hex');
    if (this.keys && this.keys.engineHex === hex) return this.keys;
    if (!this._ku) {
      this._ku = {
        auth: usm.passwordToKey(v3.authPassword, v3.authProtocol),
        priv: this.level === 'authPriv' ? usm.passwordToKey(v3.privPassword, v3.authProtocol) : null,
      };
    }
    this.keys = {
      engineHex: hex,
      auth: usm.localizeKey(this._ku.auth, this.engine.id, v3.authProtocol),
      priv: this._ku.priv ? usm.localizeKey(this._ku.priv, this.engine.id, v3.authProtocol) : null,
    };
    return this.keys;
  }

  // ── encoding ───────────────────────────────────────────────────────────

  _allocRequestId() {
    const id = this.nextRequestId;
    this.nextRequestId = id >= 0x7ffffffe ? 1 : id + 1;
    return id;
  }

  _allocMsgId() {
    const id = this.nextMsgId;
    this.nextMsgId = id >= 0x7ffffffe ? 1 : id + 1;
    return id;
  }

  _encode(entry) {
    const pdu = msg.encodeRequestPdu(entry.type, entry.requestId, entry.oids, entry.bulk);
    if (this.version !== VERSION.v3) return msg.encodeCommunityMessage(this.version, this.community, pdu);
    const discovery = entry.discovery === 'engine';
    const level = discovery ? 'noAuthNoPriv' : this.level;
    const keys = discovery ? null : this._localKeys();
    const { boots, time } = discovery ? { boots: 0, time: 0 } : this._engineTime();
    const engineId = discovery || !this.engine ? Buffer.alloc(0) : this.engine.id;
    this.salt += 1n;
    return msg.encodeV3Message({
      msgId: entry.msgId,
      msgMaxSize: this.cfg.msgMaxSize || UDP_MAX,
      level,
      engineId,
      engineBoots: boots,
      engineTime: time,
      user: discovery ? Buffer.alloc(0) : Buffer.from(this.v3.user, 'utf8'),
      auth: level !== 'noAuthNoPriv' ? { protocol: this.v3.authProtocol, key: keys.auth } : undefined,
      priv: level === 'authPriv' ? { protocol: this.v3.privProtocol, key: keys.priv, salt: this.salt } : undefined,
      contextEngineId: discovery ? Buffer.alloc(0) : this.v3.contextEngineId || engineId,
      contextName: discovery ? Buffer.alloc(0) : Buffer.from(this.v3.contextName || '', 'utf8'),
      pdu,
    });
  }

  // ── receiving ──────────────────────────────────────────────────────────

  _onDatagram(buf) {
    let decoded;
    try {
      decoded = msg.decodeMessage(buf);
    } catch (err) {
      this.stats.malformed++;
      this.lastNotice = `ignored a malformed datagram: ${err.message}`;
      return;
    }
    if (decoded.version !== this.version) {
      this.stats.malformed++;
      this.lastNotice = `ignored an SNMP version ${decoded.version} datagram (session is ${this.cfg.version})`;
      return;
    }
    if (this.version === VERSION.v3) {
      this._onV3(buf, decoded);
      return;
    }
    const entry = this.pending.get(decoded.pdu.requestId);
    if (!entry) {
      this.stats.stale++;
      return;
    }
    if (decoded.pdu.type !== PDU.RESPONSE) {
      this.stats.malformed++;
      return;
    }
    if (!decoded.community.equals(this.community)) {
      // A response carrying another community is not an answer to us.
      this.stats.malformed++;
      return;
    }
    entry.finish({ ok: true, pdu: decoded.pdu });
  }

  _onV3(buf, decoded) {
    const env = decoded.v3;
    const entry = this.pending.get(env.msgId);
    if (!entry) {
      this.stats.stale++;
      return;
    }
    if (env.securityModel !== msg.USM_MODEL || !env.usm) {
      this.stats.malformed++;
      return;
    }
    const sec = env.usm;
    const authed = (env.flags & FLAG.AUTH) !== 0;
    const priv = (env.flags & FLAG.PRIV) !== 0;
    let scoped = decoded.scoped;
    if (authed) {
      if (this.level === 'noAuthNoPriv' || entry.discovery === 'engine') {
        // We cannot verify it; only an unauthenticated report/response helps discovery.
        this.stats.malformed++;
        return;
      }
      if (!this.engine || !sec.engineId.equals(this.engine.id)) {
        this.stats.malformed++;
        return;
      }
      if (sec.user.toString('utf8') !== this.v3.user) {
        this.stats.malformed++;
        return;
      }
      const keys = this._localKeys();
      if (!usm.verifyMac(this.v3.authProtocol, keys.auth, msg.zeroAuth(buf, sec), sec.authParams)) {
        this.stats.badDigest++;
        this.lastNotice = 'ignored a response whose authentication digest did not verify';
        return;
      }
      // RFC 3414 3.2 step 7b: update the cached engine time, then the time-window check.
      const e = this.engine;
      if (sec.engineBoots > e.boots || (sec.engineBoots === e.boots && sec.engineTime > e.latest)) {
        e.boots = sec.engineBoots;
        e.time = sec.engineTime;
        e.latest = sec.engineTime;
        e.receivedAt = this._now();
      }
      if (e.boots === MAX_INT32 || sec.engineBoots < e.boots || (sec.engineBoots === e.boots && sec.engineTime < e.latest - TIME_WINDOW_S)) {
        this.stats.outOfWindow++;
        this.lastNotice = 'ignored an authenticated message outside the time window (possible replay)';
        return;
      }
      if (env.msgMaxSize >= 484) e.maxSize = env.msgMaxSize;
      if (priv) {
        if (this.level !== 'authPriv' || !decoded.encrypted) {
          this.stats.malformed++;
          return;
        }
        try {
          const plain = usm.decrypt(this.v3.privProtocol, keys.priv, decoded.encrypted, { engineBoots: sec.engineBoots, engineTime: sec.engineTime, privParams: sec.privParams });
          scoped = msg.decodeScopedPdu(plain, 0, plain.length);
        } catch (err) {
          this.stats.malformed++;
          this.lastNotice = `could not decrypt a response: ${err.message}`;
          return;
        }
      }
    } else if (priv) {
      this.stats.malformed++; // priv without auth is invalid (RFC 3412 7.2 step 5)
      return;
    }
    if (!scoped) {
      this.stats.malformed++;
      return;
    }
    const pdu = scoped.pdu;
    if (pdu.type === PDU.REPORT) {
      const oid = pdu.varbinds[0] && pdu.varbinds[0].oid;
      const report = (oid && usm.REPORT_OIDS[oid]) || 'unknownReport';
      this.stats.reports[report] = (this.stats.reports[report] || 0) + 1;
      entry.finish({ ok: false, kind: 'report', report, authenticated: authed, engine: { id: sec.engineId, boots: sec.engineBoots, time: sec.engineTime }, maxSize: env.msgMaxSize, oid });
      return;
    }
    if (pdu.type !== PDU.RESPONSE) {
      this.stats.malformed++;
      return;
    }
    if (!authed && this.level !== 'noAuthNoPriv' && entry.discovery !== 'engine') {
      // An unauthenticated Response for an authenticated request is never data.
      this.stats.malformed++;
      return;
    }
    if (pdu.requestId !== entry.requestId) {
      this.stats.stale++;
      return;
    }
    if (!authed && sec.engineId.length && (!this.engine || !this.engine.id.length)) {
      // Discovery answered with a Response, or a noAuthNoPriv session: learn the engine.
      this._setEngine(sec.engineId, sec.engineBoots, sec.engineTime);
    }
    entry.finish({ ok: true, pdu });
  }

  // ── sending ────────────────────────────────────────────────────────────

  /** One request/response exchange with retries; no report handling. */
  _exchange(type, oids, { deadlineMs, retries = 1, bulk, discovery } = {}) {
    if (!this.isOpen()) return Promise.resolve({ ok: false, kind: 'transport', message: 'not connected' });
    const attempts = Math.max(1, Math.floor(retries) + 1);
    const perAttempt = Math.max(20, Math.floor(deadlineMs / attempts));
    const entry = {
      type,
      oids,
      bulk,
      discovery,
      requestId: this._allocRequestId(),
      msgId: this.version === VERSION.v3 ? this._allocMsgId() : null,
    };
    const key = this.version === VERSION.v3 ? entry.msgId : entry.requestId;
    this.stats.requests++;
    return new Promise((resolve) => {
      let timer = null;
      let attempt = 0;
      let done = false;
      entry.finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(key);
        resolve(res);
      };
      this.pending.set(key, entry);
      const fire = () => {
        if (done) return;
        if (attempt >= attempts) {
          this.stats.timeouts++;
          const extra = this.lastNotice ? ` (last ignored datagram: ${this.lastNotice})` : '';
          entry.finish({ ok: false, kind: 'timeout', message: `no answer from ${this.cfg.displayHost || this.cfg.address}:${this.cfg.port} after ${attempts} attempt${attempts === 1 ? '' : 's'} (${perAttempt} ms each)${extra}` });
          return;
        }
        if (attempt > 0) this.stats.retries++;
        attempt++;
        let buf;
        try {
          buf = this._encode(entry);
        } catch (err) {
          entry.finish({ ok: false, kind: 'transport', message: `could not encode the request: ${err.message}` });
          return;
        }
        if (buf.length > UDP_MAX) {
          entry.finish({ ok: false, kind: 'transport', message: `request of ${buf.length} bytes does not fit in one UDP datagram` });
          return;
        }
        timer = setTimeout(fire, perAttempt);
        if (timer.unref) timer.unref();
        this.transport.send(buf).catch((err) => entry.finish({ ok: false, kind: 'transport', message: `send failed: ${err.message}` }));
      };
      fire();
    });
  }

  /**
   * A request with v3 report recovery (notInTimeWindows resync, changed engine ID).
   * @returns {Promise<object>} see module doc
   */
  async request(type, oids, { deadlineMs = 2000, retries = 1, nonRepeaters, maxRepetitions } = {}) {
    const until = this._now() + deadlineMs;
    const bulk = type === PDU.GET_BULK ? { nonRepeaters: nonRepeaters || 0, maxRepetitions: maxRepetitions || 10 } : undefined;
    if (this.version === VERSION.v3 && (!this.engine || !this.engine.id.length)) {
      const d = await this.discover(Math.max(50, until - this._now()), retries);
      if (!d.ok) return d;
    }
    for (let resync = 0; ; resync++) {
      const left = until - this._now();
      if (left <= 0) return { ok: false, kind: 'timeout', message: 'deadline passed during v3 resynchronisation' };
      const res = await this._exchange(type, oids, { deadlineMs: left, retries, bulk });
      if (res.ok || res.kind !== 'report') return res;
      const recovered = resync < MAX_RESYNCS && this._recover(res);
      if (!recovered) return this._reportFailure(res);
    }
  }

  /** Apply what a report says when it is recoverable; true to retry. */
  _recover(res) {
    if (res.report === 'notInTimeWindows' && this.level !== 'noAuthNoPriv' && res.authenticated) {
      // RFC 3414 4: the report carries the agent's current boots/time. It is only
      // believed when authenticated (agents send it at authNoPriv), so a forged
      // datagram cannot move our clock.
      if (!this.engine || !res.engine.id.equals(this.engine.id)) this._setEngine(res.engine.id, res.engine.boots, res.engine.time);
      else Object.assign(this.engine, { boots: res.engine.boots, time: res.engine.time, latest: res.engine.time, receivedAt: this._now() });
      return true;
    }
    if (res.report === 'unknownEngineIDs' && res.engine.id.length && (!this.engine || !res.engine.id.equals(this.engine.id))) {
      // The agent's engine ID changed (replacement, re-flash): learn the new one and retry.
      this._setEngine(res.engine.id, res.engine.boots, res.engine.time);
      return true;
    }
    return false;
  }

  _reportFailure(res) {
    const text = usm.REPORT_MESSAGES[res.report] || `the agent sent a Report (${res.oid || 'no varbind'})`;
    const who = this.v3 ? ` (user "${this.v3.user}", ${this.level})` : '';
    return { ok: false, kind: 'report', report: res.report, message: `SNMPv3: ${text}${who}` };
  }

  /**
   * v3 engine discovery (RFC 3414 4) and, for authenticated levels, the
   * boots/time synchronisation that must precede the first authenticated request.
   */
  async discover(deadlineMs = 2000, retries = 1) {
    if (this.version !== VERSION.v3) return { ok: true };
    const until = this._now() + deadlineMs;
    const res = await this._exchange(PDU.GET, [], { deadlineMs, retries, discovery: 'engine' });
    if (res.ok) {
      if (!this.engine || !this.engine.id.length) return { ok: false, kind: 'report', report: 'noEngine', message: 'SNMPv3: the agent answered engine discovery without an engine ID' };
    } else if (res.kind === 'report') {
      if (!res.engine.id.length) return { ok: false, kind: 'report', report: res.report, message: 'SNMPv3: the agent\'s discovery report carried no engine ID' };
      this._setEngine(res.engine.id, res.engine.boots, res.engine.time);
      if (res.maxSize >= 484) this.engine.maxSize = res.maxSize;
    } else {
      return { ...res, message: `SNMPv3 engine discovery failed: ${res.message}` };
    }
    if (this.level === 'noAuthNoPriv') return { ok: true, engine: this.engine };
    // Time synchronisation: an authenticated empty Get; the agent answers notInTimeWindows
    // with its boots/time when ours (often 0/0 from discovery) are outside the window.
    for (let i = 0; i <= MAX_RESYNCS; i++) {
      const left = until - this._now();
      if (left <= 0) return { ok: false, kind: 'timeout', message: 'SNMPv3 time synchronisation did not finish within the deadline' };
      const sync = await this._exchange(PDU.GET, [], { deadlineMs: left, retries });
      if (sync.ok) return { ok: true, engine: this.engine };
      if (sync.kind !== 'report') return { ...sync, message: `SNMPv3 time synchronisation failed: ${sync.message}` };
      if (!this._recover(sync)) return this._reportFailure(sync);
    }
    return { ok: false, kind: 'report', report: 'notInTimeWindows', message: 'SNMPv3: could not synchronise engine boots/time with the agent' };
  }

  /** Largest response the agent says it can send (v3), or null. */
  agentMaxSize() {
    return this.engine && this.engine.maxSize ? this.engine.maxSize : null;
  }
}

module.exports = { SnmpSession };
