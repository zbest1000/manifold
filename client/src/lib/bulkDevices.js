// Parse a pasted table / CSV into device rows for "bulk create from a profile".
// Columns: name, host, port (optional) and then anything else: a column that
// matches a protocol device field (unitId, rack, slot, ...) is sent as that
// field, every other column is a profile parameter value.
import { parseDelimited, detectDelimiter } from '@/lib/deviceTags';
import { resolveParams } from '@/lib/deviceProfiles';

const CORE = { name: 'name', host: 'host', ip: 'host', hostname: 'host', address: 'host', port: 'port', enabled: 'enabled' };

const norm = (s) => String(s ?? '').trim();

/**
 * @param {string} text pasted CSV / TSV (first row is the header)
 * @param {{ params?: {name:string}[] }} profile
 * @param {{ name:string, type?:string }[]} [deviceFields] descriptor deviceFields
 * @returns {{ rows: object[], columns: string[], problems: string[] }}
 *   row: { line, name, host, port?, enabled?, fields:{}, params:{}, errors:[] }
 */
export function parseBulkDevices(text, profile, deviceFields = []) {
  const table = parseDelimited(text, detectDelimiter(text));
  if (table.length < 1) return { rows: [], columns: [], problems: ['Paste a header row followed by one row per device.'] };
  const header = table[0].map(norm);
  const declared = new Set((profile?.params || []).map((p) => p.name));
  const fieldByLower = new Map(deviceFields.map((f) => [f.name.toLowerCase(), f]));
  const paramByLower = new Map([...declared].map((n) => [n.toLowerCase(), n]));
  const problems = [];
  const cols = header.map((h) => {
    const k = h.toLowerCase();
    if (declared.has(h)) return { kind: 'param', name: h };
    if (CORE[k]) return { kind: 'core', name: CORE[k] };
    if (paramByLower.has(k)) return { kind: 'param', name: paramByLower.get(k) };
    if (fieldByLower.has(k)) return { kind: 'field', name: fieldByLower.get(k).name, type: fieldByLower.get(k).type };
    return { kind: 'unknown', name: h };
  });
  for (const need of ['name', 'host']) {
    if (!cols.some((c) => c.kind === 'core' && c.name === need)) problems.push(`The header needs a "${need}" column.`);
  }
  for (const c of cols) if (c.kind === 'unknown' && c.name) problems.push(`Column "${c.name}" is not a parameter of this profile or a device field and is ignored.`);
  const rows = table.slice(1).map((cells, i) => {
    const row = { line: i + 2, name: '', host: '', fields: {}, params: {}, errors: [] };
    cols.forEach((c, j) => {
      const v = norm(cells[j]);
      if (v === '' || c.kind === 'unknown') return;
      if (c.kind === 'core') {
        if (c.name === 'port') {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 1 && n <= 65535) row.port = n;
          else row.errors.push(`port "${v}" must be 1-65535`);
        } else if (c.name === 'enabled') row.enabled = !/^(0|false|no|off)$/i.test(v);
        else row[c.name] = v;
      } else if (c.kind === 'param') row.params[c.name] = v;
      else row.fields[c.name] = c.type === 'number' && Number.isFinite(Number(v)) ? Number(v) : v;
    });
    if (!row.name) row.errors.push('name is required');
    if (!row.host) row.errors.push('host is required');
    row.errors.push(...resolveParams(profile, row.params).errors);
    return row;
  });
  const names = new Map();
  for (const r of rows) {
    if (r.name && names.has(r.name)) r.errors.push(`name repeats line ${names.get(r.name)}`);
    else if (r.name) names.set(r.name, r.line);
  }
  if (!rows.length) problems.push('There are no device rows below the header.');
  return { rows, columns: cols.filter((c) => c.kind !== 'unknown').map((c) => c.name), problems };
}

/** The POST /profiles/:id/instantiate body for a parsed row. */
export function rowToInstance(row) {
  return { name: row.name, host: row.host, ...(row.port ? { port: row.port } : {}), ...(row.enabled === false ? { enabled: false } : {}), ...row.fields, params: row.params };
}

/** A header + example row so users can see the expected shape. */
export function bulkTemplate(profile) {
  const params = profile?.params || [];
  const header = ['name', 'host', 'port', ...params.map((p) => p.name)];
  const sample = ['Line 1 meter', '192.168.1.21', '', ...params.map((p) => (p.default !== undefined ? String(p.default) : ''))];
  return `${header.join(',')}\n${sample.join(',')}\n`;
}
