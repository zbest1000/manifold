'use strict';

/**
 * BACnet/IP framing: BVLC (Annex J) + NPDU (clause 6) + APDU (clause 20).
 *
 * READ-ONLY BY CONSTRUCTION. Every datagram the driver or the Discovery probe sends is
 * built by `encodePacket`, which accepts exactly:
 *   - BVLC Original-Unicast-NPDU (never Original-Broadcast, never Register-Foreign-Device,
 *     Write-Broadcast-Distribution-Table or any other BVLC function: those change state on a BBMD);
 *   - an NPDU carrying an APDU (never a network-layer message);
 *   - APDU = Confirmed-Request ReadProperty (12) or ReadPropertyMultiple (14), unsegmented,
 *     or Unconfirmed-Request Who-Is (8).
 * Everything else (WriteProperty, WritePropertyMultiple, SubscribeCOV, DeviceCommunicationControl,
 * ReinitializeDevice, Create/DeleteObject, list edits, file writes, private transfer, time
 * synchronisation, I-Am, segment acknowledgements ...) is refused with BacnetReadOnlyError before
 * a byte reaches a socket. There are no encoders for those services at all.
 */

const enc = require('./encoding');

const BVLC_TYPE = 0x81;
const BVLC = Object.freeze({ RESULT: 0x00, FORWARDED_NPDU: 0x04, ORIGINAL_UNICAST: 0x0a, ORIGINAL_BROADCAST: 0x0b });
const PDU = Object.freeze({ CONFIRMED: 0, UNCONFIRMED: 1, SIMPLE_ACK: 2, COMPLEX_ACK: 3, SEGMENT_ACK: 4, ERROR: 5, REJECT: 6, ABORT: 7 });
const SERVICE = Object.freeze({ READ_PROPERTY: 12, READ_PROPERTY_MULTIPLE: 14 });
const UNCONFIRMED = Object.freeze({ I_AM: 0, WHO_IS: 8 });

const ALLOWED_CONFIRMED = new Set([SERVICE.READ_PROPERTY, SERVICE.READ_PROPERTY_MULTIPLE]);
const ALLOWED_UNCONFIRMED = new Set([UNCONFIRMED.WHO_IS]);

/** Confirmed service names (clause 21), for refusal and error messages. */
const CONFIRMED_NAMES = {
  0: 'acknowledgeAlarm', 1: 'confirmedCOVNotification', 2: 'confirmedEventNotification', 3: 'getAlarmSummary', 4: 'getEnrollmentSummary',
  5: 'subscribeCOV', 6: 'atomicReadFile', 7: 'atomicWriteFile', 8: 'addListElement', 9: 'removeListElement', 10: 'createObject',
  11: 'deleteObject', 12: 'readProperty', 13: 'readPropertyConditional', 14: 'readPropertyMultiple', 15: 'writeProperty',
  16: 'writePropertyMultiple', 17: 'deviceCommunicationControl', 18: 'confirmedPrivateTransfer', 19: 'confirmedTextMessage',
  20: 'reinitializeDevice', 21: 'vtOpen', 22: 'vtClose', 23: 'vtData', 26: 'readRange', 27: 'lifeSafetyOperation',
  28: 'subscribeCOVProperty', 29: 'getEventInformation', 30: 'subscribeCOVPropertyMultiple', 31: 'confirmedCOVNotificationMultiple',
  32: 'confirmedAuditNotification', 33: 'auditLogQuery',
};

const MAX_APDU_SIZES = [50, 128, 206, 480, 1024, 1476];
/** Largest APDU this client accepts (BACnet/IP over Ethernet: 1476). */
const OUR_MAX_APDU = 1476;

class BacnetReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BacnetReadOnlyError';
  }
}

class BacnetFramingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BacnetFramingError';
  }
}

function maxApduCode(size) {
  let code = 0;
  for (let i = 0; i < MAX_APDU_SIZES.length; i++) if (MAX_APDU_SIZES[i] <= size) code = i;
  return code;
}

// ---- service parameter encoders (read services only) ---------------------------------------------

function encodeReadPropertyParams({ objectType, instance, property, index }) {
  const parts = [enc.contextObjectId(0, objectType, instance), enc.contextUnsigned(1, property)];
  if (index !== undefined && index !== null) parts.push(enc.contextUnsigned(2, index));
  return Buffer.concat(parts);
}

