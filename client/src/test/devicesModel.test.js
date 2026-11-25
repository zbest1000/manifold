import { describe, it, expect } from 'vitest';
import {
  tagTypeNames, tagTypeInfo, typeNeedsLength, lengthDefault, typeOptional, extraColumns, cleanFields, applyPreset, presetActive, summarizeNormalized, camelCase, suggestProperty, nodesToTags,
  nodeDisabledReason, flattenTree, probeBody, toPayload, blankDevice, browseBlockedReason
} from '@/pages/devices/model';

const s7 = { id: 's7', tagTypes: ['BOOL', 'REAL', 'STRING'], tagTypeInfo: { STRING: { name: 'STRING', needsLength: true, lengthHelp: 'maximum characters (default 254)' } }, deviceFields: [{ name: 'rack', type: 'number', default: 0 }, { name: 'remoteTsap', type: 'text', optional: true }], optionFields: [], presets: [], defaultPort: 102 };
const eip = { id: 'ethernet-ip', tagTypes: ['DINT', 'REAL'], tagTypeOptional: true, addressHelp: 'Logix tag names (no mention of optional types here).', deviceFields: [], optionFields: [{ name: 'maxPacketBytes', type: 'number', optional: true }] };
const modbus = { id: 'modbus-tcp', tagTypes: ['int16'], deviceFields: [], optionFields: [] };

describe('descriptor helpers', () => {
  it('reads per-type details from tagTypeInfo', () => {
    expect(tagTypeInfo(s7, 'STRING').needsLength).toBe(true);
    expect(typeNeedsLength(s7, 'string')).toBe(true);
    expect(typeNeedsLength(s7, 'REAL')).toBe(false);
    expect(lengthDefault(tagTypeInfo(s7, 'STRING'))).toBe(254);
    expect(lengthDefault(tagTypeInfo(s7, 'REAL'))).toBe(null);
    expect(typeNeedsLength(eip, 'DINT')).toBe(false);
  });
  it('normalizes tag types from strings or objects', () => {
    expect(tagTypeNames(s7)).toEqual(['BOOL', 'REAL', 'STRING']);
    expect(tagTypeNames(eip)).toEqual(['DINT', 'REAL']);
  });
  it('the driver flag decides whether a blank type is allowed', () => {
    expect(typeOptional(eip)).toBe(true);
    expect(typeOptional(s7)).toBe(false);
  });
  it('Modbus-only columns; S7 shows length inline', () => {
    expect(extraColumns(modbus).advanced).toEqual(['length', 'bit', 'byteOrder', 'wordOrder', 'description']);
    expect(extraColumns(s7)).toEqual({ always: ['length'], advanced: ['description'] });
    expect(extraColumns(eip)).toEqual({ always: [], advanced: ['description'] });
  });
  it('drops blank optional fields and coerces numbers', () => {
    expect(cleanFields({ rack: '1', remoteTsap: '' }, s7.deviceFields)).toEqual({ rack: 1 });
    expect(cleanFields({ maxPacketBytes: '' }, eip.optionFields)).toEqual({});
  });
  it('presets fill their fields and report when active', () => {
    const p = { label: 'S7-1200', rack: 0, slot: 1 };
    const d = applyPreset({ rack: 0, slot: 2, name: 'x' }, p);
    expect(d).toMatchObject({ rack: 0, slot: 1, name: 'x' });
    expect(presetActive(d, p)).toBe(true);
    expect(presetActive({ rack: 0, slot: 2 }, p)).toBe(false);
  });
  it('builds a payload without status or blank optionals', () => {
    const d = { ...blankDevice(s7), name: 'n', host: 'h', status: { state: 'online' }, remoteTsap: '', tags: [{ _id: 'a', key: 'k', address: 'DB1.DBD0', type: 'REAL' }] };
    const p = toPayload(d, s7);
    expect(p.status).toBeUndefined();
    expect('remoteTsap' in p).toBe(false);
    expect(p.port).toBe(102);
    expect(p.tags[0]).toEqual({ key: 'k', address: 'DB1.DBD0', type: 'REAL' });
  });
});

describe('validation summaries', () => {
  it('modbus', () => {
    expect(summarizeNormalized('modbus-tcp', { table: 'holding', offset: 99, count: 2, fc: 3, type: 'float32', byteOrder: 'big', wordOrder: 'little' })).toBe('holding 99 (0-based) x2 · FC3 · CDAB');
  });
  it('s7', () => {
    expect(summarizeNormalized('s7', { address: 'DB10.DBD0', area: 'DB', areaCode: 0x84, db: 10, byteOffset: 0, type: 'REAL', length: 4 })).toBe('DB10.DBD0 · DB10 byte 0 · REAL, 4 bytes');
  });
  it('ethernet-ip with and without a type', () => {
    expect(summarizeNormalized('ethernet-ip', { key: 'a', address: 'Motor.Speed' })).toContain('read from the controller');
    expect(summarizeNormalized('ethernet-ip', { key: 'a', address: 'X', type: 'DINT' })).toBe('X · DINT');
  });
  it('unknown shapes fall back to key/values', () => {
    expect(summarizeNormalized('other', { key: 'a', foo: 1, bar: { x: 2 }, pollGroup: 'g' })).toBe('foo: 1 · bar: {"x":2}');
    expect(summarizeNormalized('other', null)).toBe('');
  });
});

