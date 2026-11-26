// Mapping rows <-> CSV, for every source type (pure). One line per tag:
//   address,name,enabled,unit,description,displayName,dataType,scale,offset,precision,deadband,field,staleAfterMs
// Export writes the table as it is; import updates rows by address and (pick lists) adds the
// addresses the source can take, with a per-line error for everything it cannot apply.
// A header line is optional: without one the columns are address,name (a Kepware / Ignition
// "nodeId,name" export works as is; "nodeId" and "tag" are accepted for address).
import { makeRow, renameRow, setOv, renameable } from './mappingRows';
import { neutralizeFormula, restoreFormula } from '@/lib/csvSafe';

const NUMERIC = ['scale', 'offset', 'precision', 'deadband', 'staleAfterMs'];
const TEXT = ['unit', 'description', 'displayName', 'dataType', 'field'];
const ALIASES = { nodeid: 'address', tag: 'address', key: 'address', topic: 'address', metric: 'address', publish: 'enabled' };
const MAX_LINES = 5000;

/** Columns for a source type (Sparkplug metrics have no per-tag settings; field / staleness are MQTT-only). */
export function csvColumns(srcType) {
  if (srcType === 'sparkplug') return ['address', 'enabled'];
  const base = ['address', 'name', 'enabled', 'unit', 'description', 'displayName', 'dataType', 'scale', 'offset', 'precision', 'deadband'];
  return srcType === 'mqtt' ? [...base, 'field', 'staleAfterMs'] : base;
}

const quote = (v) => {
  const s = v === undefined || v === null ? '' : String(neutralizeFormula(v));
  return /[",\n\r;\t]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV text of the rows (what export downloads). */
export function rowsToCsv(rows, srcType) {
  const cols = csvColumns(srcType);
  const cell = (r, c) => {
    if (c === 'address') return r.address;
    if (c === 'name') return r.name;
    if (c === 'enabled') return r.enabled ? 'true' : 'false';
    if (c === 'deadband') return typeof r.ov.deadband === 'object' ? (r.ov.deadband.type === 'percent' ? `${r.ov.deadband.value}%` : r.ov.deadband.value) : r.ov.deadband;
    return r.ov[c];
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => quote(cell(r, c))).join(','))].join('\n') + '\n';
}

/** A template: the header plus one example line per source type. */
export function csvTemplate(srcType) {
  const cols = csvColumns(srcType);
  const example = { device: 'temp', 'device-profile': 'temp', opcua: 'ns=2;s=Line1.Motor.Temp', mqtt: 'plant/line1/temp', sparkplug: 'Motor/Temp' }[srcType] || 'temp';
  const sample = { address: example, name: 'motorTemp', enabled: 'true', unit: 'degC', description: 'Motor winding temperature', scale: '', offset: '', precision: '1', deadband: '0.5', field: srcType === 'mqtt' ? 'data.value' : '', staleAfterMs: srcType === 'mqtt' ? '60000' : '' };
  return `${cols.join(',')}\n${cols.map((c) => quote(sample[c] ?? '')).join(',')}\n`;
}

/** Split CSV text into records (quotes, doubled quotes, CRLF; delimiter , ; or tab, taken from the first line). */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const records = [];
  let rec = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) {
      rec.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      rec.push(cell);
      records.push(rec);
      rec = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || rec.length) {
    rec.push(cell);
    records.push(rec);
  }
  return records.filter((r) => r.some((x) => x.trim() !== '')).slice(0, MAX_LINES + 1);
}

const BOOL = { true: true, false: false, yes: true, no: false, on: true, off: false, 1: true, 0: false };

