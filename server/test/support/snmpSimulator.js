'use strict';

/**
 * In-process SNMP agent for tests (UDP, loopback by default).
 *
 *  - v1, v2c (communities) and v3 USM users at every level: auth MD5 / SHA-1 /
 *    SHA-224/256/384/512, privacy DES / AES-128;
 *  - Get, GetNext, GetBulk over a MIB tree that holds every SMI type (Integer32,
 *    OctetString text/binary/UTF-8, OID, IpAddress, Counter32, Gauge32, TimeTicks,
 *    Counter64, Opaque float/double/raw) and v1/v2 missing-object behaviour
 *    (noSuchName + error-index vs noSuchObject / noSuchInstance / endOfMibView);
 *  - tooBig when a response exceeds `maxResponseSize`;
 *  - v3 reports: unknownEngineIDs (discovery), notInTimeWindows, unknownUserNames,
 *    wrongDigests, unsupportedSecLevels, decryptionErrors; engine reboot and
 *    engine-ID change;
 *  - faults: drop all / next N / every Nth datagram, delay, a wrong-request-id or
 *    malformed datagram before the real answer, answers from a foreign socket,
 *    genErr for chosen OIDs.
 *
 * It records every PDU type it receives (`stats.pduTypes`) so tests can assert
 * that nothing but Get/GetNext/GetBulk ever arrives. Encoding of responses is
 * written here independently of the driver's message.js (only BER primitives and
 * the USM crypto are shared, and those have RFC test vectors).
 */

const dgram = require('dgram');
const crypto = require('crypto');
const ber = require('../../drivers/snmp/ber');
const usm = require('../../drivers/snmp/usm');

const { TAG } = ber;
const T = { GET: 0xa0, GET_NEXT: 0xa1, RESPONSE: 0xa2, GET_BULK: 0xa5, REPORT: 0xa8 };
const ERR = { tooBig: 1, noSuchName: 2, genErr: 5 };

function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
}

function opaqueFloat(f) {
  const b = Buffer.alloc(7);
  b[0] = 0x9f;
  b[1] = 0x78;
  b[2] = 4;
  b.writeFloatBE(f, 3);
  return b;
}
function opaqueDouble(d) {
  const b = Buffer.alloc(11);
  b[0] = 0x9f;
  b[1] = 0x79;
  b[2] = 8;
  b.writeDoubleBE(d, 3);
  return b;
}

const ENT = '1.3.6.1.4.1.99999.1';

