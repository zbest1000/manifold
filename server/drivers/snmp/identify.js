'use strict';

/**
 * Discovery probe (opt-in): ONE SNMPv2c GetRequest with community "public" for
 * sysDescr.0, sysObjectID.0 and sysName.0, one datagram per address, no
 * retries. UDP has no handshake, so silence means "no agent, a different
 * community, or filtered" and is never reported.
 *
 * Resolves { protocol:'snmp', method:'snmp-v2c-get', identity } or null.
 */

const { UdpTransport } = require('../runtime/udpTransport');
const msg = require('./message');
const { decodeValue, displayValue } = require('./decode');
const oids = require('./oids');

async function identifySnmp(host, port = 161, { timeoutMs = 2000, signal, createSocket, isAllowed } = {}) {
  if (signal && signal.aborted) return null;
  const t = new UdpTransport({ address: host, port, createSocket, isAllowed });
  try {
    await t.open();
  } catch {
    return null;
  }
  const requestId = 1 + Math.floor(Math.random() * 0x7ffffff0);
  const community = Buffer.from('public');
  const ask = [oids.SYS_DESCR, oids.SYS_OBJECT_ID, oids.SYS_NAME];
  return new Promise((resolve) => {
    let timer = null;
    let onAbort = null;
    const done = (v) => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      t.close();
      resolve(v);
    };
    onAbort = () => done(null);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done(null), timeoutMs);
    if (timer.unref) timer.unref();
    t.on('unreachable', () => done(null));
    t.on('error', () => done(null));
    t.on('message', (buf) => {
      let m;
      try {
        m = msg.decodeMessage(buf);
      } catch {
        return;
      }
      if (m.version !== msg.VERSION.v2c || !m.pdu || m.pdu.type !== msg.PDU.RESPONSE || m.pdu.requestId !== requestId) return;
      const identity = { version: 'v2c', community: 'public' };
      if (m.pdu.errorStatus === 0) {
        for (const vb of m.pdu.varbinds) {
          let d;
          try {
            d = decodeValue(vb.tag, vb.value);
          } catch {
            continue;
          }
          if (d.exception) continue;
          const v = displayValue(d);
          if (vb.oid === oids.SYS_DESCR) identity.sysDescr = String(v).slice(0, 200);
          if (vb.oid === oids.SYS_OBJECT_ID) identity.sysObjectID = String(v);
          if (vb.oid === oids.SYS_NAME) identity.sysName = String(v).slice(0, 100);
        }
      } else {
        identity.errorStatus = msg.errorStatusName(m.pdu.errorStatus);
      }
      const short = identity.sysDescr ? identity.sysDescr.split(/[\r\n]/)[0].slice(0, 48) : '';
      if (identity.sysName || short) identity.productName = identity.sysName || short;
      done({ protocol: 'snmp', method: 'snmp-v2c-get', identity });
    });
    let pdu;
    try {
      pdu = msg.encodeRequestPdu(msg.PDU.GET, requestId, ask);
    } catch {
      done(null);
      return;
    }
    t.send(msg.encodeCommunityMessage(msg.VERSION.v2c, community, pdu)).catch(() => done(null));
  });
}

module.exports = { identifySnmp };
