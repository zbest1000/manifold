// Pure helpers for the device tag editor: delimited-text (CSV / spreadsheet TSV)
// parsing and serialising, and row <-> tag conversion. No React, no DOM.

/** Columns in the order the table shows them (advanced ones last); also the CSV export order. */
export const TAG_COLUMNS = [
  'key',
  'address',
  'type',
  'pollGroup',
  'scale',
  'offset',
  'unit',
  'property',
  'description',
  'length',
  'bit',
  'byteOrder',
  'wordOrder'
];

const NUMERIC = new Set(['length', 'bit', 'scale', 'offset']);
const ALIASES = {
  tag: 'key',
  name: 'key',
  tagname: 'key',
  register: 'address',
  addr: 'address',
  datatype: 'type',
  poll: 'pollGroup',
  pollgroup: 'pollGroup',
  poll_group: 'pollGroup',
  uns: 'property',
  unsname: 'property',
  uns_name: 'property',
  units: 'unit',
  desc: 'description',
  byteorder: 'byteOrder',
  byte_order: 'byteOrder',
  wordorder: 'wordOrder',
  word_order: 'wordOrder'
};

/** Pick the delimiter from the first non-empty line: tab wins (spreadsheet paste), then ; or , */
export function detectDelimiter(text) {
  const first = String(text).split(/\r?\n/).find((l) => l.trim()) || '';
  if (first.includes('\t')) return '\t';
  const semi = (first.match(/;/g) || []).length;
  const comma = (first.match(/,/g) || []).length;
  return semi > comma ? ';' : ',';
}

/** RFC-4180-ish parser: quoted fields, doubled quotes, embedded newlines. Returns string[][]. */
export function parseDelimited(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function quoteField(v, delimiter) {
  const s = v === undefined || v === null ? '' : String(v);
  return s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise tags with a header row. delimiter ',' for CSV, '\t' for clipboard/TSV. */
export function serializeTags(tags, delimiter = ',', columns = TAG_COLUMNS) {
  const lines = [columns.join(delimiter)];
  for (const t of tags) lines.push(columns.map((c) => quoteField(t[c], delimiter)).join(delimiter));
  return lines.join('\n') + '\n';
}

function headerMap(cells) {
  const names = cells.map((c) => {
    const k = c.trim().toLowerCase().replace(/\s+/g, '');
    const canon = TAG_COLUMNS.find((col) => col.toLowerCase() === k);
    return canon || ALIASES[k] || null;
  });
  // A header row has at least the key or address column recognised.
  return names.includes('key') || names.includes('address') ? names : null;
}

function coerce(col, raw) {
  const v = raw.trim();
  if (v === '') return undefined;
  if (NUMERIC.has(col)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v; // keep junk visible so validation flags it
  }
  return v;
}

/**
 * Turn delimited text into tag objects. If the first row looks like a header the
 * columns are matched by name (any order); otherwise they are positional in
 * TAG_COLUMNS order, which is what a copy from the table's visible columns gives.
 * @returns {{ tags: object[], usedHeader: boolean }}
 */
export function parseTags(text, delimiter) {
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return { tags: [], usedHeader: false };
  const map = headerMap(rows[0]);
  const body = map ? rows.slice(1) : rows;
  const cols = map || TAG_COLUMNS;
  const tags = body.map((cells) => {
    const t = {};
    cols.forEach((col, i) => {
      if (!col || cells[i] === undefined) return;
      const v = coerce(col, cells[i]);
      if (v !== undefined) t[col] = v;
    });
    return t;
  });
  return { tags: tags.filter((t) => t.key || t.address), usedHeader: !!map };
}

/** Normalise one tag for sending to the server: drop blanks and UI-only props. */
export function cleanTag(tag) {
  const out = {};
  for (const c of TAG_COLUMNS) {
    const v = tag[c];
    if (v === undefined || v === null || v === '') continue;
    out[c] = NUMERIC.has(c) && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return out;
}

/** Client-side checks that need no server: missing key / duplicate key. Returns { [index]: message }. */
export function localTagErrors(tags) {
  const seen = new Map();
  const errs = {};
  tags.forEach((t, i) => {
    const k = (t.key || '').trim();
    if (!k) errs[i] = 'Key is required';
    else if (seen.has(k)) errs[i] = `Duplicate key (also row ${seen.get(k) + 1})`;
    else seen.set(k, i);
    if (!errs[i] && !String(t.address ?? '').trim()) errs[i] = 'Address is required';
  });
  return errs;
}

/** "holding 99 (0-based)" style description of a resolved wire address. */
export function describeWireAddress(norm) {
  if (!norm || norm.table === undefined) return '';
  const n = norm.count > 1 ? ` ×${norm.count}` : '';
  return `${norm.table} ${norm.offset} (0-based)${n}`;
}

// Byte/word order as the four classic names used on Modbus devices' data sheets.
export const ORDER_CODES = {
  ABCD: { byteOrder: 'big', wordOrder: 'big' },
  CDAB: { byteOrder: 'big', wordOrder: 'little' },
  BADC: { byteOrder: 'little', wordOrder: 'big' },
  DCBA: { byteOrder: 'little', wordOrder: 'little' }
};

export function orderCodeFor(byteOrder, wordOrder) {
  return Object.keys(ORDER_CODES).find((k) => ORDER_CODES[k].byteOrder === byteOrder && ORDER_CODES[k].wordOrder === wordOrder);
}

/**
 * Paste spreadsheet text into the tag list the way a spreadsheet would: starting at
 * (rowIdx, column) and spilling right and down, appending rows as needed. If the
 * text carries a recognisable header row it is treated as a full import and the
 * rows are appended instead. `makeRow` creates a blank tag (so the UI can add ids).
 * @returns {{ tags: object[], added: number, touched: number }}
 */
export function pasteIntoTags(tags, text, rowIdx, column, makeRow = () => ({})) {
  const delimiter = text.includes('\t') ? '\t' : detectDelimiter(text);
  const parsed = parseTags(text, delimiter);
  if (parsed.usedHeader) {
    return { tags: [...tags, ...parsed.tags.map((t) => ({ ...makeRow(), ...t }))], added: parsed.tags.length, touched: 0 };
  }
  const rows = parseDelimited(text, delimiter);
  const start = Math.max(0, TAG_COLUMNS.indexOf(column));
  const out = tags.map((t) => ({ ...t }));
  let added = 0;
  rows.forEach((cells, i) => {
    const r = rowIdx + i;
    if (r >= out.length) {
      out.push(makeRow());
      added++;
    }
    cells.forEach((raw, j) => {
      const col = TAG_COLUMNS[start + j];
      if (!col) return;
      const v = coerce(col, raw);
      if (v === undefined) delete out[r][col];
      else out[r][col] = v;
    });
  });
  return { tags: out, added, touched: rows.length - added };
}