describe('browse import', () => {
  it('camelCases tag names, never the raw address', () => {
    expect(camelCase('Motor_Speed')).toBe('motorSpeed');
    expect(suggestProperty('Program:MainProgram.LocalDint')).toBe('localDint');
    expect(suggestProperty('Motor.Speed')).toBe('motorSpeed');
    expect(suggestProperty('Arr[3]')).toBe('arr3');
    expect(suggestProperty('DintTag')).toBe('dintTag');
  });
  it('generates unique keys and properties against the existing rows', () => {
    let n = 0;
    const nodes = [
      { id: 'tag:Motor.Speed', address: 'Motor.Speed', meta: { dataType: 'REAL' } },
      { id: 'tag:Motor2.Speed', address: 'Other.Speed', meta: { dataType: 'REAL' } },
      { id: 'tag:Arr', address: 'Arr', meta: { dataType: 'DINT', dims: [10] } },
      { id: 'tag:Motor', address: 'Motor', meta: { dataType: 'MotorType' } }
    ];
    const rows = nodesToTags(nodes, { descriptor: eip, existing: [{ key: 'Motor.Speed', property: 'motorSpeed' }], pollGroup: 'default', makeId: () => `id${n++}` });
    expect(rows.map((r) => r.key)).toEqual(['Motor.Speed2', 'Other.Speed', 'Arr', 'Motor']);
    expect(rows.map((r) => r.property)).toEqual(['motorSpeed2', 'otherSpeed', 'arr', 'motor']);
    expect(rows.map((r) => r.type)).toEqual(['REAL', 'REAL', '', '']);
  });
  it('keeps known atomic types and leaves arrays and UDTs to the controller', () => {
    const rows = nodesToTags(
      [{ id: 'a', address: 'A', meta: { dataType: 'DINT' } }, { id: 'b', address: 'B', meta: { dataType: 'DINT', dims: [3] } }, { id: 'c', address: 'C', meta: { dataType: 'MyUdt' } }],
      { descriptor: eip, existing: [], makeId: () => 'x' }
    );
    expect(rows.map((r) => r.type)).toEqual(['DINT', '', '']);
  });
  it('explains disabled nodes', () => {
    expect(nodeDisabledReason({ kind: 'tag', address: 'Secret', meta: { accessible: false, reason: 'External Access is None' } })).toBe('External Access is None');
    expect(nodeDisabledReason({ kind: 'tag', address: '' , meta: {} })).toMatch(/Type definition/);
    expect(nodeDisabledReason({ kind: 'tag', address: 'A', meta: {} }, new Set(['A']))).toMatch(/Already/);
    expect(nodeDisabledReason({ kind: 'folder', address: '' })).toBe('');
  });
  it('flattens the lazy tree by node id so same-address folders do not collide', () => {
    const tree = {
      '': [{ id: 'controller', kind: 'folder', address: '' }, { id: 'types', kind: 'folder', address: '' }],
      controller: [{ id: 'tag:Motor', kind: 'tag', address: 'Motor', meta: { hasChildren: true } }],
      'tag:Motor': [{ id: 'tag:Motor.Speed', kind: 'tag', address: 'Motor.Speed', meta: {} }]
    };
    const rows = flattenTree(tree, new Set(['controller', 'tag:Motor']));
    expect(rows.map((r) => [r.key, r.level])).toEqual([['controller', 1], ['tag:Motor', 2], ['tag:Motor.Speed', 3], ['types', 1]]);
    expect(rows[1].isFolder).toBe(true);
  });
  it('says why browsing is unavailable', () => {
    expect(browseBlockedReason(false, {}, null)).toMatch(/save the device/);
    expect(browseBlockedReason(true, { enabled: false }, null)).toMatch(/disabled/);
    expect(browseBlockedReason(true, { enabled: true }, { phase: 'backoff' })).toMatch(/not online/);
    expect(browseBlockedReason(true, { enabled: true }, { phase: 'online' })).toBe('');
  });
});

describe('probe request bodies', () => {
  it('differ per protocol', () => {
    expect(probeBody('modbus-tcp', { address: ' holding:1 ', count: '4', unitId: '2' })).toEqual({ address: 'holding:1', count: 4, unitId: 2 });
    expect(probeBody('s7', { address: 'DB1.DBD0', count: '' })).toEqual({ address: 'DB1.DBD0' });
    expect(probeBody('s7', { address: 'DB1.DBB0', count: '8' })).toEqual({ address: 'DB1.DBB0', length: 8 });
    expect(probeBody('ethernet-ip', { address: 'Tag', count: 5 })).toEqual({ address: 'Tag' });
  });
});
