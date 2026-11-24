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
    const MAX_NAMED = 5; // a host with 50 devices must not turn the banner into a wall of names
    const named = ids.slice(0, MAX_NAMED).map((d) => names.get(d) || d).join(', ');
    const who = ids.length ? ` Affects: ${named}${ids.length > MAX_NAMED ? ` and ${ids.length - MAX_NAMED} more` : ''}.` : '';
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

/** "5 s ago", "3 min ago", "2 h ago", "4 d ago"; '' for a missing/invalid time. */
export function relativeTime(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * Quarantined tags with the reason the driver gave: [{ key, code, message, since }].
 * Falls back to the plain `quarantined` key list from an older server.
 */
export function quarantineList(status) {
  const reasons = status?.quarantineReasons || {};
  const keys = Array.isArray(status?.quarantined) && status.quarantined.length ? status.quarantined : Object.keys(reasons);
  return keys.map((key) => ({ key, code: reasons[key]?.code ?? null, message: reasons[key]?.message || null, since: reasons[key]?.since ?? null }));
}

/** Plain text for one quarantine reason ({ code, message }). */
export function quarantineReasonText(reason) {
  if (!reason) return '';
  return reason.message || (reason.code !== null && reason.code !== undefined ? `code ${reason.code}` : '');
}

/** One plain sentence for the card: "2 quarantined tags: pressure (illegal data address) and 1 more". */
export function quarantineSummary(status) {
  const list = quarantineList(status);
  if (!list.length) return '';
  const noun = `${list.length} quarantined tag${list.length === 1 ? '' : 's'}`;
  const first = list[0];
  const why = quarantineReasonText(first);
  const more = list.length > 1 ? ` and ${list.length - 1} more` : '';
  return `${noun}: ${first.key}${why ? ` (${why})` : ''}${more}`;
}

// ---------------------------------------------------------------- list / detail view helpers

const PROBLEM_RANK = { parked: 0, backoff: 1, connecting: 2, stopped: 3, online: 4, disabled: 5 };

/**
 * What the list and the detail show for a device's state: the short word, its tone, the reason
 * (why it is not online) and a sort rank (ascending = the worst first). `deviceBadge` stays the
 * source of truth; this only shortens "Backoff: ECONNREFUSED" into a word plus a reason line.
 */
export function deviceStateView(device, status, live, host) {
  const b = deviceBadge(device, status, live, host);
  const s = { ...(status || {}), ...(live || {}) };
  const word = { backoff: 'Backoff', online: 'Online', connecting: 'Connecting', parked: 'Driver parked', disabled: 'Disabled', stopped: s.state === 'offline' ? 'Offline' : 'Stopped' }[b.key] || b.label;
  const tone = b.key === 'online' ? 'good' : b.key === 'parked' ? 'bad' : b.key === 'disabled' ? 'neutral' : b.key === 'stopped' ? (s.lastError ? 'bad' : 'neutral') : 'warn';
  return { key: b.key, label: word, tone, reason: b.detail || '', since: s.since || null, rank: PROBLEM_RANK[b.key] ?? 3 };
}

/** The last driver error as text and time: { message, at } or null. */
export function lastErrorInfo(status) {
  const le = status?.lastError;
  if (!le) return null;
  const message = typeof le === 'object' ? le.message || JSON.stringify(le) : String(le);
  return { message, at: status?.lastErrorAt ?? null };
}

/**
 * The poll group that matters most for a one-line summary: slowed beats overrunning beats ok, then
 * the highest cycle/interval ratio. null when the driver has reported no cycles yet.
 */
export function pollSummary(status) {
  const groups = Object.entries(status?.groups || {});
  if (!groups.length) return null;
  const rank = { ok: 0, overrun: 1, slowed: 2 };
  let worst = null;
  for (const [id, g] of groups) {
    const h = cycleHealth(g);
    if (!worst || rank[h.level] > rank[worst.h.level] || (rank[h.level] === rank[worst.h.level] && h.ratio > worst.h.ratio)) worst = { id, h };
  }
  return { groupId: worst.id, groups: groups.length, ...worst.h };
}

/** Plain words for a cycle level: '' when healthy. */
export function cycleLevelText(h) {
  if (h.level === 'slowed') return `Slowed to ${formatMs(h.effective)}`;
  if (h.level === 'overrun') return 'Overrunning';
  return '';
}

/** A reading for display: at most 3 fraction digits, grouped thousands; the raw value belongs in the tooltip. */
export function formatReading(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Age of a sample: "0.4 s", "12 s", "3 min", "2 h"; '' when unknown. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 3600000)} h`;
}

/** "3 of 50 online · 2 with problems" for the page header. */
export function fleetSummary(views) {
  const total = views.length;
  if (!total) return '';
  const online = views.filter((v) => v.key === 'online').length;
  const problems = views.filter((v) => v.key !== 'online' && v.key !== 'disabled').length;
  const disabled = views.filter((v) => v.key === 'disabled').length;
  const parts = [`${online} of ${total} online`];
  if (problems) parts.push(`${problems} with problems`);
  if (disabled) parts.push(`${disabled} disabled`);
  return parts.join(' · ');
}
