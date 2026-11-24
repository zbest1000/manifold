import { describe, it, expect } from 'vitest';
import {
  slug, targetTopic, statusTopic, validateTemplate, looksLikeRawAddress, nameWarnings,
  resolvePreview, findCollisions, examplePayload, buildBoundIndex, boundFor, parseSourceParam,
  groupSources, sparkplugScopeError, commonPrefix
} from '@/pages/tags/helpers';
import { flattenVisible, treeKeyAction } from '@/pages/tags/treeNav';

describe('topic resolution mirrors the server', () => {
  it('slug trims and replaces whitespace and / + # runs', () => {
    expect(slug('  Motor RPM ')).toBe('Motor_RPM');
    expect(slug('a/b+c#d')).toBe('a_b_c_d');
    expect(slug('a  / b')).toBe('a_b');
  });
  it('targetTopic substitutes {name} or appends', () => {
    expect(targetTopic('uns/{name}', 'Motor RPM')).toBe('uns/Motor_RPM');
    expect(targetTopic('site/{name}/value', 'x')).toBe('site/x/value');
    expect(targetTopic('site/line///', 'x')).toBe('site/line/x');
    expect(targetTopic('', 'x')).toBe('uns/x');
    expect(targetTopic('a/{name}/{name}', 'z')).toBe('a/z/z');
  });
  it('statusTopic', () => {
    expect(statusTopic('uns/{name}')).toBe('uns/_status');
    expect(statusTopic('uns/line1/')).toBe('uns/line1/_status');
  });
});

describe('template validation', () => {
  it('accepts good templates', () => {
    expect(validateTemplate('acme/dallas/{name}')).toBeNull();
    expect(validateTemplate('acme/dallas')).toBeNull();
  });
  it('rejects bad ones', () => {
    expect(validateTemplate('')).toMatch(/Enter/);
    expect(validateTemplate('a/+/b')).toMatch(/wildcards/);
    expect(validateTemplate('/a')).toMatch(/slash/);
    expect(validateTemplate('a//b')).toMatch(/empty segment/);
    expect(validateTemplate('a/{prop}')).toMatch(/Unknown variable/);
    expect(validateTemplate('a b')).toMatch(/spaces/);
    expect(validateTemplate('$SYS/x')).toMatch(/reserved/);
  });
});

describe('raw address detection', () => {
  it('flags PLC / OPC UA style addresses', () => {
    expect(looksLikeRawAddress('DB10.DBD4')).toBe(true);
    expect(looksLikeRawAddress('db1.dbx0.0')).toBe(true);
    expect(looksLikeRawAddress('40012')).toBe(true);
    expect(looksLikeRawAddress('400123')).toBe(true);
    expect(looksLikeRawAddress('ns=2;s=Line1.Temp')).toBe(true);
  });
  it('does not flag property names', () => {
    expect(looksLikeRawAddress('speed')).toBe(false);
    expect(looksLikeRawAddress('Motor_RPM')).toBe(false);
    expect(looksLikeRawAddress('4001')).toBe(false);
    expect(looksLikeRawAddress('4000123')).toBe(false);
  });
  it('nameWarnings reports address and slugged names', () => {
    expect(nameWarnings('DB1.DBD0').map((w) => w.kind)).toContain('address');
    expect(nameWarnings('Motor RPM').map((w) => w.kind)).toEqual(['slugged']);
    expect(nameWarnings('speed')).toEqual([]);
    expect(nameWarnings('  ').map((w) => w.kind)).toContain('empty');
  });
});

