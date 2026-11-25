// "Needs attention" on the Overview (pure, unit tested in src/test/attention.test.js).
//
// Each item: { key, tone: 'bad' | 'warn', what, detail, to } where `to` is the place to fix it.
// Nothing is returned when all is well.

const fmt = (n) => Number(n || 0).toLocaleString();
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Pending counts sampled from successive engine-metrics pushes: growing = rose on each of the last `n` samples. */
export function isGrowing(samples, n = 3) {
  if (!Array.isArray(samples) || samples.length < n + 1) return false;
  const tail = samples.slice(-(n + 1));
  for (let i = 1; i < tail.length; i++) if (!(tail[i] > tail[i - 1])) return false;
  return true;
}

/** Keep the last `max` pending samples per id: { id: [n, ...] } -> new object. */
export function recordPending(history, values, max = 6) {
  const out = {};
  for (const [id, v] of Object.entries(values || {})) {
    const prev = history?.[id] || [];
    out[id] = [...prev, Number(v) || 0].slice(-max);
  }
  return out;
}

// Where each kind of stored object is edited.
const PLACE = {
  route: '/pipelines',
  mapping: '/tags?view=mappings',
  recording: '/pipelines?tab=recorder',
  'alert rule': '/settings?tab=alerts',
  model: '/pipelines?tab=models',
  contract: '/pipelines?tab=contracts'
};

const missingText = (missing) => (missing || []).map((m) => `${m.kind} ${m.id}`).join(', ');

/**
 * Pipeline, historian, alert, mapping and reference problems.
 *   routes          { [routeId]: { routed, delivered, pending, rejected, target, historianId } }  (engine-metrics pipelines)
 *   historians      { [historianId]: { delivered, rejected, pending } }                         (engine-metrics outbox)
 *   routePending / historianPending   pending samples per id (recordPending)
 *   names           { routes: {id: name}, historians: {id: name} }
 *   alertRules      [{ id, name, state: { state, since, value, ... } }]
 *   mappings        [{ id, name, enabled }] and health { [id]: { state, reasons: [{ message, fix }] } }
 *   broken          [{ type, id, name, missing }]  (GET /api/system/broken-references)
 */
export function engineAttention({ routes = {}, historians = {}, routePending = {}, historianPending = {}, names = {}, alertRules = [], mappings = [], health = {}, broken = [] } = {}) {
  const items = [];
  const routeName = (id) => names.routes?.[id] || id;
  const histName = (id) => names.historians?.[id] || id;

  for (const [id, m] of Object.entries(routes)) {
    if (m.rejected > 0) items.push({ key: `r-rej-${id}`, tone: 'bad', what: `Route ${routeName(id)}`, detail: `${plural(m.rejected, 'point')} rejected by historian ${histName(m.historianId)} (routed ${fmt(m.routed)}, delivered ${fmt(m.delivered)})`, to: '/pipelines' });
    if (m.pending > 0 && isGrowing(routePending[id])) items.push({ key: `r-pend-${id}`, tone: 'warn', what: `Route ${routeName(id)}`, detail: `${plural(m.pending, 'point')} pending and growing: historian ${histName(m.historianId)} is not keeping up`, to: '/pipelines' });
  }
  for (const [id, h] of Object.entries(historians)) {
    if (h.rejected > 0) items.push({ key: `h-rej-${id}`, tone: 'bad', what: `Historian ${histName(id)}`, detail: `${plural(h.rejected, 'point')} rejected (delivered ${fmt(h.delivered)})`, to: '/pipelines?tab=historians' });
    if (h.pending > 0 && isGrowing(historianPending[id])) items.push({ key: `h-pend-${id}`, tone: 'warn', what: `Historian ${histName(id)}`, detail: `${plural(h.pending, 'point')} pending and growing`, to: '/pipelines?tab=historians' });
  }

  const listed = new Set();
  for (const r of alertRules) {
    const st = r.state;
    const where = st?.topic ? ` on ${st.topic}` : '';
    const value = st && st.value !== undefined && st.value !== null ? ` · value ${st.value}` : '';
    if (st?.state === 'firing') items.push({ key: `a-${r.id}`, tone: 'bad', what: `Alert ${r.name || r.id}`, detail: `Firing${where}${value}`, to: '/settings?tab=alerts' });
    else if (st?.state === 'breached') items.push({ key: `a-${r.id}`, tone: 'warn', what: `Alert ${r.name || r.id}`, detail: `Breached${where}${value}${st.remainingMs ? `, fires in ${Math.ceil(st.remainingMs / 1000)} s if it lasts` : ''}`, to: '/settings?tab=alerts' });
    else if (st?.state === 'broken') {
      listed.add(`alert rule:${r.id}`);
      items.push({ key: `a-${r.id}`, tone: 'bad', what: `Alert ${r.name || r.id}`, detail: `Broken reference: ${missingText(st.broken)} no longer exists`, to: '/settings?tab=alerts' });
    }
  }

  for (const b of mappings) {
    const h = health[b.id];
    if (!h || b.enabled === false || (h.state !== 'problem' && h.state !== 'source-missing')) continue;
    listed.add(`mapping:${b.id}`);
    const why = h.reasons?.[0]?.message || 'not publishing';
    items.push({ key: `m-${b.id}`, tone: 'bad', what: `Mapping ${b.name || b.id}`, detail: `Not publishing: ${why}`, to: '/tags?view=mappings' });
  }

  for (const o of broken) {
    if (listed.has(`${o.type}:${o.id}`)) continue; // already listed with its reason
    items.push({ key: `x-${o.type}-${o.id}`, tone: 'bad', what: `${o.type[0].toUpperCase()}${o.type.slice(1)} ${o.name || o.id}`, detail: `Broken reference: ${missingText(o.missing)} no longer exists`, to: PLACE[o.type] || '/' });
  }
  return items;
}
