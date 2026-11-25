// Discovery -> device mapping. The scan reports southbound devices as
// { kind, protocol, host, port, identity, suggestedDevice:{ name, protocol, host, port } }.

/** Protocols the scan can look for, with the server's default ports and opt-in field. */
export const SCAN_PROTOCOLS = [
  { id: 'modbus-tcp', kind: 'modbus', label: 'Modbus TCP', field: 'modbusPorts', port: 502 },
  { id: 's7', kind: 's7', label: 'Siemens S7', field: 's7Ports', port: 102 },
  { id: 'ethernet-ip', kind: 'ethernet-ip', label: 'EtherNet/IP', field: 'eipPorts', port: 44818 }
];

/** Parse "502, 1502" -> { ports: [502, 1502], bad: [] }; invalid entries are returned in `bad`. */
export function parsePorts(text) {
  const ports = [];
  const bad = [];
  for (const part of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.push(n);
    else bad.push(part);
  }
  return { ports: [...new Set(ports)], bad };
}

/**
 * Request body for POST /api/system/discovery/start. Each ticked protocol sends
 * its explicit port field; none ticked sends none (the server then scans only
 * MQTT / OPC UA / i3X because device probing is opt-in).
 * @param {{ range?: string, selected: Record<string, string|number[]|null> }} o
 *   selected: protocol id -> ports text or array (absent / null = not scanned)
 */
export function buildScanOptions({ range, selected = {} }) {
  const body = {};
  if (range && range.trim()) body.range = range.trim();
  for (const p of SCAN_PROTOCOLS) {
    const v = selected[p.id];
    if (v === undefined || v === null || v === false) continue;
    const ports = Array.isArray(v) ? v : parsePorts(v).ports;
    body[p.field] = ports.length ? ports : [p.port];
  }
  return body;
}

/** Is this discovery result a southbound device the Devices page can add? */
export function isDeviceResult(r) {
  return Boolean(r && r.suggestedDevice && r.suggestedDevice.protocol && r.suggestedDevice.host);
}

const EXCEPTIONS = { 1: 'illegal function', 2: 'illegal data address', 3: 'illegal data value', 4: 'device failure', 10: 'gateway path unavailable', 11: 'gateway target failed to respond' };

/** One line of plain text for the identity the probe returned. */
export function identityText(r) {
  const id = r?.identity || {};
  if (r?.protocol === 'modbus-tcp') {
    if (id.response === 'device-id') {
      const bits = [id.productName || id.modelName, id.vendorName, id.productCode && `code ${id.productCode}`, id.revision && `rev ${id.revision}`].filter(Boolean);
      return `${bits.join(' · ') || 'Modbus server'} (unit ${id.unitId ?? 1}, device identification)`;
    }
    const how = id.response === 'exception' ? `answered with an exception (${id.exception || EXCEPTIONS[id.exceptionCode] || `code ${id.exceptionCode}`})` : 'answered a register read';
    return `Modbus server, unit ${id.unitId ?? 1} ${how}`;
  }
  if (r?.protocol === 's7') {
    if (id.accepted === false) return `Siemens S7 controller refused the connection (check rack/slot or PUT/GET)${id.rack !== undefined ? `, rack ${id.rack} slot ${id.slot}` : ''}`;
    const model = id.moduleTypeName || id.orderCode;
    if (model) {
      const bits = [model, id.orderCode && id.orderCode !== model ? id.orderCode : '', id.firmware, id.cpuState, id.serialNumber && `serial ${id.serialNumber}`].filter(Boolean);
      return `Siemens ${bits.join(' · ')} · rack ${id.rack} slot ${id.slot}`;
    }
    return `Siemens S7 controller accepts ISO-on-TCP connections${id.rack !== undefined ? `, rack ${id.rack} slot ${id.slot}` : ''}`;
  }
  if (r?.protocol === 'ethernet-ip') {
    const bits = [
      id.productName,
      id.vendor ? id.vendor : id.vendorId !== undefined ? `vendor ${id.vendorId}` : '',
      id.deviceTypeName,
      id.productCode !== undefined ? `product code ${id.productCode}` : '',
      id.revision ? `rev ${id.revision}` : '',
      id.serialNumber ? `serial ${id.serialNumber}` : '',
      id.stateName
    ].filter(Boolean);
    return bits.length ? bits.join(' · ') : 'EtherNet/IP device';
  }
  if (r?.kind === 'mqtt') {
    if (!r.verified) return 'Port open, but it did not answer an MQTT CONNECT';
    return id.anonymousAccess ? 'Anonymous access allowed' : 'Authentication required';
  }
  if (r?.kind === 'opcua') {
    if (!r.verified) return 'Port open, but it did not answer an OPC UA Hello';
    return id.accepted === false ? `UA-TCP server (refused the Hello: ${id.errorCode})` : 'UA-TCP server answered the Hello';
  }
  if (r?.kind === 'i3x') return `${r.serverName ? `${r.serverName} · ` : ''}${r.baseUrl || ''}`;
  return Object.entries(id).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

/** A device draft (fields of the device form) from a result's suggestedDevice. */
export function draftFromResult(r) {
  const s = r.suggestedDevice;
  const draft = { name: String(s.name || `${s.protocol} ${s.host}`), protocol: s.protocol, host: s.host, port: s.port };
  const id = r.identity || {};
  if (s.protocol === 's7' && id.rack !== undefined) Object.assign(draft, { rack: id.rack, slot: id.slot });
  if (s.protocol === 'modbus-tcp' && id.unitId !== undefined) draft.unitId = id.unitId;
  return draft;
}

/** All device results of a scan as drafts, one per host:port, in a stable order. */
export function draftsFromResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results || []) {
    if (!isDeviceResult(r)) continue;
    const k = `${r.suggestedDevice.host}:${r.suggestedDevice.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(draftFromResult(r));
  }
  return out.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }) || a.port - b.port);
}

/** Is this discovered MQTT broker / OPC UA server already one of the configured connections? */
export function isAlreadyConnected(r, { brokers = [], opcua = [] } = {}) {
  if (r?.kind === 'mqtt') return brokers.some((b) => b.host === r.host && Number(b.port) === Number(r.port));
  if (r?.kind === 'opcua') return opcua.some((c) => c.endpointUrl === (r.endpointUrl || `opc.tcp://${r.host}:${r.port}`));
  return false;
}

