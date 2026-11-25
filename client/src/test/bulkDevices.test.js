import { describe, it, expect } from 'vitest';
import { parseBulkDevices, rowToInstance, bulkTemplate } from '@/lib/bulkDevices';

const profile = { id: 'p', params: [{ name: 'base', default: 100 }, { name: 'zone' }] };
const fields = [{ name: 'unitId', type: 'number' }, { name: 'rack', type: 'number' }];

describe('parseBulkDevices', () => {
  it('parses a CSV with params and device fields', () => {
    const csv = 'name,host,port,zone,base,unitId\nPump 1,10.0.0.1,1502,A,200,3\nPump 2,10.0.0.2,,B,,';
    const { rows, problems, columns } = parseBulkDevices(csv, profile, fields);
    expect(problems).toEqual([]);
    expect(columns).toEqual(['name', 'host', 'port', 'zone', 'base', 'unitId']);
    expect(rows[0]).toMatchObject({ line: 2, name: 'Pump 1', host: '10.0.0.1', port: 1502, params: { zone: 'A', base: '200' }, fields: { unitId: 3 }, errors: [] });
    expect(rows[1]).toMatchObject({ line: 3, params: { zone: 'B' }, errors: [] });
    expect('port' in rows[1]).toBe(false);
  });
  it('parses a tab-separated spreadsheet paste and matches headers case-insensitively', () => {
    const { rows } = parseBulkDevices('Name\tIP\tZONE\nA\t1.1.1.1\tz1', profile, fields);
    expect(rows[0]).toMatchObject({ name: 'A', host: '1.1.1.1', params: { zone: 'z1' }, errors: [] });
  });
  it('handles quoted fields with commas', () => {
    const { rows } = parseBulkDevices('name,host,zone\n"Pump, main",h1,"a,b"', profile);
    expect(rows[0].name).toBe('Pump, main');
    expect(rows[0].params.zone).toBe('a,b');
  });
  it('flags row problems per row without dropping the good rows', () => {
    const { rows } = parseBulkDevices('name,host,port,zone\nok,h1,502,A\n,h2,502,A\nbad port,h3,99999,A\nno zone,h4,,\nok,h5,,A', profile);
    expect(rows[0].errors).toEqual([]);
    expect(rows[1].errors).toContain('name is required');
    expect(rows[2].errors[0]).toContain('port "99999"');
    expect(rows[3].errors).toContain('parameter "zone" is required');
    expect(rows[4].errors[0]).toContain('name repeats line 2');
  });
  it('reports a missing header column and ignored columns', () => {
    const r = parseBulkDevices('host,colour\nh1,red', profile);
    expect(r.problems.some((p) => p.includes('"name" column'))).toBe(true);
    expect(r.problems.some((p) => p.includes('"colour"'))).toBe(true);
  });
  it('empty input asks for a header', () => {
    expect(parseBulkDevices('', profile).problems[0]).toContain('header');
  });
  it('builds the instantiate body', () => {
    const { rows } = parseBulkDevices('name,host,port,zone,enabled,unitId\nA,h,1502,Z,no,2', profile, fields);
    expect(rowToInstance(rows[0])).toEqual({ name: 'A', host: 'h', port: 1502, enabled: false, unitId: 2, params: { zone: 'Z' } });
  });
  it('offers a template with the declared params', () => {
    expect(bulkTemplate(profile).split('\n')[0]).toBe('name,host,port,base,zone');
  });
});
