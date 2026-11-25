// Bulk edits and spreadsheet paste over editor rows (pure; see mappingModel.js).
import { renameRow, setOv, COPY_KEYS } from './mappingRows';

const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);

// ---- bulk edits -------------------------------------------------------------------------------

const mapKeys = (rows, keys, fn) => {
  const set = keys instanceof Set ? keys : new Set(keys);
  return rows.map((r) => (set.has(r.key) ? fn(r) : r));
};

export const bulkEnable = (rows, keys, on) => mapKeys(rows, keys, (r) => ({ ...r, enabled: on }));
export const bulkSet = (rows, keys, field, value) => mapKeys(rows, keys, (r) => setOv(r, field, value));
export const bulkContextKey = (rows, keys, key, value) =>
  mapKeys(rows, keys, (r) => setOv(r, 'context', { ...(isObj(r.ov.context) ? r.ov.context : {}), [key]: value }));
export const bulkReset = (rows, keys) => mapKeys(rows, keys, (r) => ({ ...r, ov: {} }));

/** Words of a name: separators and camel/Pascal boundaries. */
export function words(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** camelCase exactly like the server's suggestions: "Motor_Speed" -> motorSpeed, "TT101_PV" -> tt101Pv. */
export function camelCase(s) {
  const parts = String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return parts
    .map((w, i) => {
      const lower = /^[A-Z0-9]+$/.test(w) ? w.toLowerCase() : w;
      return i === 0 ? lower.charAt(0).toLowerCase() + lower.slice(1) : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

export const snakeCase = (s) => words(s).map((w) => w.toLowerCase()).join('_');
export const stripPrefix = (s, prefix) => (prefix && String(s).toLowerCase().startsWith(String(prefix).toLowerCase()) ? String(s).slice(prefix.length) : String(s));

/** Apply a naming transform to the names of the given rows. kind: camel | snake | strip | replace. */
export function bulkRename(rows, keys, { kind, prefix = '', find = '', replace = '', regex = false, caseSensitive = false }) {
  let re = null;
  if (kind === 'replace') {
    if (!find) return rows;
    const src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      re = new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch {
      return rows;
    }
  }
  return mapKeys(rows, keys, (r) => {
    let next = r.name;
    if (kind === 'camel') next = camelCase(r.name);
    else if (kind === 'snake') next = snakeCase(r.name);
    else if (kind === 'strip') next = stripPrefix(r.name, prefix);
    else if (kind === 'replace') next = r.name.replace(re, replace);
    return next && next !== r.name ? renameRow(r, next) : r;
  });
}

/** Copy the transferable settings of one row onto others (names are never copied). */
export function bulkCopy(rows, fromKey, keys) {
  const from = rows.find((r) => r.key === fromKey);
  if (!from) return rows;
  return mapKeys(rows, keys, (r) => {
    if (r.key === fromKey) return r;
    const ov = { ...r.ov };
    for (const k of COPY_KEYS) {
      if (from.ov[k] !== undefined) ov[k] = from.ov[k];
      else delete ov[k];
    }
    return { ...r, ov };
  });
}

/** Spreadsheet clipboard text -> rows of cells (tab separated, CRLF tolerant, trailing newline dropped). */
export function parseGrid(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

export const PASTE_COLUMNS = ['name', 'unit', 'description'];

/**
 * Paste a grid starting at (startKey, startCol) over `orderKeys` (the table order). Columns run
 * name -> unit -> description; extra cells are ignored. Returns { rows, count }.
 */
export function applyPaste(rows, orderKeys, startKey, startCol, grid) {
  const startRow = orderKeys.indexOf(startKey);
  const c0 = PASTE_COLUMNS.indexOf(startCol);
  if (startRow < 0 || c0 < 0) return { rows, count: 0 };
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let count = 0;
  grid.forEach((cells, i) => {
    const key = orderKeys[startRow + i];
    if (!key) return;
    let r = byKey.get(key);
    cells.forEach((cell, j) => {
      const col = PASTE_COLUMNS[c0 + j];
      if (!col) return;
      const v = cell.trim();
      if (col === 'name') r = v ? renameRow(r, v) : r;
      else r = setOv(r, col, v);
    });
    byKey.set(key, r);
    count += 1;
  });
  return { rows: rows.map((r) => byKey.get(r.key)), count };
}
