'use strict';

/**
 * In-process BACnet/IP device for tests (node:dgram).
 *
 * Written WITHOUT importing the driver's encoders or decoders, so tests compare two independent
 * readings of the protocol. It cannot prove correctness against real firmware
 * (see server/drivers/bacnet/NOTES.md).
 *
 * Implements: Who-Is -> unicast I-Am (or silence: `iAmBroadcastOnly`), ReadProperty with array
 * index (index 0 = length), ReadPropertyMultiple with per-property errors (switchable off: Reject
 * unrecognized-service), max APDU with NO segmentation (Abort segmentation-not-supported when a
 * reply does not fit), the wildcard device instance 4194303, a routed mode (the simulator is a
 * router + device: requests must carry DNET/DADR, replies carry SNET/SADR; other DNETs get a
 * Reject-Message-To-Network; `routed.answerLocal` also answers un-routed requests, as a gateway with a
 * virtual network does), and answering from a different UDP source port.
 * Every other confirmed service (WriteProperty, SubscribeCOV, ...) is answered with Reject and
 * COUNTED in stats.writesReceived, so tests can prove the driver never sends one.
 *
 * Fault injection (sim.faults, mutable at any time):
 *   blackhole      (bool)    answer nothing
 *   dropNext       (number)  drop the next N confirmed requests (exercises retries)
 *   delayMs        (number)  delay every reply
 *   lateReply      (number)  one-shot: delay the next confirmed reply by N ms
 *   truncate       (bool)    one-shot: cut the next reply short (BVLC length still says full)
 *   badBvlcLength  (bool)    one-shot: BVLC length field that does not match the datagram
 *   wrongInvokeId  (bool)    one-shot: answer with invoke id + 1
 *   wrongService   (bool)    one-shot: ComplexACK with the other read service choice
 *   abortNext      (number)  one-shot: Abort with this reason
 *   rejectNext     (number)  one-shot: Reject with this reason
 *   errorNext      ([cls, code]) one-shot: Error PDU
 *   rpmWholeError  (bool)    an RPM naming any unknown object is answered with ONE Error PDU
 *   segmentedReply (bool)    one-shot: send a ComplexACK flagged segmented
 */

const dgram = require('dgram');

const OBJ = { 'analog-input': 0, 'analog-output': 1, 'analog-value': 2, 'binary-input': 3, 'binary-output': 4, 'binary-value': 5, device: 8, 'multi-state-input': 13, 'multi-state-output': 14, 'multi-state-value': 19, 'characterstring-value': 40, 'date-value': 42, 'integer-value': 45, 'large-analog-value': 46, 'octetstring-value': 47, 'bitstring-value': 39, 'time-value': 50, 'positive-integer-value': 48, schedule: 17 };
const P = { objectIdentifier: 75, objectName: 77, objectType: 79, presentValue: 85, statusFlags: 111, reliability: 103, outOfService: 81, units: 117, description: 28, objectList: 76, maxApdu: 62, segmentation: 107, vendorId: 120, vendorName: 121, modelName: 70, firmware: 44, appVersion: 12, protocolRevision: 139, stateText: 110, numberOfStates: 74, priorityArray: 87, activeText: 4, inactiveText: 46 };

// ---- independent encoder ------------------------------------------------------------------------

function hdr(tag, ctx, len) {
  const out = [];
  const first = (tag <= 14 ? tag << 4 : 0xf0) | (ctx ? 0x08 : 0);
  if (len <= 4) out.push(first | len);
  else if (len < 254) out.push(first | 5);
  else out.push(first | 5);
  if (tag > 14) out.push(tag);
  if (len > 4 && len < 254) out.push(len);
  else if (len >= 254) out.push(254, (len >> 8) & 0xff, len & 0xff);
  return Buffer.from(out);
}