describe('preview + collisions', () => {
  const rows = [
    { key: 'a', address: 'ns=2;s=A', name: 'Motor RPM' },
    { key: 'b', address: 'ns=2;s=B', name: 'Motor_RPM' },
    { key: 'c', address: 'ns=2;s=C', name: 'Temp' }
  ];
  it('resolves topics and warnings', () => {
    const r = resolvePreview('uns/{name}', rows);
    expect(r.map((x) => x.topic)).toEqual(['uns/Motor_RPM', 'uns/Motor_RPM', 'uns/Temp']);
    expect(r[0].warnings.map((w) => w.kind)).toEqual(['slugged']);
    expect(r[2].warnings).toEqual([]);
  });
  it('detects collisions after slugging', () => {
    const c = findCollisions(resolvePreview('uns/{name}', rows));
    expect([...c.keys()]).toEqual(['uns/Motor_RPM']);
    expect(c.get('uns/Motor_RPM')).toEqual(['a', 'b']);
  });
  it('a template without {name} still resolves distinct topics; none collide', () => {
    expect(findCollisions(resolvePreview('x', [rows[0], rows[2]])).size).toBe(0);
  });
  it('flags an address segment contributed by the template', () => {
    const r = resolvePreview('plc/DB1.x/{name}', [rows[2]]);
    expect(r[0].warnings.map((w) => w.kind)).toContain('address');
  });
  it('example payloads', () => {
    expect(JSON.parse(examplePayload('envelope'))).toEqual({ v: 42.5, t: 1700000000000, q: 192 });
    expect(examplePayload('plain')).toBe('42.5');
  });
  it('commonPrefix', () => {
    expect(commonPrefix(['a/b/c', 'a/b/d'])).toBe('a/b/');
    expect(commonPrefix(['x'])).toBe('x/');
  });
});

describe('bound tag index', () => {
  const bindings = [
    {
      id: 'b1', name: 'Line 1', target: { mode: 'mqtt', pathTemplate: 'uns/l1/{name}' },
      source: { type: 'opcua', connectionId: 'c1', tags: [{ address: 'ns=2;s=A', name: 'Motor RPM' }] }
    },
    {
      id: 'b2', name: 'Dev', target: { mode: 'mqtt', pathTemplate: 'uns/dev/{name}' },
      source: { type: 'device', deviceId: 'd1', tags: [{ address: '40001', name: 'speed' }] }
    },
    {
      id: 'b3', name: 'SP', target: { mode: 'sparkplug', group: 'G', edge: 'E', device: 'D' },
      source: { type: 'sparkplug', brokerId: 'k', group: 'g', edge: 'e', device: 'd', metrics: ['m1'] }
    },
    {
      id: 'b4', target: { mode: 'sparkplug', group: 'G', edge: 'E' },
      source: { type: 'sparkplug', brokerId: 'k', group: 'g', edge: 'e', device: null }
    }
  ];
  const idx = buildBoundIndex(bindings);
  it('matches opcua and device tags by source id + address, with resolved target path', () => {
    const hit = boundFor(idx, { type: 'opcua', id: 'c1' }, { kind: 'tag', address: 'ns=2;s=A' });
    expect(hit).toHaveLength(1);
    expect(hit[0].path).toBe('uns/l1/Motor_RPM');
    expect(boundFor(idx, { type: 'opcua', id: 'other' }, { kind: 'tag', address: 'ns=2;s=A' })).toEqual([]);
    expect(boundFor(idx, { type: 'device', id: 'd1' }, { kind: 'tag', address: '40001' })[0].path).toBe('uns/dev/speed');
  });
  it('matches sparkplug by scope + metric, and wildcard bindings cover every metric of the endpoint', () => {
    const meta = { group: 'g', edge: 'e', device: 'd' };
    expect(boundFor(idx, { type: 'sparkplug', id: 'k' }, { kind: 'tag', address: 'm1', meta })).toHaveLength(1);
    expect(boundFor(idx, { type: 'sparkplug', id: 'k' }, { kind: 'tag', address: 'm2', meta })).toEqual([]);
    const nodeMeta = { group: 'g', edge: 'e', device: null };
    expect(boundFor(idx, { type: 'sparkplug', id: 'k' }, { kind: 'tag', address: 'anything', meta: nodeMeta })).toHaveLength(1);
  });
  it('ignores folders', () => {
    expect(boundFor(idx, { type: 'opcua', id: 'c1' }, { kind: 'folder', address: 'ns=2;s=A' })).toEqual([]);
  });
});

describe('source param + grouping', () => {
  it('parseSourceParam splits on the first colon only', () => {
    expect(parseSourceParam('device:abc')).toEqual({ type: 'device', id: 'abc' });
    expect(parseSourceParam('device:a:b')).toEqual({ type: 'device', id: 'a:b' });
    expect(parseSourceParam('nonsense')).toBeNull();
    expect(parseSourceParam('x:')).toBeNull();
    expect(parseSourceParam(null)).toBeNull();
  });
  it('groupSources groups by type in a fixed order, unknown types last', () => {
    const g = groupSources([
      { type: 'mqtt', id: '1', label: 'a' }, { type: 'device', id: '2', label: 'b' }, { type: 'plc9', id: '3', label: 'c' }
    ]);
    expect(g.map((x) => x.type)).toEqual(['device', 'mqtt', 'other']);
  });
  it('sparkplugScopeError', () => {
    const a = { meta: { group: 'g', edge: 'e', device: 'd' } };
    expect(sparkplugScopeError([a, a])).toBeNull();
    expect(sparkplugScopeError([a, { meta: { group: 'g', edge: 'e', device: 'x' } }])).toMatch(/2 Sparkplug devices/);
  });
});

