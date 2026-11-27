import { describe, expect, it } from 'vitest';
import { matchSummary, searchNodes, stepActive } from '@/lib/nodeSearch';
import { collapseAllKeys, expandAllKeys, layoutForest } from '@/graph/unsLayout';
import { buildUnsTree } from '@/graph/unsTree';

const items = [
  { id: '1', label: 'temp', path: 'plant/line1/temp' },
  { id: '2', label: 'temperature', path: 'plant/line2/temperature' },
  { id: '3', label: 'line1', path: 'plant/line1' },
  { id: '4', label: 'attempt', path: 'other/attempt' },
  { id: '5', label: 'speed', path: 'plant/temp-zone/speed' }
];

describe('node search', () => {
  it('ranks an exact name, then a name prefix, then a name substring, then a path match', () => {
    const { results, total } = searchNodes(items, 'TEMP');
    expect(results.map((r) => r.id)).toEqual(['1', '2', '4', '5']);
    expect(total).toBe(4);
  });
  it('treats + and # as an MQTT filter on the path', () => {
    expect(searchNodes(items, 'plant/+/temp').results.map((r) => r.id)).toEqual(['1']);
    expect(searchNodes(items, 'plant/line1/#').results.map((r) => r.id).sort()).toEqual(['1', '3']);
  });
  it('limits the list but counts every match', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: String(i), label: `unit${i}`, path: `big/fleet/unit${i}` }));
    const r = searchNodes(many, 'unit', { limit: 50 });
    expect(r.results).toHaveLength(50);
    expect(r.total).toBe(120);
    expect(matchSummary(50, 120)).toBe('50 of 120 matches shown');
    expect(matchSummary(1, 1)).toBe('1 match');
    expect(matchSummary(0, 0)).toBe('No matches');
    expect(searchNodes(many, '   ').total).toBe(0);
  });
  it('arrow keys wrap through the options', () => {
    expect(stepActive(-1, 3, 'ArrowDown')).toBe(0);
    expect(stepActive(2, 3, 'ArrowDown')).toBe(0);
    expect(stepActive(0, 3, 'ArrowUp')).toBe(2);
    expect(stepActive(-1, 3, 'ArrowUp')).toBe(2);
    expect(stepActive(1, 0, 'ArrowDown')).toBe(-1);
  });
});

/** The big-namespace e2e fixture's shape: 3 areas x 5 lines x 5 cells x 4 metrics, plus a 2,000-unit fleet. */
function bigTree() {
  const topics = [];
  for (let a = 1; a <= 3; a++) for (let l = 1; l <= 5; l++) for (let c = 1; c <= 5; c++) for (const m of ['temperature', 'pressure', 'speed', 'power']) topics.push({ topic: `acme/area${a}/line${l}/cell${c}/${m}` });
  for (let i = 1; i <= 2000; i++) topics.push({ topic: `big/fleet/unit${String(i).padStart(4, '0')}` });
  return buildUnsTree({ id: 'b', name: 'Big' }, topics);
}

describe('expand all / collapse all', () => {
  it('opens every branch of the big namespace, one page of the long branch, within the cap', () => {
    const root = bigTree();
    const r = expandAllKeys([root]);
    expect(r.complete).toBe(true);
    expect(r.keys).toContain('b:');
    expect(r.keys).toContain('b:acme/area3/line5/cell5');
    expect(r.keys).toContain('b:big/fleet');
    const layout = layoutForest([root], new Set(r.keys));
    expect(layout.nodes.length).toBe(r.laid);
    expect(layout.nodes.length).toBeLessThan(600); // 2,000 units page to 50
    expect(layout.nodes.filter((l) => l.pager)).toHaveLength(1);
  });
  it('stops at the cap breadth first and says it is incomplete', () => {
    const root = bigTree();
    const r = expandAllKeys([root], null, 120);
    expect(r.complete).toBe(false);
    expect(r.laid).toBeLessThanOrEqual(120);
    expect(r.keys.slice(0, 3)).toEqual(['b:', 'b:acme', 'b:big']); // shallow levels first
    expect(layoutForest([root], new Set(r.keys)).nodes.length).toBe(r.laid);
  });
  it('honours the page and filter of a long branch', () => {
    const root = bigTree();
    const fleet = root.children.get('big').children.get('fleet');
    const r = expandAllKeys([root], new Map([[fleet.id, { page: 3, filter: '' }]]));
    const layout = layoutForest([root], new Set(r.keys), new Map([[fleet.id, { page: 3, filter: '' }]]));
    expect(layout.nodes.some((l) => l.node.name === 'unit0151')).toBe(true);
    expect(layout.nodes.some((l) => l.node.name === 'unit0001')).toBe(false);
  });
  it('collapse leaves each namespace open one level', () => {
    expect(collapseAllKeys([bigTree()])).toEqual(['b:']);
  });
});
