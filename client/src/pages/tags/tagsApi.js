// Thin wrappers for the Tags page. lib/api.js keeps its low-level request helper private, so
// methods that already exist there go through `api`; the few new endpoints use `call` below,
// which attaches the same bearer token.
import { api, getAuthToken } from '@/lib/api';

async function call(path, { method = 'GET', body, signal } = {}) {
  const token = getAuthToken();
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error('Could not reach the server. Check that Manifold is running.');
  }
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    // status and body travel with the error: a 409 { code: 'stale', current } is handled by the editor.
    const err = new Error(json.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export const fetchSources = () => api.tagSources().then((r) => r.sources || []);
export const browse = (source, node = '') => api.tagBrowse(source.type, source.id, node).then((r) => r.children || []);
export const fetchBindings = () => api.listBindings();
/** POST /api/tags/bindings -> stored binding + { warnings }. Throws { status: 409, body: { code: 'stale', current } } on a concurrent edit. */
export const saveBinding = (b) => call('/api/tags/bindings', { method: 'POST', body: b });
export const removeBinding = (id) => api.deleteBinding(id);
export const setHostState = (body) => api.sparkplugState(body);

/** POST /api/tags/bindings/preview -> { valid, error? | resolved topics, payloads, warnings }. Read-only. */
export const previewBinding = (draft, signal) => call('/api/tags/bindings/preview', { method: 'POST', body: draft, signal });

/** GET /api/tags/bindings/schema -> the option catalogue the editor renders from (cached for the session). */
let schemaPromise = null;
export const fetchSchema = () => {
  schemaPromise ||= call('/api/tags/bindings/schema').catch((e) => {
    schemaPromise = null;
    throw e;
  });
  return schemaPromise;
};

/** POST /api/tags/bindings/suggest { source } -> { tags: [{ address, suggestedName, basis, rawAddress, ... }], context }. Read-only. */
export const suggestMapping = (source) => call('/api/tags/bindings/suggest', { method: 'POST', body: { source } });

export const fetchHistorians = () => api.listHistorians().then((r) => r.historians || []);
export const fetchProfiles = () => call('/api/devices/profiles').then((r) => r.profiles || []);
export const fetchDevices = () => api.devices().then((r) => r.devices || []);

/** One level of the observed topic tree under `prefix` (same API the Flows view uses) -> { children, truncated }. */
export const topicChildren = (brokerId, prefix = '') => api.topicTree(brokerId, prefix, 300);

/** Effective tags of a device with their metadata (property, unit, type), flattening poll-group folders. */
export async function fetchDeviceTags(deviceId) {
  const src = { type: 'device', id: deviceId };
  const top = await browse(src, '');
  const folders = top.filter((n) => n.kind === 'folder');
  const nested = await Promise.all(folders.map((f) => browse(src, f.address)));
  return [...top.filter((n) => n.kind === 'tag'), ...nested.flat().filter((n) => n.kind === 'tag')];
}

/** GET /api/tags/bindings/migrations -> { candidates: [{ route, mapping, differences, blocked }] } (pipeline routes the old Tags flow created). */
export const fetchMigrations = () => call('/api/tags/bindings/migrations');

/** POST /api/tags/bindings/migrate { routeId, mapping, route: 'disable' | 'delete' } -> { binding, route }. */
export const migrateRoute = (body) => call('/api/tags/bindings/migrate', { method: 'POST', body });

/** GET (dry run) or POST { dryRun: false } /api/tags/bindings/cleanup-retained -> { topics: [{ brokerId, topic, bindingName, reason, connected, cleared? }], cleared, waiting }. */
export const cleanupRetained = (dryRun) => (dryRun ? call('/api/tags/bindings/cleanup-retained') : call('/api/tags/bindings/cleanup-retained', { method: 'POST', body: { dryRun: false } }));
