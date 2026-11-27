import { bindingSourceId } from './helpers';
// Pure display helpers for the bindings table / detail.

/**
 * How the Mappings table names a mapping's source: the /api/tags/sources label when the source is
 * listed (connected), else its id. Uses the same source id as the browse list for every source type
 * (an IoT device is `<brokerId>|<deviceId>`), so an IoT mapping is not shown as "not connected".
 */
export function sourceLabel(b, sources, profiles = []) {
  const s = b.source || {};
  if (s.type === 'device-profile') {
    const p = profiles.find((x) => x.id === s.profileId);
    return { type: 'profile', label: p ? p.name : s.profileId || '?', connected: Boolean(p) };
  }
  const id = bindingSourceId(s);
  const found = sources.find((x) => x.type === s.type && x.id === id);
  const scope = s.type === 'sparkplug' ? ` ${s.group}/${s.edge}${s.device ? `/${s.device}` : ''}` : s.type === 'mqtt' && s.tags === 'all' ? ` ${s.filter}` : '';
  return { type: s.type, label: `${found?.label || (s.type === 'iot' ? s.deviceId : id) || '?'}${scope}`, connected: Boolean(found) };
}

export function layoutLabel(b) {
  const t = b.target || {};
  if (t.mode === 'sparkplug') return 'Sparkplug';
  return t.layout === 'object-per-asset' ? 'Object per asset' : 'Topic per tag';
}

/** "0.5 abs, hb 60 s" style summary of report-by-exception settings ('' when none). */
export function rbeLabel(b) {
  const parts = [];
  const db = b.rbe?.deadband;
  if (db && Number(db.value) > 0) parts.push(db.type === 'percent' ? `${db.value}%` : `${db.value} abs`);
  else if (Number(b.target?.deadband) > 0) parts.push(`${b.target.deadband} abs`);
  const hb = Number(b.rbe?.heartbeatMs);
  if (hb > 0) parts.push(`hb ${hb >= 1000 && hb % 1000 === 0 ? `${hb / 1000} s` : `${hb} ms`}`);
  return parts.join(', ');
}

/** Instances of a profile binding's profile (null when unknown). */
export function instanceCount(b, profiles = []) {
  if (b.source?.type !== 'device-profile') return null;
  const p = profiles.find((x) => x.id === b.source.profileId);
  return p ? (p.instances || []).length : null;
}

/** Everything a binding's detail row lists, as [label, value] pairs (strings only). */
export function detailFacts(b, { profiles = [], historians = [] } = {}) {
  const t = b.target || {};
  const facts = [['Layout', layoutLabel(b)]];
  if (t.mode === 'mqtt') {
    facts.push(['Format', `${t.format || 'plain'}${t.retain ? ', retained' : ''}, QoS ${t.qos || 0}`]);
    if (t.layout === 'object-per-asset' && t.maxObjectBytes) facts.push(['Max object size', `${t.maxObjectBytes} bytes`]);
    facts.push(['Status topic', t.statusTopic === false ? 'off' : 'on'], ['Meta topic', t.metaTopic === false ? 'off' : 'on']);
  }
  facts.push(['Deadband / heartbeat', rbeLabel(b) || 'none']);
  if (t.historian) {
    const h = historians.find((x) => x.id === t.historian.historianId);
    facts.push(['History', h ? `${h.name || h.id} (${h.type})` : `${t.historian.historianId} (not found)`]);
  }
  if (b.source?.type === 'device-profile') {
    const p = profiles.find((x) => x.id === b.source.profileId);
    facts.push(['Profile', `${p ? p.name : b.source.profileId} - ${instanceCount(b, profiles) ?? '?'} instance(s)`]);
  }
  return facts;
}

const ELIGIBLE = new Set(['timebase', 'timescaledb']);

/** Why a historian cannot be a direct target (null when it can). */
export function historianReason(h) {
  if (ELIGIBLE.has(h.type)) return null;
  if (h.type === 'influxdb') return 'not offered for device data: its writer does not store quality';
  return 'not supported as a direct target';
}

