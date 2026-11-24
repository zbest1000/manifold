// Device API calls that lib/api.js does not export (it keeps its request helper
// private and is owned elsewhere). Everything else on this page uses `api`.
import { getAuthToken } from '@/lib/api';

/**
 * JSON request that keeps the server's exact message and the structured parts
 * of an error body: `err.status`, `err.details` (400), `err.instances` and
 * `err.bindings` (409 on profile delete).
 */
export async function jsonRequest(path, { method = 'GET', body } = {}) {
  const token = getAuthToken();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error(e.message || 'Network request failed');
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (Array.isArray(data.details)) err.details = data.details;
    if (Array.isArray(data.instances)) err.instances = data.instances;
    if (Array.isArray(data.bindings)) err.bindings = data.bindings;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

/** GET /api/devices/:id/browse?node= -> children[] (browse-capable drivers only). */
export async function browseDevice(id, node = '') {
  const qs = node ? `?node=${enc(node)}` : '';
  const body = await jsonRequest(`/api/devices/${enc(id)}/browse${qs}`);
  return body.children || [];
}

/** GET /api/devices/profiles -> profiles[] with `instances: [{ id, name }]`. */
export const listProfiles = async () => (await jsonRequest('/api/devices/profiles')).profiles || [];
export const createProfile = (profile) => jsonRequest('/api/devices/profiles', { method: 'POST', body: profile });
export const updateProfile = (id, profile) => jsonRequest(`/api/devices/profiles/${enc(id)}`, { method: 'PUT', body: profile });
export const deleteProfile = (id) => jsonRequest(`/api/devices/profiles/${enc(id)}`, { method: 'DELETE' });
export const instantiateProfile = (id, body) => jsonRequest(`/api/devices/profiles/${enc(id)}/instantiate`, { method: 'POST', body });

/** POST /api/system/discovery/start; the server's refusal text is shown verbatim. */
export const startDiscoveryScan = (options) => jsonRequest('/api/system/discovery/start', { method: 'POST', body: options });