describe('tree keyboard navigation', () => {
  // root: F1 (folder) -> [T1, F2 -> [T2]], T0 (tag)
  const byParent = {
    '': [
      { id: 'F1', name: 'F1', address: 'F1', kind: 'folder' },
      { id: 'T0', name: 'T0', address: 'T0', kind: 'tag' }
    ],
    F1: [
      { id: 'T1', name: 'alpha', address: 'T1', kind: 'tag' },
      { id: 'F2', name: 'F2', address: 'F2', kind: 'folder' }
    ],
    F2: [{ id: 'T2', name: 'beta', address: 'T2', kind: 'tag' }]
  };
  const collapsed = flattenVisible(byParent, new Set());
  const open = flattenVisible(byParent, new Set(['F1', 'F2']));

  it('flattens only expanded levels with aria metadata', () => {
    expect(collapsed.map((i) => i.key)).toEqual(['F1', 'T0']);
    expect(open.map((i) => i.key)).toEqual(['F1', 'T1', 'F2', 'T2', 'T0']);
    const t2 = open.find((i) => i.key === 'T2');
    expect(t2).toMatchObject({ level: 3, parentKey: 'F2', posInSet: 1, setSize: 1 });
    expect(open[0]).toMatchObject({ level: 1, expanded: true, posInSet: 1, setSize: 2 });
  });
  it('Up/Down/Home/End move focus and clamp at the ends', () => {
    expect(treeKeyAction(open, 'F1', 'ArrowDown')).toEqual({ type: 'focus', key: 'T1' });
    expect(treeKeyAction(open, 'T1', 'ArrowUp')).toEqual({ type: 'focus', key: 'F1' });
    expect(treeKeyAction(open, 'F1', 'ArrowUp')).toBeNull();
    expect(treeKeyAction(open, 'T0', 'ArrowDown')).toBeNull();
    expect(treeKeyAction(open, 'T1', 'Home')).toEqual({ type: 'focus', key: 'F1' });
    expect(treeKeyAction(open, 'F1', 'End')).toEqual({ type: 'focus', key: 'T0' });
  });
  it('Right expands a closed folder, then moves into it; Left collapses, then goes to parent', () => {
    expect(treeKeyAction(collapsed, 'F1', 'ArrowRight')).toEqual({ type: 'expand', key: 'F1' });
    expect(treeKeyAction(open, 'F1', 'ArrowRight')).toEqual({ type: 'focus', key: 'T1' });
    expect(treeKeyAction(open, 'T1', 'ArrowRight')).toBeNull();
    expect(treeKeyAction(open, 'F1', 'ArrowLeft')).toEqual({ type: 'collapse', key: 'F1' });
    expect(treeKeyAction(open, 'T2', 'ArrowLeft')).toEqual({ type: 'focus', key: 'F2' });
    expect(treeKeyAction(open, 'T0', 'ArrowLeft')).toBeNull();
  });
  it('Enter toggles folders, Space toggles selection', () => {
    expect(treeKeyAction(open, 'F1', 'Enter')).toEqual({ type: 'toggle-expand', key: 'F1' });
    expect(treeKeyAction(open, 'T0', 'Enter')).toEqual({ type: 'toggle-select', key: 'T0' });
    expect(treeKeyAction(open, 'T1', ' ')).toEqual({ type: 'toggle-select', key: 'T1' });
    expect(treeKeyAction(open, 'T1', 'x')).toBeNull();
    expect(treeKeyAction([], null, 'ArrowDown')).toBeNull();
  });
  it('filter keeps matches and their loaded ancestors, auto-expanded', () => {
    const f = flattenVisible(byParent, new Set(), 'beta');
    expect(f.map((i) => i.key)).toEqual(['F1', 'F2', 'T2']);
    expect(f.every((i) => !i.isFolder || i.expanded)).toBe(true);
    expect(flattenVisible(byParent, new Set(), 'zzz')).toEqual([]);
  });
});
