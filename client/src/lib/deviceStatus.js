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

/** Driver host banner info: one entry per host that is parked or restarting. */
export function hostIssues(hosts) {
  const out = [];
  for (const [id, h] of Object.entries(hosts || {})) {
    if (h.state === 'parked') out.push({ id, level: 'error', text: `Driver host ${id} (${h.protocol}) is parked after ${h.restarts} restarts. Devices on it are not polling until it is restarted.` });
    else if (h.state === 'backoff') out.push({ id, level: 'warn', text: `Driver host ${id} (${h.protocol}) is restarting (attempt ${h.restarts}).` });
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
  else if (overruns > 0 || (interval > 0 && last > interval)) level = 'overrun';
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
 * Which driver host runs a device. The contract does not name the link, so use
 * `device.hostId` / `status.hostId` when present, else the host(s) of the same
 * protocol, preferring the worst state (parked > backoff > the rest).
 */
export function hostFor(device, hosts) {
  if (!hosts) return undefined;
  const direct = hosts[device.hostId] || hosts[device.status?.hostId];
  if (direct) return direct;
  const rank = { parked: 3, backoff: 2, starting: 1 };
  return Object.values(hosts)
    .filter((h) => h.protocol === device.protocol)
    .sort((a, b) => (rank[b.state] || 0) - (rank[a.state] || 0))[0];
}
