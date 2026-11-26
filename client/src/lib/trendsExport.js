import { downloadDataUrl } from '@/lib/download';

/**
 * Trends CSV export (server: GET /api/trends/export.csv, streamed).
 * Pure URL building is tested in src/test/trendsExport.test.js.
 */

/** The export URL for what Trends shows. `mode` is 'raw' or 'bucketed' (live is always raw). */
export function trendsExportUrl({ source, id, tags, units = [], from, to, mode }) {
  const p = new URLSearchParams();
  p.set('source', source);
  p.set('id', id);
  for (const t of tags) p.append('tag', t);
  tags.forEach((_, i) => p.append('unit', units[i] || ''));
  p.set('from', String(Math.floor(from)));
  p.set('to', String(Math.ceil(to)));
  p.set('mode', source === 'live' ? 'raw' : mode);
  return `/api/trends/export.csv?${p.toString()}`;
}

/** The file name from a Content-Disposition header, or a fallback. */
export function filenameFrom(disposition, fallback = 'manifold-trends.csv') {
  const m = /filename="([^"]+)"/.exec(disposition || '');
  return m ? m[1] : fallback;
}

/**
 * Download the export. Without an API token the browser fetches the URL itself and streams it to disk.
 * With one (a header cannot ride on a plain link), the response is fetched with the token and saved.
 */
export async function downloadTrendsCsv(url) {
  const { getAuthToken } = await import('@/lib/api'); // lazy: keeps this module free of the store for unit tests
  const token = getAuthToken();
  if (!token) {
    downloadDataUrl(url, '');
    return;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      // not JSON
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  downloadDataUrl(href, filenameFrom(res.headers.get('content-disposition')));
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
