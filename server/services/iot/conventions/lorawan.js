'use strict';

const { LIMITS, GOOD, UNCERTAIN, text, num, typeOf, sourceTime, capValue, idPart, base64ToHex } = require('../limits');

/**
 * LoRaWAN network servers that integrate over MQTT (JSON marshaling only). Read-only: uplink and
 * status events are read; downlink topics (ChirpStack .../command/down, The Things Stack
 * .../down/push|replace) are never touched and nothing here publishes.
 *
 * ChirpStack v4:  application/<applicationId>/device/<devEui>/event/<up|status|join>
 *   up: { time, deviceInfo { deviceName, devEui, applicationName, deviceProfileName, ... }, fCnt, fPort, dr,
 *         data (base64), object { decoded payload }, rxInfo [{ rssi, snr, gatewayId }], txInfo { frequency } }
 *   status: { batteryLevel, margin, externalPowerSource, batteryLevelUnavailable }
 * The Things Stack v3: v3/<app-id>[@<tenant-id>]/devices/<device-id>/up
 *   { end_device_ids { device_id, dev_eui, application_ids { application_id } }, received_at,
 *     uplink_message { f_port, f_cnt, frm_payload (base64), decoded_payload, rx_metadata [{ rssi, snr }],
 *                      settings { frequency }, last_battery_percentage { value } } }
 *
 * Decoded payload fields become tags; RSSI/SNR/frame counter/battery are diagnostics; without a
 * decoded payload the raw application payload is a hex tag. Availability: LoRaWAN has no
 * online/offline notion, so devices stay "unknown" (see last seen).
 */

function leavesOf(obj, prefix) {
  const out = [];
  const stack = [[obj, []]];
  while (stack.length && out.length < LIMITS.maxTagsPerDevice - 10) {
    const [o, path] = stack.pop();
    if (path.length > LIMITS.maxWalkDepth) continue;
    for (const [k, v] of Object.entries(o)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) stack.push([v, [...path, k]]);
      else out.push({ key: `${prefix}.${[...path, k].join('.')}`, name: [...path, k].join(' '), value: v });
    }
  }
  return out;
}

const DIAG = {
  rssi: { name: 'RSSI (best gateway)', unit: 'dBm', type: 'float64' },
  snr: { name: 'SNR (best gateway)', unit: 'dB', type: 'float64' },
  fCnt: { name: 'Frame counter', type: 'int64' },
  fPort: { name: 'FPort', type: 'int64' },
  frequency: { name: 'Frequency', unit: 'Hz', type: 'int64' },
  gateways: { name: 'Gateways heard', type: 'int64' },
  battery: { name: 'Battery', unit: '%', type: 'float64' },
  margin: { name: 'Link margin', unit: 'dB', type: 'float64' },
  payloadHex: { name: 'Raw payload (hex)', type: 'string', description: 'FRMPayload as hex; shown when the network server sent no decoded payload' }
};

function best(list, rssiKey = 'rssi', snrKey = 'snr') {
  let rssi;
  let snr;
  let n = 0;
  for (const r of Array.isArray(list) ? list.slice(0, 64) : []) {
    if (!r || typeof r !== 'object') continue;
    n++;
    const a = num(r[rssiKey] ?? r.channel_rssi);
    if (a !== undefined && (rssi === undefined || a > rssi)) {
      rssi = a;
      snr = num(r[snrKey]);
    }
  }
  return { rssi, snr, gateways: n };
}

/** Shared uplink handling: decoded object or raw hex, plus diagnostics. */
function applyUplink(reg, id, msg, { decoded, rawB64, diag, t }, lastKeys) {
  const seen = new Set();
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
    for (const leaf of leavesOf(decoded, 'decoded')) {
      seen.add(leaf.key);
      reg.setValue(id, leaf.key, { v: capValue(leaf.value), q: GOOD, t }, { name: leaf.name, type: Array.isArray(leaf.value) ? 'json' : typeOf(leaf.value), topic: msg.topic, selector: leaf.key });
    }
  } else if (typeof rawB64 === 'string') {
    const hex = base64ToHex(rawB64);
    if (hex !== null) {
      seen.add('payloadHex');
      reg.setValue(id, 'payloadHex', { v: hex, q: GOOD, t }, { ...DIAG.payloadHex, topic: msg.topic, selector: 'payloadHex' });
    }
  }
  for (const [k, v] of Object.entries(diag)) {
    if (v === undefined) continue;
    reg.setValue(id, k, { v, q: GOOD, t }, { ...DIAG[k], topic: msg.topic, selector: k, diagnostic: true });
  }
  // Fields an earlier uplink had but this one lacks: uncertain, not silently stale.
  for (const k of lastKeys.get(id) || []) if (!seen.has(k)) reg.setValue(id, k, { v: null, q: UNCERTAIN, reason: 'not in the last uplink' });
  lastKeys.set(id, seen);
  reg.touch(id, msg);
}