// ---- the scan form -----------------------------------------------------------------------

/** Everything the scan can look for. `device` kinds are opt-in (they speak to PLCs). */
export const SCAN_KINDS = [
  { id: 'mqtt', field: 'mqttPorts', label: 'MQTT brokers', ports: [1883, 8883], on: true },
  { id: 'opcua', field: 'opcuaPorts', label: 'OPC UA servers', ports: [4840], on: true },
  { id: 'i3x', field: 'i3xPorts', label: 'i3X servers', ports: [80, 443, 8080], on: true },
  { id: 'modbus', field: 'modbusPorts', label: 'Modbus TCP', ports: [502], device: true },
  { id: 's7', field: 's7Ports', label: 'Siemens S7', ports: [102], device: true },
  { id: 'ethernet-ip', field: 'eipPorts', label: 'EtherNet/IP', ports: [44818], device: true }
];
export const DEVICE_KIND_IDS = SCAN_KINDS.filter((k) => k.device).map((k) => k.id);

/** Port list for one kind: the typed text, or the defaults when it is blank. */
export function portsFor(kind, text) {
  const parsed = parsePorts(text);
  return parsed.ports.length ? parsed.ports : kind.ports;
}

/**
 * Request body for /api/system/discovery/start and /plan from the form.
 * @param {{ range?: string, kinds: Record<string, boolean>, ports?: Record<string, string>, mqttWs?: string,
 *           advanced?: { concurrency?: string, perHost?: string, timeoutMs?: string, identifyTimeoutMs?: string } }} f
 */
export function buildScanRequest({ range, kinds = {}, ports = {}, mqttWs = '', advanced = {} }) {
  const body = {};
  if (range && range.trim()) body.range = range.trim();
  for (const k of SCAN_KINDS) {
    if (kinds[k.id]) body[k.field] = portsFor(k, ports[k.id]);
    else if (!k.device) body[k.field] = []; // an unticked MQTT / OPC UA / i3X must not fall back to its default
  }
  const ws = parsePorts(mqttWs).ports;
  if (kinds.mqtt && ws.length) body.mqttWsPorts = ws;
  for (const key of ['concurrency', 'perHost', 'timeoutMs', 'identifyTimeoutMs']) {
    const v = String(advanced[key] ?? '').trim();
    if (v !== '') body[key] = Number(v);
  }
  return body;
}

/** The first thing wrong with the range text, or '' (blank is fine: the server scans the local subnet). */
export function rangeProblem(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (t.includes(':')) return 'IPv6 is not supported. Enter an IPv4 address or CIDR such as 192.168.1.0/24.';
  if (/^[\d.]+(\/.*)?$/.test(t)) {
    const [base, prefix, extra] = t.split('/');
    const octets = base.split('.');
    if (extra !== undefined || octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return 'Not an IPv4 address. Use the form 192.168.1.0/24.';
    if (prefix !== undefined && (!/^\d{1,2}$/.test(prefix) || Number(prefix) > 32)) return 'The prefix after the slash must be 0 to 32.';
    return '';
  }
  if (t.includes('/')) return 'Ranges are IPv4 CIDR such as 192.168.1.0/24; a hostname scans just that host.';
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(t)) return 'Not an IPv4 address, CIDR or hostname.';
  return '';
}

/** "about 40 s", "about 6 min", "about 2.5 h". */
export function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = s / 3600;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

/** Where Manifold keeps what a `known` marker refers to. */
export const KNOWN_PAGE = { broker: '/brokers', opcua: '/opcua', i3x: '/i3x', device: '/devices' };
export const KNOWN_LABEL = { broker: 'broker', opcua: 'OPC UA connection', i3x: 'i3X server', device: 'device' };

/** Filter groups of the results table. */
export const RESULT_GROUPS = [
  { id: 'all', label: 'All' },
  { id: 'mqtt', label: 'MQTT' },
  { id: 'opcua', label: 'OPC UA' },
  { id: 'i3x', label: 'i3X' },
  { id: 'device', label: 'Devices' }
];
export const groupOf = (r) => (isDeviceResult(r) ? 'device' : r?.kind);

/** Numeric-aware sort key for host:port. */
export const endpointSortKey = (r) => `${String(r.host).split('.').map((o) => o.padStart(3, '0')).join('.')}:${String(r.port).padStart(5, '0')}`;
