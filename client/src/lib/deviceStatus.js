// Pure helpers that turn the server's device status into what the list shows.

/**
 * Merge the REST status with the latest socket `device-state` push (which wins,
 * it is newer) and map it onto a badge: { key, label, status, detail }.
 * `status` is a key understood by the shared <Badge>.
 */
export function deviceBadge(device, status, live, host) {
  if (device && device.enabled === false) return { key: 'disabled', label: 'Disabled', status: 'offline', detail: '' };
  const s = { ...(status || {}), ...(live || {}) };
  if (host && host.state === 'parked') {
    return { key: 'parked', label: 'Driver parked', status: 'error', detail: s.reason || 'The driver process crashed repeatedly and was parked' };
  }
  switch (s.phase) {
    case 'online':
      return { key: 'online', label: 'Online', status: 'connected', detail: '' };
    case 'connecting':
      return { key: 'connecting', label: 'Connecting', status: 'connecting', detail: s.reason || '' };
    case 'backoff':
      return { key: 'backoff', label: s.reason ? `Backoff: ${s.reason}` : 'Backoff', status: 'reconnecting', detail: s.reason || '' };
    case 'stopped':
      return { key: 'stopped', label: 'Stopped', status: 'offline', detail: s.reason || '' };
    default:
      // No phase yet (driver host still starting, or older server): fall back to the coarse state.
      if (s.state === 'online') return { key: 'online', label: 'Online', status: 'connected', detail: '' };
      if (host && host.state === 'starting') return { key: 'connecting', label: 'Starting', status: 'connecting', detail: '' };
      return { key: 'stopped', label: s.state === 'offline' ? 'Offline' : 'Unknown', status: 'offline', detail: s.reason || '' };
  }
}

/**
 * Driver host banner info: one entry per host that is parked or restarting.
 * `devices` (optional) names the devices that live on the host via `deviceIds`.
 */
export function hostIssues(hosts, devices = []) {
  const names = new Map((devices || []).map((d) => [d.id, d.name]));
  const out = [];
  for (const [id, h] of Object.entries(hosts || {})) {
    if (h.state !== 'parked' && h.state !== 'backoff') continue;
    const ids = Array.isArray(h.deviceIds) ? h.deviceIds : [];
    const who = ids.length ? ` Affects: ${ids.map((d) => names.get(d) || d).join(', ')}.` : '';
    if (h.state === 'parked') out.push({ id, level: 'error', deviceIds: ids, text: `Driver host ${id} (${h.protocol}) is parked after ${h.restarts} restarts. Its devices are not polling until it is restarted.${who}` });
    else out.push({ id, level: 'warn', deviceIds: ids, text: `Driver host ${id} (${h.protocol}) is restarting (attempt ${h.restarts}).${who}` });
  }
  return out;
}

/**
 * Polling health for one poll group.
 *  - slowed:  the scheduler stretched the interval (effective > configured)
 *  - overrun: cycles take longer than the interval, or have overrun before
 *  - ok
 * `ratio` is average cycle time as a share of the effective interval.
 */
export function cycleHealth(group) {
  const interval = Number(group?.intervalMs) || 0;
  const effective = Number(group?.effectiveIntervalMs) || interval;
  const last = Number(group?.lastCycleMs) || 0;
  const avg = Number(group?.avgCycleMs) || 0;
  const overruns = Number(group?.overruns) || 0;
  const ratio = effective > 0 ? avg / effective : 0;
  let level = 'ok';
  if (effective > interval && interval > 0) level = 'slowed';
  // `overruns` is a lifetime counter: it is shown, but only a cycle that is slow right now raises the level.
  else if (interval > 0 && (last > interval || avg > interval)) level = 'overrun';
  return { level, ratio, interval, effective, last, avg, overruns };
}

/** Worst level across groups, for the card's warning accent. */
export function worstHealth(groups) {
  const order = { ok: 0, overrun: 1, slowed: 2 };
  let worst = 'ok';
  for (const g of Object.values(groups || {})) {
    const l = cycleHealth(g).level;
    if (order[l] > order[worst]) worst = l;
  }
  return worst;
}

/** Quality as a small descriptor. q is 192/64/0 (OPC-style) but strings are tolerated. */
export function qualityInfo(q) {
  if (q === 192 || q === 'good') return { key: 'good', label: 'Good' };
  if (q === 64 || q === 'uncertain') return { key: 'uncertain', label: 'Uncertain' };
  return { key: 'bad', label: 'Bad' };
}

export function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(7)));
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function formatMs(ms) {
  if (ms === undefined || ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Which driver host runs a device: the host whose `deviceIds` lists it. Only when
 * no host reports `deviceIds` at all (older server) fall back to the worst host
 * of the same protocol.
 */
export function hostFor(device, hosts) {
  if (!hosts) return undefined;
  const all = Object.values(hosts);
  const direct = all.find((h) => Array.isArray(h.deviceIds) && h.deviceIds.includes(device.id)) || hosts[device.hostId] || hosts[device.status?.hostId];
  if (direct) return direct;
  if (all.some((h) => Array.isArray(h.deviceIds))) return undefined;
  const rank = { parked: 3, backoff: 2, starting: 1 };
  return all.filter((h) => h.protocol === device.protocol).sort((a, b) => (rank[b.state] || 0) - (rank[a.state] || 0))[0];
}

/** A value is stale when nothing updated it for more than 3x the poll interval (min 3 s). */
export function staleAfterMs(intervalMs) {
  return Math.max(3000, 3 * (Number(intervalMs) || 1000));
}
export function isStale(sample, intervalMs, now = Date.now()) {
  return Boolean(sample && sample.tRead && now - sample.tRead > staleAfterMs(intervalMs));
}

// Driver "exception" codes by protocol. The runtime keys device.status.exceptions by code only.
const EXC_NAMES = {
  'modbus-tcp': { 1: 'Illegal function', 2: 'Illegal data address (register does not exist)', 3: 'Illegal data value', 4: 'Device failure', 5: 'Acknowledge (busy, retry later)', 6: 'Device busy', 10: 'Gateway path unavailable', 11: 'Gateway target did not respond' },
  s7: { 1: 'CPU hardware fault', 3: 'Access not allowed (PUT/GET or protection)', 5: 'Address out of range (DB too short)', 6: 'Data type not supported', 7: 'Data type inconsistent', 10: 'Object does not exist (DB missing)', PLAN_STALE: 'Plan exceeds negotiated PDU', INVALID_REQUEST: 'Invalid request' },
  'ethernet-ip': { '-1': 'Read-only violation', 1: 'Connection failure', 2: 'Resource unavailable', 3: 'Invalid parameter', 4: 'Tag or path not found', 5: 'Path destination unknown', 8: 'Service not supported', 15: 'Privilege violation', 16: 'Device state conflict', 19: 'Not enough data', 20: 'Attribute not supported', 21: 'Too much data', 22: 'Object does not exist', 255: 'General error' }
};
export function exceptionName(protocol, code) {
  return EXC_NAMES[protocol]?.[code] || `Code ${code}`;
}