function uintBuf(v) {
  if (v < 0x100) return Buffer.from([v]);
  if (v < 0x10000) return Buffer.from([v >> 8, v & 0xff]);
  if (v < 0x1000000) return Buffer.from([v >> 16, (v >> 8) & 0xff, v & 0xff]);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

function app(tag, content) {
  return Buffer.concat([hdr(tag, false, content.length), content]);
}

function ctxPrim(tag, content) {
  return Buffer.concat([hdr(tag, true, content.length), content]);
}

const open = (t) => Buffer.from([t <= 14 ? (t << 4) | 0x0e : 0xfe, ...(t > 14 ? [t] : [])]);
const close = (t) => Buffer.from([t <= 14 ? (t << 4) | 0x0f : 0xff, ...(t > 14 ? [t] : [])]);

function oidBuf(type, inst) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(((type << 22) | inst) >>> 0);
  return b;
}

/** Value spec -> application-tagged bytes. */
function encodeValue(spec) {
  if (Array.isArray(spec)) return Buffer.concat(spec.map(encodeValue));
  switch (spec.t) {
    case 'null':
      return Buffer.from([0x00]);
    case 'bool':
      return Buffer.from([0x10 | (spec.v ? 1 : 0)]);
    case 'uint':
      return app(2, uintBuf(spec.v));
    case 'signed': {
      const v = spec.v;
      let b;
      if (v >= -128 && v <= 127) b = Buffer.from([v & 0xff]);
      else if (v >= -32768 && v <= 32767) {
        b = Buffer.alloc(2);
        b.writeInt16BE(v);
      } else {
        b = Buffer.alloc(4);
        b.writeInt32BE(v);
      }
      return app(3, b);
    }
    case 'real': {
      const b = Buffer.alloc(4);
      b.writeFloatBE(spec.v);
      return app(4, b);
    }
    case 'double': {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(spec.v);
      return app(5, b);
    }
    case 'octet':
      return app(6, Buffer.from(spec.v, 'hex'));
    case 'str': {
      const cs = spec.charset || 'utf8';
      let body;
      if (cs === 'ucs2') {
        body = Buffer.from(spec.v, 'utf16le');
        body.swap16();
        body = Buffer.concat([Buffer.from([4]), body]);
      } else if (cs === 'latin1') body = Buffer.concat([Buffer.from([5]), Buffer.from(spec.v, 'latin1')]);
      else body = Buffer.concat([Buffer.from([0]), Buffer.from(spec.v, 'utf8')]);
      return app(7, body);
    }
    case 'bits': {
      const n = spec.v.length;
      const bytes = Buffer.alloc(Math.ceil(n / 8));
      spec.v.forEach((bit, i) => {
        if (bit) bytes[i >> 3] |= 0x80 >> (i & 7);
      });
      const unused = bytes.length * 8 - n;
      return app(8, Buffer.concat([Buffer.from([unused]), bytes]));
    }
    case 'enum':
      return app(9, uintBuf(spec.v));
    case 'date':
      return app(10, Buffer.from([spec.year - 1900, spec.month, spec.day, spec.dow ?? 255]));
    case 'time':
      return app(11, Buffer.from([spec.h, spec.m, spec.s, spec.hs ?? 0]));
    case 'oid':
      return app(12, oidBuf(spec.type, spec.inst));
    case 'raw':
      return Buffer.from(spec.hex, 'hex');
    default:
      throw new Error(`simulator: unknown value spec ${spec.t}`);
  }
}

// ---- independent decoder (requests only) -------------------------------------------------------

function readTag(buf, o) {
  const first = buf[o];
  let p = o + 1;
  let tag = first >> 4;
  if (tag === 15) tag = buf[p++];
  const ctx = (first & 8) !== 0;
  const lvt = first & 7;
  if (ctx && lvt === 6) return { tag, ctx, open: true, next: p };
  if (ctx && lvt === 7) return { tag, ctx, close: true, next: p };
  let len = lvt;
  if (lvt === 5) {
    len = buf[p++];
    if (len === 254) {
      len = buf.readUInt16BE(p);
      p += 2;
    }
  }
  if (p + len > buf.length) throw new Error('truncated');
  return { tag, ctx, len, at: p, next: p + len };
}

function uintAt(buf, at, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[at + i];
  return v;
}

// ---- default device ----------------------------------------------------------------------------

