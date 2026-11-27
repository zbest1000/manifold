'use strict';

/**
 * In-process CoAP server for tests (node:dgram, UDP on 127.0.0.1).
 *
 * Deliberately written WITHOUT importing the driver's codec so the tests compare
 * two independent readings of RFC 7252 / 7959 / 7641. It cannot prove behaviour
 * against real firmware (see server/drivers/coap/NOTES.md).
 *
 * Serves (`sim.resources`, replaceable with `setResource`):
 *   /temp /flag /name         text/plain
 *   /json                     application/json document with nested members
 *   /cbor                     application/cbor map (ints, floats, half float, arrays, tags)
 *   /senml /senml-cbor        SenML packs (base name, base unit, several records)
 *   /octet                    application/octet-stream
 *   /big /bigjson             3000+ byte bodies, served block-wise (size negotiated down to maxSzx)
 *   /sep /sepnon              separate responses (empty ACK, then CON / NON)
 *   /obs /obs-big /obs-ignore observable resources (the last one ignores Observe)
 *   /forbidden /unavail       4.03 and 5.03 (Max-Age 1)
 *   /noblock                  answers 4.02 to a Block2 option
 *   /changing                 body whose ETag changes while its blocks are fetched
 *   /huge                     declares Size2 of 10 MB
 *   /.well-known/core         link-format listing of the above
 *
 * ALL request codes other than GET and the empty message are counted in
 * `stats.nonGetReceived` (and answered 4.05), so tests can prove the driver
 * never sends a write method.
 *
 * Fault injection (sim.faults, mutable at any time; numbers count down):
 *   dropRequests (n)      ignore the next n datagrams
 *   dropResponses (n)     process the next n requests but send no reply (the retransmission is deduplicated)
 *   duplicateResponses (n) send the next n replies twice
 *   resetNext (n)         answer the next n requests with RST
 *   wrongTokenNext (n)    piggybacked reply carries another token
 *   wrongMidNext (n)      piggybacked reply carries another message id
 *   garbageNext (n)       reply with bytes that are not a CoAP message
 *   truncateNext (n)      reply cut after the first 3 bytes
 *   delayMs               delay every reply
 *   silent (bool)         never reply to anything (a dead device)
 *   pingSilent (bool)     ignore empty CON messages only
 */

const dgram = require('node:dgram');

const T = { CON: 0, NON: 1, ACK: 2, RST: 3 };

// ---- independent codec (tiny) ---------------------------------------------------

function uint(n) {
  if (n === 0) return Buffer.alloc(0);
  const out = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from(out);
}

function parse(buf) {
  if (buf.length < 4 || buf[0] >> 6 !== 1) return null;
  const tkl = buf[0] & 15;
  const m = { type: (buf[0] >> 4) & 3, code: buf[1], mid: buf.readUInt16BE(2), token: buf.subarray(4, 4 + tkl), opts: [], payload: Buffer.alloc(0) };
  let p = 4 + tkl;
  let num = 0;
  while (p < buf.length) {
    if (buf[p] === 0xff) {
      m.payload = buf.subarray(p + 1);
      break;
    }
    let d = buf[p] >> 4;
    let l = buf[p] & 15;
    p++;
    if (d === 13) d = buf[p++] + 13;
    else if (d === 14) {
      d = buf.readUInt16BE(p) + 269;
      p += 2;
    }
    if (l === 13) l = buf[p++] + 13;
    else if (l === 14) {
      l = buf.readUInt16BE(p) + 269;
      p += 2;
    }
    num += d;
    m.opts.push([num, buf.subarray(p, p + l)]);
    p += l;
  }
  return m;
}

