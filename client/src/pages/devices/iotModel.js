// Pure helpers for IoT devices over MQTT (server: services/iot/, routes/iot.js). No React.
//
// Manifold reads what bridges and gateways (Zigbee2MQTT, Z-Wave JS UI, Home Assistant discovery,
// Tasmota, Shelly, LoRaWAN network servers) publish. It never pairs or controls a device.

export const CONVENTION_SHORT = {
  zigbee2mqtt: 'Zigbee2MQTT',
  zwavejs: 'Z-Wave JS UI',
  homeassistant: 'HA discovery',
  tasmota: 'Tasmota',
  shelly: 'Shelly',
  chirpstack: 'ChirpStack',
  ttn: 'The Things Stack'
};

/** Option fields per convention: [key, label, help]. */
export const CONVENTION_OPTIONS = {
  zigbee2mqtt: [['baseTopic', 'Base topic', 'mqtt.base_topic in the Zigbee2MQTT configuration']],
  zwavejs: [['prefix', 'Topic prefix', 'MQTT prefix in Z-Wave JS UI settings']],
  homeassistant: [['prefix', 'Discovery prefix', 'Default homeassistant']],
  tasmota: [
    ['fullTopic', 'FullTopic', 'Default %prefix%/%topic%/'],
    ['discoveryPrefix', 'Discovery prefix', 'Default tasmota/discovery']
  ],
  shelly: [['gen1Prefix', 'Gen1 prefix', 'Gen1 devices publish under shellies/ by default']],
  chirpstack: [['prefix', 'Topic prefix', 'Default application']],
  ttn: [['prefix', 'Topic prefix', 'Default v3']]
};

export const conventionLabel = (id) => CONVENTION_SHORT[id] || id;

/** Availability -> { tone, label } for StatusText. */
export function availabilityView(availability) {
  if (availability === 'online') return { tone: 'good', label: 'Online' };
  if (availability === 'offline') return { tone: 'bad', label: 'Offline' };
  return { tone: 'neutral', label: 'Unknown' };
}

/** OPC-style quality code -> { tone, label }. null = no value received yet. */
export function qualityView(q) {
  if (q === null || q === undefined) return { tone: 'neutral', label: 'No value' };
  if (q >= 192) return { tone: 'good', label: 'Good' };
  if (q >= 64) return { tone: 'warn', label: 'Uncertain' };
  return { tone: 'bad', label: 'Bad' };
}

/** A value for a table cell: numbers as they are, booleans as true/false, structures as compact JSON. */
export function formatIotValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  }
  return String(v);
}

/** Range / enum summary for the tag table. */
export function tagLimits(t) {
  if (t.range && Number.isFinite(t.range.min) && Number.isFinite(t.range.max)) return `${t.range.min} to ${t.range.max}`;
  if (Array.isArray(t.enum) && t.enum.length) return t.enum.length > 4 ? `${t.enum.slice(0, 4).join(', ')} +${t.enum.length - 4}` : t.enum.join(', ');
  return '';
}

/** Filter the device list by text, convention and broker. */
export function filterDevices(list, { text = '', convention = 'all', brokerId = 'all', availability = 'all' } = {}) {
  const t = text.trim().toLowerCase();
  return (list || []).filter((d) => {
    if (convention !== 'all' && d.convention !== convention) return false;
    if (brokerId !== 'all' && d.brokerId !== brokerId) return false;
    if (availability !== 'all' && (availability === 'offline' ? d.availability !== 'offline' : d.availability === 'offline')) return false;
    if (!t) return true;
    return `${d.name} ${d.manufacturer || ''} ${d.model || ''} ${d.id} ${conventionLabel(d.convention)} ${d.brokerName}`.toLowerCase().includes(t);
  });
}

/** Editable form state from a broker's detection status ({ config: { conventions } }). */
export function draftFromConfig(config) {
  const out = {};
  for (const [id, c] of Object.entries(config?.conventions || {})) out[id] = { ...c };
  return out;
}

/** PUT body from a draft (options trimmed; empty options fall back to the server defaults). */
export function configFromDraft(draft) {
  const conventions = {};
  for (const [id, c] of Object.entries(draft || {})) {
    const o = { enabled: Boolean(c.enabled) };
    for (const [k] of CONVENTION_OPTIONS[id] || []) {
      const v = typeof c[k] === 'string' ? c[k].trim() : c[k];
      if (v) o[k] = v;
    }
    conventions[id] = o;
  }
  return { conventions };
}

/** Client-side check of an option value (the server validates again). '' when fine. */
export function optionProblem(id, key, value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (/[+#]/.test(v)) return 'No MQTT wildcards (+ or #).';
  if (id === 'tasmota' && key === 'fullTopic' && !v.includes('%topic%')) return 'Must contain %topic%.';
  if (id === 'shelly' && v.includes('/')) return 'A single topic level.';
  return '';
}

/** The Tags workspace link that maps this device. */
export const mapLink = (d) => `/tags?source=${encodeURIComponent(`iot:${d.sourceId || `${d.brokerId}|${d.id}`}`)}`;

/** Registry tags -> the device-tag shape the mapping editor reads as tag definitions. */
export function tagDefsFromIot(tags) {
  return (tags || []).map((t) => {
    const d = { key: t.key, property: t.name };
    if (t.type && t.type !== 'unknown') d.type = t.type;
    if (t.unit) d.unit = t.unit;
    if (t.description) d.description = t.description;
    if (t.range) d.range = t.range;
    return d;
  });
}

/** "12 devices on 2 brokers" style summary. */
export function iotSummary(devices) {
  const n = devices?.length || 0;
  if (!n) return 'No IoT devices yet';
  const brokers = new Set(devices.map((d) => d.brokerId)).size;
  const off = devices.filter((d) => d.availability === 'offline').length;
  return `${n} device${n === 1 ? '' : 's'} on ${brokers} broker${brokers === 1 ? '' : 's'}${off ? `, ${off} offline` : ''}`;
}