/** One cell -> [value] | [undefined, error]. Empty cells clear nothing (they are skipped). */
function cellValue(col, raw) {
  const v = restoreFormula(raw.trim());
  if (col === 'enabled') return Object.hasOwn(BOOL, v.toLowerCase()) ? [BOOL[v.toLowerCase()]] : [undefined, `enabled must be true or false, not "${v}"`];
  if (col === 'deadband') {
    const pct = v.endsWith('%');
    const n = Number(pct ? v.slice(0, -1) : v);
    if (!Number.isFinite(n) || n < 0 || (pct && n > 100)) return [undefined, `deadband "${v}" is not a number of 0 or more (or a percent up to 100%)`];
    return [pct ? { type: 'percent', value: n } : n];
  }
  if (NUMERIC.includes(col)) {
    const n = Number(v);
    if (!Number.isFinite(n)) return [undefined, `${col} "${v}" is not a number`];
    if (col === 'scale' && n === 0) return [undefined, 'scale cannot be 0'];
    if (col === 'precision' && !(Number.isInteger(n) && n >= 0 && n <= 10)) return [undefined, 'precision must be a whole number from 0 to 10'];
    if (col === 'staleAfterMs' && !(Number.isInteger(n) && n >= 1000 && n <= 86400000)) return [undefined, 'staleAfterMs must be 1000 to 86400000'];
    return [n];
  }
  return [v];
}

/** Can a pick-list mapping of this source take a new address? -> null (yes) or the reason. */
function addReason(srcType, address, tagDefs) {
  if (srcType === 'device' || srcType === 'device-profile') return tagDefs?.some((t) => t.key === address) ? null : `"${address}" is not a tag of the ${srcType === 'device' ? 'device' : 'profile'}`;
  if (srcType === 'mqtt' && /[+#]/.test(address)) return `"${address}" is a wildcard; list concrete topics (or map by filter)`;
  return null;
}

/**
 * Apply CSV text to the editor state's rows. -> { rows, errors: [{ line, message }], added, updated }.
 * Lines with an error are skipped entirely; the others apply.
 */
export function applyCsv(state, text, { tagDefs = null } = {}) {
  const records = parseCsv(text);
  const errors = [];
  if (!records.length) return { rows: state.rows, errors: [{ line: 0, message: 'No lines found.' }], added: 0, updated: 0 };
  const head = records[0].map((h) => h.trim().replace(/^"|"$/g, ''));
  const named = head.map((h) => ALIASES[h.toLowerCase()] || h);
  const hasHeader = named.includes('address');
  const cols = hasHeader ? named : ['address', 'name'];
  const allowed = new Set(csvColumns(state.srcType));
  if (hasHeader) for (const c of cols) if (c && !allowed.has(c)) errors.push({ line: 0, message: `Column "${c}" is not used for this source and is ignored.` });
  const rows = [...state.rows];
  const index = new Map(rows.map((r, i) => [r.address, i]));
  let added = 0;
  let updated = 0;
  records.slice(hasHeader ? 1 : 0).forEach((rec, k) => {
    const line = k + (hasHeader ? 2 : 1);
    const get = (c) => restoreFormula(cols.indexOf(c) >= 0 ? rec[cols.indexOf(c)] ?? '' : '');
    const address = get('address').trim();
    if (!address) return errors.push({ line, message: 'No address.' });
    let row;
    if (index.has(address)) row = rows[index.get(address)];
    else if (state.selectMode === 'rules') return errors.push({ line, message: `"${address}" is not among the tags the rules list; nothing to update.` });
    else {
      const why = addReason(state.srcType, address, tagDefs);
      if (why) return errors.push({ line, message: why });
      row = makeRow({ srcType: state.srcType, address, def: tagDefs?.find((t) => t.key === address) || {} });
    }
    const lineErrors = [];
    let next = row;
    for (const c of cols) {
      const raw = get(c);
      if (!allowed.has(c) || c === 'address' || raw.trim() === '') continue;
      if (c === 'name') {
        if (!renameable(state.srcType)) lineErrors.push('names of this source cannot be changed');
        else next = renameRow(next, restoreFormula(raw.trim()));
        continue;
      }
      const [v, err] = cellValue(c, raw);
      if (err) lineErrors.push(err);
      else if (c === 'enabled') next = { ...next, enabled: v };
      else if (TEXT.includes(c) || NUMERIC.includes(c)) next = setOv(next, c, v);
    }
    if (lineErrors.length) return errors.push({ line, message: `${address}: ${lineErrors.join('; ')}` });
    if (index.has(address)) {
      rows[index.get(address)] = next;
      updated += 1;
    } else {
      index.set(address, rows.length);
      rows.push(next);
      added += 1;
    }
    return undefined;
  });
  return { rows, errors, added, updated };
}
