// Device API calls that lib/api.js does not export (it keeps its request helper
// private and is owned elsewhere). Everything else on this page uses `api`.
import { getAuthToken } from '@/lib/api';

/** GET /api/devices/:id/browse?node= -> children[] (browse-capable drivers only). */
export async function browseDevice(id, node = '') {
  const token = getAuthToken();
  const qs = node ? `?node=${encodeURIComponent(node)}` : '';
  let res;
  try {
    res = await fetch(`/api/devices/${encodeURIComponent(id)}/browse${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  } catch (e) {
    throw new Error(e.message || 'Network request failed');
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) throw new Error(body.error || `Browse failed (${res.status})`);
  return body.children || [];
}