/** specs: [{ objectType, instance, refs: [{ property, index? }] }] */
function encodeReadPropertyMultipleParams(specs) {
  if (!Array.isArray(specs) || !specs.length) throw new RangeError('ReadPropertyMultiple needs at least one object');
  const parts = [];
  for (const s of specs) {
    if (!Array.isArray(s.refs) || !s.refs.length) throw new RangeError('ReadPropertyMultiple needs at least one property per object');
    parts.push(enc.contextObjectId(0, s.objectType, s.instance), enc.opening(1));
    for (const r of s.refs) {
      parts.push(enc.contextUnsigned(0, r.property));
      if (r.index !== undefined && r.index !== null) parts.push(enc.contextUnsigned(1, r.index));
    }
    parts.push(enc.closing(1));
  }
  return Buffer.concat(parts);
}

function encodeWhoIsParams({ low, high } = {}) {
  if (low === undefined && high === undefined) return Buffer.alloc(0);
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high > enc.MAX_INSTANCE || low > high) {
    throw new RangeError('Who-Is limits must be 0 <= low <= high <= 4194303');
  }
  return Buffer.concat([enc.contextUnsigned(0, low), enc.contextUnsigned(1, high)]);
}

// ---- APDU builders -------------------------------------------------------------------------------

/** Confirmed-Request header: unsegmented, segmented-response NOT accepted (we never reassemble). */
function confirmedApdu({ invokeId, service, params, maxApdu = OUR_MAX_APDU }) {
  if (!Number.isInteger(invokeId) || invokeId < 0 || invokeId > 255) throw new RangeError('invokeId must be 0..255');
  const head = Buffer.from([PDU.CONFIRMED << 4, maxApduCode(maxApdu) & 0x0f, invokeId, service]);
  return Buffer.concat([head, params]);
}

function unconfirmedApdu({ service, params }) {
  return Buffer.concat([Buffer.from([PDU.UNCONFIRMED << 4, service]), params]);
}

/**
 * The read-only allowlist, applied to the finished APDU bytes (so nothing can be smuggled in by a
 * caller that builds its own buffer).
 * @throws {BacnetReadOnlyError}
 */
function assertReadOnly(apdu) {
  if (!Buffer.isBuffer(apdu) || apdu.length < 2) throw new BacnetReadOnlyError('empty APDU');
  const type = apdu[0] >> 4;
  if (type === PDU.CONFIRMED) {
    if (apdu.length < 4) throw new BacnetReadOnlyError('truncated confirmed request');
    if (apdu[0] & 0x0c) throw new BacnetReadOnlyError('segmented requests are not sent');
    const service = apdu[3];
    if (!ALLOWED_CONFIRMED.has(service)) {
      throw new BacnetReadOnlyError(`refused: confirmed service ${service} (${CONFIRMED_NAMES[service] || 'unknown'}) is not a read; this driver only sends ReadProperty and ReadPropertyMultiple`);
    }
    return;
  }
  if (type === PDU.UNCONFIRMED) {
    if (!ALLOWED_UNCONFIRMED.has(apdu[1])) throw new BacnetReadOnlyError(`refused: unconfirmed service ${apdu[1]} is not sent (only Who-Is)`);
    return;
  }
  throw new BacnetReadOnlyError(`refused: APDU type ${type} is not sent by this client`);
}

/**
 * NPDU (clause 6.2). `route` = { network, mac:Buffer } addresses a device behind a router
 * (DNET/DADR, hop count 255); without it the device is on the local B/IP network.
 */
function encodeNpdu(apdu, { route = null, expectReply = false } = {}) {
  let control = expectReply ? 0x04 : 0x00;
  const parts = [];
  if (route) {
    const { network, mac } = route;
    if (!Number.isInteger(network) || network < 1 || network > 0xfffe) throw new RangeError('route network must be 1..65534');
    if (!Buffer.isBuffer(mac) || mac.length > 255) throw new RangeError('route MAC must be a Buffer of at most 255 bytes');
    control |= 0x20;
    const d = Buffer.alloc(3);
    d.writeUInt16BE(network, 0);
    d[2] = mac.length;
    parts.push(d, mac);
  }
  const head = Buffer.from([0x01, control]);
  const tail = route ? [Buffer.from([0xff])] : [];
  return Buffer.concat([head, ...parts, ...tail, apdu]);
}