function build({ type, code, mid, token = Buffer.alloc(0), opts = [], payload }) {
  const sorted = opts.map((o, i) => [...o, i]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const parts = [Buffer.from([0x40 | (type << 4) | token.length, code, mid >> 8, mid & 255]), token];
  let prev = 0;
  const ext = (n) => (n < 13 ? [n, []] : n < 269 ? [13, [n - 13]] : [14, [(n - 269) >> 8, (n - 269) & 255]]);
  for (const [num, val] of sorted) {
    const [dn, de] = ext(num - prev);
    const [ln, le] = ext(val.length);
    prev = num;
    parts.push(Buffer.from([(dn << 4) | ln, ...de, ...le]), val);
  }
  if (payload && payload.length) parts.push(Buffer.from([0xff]), payload);
  return Buffer.concat(parts);
}

const O = { OBSERVE: 6, PATH: 11, CF: 12, MAXAGE: 14, QUERY: 15, ACCEPT: 17, ETAG: 4, BLOCK2: 23, SIZE2: 28 };
const code = (c, d) => (c << 5) | d;
const GET = 1;
const C = { CONTENT: code(2, 5), NOT_FOUND: code(4, 4), BAD_OPTION: code(4, 2), NOT_ALLOWED: code(4, 5), FORBIDDEN: code(4, 3), UNAVAIL: code(5, 3) };

// ---- test data encoders -------------------------------------------------------------

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Encode a JS value as CBOR. Numbers: integers as ints, others as float64. {$half: bits} is a half-float, {$f32: x} a single, {$tag, $v} a tag. */
function cbor(v) {
  if (v === null) return Buffer.from([0xf6]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
    const b = Buffer.alloc(9);
    b[0] = 0xfb;
    b.writeDoubleBE(v, 1);
    return b;
  }
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cbor)]);
  if (v && v.$half !== undefined) return Buffer.from([0xf9, v.$half >> 8, v.$half & 255]);
  if (v && v.$f32 !== undefined) {
    const b = Buffer.alloc(5);
    b[0] = 0xfa;
    b.writeFloatBE(v.$f32, 1);
    return b;
  }
  if (v && v.$tag !== undefined) return Buffer.concat([cborHead(6, v.$tag), cbor(v.$v)]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  const keys = Object.keys(v);
  return Buffer.concat([cborHead(5, keys.length), ...keys.flatMap((k) => [cbor(k), cbor(v[k])])]);
}

const SENML = [
  { bn: 'urn:dev:ow:10e2073a01080063:', bu: 'Cel', n: 'temp', v: 21.5 },
  { n: 'hum', u: '%RH', v: 40 },
  { n: 'door', vb: true },
  { n: 'label', vs: 'lab-3' },
  { n: 'raw', vd: Buffer.from([1, 2, 3]).toString('base64url') }
];

function senmlCbor() {
  const rec = (pairs) => new Map(pairs);
  return cbor([
    rec([[-2, 'urn:dev:ow:10e2073a01080063:'], [-4, 'Cel'], [0, 'temp'], [2, 21.5]]),
    rec([[0, 'hum'], [1, '%RH'], [2, 40]]),
    rec([[0, 'door'], [4, true]]),
    rec([[0, 'label'], [3, 'lab-3']])
  ]);
}

function defaultResources() {
  const big = Buffer.alloc(3000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const bigJson = Buffer.from(JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i, v: i * 2 })), last: 'end' }));
  return {
    '/temp': { cf: 0, body: '21.5' },
    '/flag': { cf: 0, body: 'true' },
    '/name': { cf: 0, body: 'sensor-1' },
    '/json': { cf: 50, body: JSON.stringify({ temperature: 21.5, humidity: 40, ok: true, label: 'lab', nested: { list: [1, 2, { v: 3 }] }, nothing: null, 'a.b': 7 }) },
    '/cbor': {
      cf: 60,
      body: cbor({ temperature: 21.5, half: { $half: 0x4900 }, single: { $f32: 1.5 }, count: 42, neg: -7, ok: true, label: 'cb', list: [1, 2, 3], when: { $tag: 1, $v: 1700000000 }, nothing: null, nested: { x: 5 } })
    },
    '/senml': { cf: 110, body: JSON.stringify(SENML) },
    '/senml-cbor': { cf: 112, body: senmlCbor() },
    '/octet': { cf: 42, body: Buffer.from([0xde, 0xad, 0xbe, 0xef]) },
    '/big': { cf: 42, body: big },
    '/bigjson': { cf: 50, body: bigJson },
    '/sep': { cf: 0, body: '33', separate: 60 },
    '/sepnon': { cf: 0, body: '34', separate: 60, separateType: 'non' },
    '/obs': { cf: 0, body: '1', observable: true, maxAge: 60 },
    '/obs-big': { cf: 50, body: bigJson, observable: true, maxAge: 60 },
    '/obs-ignore': { cf: 0, body: '5', observable: false },
    '/forbidden': { cf: 0, body: 'no', code: C.FORBIDDEN },
    '/unavail': { cf: 0, body: 'later', code: C.UNAVAIL, maxAge: 1 },
    '/noblock': { cf: 0, body: 'plain', rejectBlock2: true },
    '/changing': { cf: 42, body: Buffer.alloc(2500, 7), etagFlip: 99 },
    '/huge': { cf: 42, body: Buffer.alloc(3000, 1), size2: 10000000 }
  };
}

