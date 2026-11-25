import { describe, it, expect } from 'vitest';
import { parseDelimited, parseTags, serializeTags, detectDelimiter, localTagErrors, describeWireAddress, cleanTag, orderCodeFor, pasteIntoTags, TAG_COLUMNS } from '@/lib/deviceTags';

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes, embedded delimiters and newlines', () => {
    const rows = parseDelimited('a,"b,1","say ""hi""","l1\nl2"\nx,y,z,w', ',');
    expect(rows).toEqual([['a', 'b,1', 'say "hi"', 'l1\nl2'], ['x', 'y', 'z', 'w']]);
  });
  it('detects tab, semicolon and comma', () => {
    expect(detectDelimiter('a\tb,c')).toBe('\t');
    expect(detectDelimiter('a;b;c,d')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
  });
  it('tolerates CRLF and blank lines', () => {
    expect(parseDelimited('a,b\r\n\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('parseTags', () => {
  it('matches columns by header name in any order, with aliases', () => {
    const { tags, usedHeader } = parseTags('Address,Tag,DataType,scale\nholding:100,Temp,int16,0.1');
    expect(usedHeader).toBe(true);
    expect(tags).toEqual([{ address: 'holding:100', key: 'Temp', type: 'int16', scale: 0.1 }]);
  });
  it('is positional without a header (spreadsheet paste)', () => {
    const { tags, usedHeader } = parseTags('Temp\tholding:100\tint16\t\t0.1\n');
    expect(usedHeader).toBe(false);
    expect(tags[0]).toMatchObject({ key: 'Temp', address: 'holding:100', type: 'int16', scale: 0.1 });
  });
  it('keeps non-numeric junk in numeric columns so validation can flag it', () => {
    const { tags } = parseTags('key,address,scale\nA,holding:1,abc');
    expect(tags[0].scale).toBe('abc');
  });
  it('round-trips through CSV and TSV', () => {
    const tags = [
      { key: 'Temp', address: 'holding:100', type: 'int16', scale: 0.1, unit: 'degC', description: 'Supply, "main" air' },
      { key: 'Run', address: 'coil:5', type: 'bool', pollGroup: 'fast', byteOrder: 'little', wordOrder: 'big' },
      { key: 'Energy', address: '40010', type: 'float32', length: 2, bit: 0, offset: -1.5, property: 'Energy/Total' }
    ];
    for (const d of [',', '\t']) {
      const { tags: back, usedHeader } = parseTags(serializeTags(tags, d), d);
      expect(usedHeader).toBe(true);
      expect(back).toEqual(tags);
    }
  });
});

describe('helpers', () => {
  it('flags missing and duplicate keys and missing addresses', () => {
    const e = localTagErrors([{ key: 'a', address: '1' }, { key: 'a', address: '2' }, { key: '', address: '3' }, { key: 'b' }]);
    expect(e[0]).toBeUndefined();
    expect(e[1]).toMatch(/Duplicate/);
    expect(e[2]).toMatch(/Key/);
    expect(e[3]).toMatch(/Address/);
  });
  it('describes wire addresses', () => {
    expect(describeWireAddress({ table: 'holding', offset: 99, count: 1 })).toBe('holding 99 (0-based)');
    expect(describeWireAddress({ table: 'input', offset: 0, count: 2 })).toBe('input 0 (0-based) ×2');
    expect(describeWireAddress(null)).toBe('');
  });
  it('cleanTag drops blanks and unknown props', () => {
    expect(cleanTag({ key: 'a', address: '1', unit: '', scale: 0, _ui: 1 })).toEqual({ key: 'a', address: '1', scale: 0 });
  });
  it('cleanTag converts numeric text but leaves junk for the server to flag', () => {
    expect(cleanTag({ key: 'a', address: '1', scale: '0.1', bit: '3', offset: 'x' })).toEqual({ key: 'a', address: '1', scale: 0.1, bit: 3, offset: 'x' });
  });
  it('maps byte/word order to the ABCD names', () => {
    expect(orderCodeFor('big', 'little')).toBe('CDAB');
    expect(orderCodeFor('little', 'little')).toBe('DCBA');
    expect(TAG_COLUMNS[0]).toBe('key');
  });
});

describe('pasteIntoTags', () => {
  const base = [{ key: 'a', address: '1' }, { key: 'b', address: '2' }];
  it('fills from the focused cell, spilling right and down, adding rows as needed', () => {
    const r = pasteIntoTags(base, 'x\tholding:5\ny\tholding:6\nz\tholding:7', 1, 'key');
    expect(r.tags.map((t) => [t.key, t.address])).toEqual([['a', '1'], ['x', 'holding:5'], ['y', 'holding:6'], ['z', 'holding:7']]);
    expect(r.added).toBe(2);
    expect(r.touched).toBe(1);
  });
  it('starts at the focused column', () => {
    const r = pasteIntoTags(base, 'int16\tfast', 0, 'type');
    expect(r.tags[0]).toMatchObject({ key: 'a', type: 'int16', pollGroup: 'fast' });
  });
  it('appends rows when the paste has a header row', () => {
    const r = pasteIntoTags(base, 'key\taddress\ntemp\tholding:9', 0, 'unit', () => ({ _id: 1 }));
    expect(r.tags).toHaveLength(3);
    expect(r.tags[2]).toEqual({ _id: 1, key: 'temp', address: 'holding:9' });
  });
});
