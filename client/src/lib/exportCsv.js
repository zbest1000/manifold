import { downloadDataUrl } from './download';

// RFC-4180-ish escaping: quote when the cell contains a comma, quote or newline.
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: array of arrays (first row = header). Triggers a browser download. */
export function downloadCsv(rows, filename) {
  const csv = rows.map((r) => r.map(cell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  downloadDataUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Historian-shaped series ([{ tag, points: [[tsMs, value], …] }]) → one wide
 * CSV: an ISO timestamp column plus one column per tag, rows on the union of
 * timestamps (blank where a tag has no sample at that instant) — the shape
 * Excel pivot tables and pandas both ingest directly.
 */
export function seriesToCsvRows(series) {
  const tags = series.map((s) => s.tag || 'series');
  const byTs = new Map(); // ts -> row values indexed by series
  series.forEach((s, i) => {
    for (const [ts, v] of s.points || []) {
      let row = byTs.get(ts);
      if (!row) {
        row = new Array(series.length).fill('');
        byTs.set(ts, row);
      }
      row[i] = v;
    }
  });
  const rows = [['timestamp', ...tags]];
  for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
    rows.push([new Date(ts).toISOString(), ...byTs.get(ts)]);
  }
  return rows;
}