function defaultObjects() {
  return {
    'analog-input:1': { [P.objectName]: { t: 'str', v: 'Zone Temp' }, [P.presentValue]: { t: 'real', v: 21.5 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.reliability]: { t: 'enum', v: 0 }, [P.outOfService]: { t: 'bool', v: false }, [P.units]: { t: 'enum', v: 62 }, [P.description]: { t: 'str', v: 'Room 101 temperature' } },
    'analog-input:2': { [P.objectName]: { t: 'str', v: 'Supply Pressure' }, [P.presentValue]: { t: 'real', v: 101.3 }, [P.statusFlags]: { t: 'bits', v: [false, true, false, false] }, [P.reliability]: { t: 'enum', v: 2 }, [P.outOfService]: { t: 'bool', v: false }, [P.units]: { t: 'enum', v: 54 } },
    'analog-value:7': { [P.objectName]: { t: 'str', v: 'Setpoint' }, [P.presentValue]: { t: 'real', v: 22 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, true] }, [P.outOfService]: { t: 'bool', v: true }, [P.units]: { t: 'enum', v: 62 } },
    'analog-output:3': { [P.objectName]: { t: 'str', v: 'Valve' }, [P.presentValue]: { t: 'real', v: 45.25 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.outOfService]: { t: 'bool', v: false }, [P.units]: { t: 'enum', v: 98 }, [P.priorityArray]: [{ t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'real', v: 45.25 }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }, { t: 'null' }] },
    'binary-input:2': { [P.objectName]: { t: 'str', v: 'Fan Status' }, [P.presentValue]: { t: 'enum', v: 1 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.outOfService]: { t: 'bool', v: false }, [P.activeText]: { t: 'str', v: 'On' } },
    'binary-value:4': { [P.objectName]: { t: 'str', v: 'Occupied' }, [P.presentValue]: { t: 'enum', v: 0 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.outOfService]: { t: 'bool', v: false } },
    'binary-output:1': { [P.objectName]: { t: 'str', v: 'Pump Cmd' }, [P.presentValue]: { t: 'enum', v: 1 }, [P.statusFlags]: { t: 'bits', v: [false, false, true, false] }, [P.outOfService]: { t: 'bool', v: false } },
    'multi-state-value:1': { [P.objectName]: { t: 'str', v: 'Mode' }, [P.presentValue]: { t: 'uint', v: 2 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.outOfService]: { t: 'bool', v: false }, [P.numberOfStates]: { t: 'uint', v: 3 }, [P.stateText]: [{ t: 'str', v: 'Off' }, { t: 'str', v: 'Auto' }, { t: 'str', v: 'Manual' }] },
    'multi-state-input:5': { [P.objectName]: { t: 'str', v: 'Stage' }, [P.presentValue]: { t: 'uint', v: 1 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.outOfService]: { t: 'bool', v: false } },
    'characterstring-value:1': { [P.objectName]: { t: 'str', v: 'Label' }, [P.presentValue]: { t: 'str', v: 'Grüße', charset: 'ucs2' }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'characterstring-value:2': { [P.objectName]: { t: 'str', v: 'Latin' }, [P.presentValue]: { t: 'str', v: 'Café', charset: 'latin1' }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'integer-value:1': { [P.objectName]: { t: 'str', v: 'Offset' }, [P.presentValue]: { t: 'signed', v: -1234 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'large-analog-value:1': { [P.objectName]: { t: 'str', v: 'Energy' }, [P.presentValue]: { t: 'double', v: 123456789.125 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] }, [P.units]: { t: 'enum', v: 19 } },
    'octetstring-value:1': { [P.objectName]: { t: 'str', v: 'Raw' }, [P.presentValue]: { t: 'octet', v: 'deadbeef' }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'bitstring-value:1': { [P.objectName]: { t: 'str', v: 'Flags' }, [P.presentValue]: { t: 'bits', v: [true, false, true] }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'date-value:1': { [P.objectName]: { t: 'str', v: 'Holiday' }, [P.presentValue]: { t: 'date', year: 2026, month: 12, day: 25, dow: 5 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'time-value:1': { [P.objectName]: { t: 'str', v: 'Start' }, [P.presentValue]: { t: 'time', h: 7, m: 30, s: 0, hs: 0 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'positive-integer-value:1': { [P.objectName]: { t: 'str', v: 'Count' }, [P.presentValue]: { t: 'uint', v: 70000 }, [P.statusFlags]: { t: 'bits', v: [false, false, false, false] } },
    'schedule:1': { [P.objectName]: { t: 'str', v: 'Weekly' } },
  };
}

class BacnetSimulator {
  /**
   * @param {object} [o]
   * @param {number} [o.deviceInstance]
   * @param {object} [o.objects] 'type-name:instance' -> { propId: valueSpec }
   * @param {boolean} [o.rpm] ReadPropertyMultiple supported (default true)
   * @param {number} [o.maxApdu] device max APDU (default 480); no segmentation either way
   * @param {{network:number, mac:Buffer}} [o.routed] act as a router with the device behind it
   * @param {boolean} [o.iAmBroadcastOnly] never answer Who-Is with a unicast I-Am
   * @param {boolean} [o.replyFromOtherPort] send every reply from a second socket
   * @param {number} [o.vendorId]
   */
  constructor(o = {}) {
    this.deviceInstance = o.deviceInstance ?? 1234;
    this.rpm = o.rpm !== false;
    this.maxApdu = o.maxApdu ?? 480;
    this.routed = o.routed || null;
    this.iAmBroadcastOnly = Boolean(o.iAmBroadcastOnly);
    this.replyFromOtherPort = Boolean(o.replyFromOtherPort);
    this.vendorId = o.vendorId ?? 999;
    this.objects = new Map();
    const objs = o.objects || defaultObjects();
    for (const [k, props] of Object.entries(objs)) this._addObject(k, props);
    this._addObject(`device:${this.deviceInstance}`, {
      [P.objectName]: { t: 'str', v: o.deviceName || 'Sim AHU-1' },
      [P.vendorName]: { t: 'str', v: 'Manifold Test Vendor' },
      [P.vendorId]: { t: 'uint', v: this.vendorId },
      [P.modelName]: { t: 'str', v: o.modelName || 'SIM-BAC-1' },
      [P.firmware]: { t: 'str', v: '1.2.3' },
      [P.appVersion]: { t: 'str', v: '4.5' },
      [P.protocolRevision]: { t: 'uint', v: 14 },
      [P.maxApdu]: { t: 'uint', v: this.maxApdu },
      [P.segmentation]: { t: 'enum', v: 3 },
      ...(o.deviceProps || {}),
    });
    this.faults = {};
    this.stats = { requests: 0, rp: 0, rpm: 0, whoIs: 0, writesReceived: 0, broadcasts: 0, services: [], sources: [] };
    this.sock = null;
    this.alt = null;
    this.port = null;
  }

  _key(type, inst) {
    return `${type}:${inst}`;
  }

  _addObject(name, props) {
    const [t, i] = name.split(':');
    const type = /^\d+$/.test(t) ? Number(t) : OBJ[t];
    if (type === undefined) throw new Error(`simulator: unknown object type ${t}`);
    this.objects.set(this._key(type, Number(i)), { type, inst: Number(i), props: { ...props } });
  }

  /** object-list of the device: every object, the device first. */
  _objectList() {
    const devKey = this._key(8, this.deviceInstance);
    const keys = [devKey, ...[...this.objects.keys()].filter((k) => k !== devKey)];
    return keys.map((k) => {
      const o = this.objects.get(k);
      return { t: 'oid', type: o.type, inst: o.inst };
    });
  }

  addObjects(map) {
    for (const [k, props] of Object.entries(map)) this._addObject(k, props);
  }

  setValue(name, prop, spec) {
    const [t, i] = name.split(':');
    const type = /^\d+$/.test(t) ? Number(t) : OBJ[t];
    const o = this.objects.get(this._key(type, Number(i)));
    if (!o) throw new Error(`simulator: no object ${name}`);
    o.props[prop] = spec;
  }

  async start(port = 0) {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    await new Promise((resolve) => this.sock.bind(port, '127.0.0.1', resolve));
    this.port = this.sock.address().port;
    if (this.replyFromOtherPort) {
      this.alt = dgram.createSocket('udp4');
      await new Promise((resolve) => this.alt.bind(0, '127.0.0.1', resolve));
    }
    return this;
  }

  async stop() {
    for (const s of [this.sock, this.alt]) {
      if (!s) continue;
      await new Promise((resolve) => {
        try {
          s.close(resolve);
        } catch {
          resolve();
        }
      });
    }
    this.sock = this.alt = null;
  }

  // ---- framing -----------------------------------------------------------------------------------

  _wrap(apdu, { networkMessage = null, snet = null } = {}) {
    const parts = [];
    let control = 0;
    const src = snet || (this.routed ? this.routed : null);
    if (src) {
      control |= 0x08;
      const s = Buffer.alloc(3);
      s.writeUInt16BE(src.network);
      s[2] = src.mac.length;
      parts.push(s, src.mac);
    }
    if (networkMessage) control |= 0x80;
    const npdu = Buffer.concat([Buffer.from([1, control]), ...parts, networkMessage || apdu]);
    const head = Buffer.from([0x81, 0x0a, 0, 0]);
    head.writeUInt16BE(npdu.length + 4, 2);
    return Buffer.concat([head, npdu]);
  }

  _send(packet, rinfo, delay = 0) {
    const sock = this.replyFromOtherPort && this.alt ? this.alt : this.sock;
    const go = () => {
      if (sock) sock.send(packet, rinfo.port, rinfo.address);
    };
    const d = delay + (this.faults.delayMs || 0);
    if (d > 0) setTimeout(go, d).unref?.();
    else go();
  }

  _onMessage(msg, rinfo) {
    if (this.faults.blackhole) return;
    this.stats.sources.push(`${rinfo.address}:${rinfo.port}`);
    if (msg.length < 4 || msg[0] !== 0x81 || msg.readUInt16BE(2) !== msg.length) return;
    if (msg[1] === 0x0b) this.stats.broadcasts++;
    if (msg[1] !== 0x0a && msg[1] !== 0x0b) {
      this.stats.writesReceived++; // any BVLC management function (Register-Foreign-Device, Write-BDT ...)
      return;
    }
    let p = 4;
    if (msg[p] !== 1) return;
    const control = msg[p + 1];
    p += 2;
    let dnet = null;
    let dadr = null;
    if (control & 0x20) {
      dnet = msg.readUInt16BE(p);
      const len = msg[p + 2];
      dadr = msg.subarray(p + 3, p + 3 + len);
      p += 3 + len;
    }
    if (control & 0x08) {
      const len = msg[p + 2];
      p += 3 + len;
    }
    if (control & 0x20) p++; // hop count
    if (control & 0x80) {
      this.stats.writesReceived++; // network-layer messages are never expected from the driver
      return;
    }
    // Routing checks
    if (this.routed) {
      if (dnet === null && !this.routed.answerLocal) return; // the router itself has nothing to say
      if (dnet !== null && dnet !== this.routed.network) {
        const m = Buffer.from([0x03, 0x01, 0, 0]);
        m.writeUInt16BE(dnet, 2);
        this._send(this._wrap(null, { networkMessage: m, snet: null }).subarray(0), rinfo);
        return;
      }
      if (dnet !== null && !dadr.equals(this.routed.mac)) return; // nobody with that MAC
    } else if (dnet !== null) {
      return; // not a router
    }
    const apdu = msg.subarray(p);
    try {
      this._onApdu(apdu, rinfo);
    } catch {
      /* malformed request: a real device would Reject; ignoring keeps the test signal clear */
    }
  }

  _onApdu(apdu, rinfo) {
    const type = apdu[0] >> 4;
    if (type === 1) {
      const service = apdu[1];
      this.stats.services.push(`u${service}`);
      if (service !== 8) {
        this.stats.writesReceived++;
        return;
      }
      this.stats.whoIs++;
      let low = null;
      let high = null;
      if (apdu.length > 2) {
        const a = readTag(apdu, 2);
        low = uintAt(apdu, a.at, a.len);
        const b = readTag(apdu, a.next);
        high = uintAt(apdu, b.at, b.len);
      }
      if (low !== null && (this.deviceInstance < low || this.deviceInstance > high)) return;
      if (this.iAmBroadcastOnly) return;
      const body = Buffer.concat([app(12, oidBuf(8, this.deviceInstance)), app(2, uintBuf(this.maxApdu)), app(9, uintBuf(3)), app(2, uintBuf(this.vendorId))]);
      this._send(this._wrap(Buffer.concat([Buffer.from([0x10, 0x00]), body])), rinfo);
      return;
    }
    if (type !== 0) return;
    if (apdu[0] & 0x08) return; // segmented requests are not expected
    const invokeId = apdu[2];
    const service = apdu[3];
    this.stats.requests++;
    this.stats.services.push(service);
    if (this.faults.dropNext > 0) {
      this.faults.dropNext--;
      return;
    }
    const reply = (buf) => {
      let packet = this._wrap(buf);
      let delay = 0;
      if (this.faults.lateReply) {
        delay = this.faults.lateReply;
        this.faults.lateReply = 0;
      }
      if (this.faults.truncate) {
        this.faults.truncate = false;
        packet = packet.subarray(0, packet.length - 3);
        packet.writeUInt16BE(packet.length, 2); // consistent BVLC, truncated APDU
      }
      if (this.faults.badBvlcLength) {
        this.faults.badBvlcLength = false;
        packet = Buffer.from(packet);
        packet.writeUInt16BE(packet.length + 5, 2);
      }
      this._send(packet, rinfo, delay);
    };
    const id = this.faults.wrongInvokeId ? (invokeId + 1) & 0xff : invokeId;
    this.faults.wrongInvokeId = false;
    if (this.faults.abortNext !== undefined) {
      const r = this.faults.abortNext;
      delete this.faults.abortNext;
      return reply(Buffer.from([0x71, id, r]));
    }
    if (this.faults.rejectNext !== undefined) {
      const r = this.faults.rejectNext;
      delete this.faults.rejectNext;
      return reply(Buffer.from([0x60, id, r]));
    }
    if (this.faults.errorNext) {
      const [c, e] = this.faults.errorNext;
      delete this.faults.errorNext;
      return reply(Buffer.concat([Buffer.from([0x50, id, service]), app(9, uintBuf(c)), app(9, uintBuf(e))]));
    }
    if (service === 12) {
      this.stats.rp++;
      return reply(this._readProperty(id, apdu.subarray(4)));
    }
    if (service === 14) {
      this.stats.rpm++;
      if (!this.rpm) return reply(Buffer.from([0x60, id, 9])); // Reject: unrecognized-service
      return reply(this._readPropertyMultiple(id, apdu.subarray(4)));
    }
    this.stats.writesReceived++;
    return reply(Buffer.from([0x60, id, 9]));
  }

  _resolve(type, inst) {
    if (type === 8 && inst === 4194303) inst = this.deviceInstance;
    return this.objects.get(this._key(type, inst)) || null;
  }

  /** -> { value:Buffer } | { error:[cls, code] } */
  _value(type, inst, prop, index) {
    const o = this._resolve(type, inst);
    if (!o) return { error: [1, 31] }; // object / unknown-object
    let spec;
    if (prop === P.objectIdentifier) spec = { t: 'oid', type: o.type, inst: o.inst };
    else if (prop === P.objectType) spec = { t: 'enum', v: o.type };
    else if (prop === P.objectList && o.type === 8) spec = this._objectList();
    else spec = o.props[prop];
    if (spec === undefined) return { error: [2, 32] }; // property / unknown-property
    const fault = this.faults.errorFor && this.faults.errorFor[`${type}:${inst}:${prop}`];
    if (fault) return { error: fault };
    if (index !== undefined) {
      if (!Array.isArray(spec)) return { error: [2, 50] }; // property-is-not-an-array
      if (index === 0) return { value: encodeValue({ t: 'uint', v: spec.length }) };
      if (index > spec.length) return { error: [2, 42] }; // invalid-array-index
      return { value: encodeValue(spec[index - 1]) };
    }
    return { value: encodeValue(spec) };
  }

  _fits(apdu) {
    return apdu.length <= this.maxApdu;
  }

  _ack(id, service, body) {
    if (this.faults.segmentedReply) {
      this.faults.segmentedReply = false;
      return Buffer.concat([Buffer.from([0x3c, id, 0, 1, service]), body]);
    }
    const svc = this.faults.wrongService ? (service === 12 ? 14 : 12) : service;
    this.faults.wrongService = false;
    const out = Buffer.concat([Buffer.from([0x30, id, svc]), body]);
    return this._fits(out) ? out : Buffer.from([0x71, id, 4]); // Abort (server): segmentation-not-supported
  }

  _readProperty(id, body) {
    const a = readTag(body, 0);
    const raw = body.readUInt32BE(a.at);
    const type = raw >>> 22;
    const inst = raw & 0x3fffff;
    const b = readTag(body, a.next);
    const prop = uintAt(body, b.at, b.len);
    let index;
    if (b.next < body.length) {
      const c = readTag(body, b.next);
      index = uintAt(body, c.at, c.len);
    }
    const r = this._value(type, inst, prop, index);
    if (r.error) return Buffer.concat([Buffer.from([0x50, id, 12]), app(9, uintBuf(r.error[0])), app(9, uintBuf(r.error[1]))]);
    const o = this._resolve(type, inst);
    const parts = [ctxPrim(0, oidBuf(o.type, o.inst)), ctxPrim(1, uintBuf(prop))];
    if (index !== undefined) parts.push(ctxPrim(2, uintBuf(index)));
    parts.push(open(3), r.value, close(3));
    return this._ack(id, 12, Buffer.concat(parts));
  }

  _readPropertyMultiple(id, body) {
    const specs = [];
    let p = 0;
    while (p < body.length) {
      const a = readTag(body, p);
      const raw = body.readUInt32BE(a.at);
      p = a.next;
      const o = readTag(body, p);
      if (!o.open) throw new Error('bad rpm');
      p = o.next;
      const refs = [];
      for (;;) {
        const t = readTag(body, p);
        if (t.close) {
          p = t.next;
          break;
        }
        const prop = uintAt(body, t.at, t.len);
        p = t.next;
        let index;
        const n = readTag(body, p);
        if (!n.close && n.tag === 1) {
          index = uintAt(body, n.at, n.len);
          p = n.next;
        }
        refs.push({ prop, index });
      }
      specs.push({ type: raw >>> 22, inst: raw & 0x3fffff, refs });
    }
    if (this.faults.rpmWholeError && specs.some((s) => !this._resolve(s.type, s.inst))) {
      return Buffer.concat([Buffer.from([0x50, id, 14]), app(9, uintBuf(1)), app(9, uintBuf(31))]);
    }
    const parts = [];
    for (const s of specs) {
      const o = this._resolve(s.type, s.inst);
      parts.push(ctxPrim(0, oidBuf(o ? o.type : s.type, o ? o.inst : s.inst)), open(1));
      for (const r of s.refs) {
        parts.push(ctxPrim(2, uintBuf(r.prop)));
        if (r.index !== undefined) parts.push(ctxPrim(3, uintBuf(r.index)));
        const v = this._value(s.type, s.inst, r.prop, r.index);
        if (v.error) parts.push(open(5), app(9, uintBuf(v.error[0])), app(9, uintBuf(v.error[1])), close(5));
        else parts.push(open(4), v.value, close(4));
      }
      parts.push(close(1));
    }
    return this._ack(id, 14, Buffer.concat(parts));
  }
}

async function startBacnetSimulator(opts = {}) {
  const sim = new BacnetSimulator(opts);
  await sim.start(opts.port || 0);
  return sim;
}

module.exports = { BacnetSimulator, startBacnetSimulator, encodeValue, P, OBJ };
