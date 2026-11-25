'use strict';

const { filterProblem } = require('./mqttMatch');
const { validateAssetPath } = require('./bindingModel');

/**
 * Pipeline routes the old Tags flow created for MQTT-topic selections, and the mapping each
 * becomes. Identification is deliberately conservative: only the exact shape that flow wrote is
 * recognised -
 *
 *   { name, source: { brokerId, filter: '<a/b/>#' | '<a/b/c>' },
 *     transforms: [{ type: 'repath', to: '<base>/{n+1-}' }, ({ type: 'envelope' })?],
 *     target: { type: 'mqtt', brokerId, retain?, qos? } }
 *
 * where n is the number of literal levels before the filter's last level (or its "#"), and nothing
 * else on the route. Anything hand-edited is left alone. A candidate is never applied without the
 * user reviewing the proposed mapping (routes/tags.js POST /bindings/migrate).
 */

const ROUTE_KEYS = new Set(['id', 'name', 'enabled', 'source', 'transforms', 'target', 'createdAt', 'updatedAt', 'rev']);
const only = (o, keys) => o && typeof o === 'object' && Object.keys(o).every((k) => keys.includes(k));

/** -> { base, prefix: [levels], wildcard, envelope } when the route has the Tags-flow shape, else null. */
function legacyShape(r) {
  if (!r || typeof r !== 'object' || !Object.keys(r).every((k) => ROUTE_KEYS.has(k))) return null;
  const s = r.source;
  const t = r.target;
  const tr = r.transforms;
  if (!only(s, ['brokerId', 'filter']) || !s.brokerId || typeof s.filter !== 'string' || filterProblem(s.filter)) return null;
  if (!only(t, ['type', 'brokerId', 'retain', 'qos']) || t.type !== 'mqtt' || !t.brokerId) return null;
  if (!Array.isArray(tr) || tr.length < 1 || tr.length > 2) return null;
  if (!only(tr[0], ['type', 'to']) || tr[0].type !== 'repath' || typeof tr[0].to !== 'string') return null;
  if (tr[1] && (!only(tr[1], ['type']) || tr[1].type !== 'envelope')) return null;
  const levels = s.filter.split('/');
  const wildcard = levels[levels.length - 1] === '#';
  if (levels.slice(0, -1).some((l) => l === '+' || l === '#') || (!wildcard && levels.includes('+'))) return null;
  const prefix = levels.slice(0, -1);
  const m = /^(.*)\/\{(\d+)-\}$/.exec(tr[0].to);
  if (!m || Number(m[2]) !== prefix.length + 1) return null;
  const base = m[1];
  if (validateAssetPath(base)) return null;
  return { base, prefix, wildcard, envelope: tr.length === 2 };
}

/** The mapping (binding body) equivalent to a Tags-flow route. */
function mappingFor(r, shape) {
  const source = shape.wildcard
    ? { type: 'mqtt', brokerId: r.source.brokerId, tags: 'all', filter: r.source.filter }
    : { type: 'mqtt', brokerId: r.source.brokerId, tags: [{ address: r.source.filter, name: r.source.filter.split('/').pop() }] };
  const target = { mode: 'mqtt', brokerId: r.target.brokerId, assetPath: shape.base, layout: 'topic-per-tag', format: shape.envelope ? 'envelope' : 'plain' };
  if (r.target.qos) target.qos = Number(r.target.qos) || 0;
  if (r.target.retain) target.retain = true;
  const name = typeof r.name === 'string' && r.name && !/^tags -> /.test(r.name) ? r.name : `${shape.base} (from route)`;
  return { name, enabled: r.enabled !== false, source, target };
}

/** Candidates among the stored pipeline routes: [{ route, mapping, createdByTags, differences }]. */
function migrationCandidates(routes) {
  const out = [];
  for (const r of routes || []) {
    const shape = legacyShape(r);
    if (!shape) continue;
    const differences = [
      'Adds a retained _status document (broker connection) and a retained _meta document under the asset path.',
      shape.envelope
        ? 'Envelope payloads ({v, t, q}); a {v,t,q,u} or {value,timestamp,quality,unit} payload is read as an envelope instead of being wrapped again.'
        : 'Plain payloads: a value/time/quality envelope or {value, unit} object is reduced to its value; other JSON objects pass through unchanged.'
    ];
    out.push({ route: r, mapping: mappingFor(r, shape), createdByTags: /^tags -> /.test(String(r.name || '')), differences });
  }
  return out;
}

module.exports = { legacyShape, mappingFor, migrationCandidates };