/** The single function through which every outgoing datagram is built. */
function encodePacket(apdu, { route = null } = {}) {
  assertReadOnly(apdu);
  const npdu = encodeNpdu(apdu, { route, expectReply: (apdu[0] >> 4) === PDU.CONFIRMED });
  const head = Buffer.alloc(4);
  head[0] = BVLC_TYPE;
  head[1] = BVLC.ORIGINAL_UNICAST;
  head.writeUInt16BE(npdu.length + 4, 2);
  return Buffer.concat([head, npdu]);
}

function readPropertyPacket(invokeId, ref, opts = {}) {
  return encodePacket(confirmedApdu({ invokeId, service: SERVICE.READ_PROPERTY, params: encodeReadPropertyParams(ref) }), opts);
}

function readPropertyMultiplePacket(invokeId, specs, opts = {}) {
  return encodePacket(confirmedApdu({ invokeId, service: SERVICE.READ_PROPERTY_MULTIPLE, params: encodeReadPropertyMultipleParams(specs) }), opts);
}

function whoIsPacket(limits, opts = {}) {
  return encodePacket(unconfirmedApdu({ service: UNCONFIRMED.WHO_IS, params: encodeWhoIsParams(limits) }), opts);
}

// ---- decoding ------------------------------------------------------------------------------------

const NETWORK_REJECT_REASONS = {
  0: 'other error',
  1: 'the router cannot reach the destination network',
  2: 'the router is busy',
  3: 'unknown network-layer message type',
  4: 'message too long for the destination network',
  5: 'security error',
  6: 'addressing error',
};

/**
 * Decode one received datagram.
 * @returns {{bvlcFunction:number, bvlcResult?:number, forwardedFrom?:string, npdu?:object, apdu?:Buffer, networkMessage?:object}}
 * @throws {BacnetFramingError}
 */
function decodePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new BacnetFramingError('datagram shorter than a BVLC header');
  if (buf[0] !== BVLC_TYPE) throw new BacnetFramingError(`not BACnet/IP (BVLC type 0x${buf[0].toString(16)})`);
  const fn = buf[1];
  const len = buf.readUInt16BE(2);
  if (len !== buf.length) throw new BacnetFramingError(`BVLC length ${len} does not match the datagram (${buf.length} bytes)`);
  if (fn === BVLC.RESULT) {
    if (buf.length < 6) throw new BacnetFramingError('truncated BVLC-Result');
    return { bvlcFunction: fn, bvlcResult: buf.readUInt16BE(4) };
  }
  let p = 4;
  let forwardedFrom;
  if (fn === BVLC.FORWARDED_NPDU) {
    if (buf.length < 10) throw new BacnetFramingError('truncated Forwarded-NPDU');
    forwardedFrom = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}:${buf.readUInt16BE(8)}`;
    p = 10;
  } else if (fn !== BVLC.ORIGINAL_UNICAST && fn !== BVLC.ORIGINAL_BROADCAST) {
    return { bvlcFunction: fn }; // BBMD management traffic: not for us
  }
  const npdu = decodeNpdu(buf, p);
  const out = { bvlcFunction: fn, npdu };
  if (forwardedFrom) out.forwardedFrom = forwardedFrom;
  if (npdu.networkMessage) out.networkMessage = npdu.networkMessage;
  else out.apdu = buf.subarray(npdu.apduOffset);
  return out;
}

function decodeNpdu(buf, off) {
  if (off + 2 > buf.length) throw new BacnetFramingError('truncated NPDU');
  if (buf[off] !== 0x01) throw new BacnetFramingError(`unsupported NPDU version ${buf[off]}`);
  const control = buf[off + 1];
  let p = off + 2;
  const need = (n) => {
    if (p + n > buf.length) throw new BacnetFramingError('truncated NPDU address');
  };
  const out = { control, priority: control & 0x03, expectingReply: (control & 0x04) !== 0 };
  if (control & 0x20) {
    need(3);
    out.dnet = buf.readUInt16BE(p);
    const dlen = buf[p + 2];
    p += 3;
    need(dlen);
    out.dadr = Buffer.from(buf.subarray(p, p + dlen));
    p += dlen;
  }
  if (control & 0x08) {
    need(3);
    out.snet = buf.readUInt16BE(p);
    const slen = buf[p + 2];
    p += 3;
    if (slen === 0) throw new BacnetFramingError('source network with an empty SADR');
    need(slen);
    out.sadr = Buffer.from(buf.subarray(p, p + slen));
    p += slen;
  }
  if (control & 0x20) {
    need(1);
    out.hopCount = buf[p++];
  }
  if (control & 0x80) {
    need(1);
    const type = buf[p++];
    const msg = { type };
    if (type >= 0x80) {
      need(2);
      msg.vendorId = buf.readUInt16BE(p);
      p += 2;
    }
    if (type === 0x03 && p + 3 <= buf.length) {
      msg.reason = buf[p];
      msg.reasonText = NETWORK_REJECT_REASONS[buf[p]] || `reason ${buf[p]}`;
      msg.network = buf.readUInt16BE(p + 1);
    }
    out.networkMessage = msg;
  }
  out.apduOffset = p;
  return out;
}

/**
 * Decode the fixed APDU header.
 * @returns {object} { type, invokeId, service, ... , body:Buffer }
 */
function decodeApdu(apdu) {
  if (!apdu || apdu.length < 1) throw new BacnetFramingError('empty APDU');
  const type = apdu[0] >> 4;
  const need = (n, what) => {
    if (apdu.length < n) throw new BacnetFramingError(`truncated ${what}`);
  };
  switch (type) {
    case PDU.CONFIRMED: {
      need(4, 'confirmed request');
      const segmented = (apdu[0] & 0x08) !== 0;
      const hdr = segmented ? 6 : 4;
      need(hdr, 'confirmed request');
      return { type: 'confirmed-request', invokeId: apdu[2], service: apdu[segmented ? 5 : 3], body: apdu.subarray(hdr) };
    }
    case PDU.UNCONFIRMED:
      need(2, 'unconfirmed request');
      return { type: 'unconfirmed-request', service: apdu[1], body: apdu.subarray(2) };
    case PDU.SIMPLE_ACK:
      need(3, 'SimpleACK');
      return { type: 'simple-ack', invokeId: apdu[1], service: apdu[2], body: apdu.subarray(3) };
    case PDU.COMPLEX_ACK: {
      const segmented = (apdu[0] & 0x08) !== 0;
      if (segmented) {
        need(5, 'segmented ComplexACK');
        return { type: 'complex-ack', segmented: true, moreFollows: (apdu[0] & 0x04) !== 0, invokeId: apdu[1], sequence: apdu[2], window: apdu[3], service: apdu[4], body: apdu.subarray(5) };
      }
      need(3, 'ComplexACK');
      return { type: 'complex-ack', segmented: false, invokeId: apdu[1], service: apdu[2], body: apdu.subarray(3) };
    }
    case PDU.SEGMENT_ACK:
      need(4, 'SegmentACK');
      return { type: 'segment-ack', invokeId: apdu[1], body: apdu.subarray(4) };
    case PDU.ERROR: {
      need(3, 'Error PDU');
      const body = apdu.subarray(3);
      try {
        let p = 0;
        // Some stacks wrap the error pair in context tag 0 (the shape of a few service-specific errors).
        if (enc.isOpening(body, 0, 0)) p = enc.readTag(body, 0).headerLength;
        const e = enc.readErrorPair(body, p);
        return { type: 'error', invokeId: apdu[1], service: apdu[2], errorClass: e.errorClass, errorCode: e.errorCode, body };
      } catch (err) {
        throw new BacnetFramingError(`malformed Error PDU: ${err.message}`);
      }
    }
    case PDU.REJECT:
      need(3, 'Reject PDU');
      return { type: 'reject', invokeId: apdu[1], reason: apdu[2], body: Buffer.alloc(0) };
    case PDU.ABORT:
      need(3, 'Abort PDU');
      return { type: 'abort', invokeId: apdu[1], reason: apdu[2], server: (apdu[0] & 0x01) !== 0, body: Buffer.alloc(0) };
    default:
      throw new BacnetFramingError(`reserved APDU type ${type}`);
  }
}

/** I-Am parameters: device id, max APDU, segmentation, vendor id (all application tagged). */
function parseIAm(body) {
  const { items } = enc.decodeValues(body, 0, body.length);
  const [id, maxApdu, seg, vendor] = items;
  if (!id || id.tag !== 'object-identifier' || !maxApdu || maxApdu.tag !== 'unsigned' || !seg || seg.tag !== 'enumerated' || !vendor || vendor.tag !== 'unsigned') {
    throw new BacnetFramingError('malformed I-Am');
  }
  return { objectType: id.value.type, instance: id.value.instance, maxApdu: Number(maxApdu.value), segmentation: Number(seg.value), vendorId: Number(vendor.value) };
}

/** ReadProperty-ACK: [0] object id, [1] property, [2] index?, [3] { values }. */
function parseReadPropertyAck(body) {
  try {
    const o = enc.readContextObjectId(body, 0, 0);
    if (!o) throw new Error('object identifier missing');
    const pr = enc.readContextUnsigned(body, o.next, 1);
    if (!pr) throw new Error('property identifier missing');
    let p = pr.next;
    let index;
    const ix = enc.readContextUnsigned(body, p, 2);
    if (ix) {
      index = ix.value;
      p = ix.next;
    }
    if (!enc.isOpening(body, p, 3)) throw new Error('property value missing');
    const start = p + enc.readTag(body, p).headerLength;
    const { items, next } = enc.decodeValues(body, start, body.length, 3);
    if (next >= body.length || !enc.isClosing(body, next, 3)) throw new Error('property value not closed');
    return { objectType: o.value.type, instance: o.value.instance, property: pr.value, index, values: items, raw: body.subarray(start, next) };
  } catch (err) {
    if (err instanceof BacnetFramingError) throw err;
    throw new BacnetFramingError(`malformed ReadProperty-ACK: ${err.message}`);
  }
}

/**
 * ReadPropertyMultiple-ACK: list of { [0] object id, [1] { ([2] property, [3] index?, [4] {values} | [5] {error}) * } }.
 * @returns {Array<{objectType, instance, results:Array<{property, index, values?, raw?, error?}>}>}
 */
function parseReadPropertyMultipleAck(body) {
  try {
    const out = [];
    let p = 0;
    while (p < body.length) {
      const o = enc.readContextObjectId(body, p, 0);
      if (!o) throw new Error('object identifier missing');
      p = o.next;
      if (!enc.isOpening(body, p, 1)) throw new Error('list of results missing');
      p += enc.readTag(body, p).headerLength;
      const results = [];
      while (!enc.isClosing(body, p, 1)) {
        if (p >= body.length) throw new Error('list of results not closed');
        const pr = enc.readContextUnsigned(body, p, 2);
        if (!pr) throw new Error('property identifier missing');
        p = pr.next;
        let index;
        const ix = enc.readContextUnsigned(body, p, 3);
        if (ix) {
          index = ix.value;
          p = ix.next;
        }
        if (enc.isOpening(body, p, 4)) {
          const start = p + enc.readTag(body, p).headerLength;
          const { items, next } = enc.decodeValues(body, start, body.length, 4);
          if (next >= body.length) throw new Error('property value not closed');
          results.push({ property: pr.value, index, values: items, raw: body.subarray(start, next) });
          p = next + enc.readTag(body, next).headerLength;
        } else if (enc.isOpening(body, p, 5)) {
          const e = enc.readErrorPair(body, p + enc.readTag(body, p).headerLength);
          if (!enc.isClosing(body, e.next, 5)) throw new Error('property access error not closed');
          results.push({ property: pr.value, index, error: { errorClass: e.errorClass, errorCode: e.errorCode } });
          p = e.next + enc.readTag(body, e.next).headerLength;
        } else {
          throw new Error('property result is neither a value nor an error');
        }
      }
      p += enc.readTag(body, p).headerLength;
      out.push({ objectType: o.value.type, instance: o.value.instance, results });
    }
    return out;
  } catch (err) {
    if (err instanceof BacnetFramingError) throw err;
    throw new BacnetFramingError(`malformed ReadPropertyMultiple-ACK: ${err.message}`);
  }
}

module.exports = {
  BVLC,
  PDU,
  SERVICE,
  UNCONFIRMED,
  CONFIRMED_NAMES,
  MAX_APDU_SIZES,
  OUR_MAX_APDU,
  BacnetReadOnlyError,
  BacnetFramingError,
  maxApduCode,
  encodeReadPropertyParams,
  encodeReadPropertyMultipleParams,
  encodeWhoIsParams,
  confirmedApdu,
  unconfirmedApdu,
  assertReadOnly,
  encodeNpdu,
  encodePacket,
  readPropertyPacket,
  readPropertyMultiplePacket,
  whoIsPacket,
  decodePacket,
  decodeApdu,
  parseIAm,
  parseReadPropertyAck,
  parseReadPropertyMultipleAck,
};
