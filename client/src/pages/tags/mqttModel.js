// MQTT-topic sources in the mapping editor (pure; see mappingModel.js). A mapping reads one value
// per topic: { type: 'mqtt', brokerId, tags: [{ address: <topic>, name?, field?, staleAfterMs? }] }
// or tags: "all" with a wildcard filter (new matching topics are picked up by the server).
import { commonPrefix } from './helpers';
import { lastLevel } from './mappingRows';

/** Published names of picked MQTT topics: the levels below their common prefix (unique where last levels repeat). */
export function mqttNames(addresses) {
  const segs = commonPrefix(addresses).split('/').filter(Boolean).length;
  const keep = Math.min(segs, ...addresses.map((a) => a.split('/').length - 1));
  return new Map(addresses.map((a) => [a, a.split('/').slice(keep).join('/') || lastLevel(a)]));
}

/** A wildcard filter over picked topics: their common prefix + "#" ("#" alone when they share none). */
export function defaultFilter(topics) {
  const list = topics.filter(Boolean);
  if (!list.length) return '#';
  const keep = Math.min(commonPrefix(list).split('/').filter(Boolean).length, ...list.map((t) => t.split('/').length - 1));
  return keep ? `${list[0].split('/').slice(0, keep).join('/')}/#` : '#';
}

/** filter (tags: "all" only), default field and staleness of an MQTT-topic source. */
export function mqttSourceKeys(base, state) {
  const f = state.form;
  if (state.selectMode === 'rules') base.filter = String(state.ref.filter || '').trim();
  else delete base.filter;
  const field = String(f.srcField || '').trim();
  if (field) base.field = field;
  else delete base.field;
  const stale = String(f.staleAfterMs ?? '').trim();
  if (stale !== '') base.staleAfterMs = Number.isFinite(Number(stale)) ? Number(stale) : stale;
  else delete base.staleAfterMs;
}

/** POST /bindings/suggest rows of a filter -> the tag definitions rules mode lists ({ key, browseName }). */
export const tagDefsFromSuggest = (data) => (data?.tags || []).map((t) => ({ key: t.address, browseName: t.suggestedName }));