/** Default MIB: oid -> { type, value } (value may be a function of the simulator). */
function defaultMib() {
  return {
    '1.3.6.1.2.1.1.1.0': { type: 'OctetString', value: 'Manifold SNMP simulator' },
    '1.3.6.1.2.1.1.2.0': { type: 'OID', value: '1.3.6.1.4.1.8072.3.2.10' },
    '1.3.6.1.2.1.1.3.0': { type: 'TimeTicks', value: (sim) => sim.upTime() },
    '1.3.6.1.2.1.1.4.0': { type: 'OctetString', value: 'ops@example.invalid' },
    '1.3.6.1.2.1.1.5.0': { type: 'OctetString', value: 'sim-agent' },
    '1.3.6.1.2.1.1.6.0': { type: 'OctetString', value: 'Lab' },
    '1.3.6.1.2.1.1.7.0': { type: 'Integer32', value: 72 },
    '1.3.6.1.2.1.2.1.0': { type: 'Integer32', value: 2 },
    '1.3.6.1.2.1.2.2.1.1.1': { type: 'Integer32', value: 1 },
    '1.3.6.1.2.1.2.2.1.1.2': { type: 'Integer32', value: 2 },
    '1.3.6.1.2.1.2.2.1.2.1': { type: 'OctetString', value: 'eth0' },
    '1.3.6.1.2.1.2.2.1.2.2': { type: 'OctetString', value: 'eth1' },
    '1.3.6.1.2.1.2.2.1.3.1': { type: 'Integer32', value: 6 },
    '1.3.6.1.2.1.2.2.1.5.1': { type: 'Gauge32', value: 1000000000 },
    '1.3.6.1.2.1.2.2.1.6.1': { type: 'OctetString', value: Buffer.from([0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e]) },
    '1.3.6.1.2.1.2.2.1.8.1': { type: 'Integer32', value: 1 },
    '1.3.6.1.2.1.2.2.1.8.2': { type: 'Integer32', value: 2 },
    '1.3.6.1.2.1.2.2.1.10.1': { type: 'Counter32', value: 1000 },
    '1.3.6.1.2.1.2.2.1.10.2': { type: 'Counter32', value: 5 },
    '1.3.6.1.2.1.2.2.1.16.1': { type: 'Counter32', value: 2000 },
    '1.3.6.1.2.1.4.20.1.1.192.168.1.10': { type: 'IpAddress', value: '192.168.1.10' },
    '1.3.6.1.2.1.25.3.3.1.2.196608': { type: 'Integer32', value: 17 },
    '1.3.6.1.2.1.31.1.1.1.1.1': { type: 'OctetString', value: 'eth0' },
    '1.3.6.1.2.1.31.1.1.1.6.1': { type: 'Counter64', value: 1099511627776n + 12345n },
    '1.3.6.1.2.1.31.1.1.1.15.1': { type: 'Gauge32', value: 1000 },
    [`${ENT}.1.0`]: { type: 'Integer32', value: -42 },
    [`${ENT}.2.0`]: { type: 'Opaque', value: opaqueFloat(21.5) },
    [`${ENT}.3.0`]: { type: 'Opaque', value: opaqueDouble(1234.5678) },
    [`${ENT}.4.0`]: { type: 'Opaque', value: Buffer.from([0x01, 0x02, 0x03]) },
    [`${ENT}.5.0`]: { type: 'OctetString', value: Buffer.from([0x00, 0xff, 0x10]) },
    [`${ENT}.6.0`]: { type: 'Counter32', value: 4294967290 },
    [`${ENT}.7.0`]: { type: 'OctetString', value: 'x'.repeat(1000) },
    [`${ENT}.8.0`]: { type: 'OctetString', value: 'Température' },
    [`${ENT}.9.0`]: { type: 'Gauge32', value: 4294967295 },
    [`${ENT}.10.0`]: { type: 'Counter64', value: 18446744073709551615n },
    [`${ENT}.11.0`]: { type: 'OctetString', value: Buffer.from('padded\0\0', 'latin1') },
  };
}

