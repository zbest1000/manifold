import { describe, it, expect } from 'vitest';
import { newState, stateFromBinding, buildMapping } from '@/pages/tags/mappingModel';
import { parseCsv, rowsToCsv, applyCsv, csvTemplate, csvColumns } from '@/pages/tags/csvRows';
import { describeConflict, overwriteBody, isStale, diffFields } from '@/pages/tags/editor/staleEdit';

const brokers = [{ id: 'b1', name: 'Local' }];
const DEFS = [{ key: 'temp', property: 'temperature', unit: 'degC' }, { key: 'rpm' }];

describe('CSV rows', () => {
  it('parses quotes, doubled quotes, CRLF, semicolons and tabs', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
    expect(parseCsv('a;b\nc;d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('device pick list: updates by address, adds device tags, refuses unknown keys and bad cells per line', () => {
    const s = stateFromBinding({ id: 'x', enabled: true, source: { type: 'device', deviceId: 'd', tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a' } }, { brokers, tagDefs: DEFS });
    const r = applyCsv(s, 'address,name,unit,scale,deadband,enabled\ntemp,t1,K,2,5%,true\nrpm,speed,,,,false\nnope,x\ntemp,t2,,0\n', { tagDefs: DEFS });
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
    expect(r.errors[0].message).toMatch(/not a tag of the device/);
    expect(r.errors[1].message).toMatch(/scale cannot be 0/);
    const b = buildMapping({ ...s, rows: r.rows });
    expect(b.source.tags).toEqual([{ address: 'temp', name: 't1', unit: 'K', scale: 2, deadband: { type: 'percent', value: 5 } }, { address: 'rpm', name: 'speed', enabled: false }]);
  });

  it('headerless "nodeId,name" lists still work for OPC UA; export -> import round trips', () => {
    const s = newState({ srcType: 'opcua', ref: { connectionId: 'c' }, picked: [], brokers });
    const r = applyCsv(s, 'ns=2;s=A.B,Motor B\nns=2;s=A.C,Motor C\n');
    expect(r.rows.map((x) => [x.address, x.name])).toEqual([['ns=2;s=A.B', 'Motor B'], ['ns=2;s=A.C', 'Motor C']]);
    const csv = rowsToCsv(r.rows, 'opcua');
    const again = applyCsv({ ...s, rows: [] }, csv);
    expect(again.rows.map((x) => [x.address, x.name, x.enabled])).toEqual([['ns=2;s=A.B', 'Motor B', true], ['ns=2;s=A.C', 'Motor C', true]]);
  });

  it('MQTT columns include field and staleness; wildcards are refused; rules mode only updates', () => {
    expect(csvColumns('mqtt')).toContain('staleAfterMs');
    expect(csvTemplate('mqtt').split('\n')[0]).toBe(csvColumns('mqtt').join(','));
    const s = newState({ srcType: 'mqtt', ref: { brokerId: 'src' }, picked: [], brokers });
    const r = applyCsv(s, 'topic,name,field,staleAfterMs\nplant/a,a,data.v,5000\nplant/#,x\n');
    expect(r.rows[0].ov).toEqual({ field: 'data.v', staleAfterMs: 5000 });
    expect(r.errors[0].message).toMatch(/wildcard/);
    const rules = { ...s, selectMode: 'rules', rows: r.rows };
    expect(applyCsv(rules, 'address,unit\nplant/b,K\n').errors[0].message).toMatch(/not among the tags/);
  });
});

describe('stale edits', () => {
  const base = { id: 'm', name: 'a', rev: 3, target: { assetPath: 'x', qos: 0 } };
  it('describes what changed elsewhere, here and in both places', () => {
    const c = describeConflict({ base, mine: { ...base, name: 'mine', target: { assetPath: 'y', qos: 0 } }, theirs: { ...base, rev: 4, target: { assetPath: 'z', qos: 1 } } });
    expect(c.elsewhere.map((d) => d.path)).toEqual(['target.assetPath', 'target.qos']);
    expect(c.here.map((d) => d.path)).toEqual(['name', 'target.assetPath']);
    expect(c.both).toEqual(['target.assetPath']);
    expect(diffFields({ a: [1] }, { a: [] })).toEqual([{ path: 'a', from: '(not set)', to: '[]' }, { path: 'a[0]', from: '1', to: '(not set)' }]);
  });
  it('keep mine is based on their revision; an older server without rev gets none', () => {
    expect(overwriteBody({ ...base, name: 'mine' }, { rev: 9 })).toMatchObject({ name: 'mine', rev: 9 });
    expect(overwriteBody({ ...base }, { name: 'x' }).rev).toBeUndefined();
    expect(isStale({ status: 409, body: { code: 'stale' } })).toBe(true);
    expect(isStale({ status: 409, body: {} })).toBe(false);
  });
});
