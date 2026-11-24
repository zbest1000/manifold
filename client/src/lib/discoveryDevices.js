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
    const how = id.response === 'exception' ? `answered with an exception (${id.exception || EXCEPTIONS[id.exceptionCode] || `code ${id.exceptionCode}`})` : 'answered a register read';
    return `Modbus server, unit ${id.unitId ?? 1} ${how}`;
  }
  if (r?.protocol === 's7') {
    const accepted = id.accepted === false ? 'refused the connection (check rack/slot or PUT/GET)' : 'accepts ISO-on-TCP connections';
    return `Siemens S7 controller ${accepted}${id.rack !== undefined ? `, rack ${id.rack} slot ${id.slot}` : ''}`;
  }
  if (r?.protocol === 'ethernet-ip') {
    const bits = [
      id.productName,
      id.vendorId !== undefined ? `vendor ${id.vendorId}` : '',
      id.productCode !== undefined ? `product code ${id.productCode}` : '',
      id.revision ? `rev ${id.revision}` : '',
      id.serialNumber ? `serial ${id.serialNumber}` : ''
    ].filter(Boolean);
    return bits.length ? bits.join(' · ') : 'EtherNet/IP device';
  }
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