class CoapSimulator {
  /** @param {{resources?:object, maxSzx?:number, host?:string}} [opts] maxSzx: biggest block size exponent the server will use (6 = 1024) */
  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.maxSzx = opts.maxSzx ?? 6;
    this.resources = { ...defaultResources(), ...(opts.resources || {}) };
    this.faults = { dropRequests: 0, dropResponses: 0, duplicateResponses: 0, resetNext: 0, wrongTokenNext: 0, wrongMidNext: 0, garbageNext: 0, truncateNext: 0, delayMs: 0, silent: false, pingSilent: false };
    this.stats = { received: 0, gets: 0, nonGetReceived: 0, pings: 0, duplicateRequests: 0, blockRequests: 0, deregistrations: 0, registrations: 0, notificationsSent: 0, observerResets: 0, acksReceived: 0, sepResponses: 0 };
    this.log = [];
    this.observers = []; // { key, token, rinfo, seq }
    this._mid = Math.floor(Math.random() * 65536);
    this._seen = new Map();
    this._awaiting = new Map(); // mid of a CON we sent -> { timer, obs? }
    this._flips = new Map();
    this.sock = null;
    this.port = 0;
  }

  async start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => {
      try {
        this._onMessage(msg, rinfo);
      } catch (err) {
        process.stderr.write(`coap simulator error: ${err.stack}\n`);
      }
    });
    await new Promise((resolve) => this.sock.bind(0, this.host, resolve));
    this.port = this.sock.address().port;
    return this;
  }

  async stop() {
    for (const w of this._awaiting.values()) clearTimeout(w.timer);
    this._awaiting.clear();
    if (!this.sock) return;
    await new Promise((resolve) => this.sock.close(resolve));
    this.sock = null;
  }

  setResource(path, def) {
    if (def === null) delete this.resources[path];
    else this.resources[path] = def;
  }

  /** The requests of one kind seen so far, e.g. log.filter((r) => r.path === '/temp'). */
  get requests() {
    return this.log;
  }

  _nextMid() {
    this._mid = (this._mid + 1) & 0xffff;
    return this._mid;
  }

  _send(buf, rinfo, { allowFaults = true } = {}) {
    if (this.faults.silent) return;
    const send = (b) => this.sock && this.sock.send(b, rinfo.port, rinfo.address);
    const f = this.faults;
    const go = () => {
      if (allowFaults && f.garbageNext > 0) {
        f.garbageNext--;
        send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]));
        return;
      }
      if (allowFaults && f.truncateNext > 0) {
        f.truncateNext--;
        send(buf.subarray(0, 3));
        return;
      }
      send(buf);
      if (allowFaults && f.duplicateResponses > 0) {
        f.duplicateResponses--;
        send(buf);
      }
    };
    if (f.delayMs > 0) setTimeout(go, f.delayMs).unref();
    else go();
  }

  _pathOf(m) {
    return '/' + m.opts.filter((o) => o[0] === O.PATH).map((o) => o[1].toString('utf8')).join('/');
  }

  _find(path, query) {
    if (query && this.resources[`${path}?${query}`]) return this.resources[`${path}?${query}`];
    return this.resources[path];
  }

  _linkFormat() {
    return Object.entries(this.resources)
      .filter(([p]) => !p.includes('?'))
      .map(([p, r]) => {
        const attrs = [];
        if (r.cf !== undefined) attrs.push(`ct=${r.cf}`);
        if (r.observable) attrs.push('obs');
        if (r.rt) attrs.push(`rt="${r.rt}"`);
        return `<${p}>${attrs.length ? `;${attrs.join(';')}` : ''}`;
      })
      .concat(['</.well-known/core>;ct=40'])
      .join(',');
  }

  _onMessage(buf, rinfo) {
    this.stats.received++;
    if (this.faults.dropRequests > 0) {
      this.faults.dropRequests--;
      return;
    }
    const m = parse(buf);
    if (!m) return;
    const peer = `${rinfo.address}:${rinfo.port}`;
    if (m.code === 0) {
      if (m.type === T.CON) {
        this.stats.pings++;
        if (!this.faults.pingSilent) this._send(build({ type: T.RST, code: 0, mid: m.mid }), rinfo, { allowFaults: false });
      } else if (m.type === T.ACK) {
        this.stats.acksReceived++;
        this._clearAwait(m.mid);
      } else if (m.type === T.RST) {
        const w = this._awaiting.get(m.mid);
        if (w && w.obs) {
          this.stats.observerResets++;
          this.observers = this.observers.filter((o) => o !== w.obs);
        }
        this._clearAwait(m.mid);
      }
      return;
    }
    if (m.code >= 0x40) {
      // The client answering us with a response code: not a thing.
      if (m.type === T.CON) this._send(build({ type: T.RST, code: 0, mid: m.mid }), rinfo, { allowFaults: false });
      return;
    }
    const path = this._pathOf(m);
    const queryOpts = m.opts.filter((o) => o[0] === O.QUERY).map((o) => o[1].toString('utf8'));
    const entry = { method: m.code, path, query: queryOpts.join('&'), mid: m.mid, type: m.type, token: m.token.toString('hex'), at: Date.now() };
    const ob = m.opts.find((o) => o[0] === O.OBSERVE);
    if (ob) entry.observe = ob[1].length ? ob[1].readUIntBE(0, ob[1].length) : 0;
    const b2 = m.opts.find((o) => o[0] === O.BLOCK2);
    if (b2) {
      const v = b2[1].length ? b2[1].readUIntBE(0, b2[1].length) : 0;
      entry.block2 = { num: v >> 4, szx: v & 7 };
    }
    const acc = m.opts.find((o) => o[0] === O.ACCEPT);
    if (acc) entry.accept = acc[1].length ? acc[1].readUIntBE(0, acc[1].length) : 0;
    this.log.push(entry);
    if (m.code !== GET) {
      this.stats.nonGetReceived++;
      this._send(build({ type: m.type === T.CON ? T.ACK : T.NON, code: C.NOT_ALLOWED, mid: m.type === T.CON ? m.mid : this._nextMid(), token: m.token }), rinfo, { allowFaults: false });
      return;
    }
    this.stats.gets++;
    const dupKey = `${peer}/${m.mid}`;
    if (m.type === T.CON && this._seen.has(dupKey)) {
      this.stats.duplicateRequests++;
      const cached = this._seen.get(dupKey);
      if (cached.reply && this.faults.dropResponses <= 0) this._send(cached.reply, rinfo);
      else if (cached.reply && this.faults.dropResponses > 0) this.faults.dropResponses--;
      return;
    }
    const seen = { reply: null };
    if (m.type === T.CON) this._seen.set(dupKey, seen);
    if (this.faults.resetNext > 0) {
      this.faults.resetNext--;
      this._send(build({ type: T.RST, code: 0, mid: m.mid }), rinfo, { allowFaults: false });
      return;
    }
    this._serve(m, entry, rinfo, seen, path, queryOpts.join('&'));
  }

  _serve(m, entry, rinfo, seen, path, query) {
    const reply = (c, { cf, body, maxAge, etag, observe, block2, size2 } = {}, { type, mid } = {}) => {
      const opts = [];
      if (observe !== undefined) opts.push([O.OBSERVE, uint(observe)]);
      if (cf !== undefined) opts.push([O.CF, uint(cf)]);
      if (maxAge !== undefined) opts.push([O.MAXAGE, uint(maxAge)]);
      if (etag) opts.push([O.ETAG, etag]);
      if (block2) opts.push([O.BLOCK2, uint(block2.num * 16 + (block2.more ? 8 : 0) + block2.szx)]);
      if (size2 !== undefined) opts.push([O.SIZE2, uint(size2)]);
      const piggy = m.type === T.CON && type === undefined;
      const rtype = type ?? (piggy ? T.ACK : T.NON);
      const token = m.token;
      const rmid = mid ?? (piggy ? m.mid : this._nextMid());
      return build({ type: rtype, code: c, mid: rmid, token, opts, payload: body });
    };
    const deliver = (buf) => {
      seen.reply = buf; // a retransmitted request is answered with this clean copy
      const f = this.faults;
      if (f.dropResponses > 0) {
        f.dropResponses--;
        return;
      }
      let out = buf;
      if (m.type === T.CON && f.wrongTokenNext > 0) {
        f.wrongTokenNext--;
        out = Buffer.from(buf);
        out.fill(0xff, 4, 4 + (buf[0] & 15));
      } else if (m.type === T.CON && f.wrongMidNext > 0) {
        f.wrongMidNext--;
        out = Buffer.from(buf);
        out.writeUInt16BE((m.mid + 1) & 0xffff, 2);
      }
      this._send(out, rinfo);
    };

    if (path === '/.well-known/core' && !this.resources[path]) {
      const body = Buffer.from(this._linkFormat());
      return this._respondBody(m, rinfo, deliver, reply, { cf: 40, body }, entry);
    }
    const res = this._find(path, query);
    if (!res) return deliver(reply(C.NOT_FOUND, { body: Buffer.from('not found') }));
    if (res.rejectBlock2 && m.opts.some((o) => o[0] === O.BLOCK2)) return deliver(reply(C.BAD_OPTION));
    const ob = m.opts.find((o) => o[0] === O.OBSERVE);
    let observe;
    if (ob) {
      const v = ob[1].length ? ob[1].readUIntBE(0, ob[1].length) : 0;
      if (v === 0 && res.observable) {
        this.stats.registrations++;
        this.observers = this.observers.filter((o) => !(o.key === path && o.token.equals(m.token)));
        const o = { key: path, token: Buffer.from(m.token), rinfo, seq: 1 };
        this.observers.push(o);
        observe = o.seq;
      } else if (v === 1) {
        this.stats.deregistrations++;
        this.observers = this.observers.filter((o) => !(o.key === path && o.token.equals(m.token)));
      }
    }
    const c = res.code ?? C.CONTENT;
    const body = typeof res.body === 'function' ? res.body() : Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body ?? '');
    this._respondBody(m, rinfo, deliver, reply, { cf: res.cf, body, maxAge: res.maxAge, code: c, observe, res, path }, entry);
  }

  _respondBody(m, rinfo, deliver, reply, d, entry) {
    const { body, cf, maxAge, observe, res } = d;
    const c = d.code ?? C.CONTENT;
    let out = { cf, maxAge, observe, body };
    const b2 = m.opts.find((o) => o[0] === O.BLOCK2);
    const limit = 1 << (this.maxSzx + 4);
    if (b2 || body.length > limit) {
      const v = b2 && b2[1].length ? b2[1].readUIntBE(0, b2[1].length) : 0;
      const num = b2 ? v >> 4 : 0;
      const szx = Math.min(b2 ? v & 7 : this.maxSzx, this.maxSzx);
      const size = 1 << (szx + 4);
      if (b2) this.stats.blockRequests++;
      const start = num * size;
      if (start >= body.length && body.length > 0) return deliver(reply(code(4, 2)));
      const slice = body.subarray(start, start + size);
      const more = start + size < body.length;
      let etag = res && res.etag ? Buffer.from(res.etag) : undefined;
      if (res && res.etagFlip) {
        // The representation changes while the first `etagFlip` transfers are in progress.
        if (num === 0) this._flips.set(entry.path, (this._flips.get(entry.path) || 0) + 1);
        const t = this._flips.get(entry.path) || 1;
        etag = Buffer.from([num > 0 && t <= res.etagFlip ? t + 100 : t]);
      }
      out = { ...out, body: slice, block2: { num, more, szx }, etag, size2: num === 0 && res && res.size2 !== undefined ? res.size2 : undefined };
    } else if (res && res.etag) out.etag = Buffer.from(res.etag);
    if (res && res.separate && m.type === T.CON) {
      this.stats.sepResponses++;
      this._send(build({ type: T.ACK, code: 0, mid: m.mid }), rinfo, { allowFaults: false });
      const delay = res.separate;
      const sepNon = res.separateType === 'non';
      setTimeout(() => {
        const mid = this._nextMid();
        const buf = reply(c, out, { type: sepNon ? T.NON : T.CON, mid });
        if (!sepNon) this._awaitAck(mid, buf, rinfo);
        this._send(buf, rinfo);
      }, delay).unref();
      return;
    }
    deliver(reply(c, out));
  }

  _awaitAck(mid, buf, rinfo, obs) {
    let tries = 0;
    const arm = () => {
      const timer = setTimeout(() => {
        if (!this._awaiting.has(mid) || ++tries > 3) return this._clearAwait(mid);
        this._send(buf, rinfo);
        arm();
      }, 200);
      timer.unref();
      this._awaiting.set(mid, { timer, obs });
    };
    arm();
  }

  _clearAwait(mid) {
    const w = this._awaiting.get(mid);
    if (w) clearTimeout(w.timer);
    this._awaiting.delete(mid);
  }

  /**
   * Send a notification to every observer of `path`. `body` replaces the resource
   * body first. `seq` forces the Observe value (use it to reorder); `con` makes it confirmable.
   */
  notify(path, { body, seq, con = false, maxAge, cf, block = true } = {}) {
    const res = this.resources[path];
    if (!res) throw new Error(`no resource ${path}`);
    if (body !== undefined) res.body = body;
    const data = typeof res.body === 'function' ? res.body() : Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body ?? '');
    for (const o of this.observers.filter((x) => x.key === path)) {
      o.seq = seq !== undefined ? seq : o.seq + 1;
      const opts = [[O.OBSERVE, uint(o.seq)], [O.CF, uint(cf ?? res.cf ?? 0)]];
      opts.push([O.MAXAGE, uint(maxAge ?? res.maxAge ?? 60)]);
      let payload = data;
      const limit = 1 << (this.maxSzx + 4);
      if (block && data.length > limit) {
        payload = data.subarray(0, limit);
        opts.push([O.BLOCK2, uint(0 * 16 + 8 + this.maxSzx)]);
      }
      const mid = this._nextMid();
      const buf = build({ type: con ? T.CON : T.NON, code: C.CONTENT, mid, token: o.token, opts, payload });
      if (con) this._awaitAck(mid, buf, o.rinfo, o);
      this.stats.notificationsSent++;
      this._send(buf, o.rinfo);
    }
  }

  /** Forget every observer (a server that rebooted or ran out of memory): no more notifications. */
  expireObservers(path) {
    this.observers = path ? this.observers.filter((o) => o.key !== path) : [];
  }

  /** Tell observers the relationship is over: an error notification without Observe. */
  endObservation(path) {
    for (const o of this.observers.filter((x) => x.key === path)) {
      this._send(build({ type: T.NON, code: C.NOT_FOUND, mid: this._nextMid(), token: o.token, payload: Buffer.from('gone') }), o.rinfo);
    }
    this.expireObservers(path);
  }
}

async function startCoapSimulator(opts) {
  return new CoapSimulator(opts).start();
}

module.exports = { CoapSimulator, startCoapSimulator, cbor, SENML, parse, build };