function createChirpstack(opts, reg) {
  const prefixParts = opts.prefix.split('/');
  const lastKeys = new Map();
  return {
    onMessage(msg) {
      const p = msg.topicParts;
      const n = prefixParts.length;
      if (p.length !== n + 5) return;
      for (let i = 0; i < n; i++) if (p[i] !== prefixParts[i]) return;
      if (p[n + 1] !== 'device' || p[n + 3] !== 'event') return;
      const event = p[n + 4];
      const payload = msg.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const devEui = String(payload.deviceInfo?.devEui || p[n + 2]).toLowerCase();
      if (!/^[0-9a-f]{16}$/.test(devEui)) return;
      const id = `chirpstack:${devEui}`;
      const info = payload.deviceInfo && typeof payload.deviceInfo === 'object' ? payload.deviceInfo : {};
      const known = reg.get(id);
      const ok = reg.upsertDevice({
        id,
        convention: 'chirpstack',
        stableId: devEui,
        name: text(info.deviceName) || known?.name || devEui,
        manufacturer: null,
        model: text(info.deviceProfileName) || known?.model || null,
        description: info.applicationName ? `application ${text(info.applicationName)}` : known?.description || null,
        details: { devEui, applicationId: text(p[n]), tenant: text(info.tenantName) || known?.details?.tenant || null },
        dynamicTags: true
      });
      if (!ok) return;
      const t = sourceTime(payload.time);
      if (event === 'up') {
        const b = best(payload.rxInfo);
        applyUplink(reg, id, msg, {
          decoded: payload.object,
          rawB64: payload.data,
          t,
          diag: { rssi: b.rssi, snr: b.snr, gateways: b.gateways || undefined, fCnt: num(payload.fCnt), fPort: num(payload.fPort), frequency: num(payload.txInfo?.frequency) }
        }, lastKeys);
      } else if (event === 'status') {
        if (payload.batteryLevelUnavailable !== true && num(payload.batteryLevel) !== undefined) reg.setValue(id, 'battery', { v: num(payload.batteryLevel), q: GOOD, t }, { ...DIAG.battery, topic: msg.topic, selector: 'batteryLevel', diagnostic: true });
        if (num(payload.margin) !== undefined) reg.setValue(id, 'margin', { v: num(payload.margin), q: GOOD, t }, { ...DIAG.margin, topic: msg.topic, selector: 'margin', diagnostic: true });
        reg.touch(id, msg);
      } else reg.touch(id, msg);
    },
    close() {}
  };
}

function createTts(opts, reg) {
  const lastKeys = new Map();
  const prefixParts = opts.prefix.split('/');
  return {
    onMessage(msg) {
      const p = msg.topicParts;
      const n = prefixParts.length;
      if (p.length !== n + 4) return;
      for (let i = 0; i < n; i++) if (p[i] !== prefixParts[i]) return;
      if (p[n + 1] !== 'devices' || p[n + 3] !== 'up') return; // join, down/*, service/*: not read
      const payload = msg.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const ids = payload.end_device_ids && typeof payload.end_device_ids === 'object' ? payload.end_device_ids : {};
      const devId = text(ids.device_id) || text(p[n + 2]);
      const app = text(p[n]);
      const devEui = typeof ids.dev_eui === 'string' && /^[0-9A-Fa-f]{16}$/.test(ids.dev_eui) ? ids.dev_eui.toLowerCase() : null;
      const id = `ttn:${devEui || idPart(`${app}/${devId}`)}`;
      const known = reg.get(id);
      const ok = reg.upsertDevice({
        id,
        convention: 'ttn',
        stableId: devEui || `${app}/${devId}`,
        name: devId || known?.name,
        manufacturer: text(ids.version_ids?.brand_id) || known?.manufacturer || null,
        model: text(ids.version_ids?.model_id) || known?.model || null,
        description: `application ${app}`,
        details: { devEui, deviceId: devId, application: app },
        dynamicTags: true
      });
      if (!ok) return;
      const up = payload.uplink_message && typeof payload.uplink_message === 'object' ? payload.uplink_message : {};
      const b = best(up.rx_metadata);
      applyUplink(reg, id, msg, {
        decoded: up.decoded_payload,
        rawB64: up.frm_payload,
        t: sourceTime(up.received_at) || sourceTime(payload.received_at),
        diag: {
          rssi: b.rssi,
          snr: b.snr,
          gateways: b.gateways || undefined,
          fCnt: num(up.f_cnt),
          fPort: num(up.f_port),
          frequency: num(up.settings?.frequency),
          battery: num(up.last_battery_percentage?.value)
        }
      }, lastKeys);
    },
    close() {}
  };
}

const prefixNorm = (def, what) => (opts = {}) => {
  const prefix = typeof opts.prefix === 'string' && opts.prefix.trim() ? opts.prefix.trim().replace(/\/+$/, '') : def;
  if (/[+#]/.test(prefix) || prefix.length > 200) throw new Error(`${what}.prefix must be a plain topic prefix without wildcards`);
  return { prefix };
};

const chirpstack = {
  id: 'chirpstack',
  label: 'ChirpStack v4 (LoRaWAN)',
  normalize: prefixNorm('application', 'chirpstack'),
  filters: (o) => [`${o.prefix}/+/device/+/event/+`],
  detect(parts, msg) {
    const n = parts.length;
    if (n < 6 || parts[n - 4] !== 'device' || parts[n - 2] !== 'event' || parts[n - 1] !== 'up') return null;
    if (!msg.payload || typeof msg.payload !== 'object' || !msg.payload.deviceInfo) return null;
    return { prefix: parts.slice(0, n - 5).join('/') || 'application' };
  },
  create: createChirpstack
};

const ttn = {
  id: 'ttn',
  label: 'The Things Stack v3 (LoRaWAN)',
  normalize: prefixNorm('v3', 'ttn'),
  filters: (o) => [`${o.prefix}/+/devices/+/up`],
  detect(parts, msg) {
    const n = parts.length;
    if (n < 5 || parts[n - 3] !== 'devices' || parts[n - 1] !== 'up') return null;
    if (!msg.payload || typeof msg.payload !== 'object' || !msg.payload.end_device_ids) return null;
    return { prefix: parts.slice(0, n - 4).join('/') || 'v3' };
  },
  create: createTts
};

module.exports = { chirpstack, ttn, best, leavesOf };