function encodeValue(type, value) {
  switch (type) {
    case 'Integer32':
      return ber.encodeInteger(value);
    case 'OctetString':
      return ber.encodeOctetString(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    case 'OID':
      return ber.encodeOid(value);
    case 'IpAddress':
      return ber.tlv(TAG.IP_ADDRESS, Buffer.from(String(value).split('.').map(Number)));
    case 'Counter32':
      return ber.encodeUnsigned(TAG.COUNTER32, value);
    case 'Gauge32':
      return ber.encodeUnsigned(TAG.GAUGE32, value);
    case 'TimeTicks':
      return ber.encodeUnsigned(TAG.TIMETICKS, value);
    case 'Counter64':
      return ber.encodeUnsigned(TAG.COUNTER64, value);
    case 'Opaque':
      return ber.tlv(TAG.OPAQUE, value);
    case 'Null':
      return ber.encodeNull();
    case 'noSuchObject':
      return Buffer.from([TAG.NO_SUCH_OBJECT, 0]);
    case 'noSuchInstance':
      return Buffer.from([TAG.NO_SUCH_INSTANCE, 0]);
    case 'endOfMibView':
      return Buffer.from([TAG.END_OF_MIB_VIEW, 0]);
    case 'raw':
      return value; // a pre-encoded TLV (malformed-value tests)
    default:
      throw new Error(`simulator: unknown type ${type}`);
  }
}

const vb = (oid, type, value) => ber.sequence(ber.encodeOid(oid), encodeValue(type, value));

function encodePdu(tag, requestId, errorStatus, errorIndex, varbinds) {
  return ber.tlv(tag, Buffer.concat([ber.encodeInteger(requestId), ber.encodeInteger(errorStatus), ber.encodeInteger(errorIndex), ber.sequence(...varbinds)]));
}

/** Parse a request PDU (the agent side of the wire). */
function parsePdu(r) {
  const t = r.read();
  const p = new ber.Reader(r.buf, t.start, t.end);
  const requestId = p.integer();
  const a = p.integer();
  const b = p.integer();
  const list = p.sub(TAG.SEQUENCE, 'varbinds');
  const oids = [];
  while (list.remaining) {
    const v = list.sub(TAG.SEQUENCE, 'varbind');
    oids.push(v.oid());
    v.read();
  }
  return { type: t.tag, requestId: Number(requestId), a: Number(a), b: Number(b), oids };
}

class SnmpSimulator {
  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 0;
    this.communities = opts.communities || ['public'];
    this.versions = opts.versions || [0, 1, 3];
    this.maxResponseSize = opts.maxResponseSize || 65507;
    this.engineId = opts.engineId || Buffer.from('80001f8880' + crypto.randomBytes(8).toString('hex'), 'hex');
    this.engineBoots = opts.engineBoots ?? 1;
    this.timeBase = Date.now();
    this.timeOffsetS = 0;
    this.started = Date.now();
    this.upTimeOffset = 0;
    this.users = new Map();
    for (const u of opts.users || []) this.addUser(u);
    this.mib = new Map();
    const src = opts.mib || defaultMib();
    for (const [oid, v] of Object.entries(src)) this.mib.set(oid, v);
    this._sorted = null;
    this.fault = { dropAll: false, dropNext: 0, dropEvery: 0, delayMs: 0, wrongIdFirst: false, garbageFirst: false, foreignSource: false, genErrOids: new Set(), reportV3: true, ignoreReportable: false };
    this.stats = { received: 0, pduTypes: [], dropped: 0, badCommunity: 0, reports: {}, requests: [], v3Levels: [] };
    this.socket = null;
    this.foreign = null;
    this.salt = BigInt(crypto.randomBytes(4).readUInt32BE(0));
    this._counter = 0;
  }

  addUser(u) {
    const user = { level: 'authPriv', authProtocol: 'sha', privProtocol: 'aes', ...u };
    this.users.set(user.name, user);
    this._keys = null;
  }

  _userKeys(user) {
    this._keyCache = this._keyCache || new Map();
    const id = `${user.name}|${this.engineId.toString('hex')}|${user.authProtocol}|${user.authPassword}|${user.privPassword}`;
    if (!this._keyCache.has(id)) {
      const k = {};
      if (user.level !== 'noAuthNoPriv') k.auth = usm.localizedKey(user.authPassword, this.engineId, user.authProtocol);
      if (user.level === 'authPriv') k.priv = usm.localizedKey(user.privPassword, this.engineId, user.authProtocol);
      this._keyCache.set(id, k);
    }
    return this._keyCache.get(id);
  }

  engineTime() {
    return Math.max(0, Math.floor((Date.now() - this.timeBase) / 1000) + this.timeOffsetS);
  }

  upTime() {
    return Math.floor((Date.now() - this.started) / 10) + this.upTimeOffset;
  }

  /** Reboot: boots+1, engine time and sysUpTime restart. */
  reboot() {
    this.engineBoots++;
    this.timeBase = Date.now();
    this.started = Date.now();
    this.upTimeOffset = 0;
  }

  set(oid, type, value) {
    this.mib.set(oid, { type, value });
    this._sorted = null;
  }

  remove(oid) {
    this.mib.delete(oid);
    this._sorted = null;
  }

  sortedOids() {
    if (!this._sorted) this._sorted = [...this.mib.keys()].sort(cmp);
    return this._sorted;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('message', (m, rinfo) => this._onMessage(m, rinfo));
      this.socket.once('error', reject);
      this.socket.bind(this.port, this.host, () => {
        this.port = this.socket.address().port;
        this.foreign = dgram.createSocket('udp4');
        this.foreign.bind(0, this.host, () => resolve(this));
      });
    });
  }

  async close() {
    for (const s of [this.socket, this.foreign]) {
      if (!s) continue;
      await new Promise((r) => {
        try {
          s.close(r);
        } catch {
          r();
        }
      });
    }
    this.socket = null;
    this.foreign = null;
  }

  _send(buf, rinfo) {
    if (!this.socket) return;
    const out = (sock, data) => sock.send(data, rinfo.port, rinfo.address);
    const go = () => {
      if (!this.socket) return;
      if (this.fault.garbageFirst) out(this.socket, Buffer.from([0x30, 0x10, 0x02, 0x01]));
      if (this.fault.foreignSource) {
        out(this.foreign, buf);
        return;
      }
      out(this.socket, buf);
    };
    if (this.fault.delayMs) setTimeout(go, this.fault.delayMs);
    else go();
  }

  _shouldDrop() {
    this._counter++;
    if (this.fault.dropAll) return true;
    if (this.fault.dropNext > 0) {
      this.fault.dropNext--;
      return true;
    }
    return this.fault.dropEvery > 0 && this._counter % this.fault.dropEvery === 0;
  }

  _onMessage(buf, rinfo) {
    this.stats.received++;
    let top;
    let version;
    try {
      top = new ber.Reader(buf).sub(TAG.SEQUENCE, 'message');
      version = top.integer();
    } catch {
      return;
    }
    if (!this.versions.includes(version)) return;
    if (this._shouldDrop()) {
      this.stats.dropped++;
      return;
    }
    try {
      if (version === 3) this._onV3(buf, rinfo);
      else this._onCommunity(version, top, rinfo);
    } catch {
      /* malformed request: an agent drops it */
    }
  }

  // ── v1 / v2c ──────────────────────────────────────────────────────────

  _onCommunity(version, top, rinfo) {
    const community = top.octets().toString('utf8');
    const pdu = parsePdu(top);
    this.stats.pduTypes.push(pdu.type);
    this.stats.requests.push({ version, type: pdu.type, oids: pdu.oids });
    if (!this.communities.includes(community)) {
      this.stats.badCommunity++;
      return; // agents drop wrong communities silently
    }
    if (version === 0 && pdu.type === T.GET_BULK) return; // not a v1 PDU
    const answer = this._answer(version, pdu);
    if (!answer) return;
    const make = (requestId, varbinds, status = answer.status, index = answer.index) =>
      ber.sequence(ber.encodeInteger(version), ber.encodeOctetString(Buffer.from(community)), encodePdu(T.RESPONSE, requestId, status, index, varbinds));
    let out = make(pdu.requestId, answer.varbinds);
    if (out.length > this.maxResponseSize) {
      // v1 echoes the request's varbinds, v2c sends an empty list (RFC 3416 4.2.1)
      out = make(pdu.requestId, version === 0 ? pdu.oids.map((o) => vb(o, 'Null')) : [], ERR.tooBig, 0);
    }
    if (this.fault.wrongIdFirst) this._send(make(pdu.requestId ^ 0x5a5a, answer.varbinds), rinfo);
    this._send(out, rinfo);
  }

  _value(oid) {
    const e = this.mib.get(oid);
    if (!e) return null;
    return { type: e.type, value: typeof e.value === 'function' ? e.value(this) : e.value };
  }

  /** Response varbinds/status for a request PDU. Exposed v1/v2 semantics. */
  _answer(version, pdu) {
    const v1 = version === 0;
    const sorted = this.sortedOids();
    const visible = (oid) => {
      const v = this._value(oid);
      return v && !(v1 && v.type === 'Counter64') ? v : null; // RFC 3584: v1 never sees Counter64
    };
    const nextAfter = (oid) => {
      for (const o of sorted) if (cmp(o, oid) > 0 && visible(o)) return o;
      return null;
    };
    const genErrAt = pdu.oids.findIndex((o) => this.fault.genErrOids.has(o));
    if (genErrAt >= 0) return { status: ERR.genErr, index: this.fault.genErrIndexZero ? 0 : genErrAt + 1, varbinds: pdu.oids.map((o) => vb(o, 'Null')) };
    if (pdu.type === T.GET) {
      const out = [];
      for (let i = 0; i < pdu.oids.length; i++) {
        const oid = pdu.oids[i];
        const v = visible(oid);
        if (v) out.push(vb(oid, v.type, v.value));
        else if (v1) return { status: ERR.noSuchName, index: i + 1, varbinds: pdu.oids.map((o) => vb(o, 'Null')) };
        else {
          const parent = oid.split('.').slice(0, -1).join('.');
          const hasColumn = sorted.some((o) => o.startsWith(`${parent}.`));
          out.push(vb(oid, hasColumn ? 'noSuchInstance' : 'noSuchObject'));
        }
      }
      return { status: 0, index: 0, varbinds: out };
    }
    if (pdu.type === T.GET_NEXT) {
      const out = [];
      for (let i = 0; i < pdu.oids.length; i++) {
        const n = nextAfter(pdu.oids[i]);
        if (n) {
          const v = visible(n);
          out.push(vb(n, v.type, v.value));
        } else if (v1) return { status: ERR.noSuchName, index: i + 1, varbinds: pdu.oids.map((o) => vb(o, 'Null')) };
        else out.push(vb(pdu.oids[i], 'endOfMibView'));
      }
      return { status: 0, index: 0, varbinds: out };
    }
    if (pdu.type === T.GET_BULK) {
      const nonRep = Math.max(0, pdu.a);
      const reps = Math.max(0, pdu.b);
      const out = [];
      const bytesOf = () => out.reduce((n, b) => n + b.length, 0);
      for (let i = 0; i < Math.min(nonRep, pdu.oids.length); i++) {
        const n = nextAfter(pdu.oids[i]);
        out.push(n ? vb(n, visible(n).type, visible(n).value) : vb(pdu.oids[i], 'endOfMibView'));
      }
      const cursors = pdu.oids.slice(nonRep);
      for (let r = 0; r < reps && cursors.length; r++) {
        for (let c = 0; c < cursors.length; c++) {
          const n = cursors[c] ? nextAfter(cursors[c]) : null;
          const enc = n ? vb(n, visible(n).type, visible(n).value) : vb(cursors[c] || pdu.oids[nonRep + c], 'endOfMibView');
          // Stop adding repetitions before the response would be too big (RFC 3416 4.2.3).
          if (bytesOf() + enc.length + 64 > this.maxResponseSize && out.length) return { status: 0, index: 0, varbinds: out };
          out.push(enc);
          cursors[c] = n;
        }
      }
      return { status: 0, index: 0, varbinds: out };
    }
    return null; // anything else (including Set) is not answered
  }

  // ── v3 ────────────────────────────────────────────────────────────────

  _report(rinfo, msgId, reqId, name, oid, { user = Buffer.alloc(0), authUser = null, contextName = Buffer.alloc(0) } = {}) {
    this.stats.reports[name] = (this.stats.reports[name] || 0) + 1;
    if (!this.fault.reportV3) return;
    const pdu = encodePdu(T.REPORT, reqId, 0, 0, [vb(oid, 'Counter32', this.stats.reports[name])]);
    this._sendV3(rinfo, { msgId, pdu, level: authUser ? 'authNoPriv' : 'noAuthNoPriv', user: authUser ? Buffer.from(authUser.name) : user, authUser, contextName, reportable: false });
  }

  _sendV3(rinfo, { msgId, pdu, level, user, authUser, contextName, reportable = false }) {
    const boots = this.engineBoots;
    const time = this.engineTime();
    const scoped = ber.sequence(ber.encodeOctetString(this.engineId), ber.encodeOctetString(contextName || Buffer.alloc(0)), pdu);
    let data = scoped;
    let privParams = Buffer.alloc(0);
    const keys = authUser ? this._userKeys(authUser) : null;
    if (level === 'authPriv') {
      this.salt += 1n;
      const r = usm.encrypt(authUser.privProtocol, keys.priv, scoped, { engineBoots: boots, engineTime: time, salt: this.salt });
      data = ber.encodeOctetString(r.encrypted);
      privParams = r.privParams;
    }
    const macLen = level !== 'noAuthNoPriv' ? usm.AUTH[authUser.authProtocol].macLength : 0;
    const flags = (level !== 'noAuthNoPriv' ? 1 : 0) | (level === 'authPriv' ? 2 : 0) | (reportable ? 4 : 0);
    // Build the security parameters with a marker we can find, then patch the MAC in.
    const authField = ber.encodeOctetString(Buffer.alloc(macLen));
    const secSeq = ber.sequence(
      ber.encodeOctetString(this.engineId),
      ber.encodeInteger(boots),
      ber.encodeInteger(time),
      ber.encodeOctetString(user),
      authField,
      ber.encodeOctetString(privParams)
    );
    const head = Buffer.concat([ber.encodeInteger(3), ber.sequence(ber.encodeInteger(msgId), ber.encodeInteger(65507), ber.encodeOctetString(Buffer.from([flags])), ber.encodeInteger(3))]);
    const secOctets = ber.encodeOctetString(secSeq);
    const body = Buffer.concat([head, secOctets, data]);
    const whole = ber.tlv(TAG.SEQUENCE, body);
    if (macLen) {
      // MAC offset: outer header + head + secOctets header + secSeq header + fields before the auth field + its 2-byte header.
      const outerHdr = whole.length - body.length;
      const secOctHdr = secOctets.length - secSeq.length;
      const before =
        ber.encodeOctetString(this.engineId).length + ber.encodeInteger(boots).length + ber.encodeInteger(time).length + ber.encodeOctetString(user).length + (authField.length - macLen);
      const offset = outerHdr + head.length + secOctHdr + headerLen(secSeq) + before;
      const mac = usm.computeMac(authUser.authProtocol, keys.auth, whole);
      mac.copy(whole, offset);
    }
    this._send(whole, rinfo);
  }

  _onV3(buf, rinfo) {
    const top = new ber.Reader(buf).sub(TAG.SEQUENCE, 'message');
    top.integer();
    const g = top.sub(TAG.SEQUENCE, 'global');
    const msgId = Number(g.integer());
    g.integer(); // max size
    const flags = g.octets()[0];
    const model = Number(g.integer());
    if (model !== 3) return;
    const secT = top.expect(TAG.OCTET_STRING, 'sec');
    const s = new ber.Reader(buf, secT.start, secT.end).sub(TAG.SEQUENCE, 'usm');
    const engineId = Buffer.from(s.octets());
    const boots = Number(s.integer());
    const time = Number(s.integer());
    const userName = Buffer.from(s.octets());
    const authT = s.expect(TAG.OCTET_STRING, 'auth');
    const privParams = Buffer.from(s.octets());
    const dataT = top.read();
    const reportable = (flags & 4) !== 0 && !this.fault.ignoreReportable;
    const level = flags & 1 ? (flags & 2 ? 'authPriv' : 'authNoPriv') : 'noAuthNoPriv';
    this.stats.v3Levels.push(level);

    // Request id of a plaintext scoped PDU (for reports before decryption).
    let reqId = 0;
    let scopedPlain = null;
    if (dataT.tag === TAG.SEQUENCE) {
      scopedPlain = buf.subarray(dataT.tlvStart, dataT.end);
      try {
        const r = new ber.Reader(scopedPlain).sub(TAG.SEQUENCE);
        r.octets();
        r.octets();
        const p = r.read();
        reqId = Number(new ber.Reader(scopedPlain, p.start, p.end).integer());
      } catch {
        /* keep 0 */
      }
    }

    if (!engineId.equals(this.engineId)) {
      if (reportable) this._report(rinfo, msgId, reqId, 'unknownEngineIDs', '1.3.6.1.6.3.15.1.1.4.0', { user: userName });
      return;
    }
    const user = this.users.get(userName.toString('utf8'));
    if (!user) {
      if (reportable) this._report(rinfo, msgId, reqId, 'unknownUserNames', '1.3.6.1.6.3.15.1.1.3.0', { user: userName });
      return;
    }
    const rank = { noAuthNoPriv: 0, authNoPriv: 1, authPriv: 2 };
    if (rank[level] > rank[user.level] || (user.level !== 'noAuthNoPriv' && level === 'noAuthNoPriv' && this.strictLevels)) {
      if (reportable) this._report(rinfo, msgId, reqId, 'unsupportedSecLevels', '1.3.6.1.6.3.15.1.1.1.0', { user: userName });
      return;
    }
    const keys = this._userKeys(user);
    if (level !== 'noAuthNoPriv') {
      const mac = buf.subarray(authT.start, authT.end);
      const zeroed = Buffer.from(buf);
      zeroed.fill(0, authT.start, authT.end);
      if (!usm.verifyMac(user.authProtocol, keys.auth, zeroed, mac)) {
        if (reportable) this._report(rinfo, msgId, reqId, 'wrongDigests', '1.3.6.1.6.3.15.1.1.5.0', { user: userName });
        return;
      }
      const now = this.engineTime();
      if (boots !== this.engineBoots || Math.abs(time - now) > 150 || this.engineBoots === 2147483647) {
        // `unauthTimeReports`: a (non-conforming or forged) unauthenticated time report.
        if (reportable) this._report(rinfo, msgId, reqId, 'notInTimeWindows', '1.3.6.1.6.3.15.1.1.2.0', this.fault.unauthTimeReports ? { user: userName } : { authUser: user });
        return;
      }
    }
    let scoped = scopedPlain;
    if (level === 'authPriv') {
      if (dataT.tag !== TAG.OCTET_STRING) return;
      try {
        scoped = usm.decrypt(user.privProtocol, keys.priv, buf.subarray(dataT.start, dataT.end), { engineBoots: boots, engineTime: time, privParams });
        new ber.Reader(scoped).sub(TAG.SEQUENCE).octets();
      } catch {
        if (reportable) this._report(rinfo, msgId, reqId, 'decryptionErrors', '1.3.6.1.6.3.15.1.1.6.0', { user: userName });
        return;
      }
    }
    if (!scoped) return;
    const r = new ber.Reader(scoped).sub(TAG.SEQUENCE, 'scoped');
    r.octets(); // contextEngineID
    const contextName = Buffer.from(r.octets());
    const pdu = parsePdu(r);
    this.stats.pduTypes.push(pdu.type);
    this.stats.requests.push({ version: 3, type: pdu.type, oids: pdu.oids, level });
    // An empty Get after discovery (time sync) gets an empty Response.
    const answer = pdu.oids.length ? this._answer(1, pdu) : { status: 0, index: 0, varbinds: [] };
    if (!answer) return;
    let out = encodePdu(T.RESPONSE, pdu.requestId, answer.status, answer.index, answer.varbinds);
    if (out.length + 200 > this.maxResponseSize) out = encodePdu(T.RESPONSE, pdu.requestId, ERR.tooBig, 0, []);
    if (this.fault.wrongIdFirst) this._sendV3(rinfo, { msgId: msgId ^ 0x5a5a, pdu: out, level, user: userName, authUser: user, contextName });
    this._sendV3(rinfo, { msgId, pdu: out, level, user: userName, authUser: level === 'noAuthNoPriv' ? null : user, contextName });
  }
}

function headerLen(tlvBuf) {
  const l = tlvBuf[1];
  return l < 0x80 ? 2 : 2 + (l & 0x7f);
}

async function startSnmpSimulator(opts = {}) {
  const sim = new SnmpSimulator(opts);
  await sim.start();
  return sim;
}

module.exports = { SnmpSimulator, startSnmpSimulator, defaultMib, opaqueFloat, opaqueDouble, ENT };
