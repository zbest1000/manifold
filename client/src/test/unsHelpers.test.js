import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LEVELS,
  namespaceKind,
  nodeLevel,
  sparkplugLevelName,
  levelName,
  namespaceIconName
} from '@/graph/unsLevels';
import { createRateWindow, sumBrokerCounter, formatRate } from '@/graph/rateWindow';
import { computeBranchSizes, orderByImportance, selectLabelIds, LOD_MIN_ZOOM } from '@/graph/labelLod';
import { deriveTopicCount, totalTopicCount } from '@/graph/topicCount';
import { UNS_THEMES, contrastRatio } from '@/graph/unsTheme';
import { buildUnsTree } from '@/graph/unsTree';
import { seedExpansion, layoutForest, fitTransform, nodeKey } from '@/graph/unsLayout';
import { recordActivity, resetLiveState, unsLiveMap, unsValueMap, staleness, rollRates, unsRateMap } from '@/graph/unsLive';
import { resolveTopicsView, TREE_DEFAULT_THRESHOLD } from '@/pages/topics/viewPref';

describe('level labelling', () => {
  it('names ISA-95 levels from the ladder for ordinary topic trees', () => {
    const n = { path: 'factory/line1', depth: 2 };
    expect(namespaceKind(n.path)).toBe('isa95');
    expect(nodeLevel(n, DEFAULT_LEVELS).name).toBe(levelName(2));
    expect(nodeLevel({ path: 'plant', depth: 1 }).name).toBe('Business Unit');
  });

  it('does not call the Sparkplug namespace a Business Unit', () => {
    const ns = nodeLevel({ path: 'spBv1.0', depth: 1 });
    expect(ns.kind).toBe('sparkplug');
    expect(ns.name).toBe('Sparkplug namespace');
    expect(ns.name).not.toMatch(/Business Unit/);
  });

  it('labels group, message type, edge node, device and metric', () => {
    expect(sparkplugLevelName(['spBv1.0', 'G1'])).toBe('Sparkplug group');
    expect(sparkplugLevelName(['spBv1.0', 'G1', 'NDATA'])).toBe('Message type');
    expect(sparkplugLevelName(['spBv1.0', 'G1', 'NDATA', 'E1'])).toBe('Edge node');
    expect(sparkplugLevelName(['spBv1.0', 'G1', 'DDATA', 'E1', 'D1'])).toBe('Device');
    expect(sparkplugLevelName(['spBv1.0', 'G1', 'DDATA', 'E1', 'D1', 'temp'])).toBe('Metric');
  });

  it('handles host STATE topics and $SYS separately from ISA-95', () => {
    expect(sparkplugLevelName(['spBv1.0', 'STATE'])).toBe('Host state');
    expect(sparkplugLevelName(['spBv1.0', 'STATE', 'scada'])).toBe('Host application');
    expect(namespaceKind('$SYS/broker/uptime')).toBe('system');
    expect(nodeLevel({ path: '$SYS', depth: 1 }).name).toBe('System');
  });

  it('gives Sparkplug and system branches distinct colours and icons', () => {
    const isa = nodeLevel({ path: 'a', depth: 1 }, DEFAULT_LEVELS, 'dark').color;
    const sp = nodeLevel({ path: 'spBv1.0', depth: 1 }, DEFAULT_LEVELS, 'dark').color;
    expect(sp).not.toBe(isa);
    expect(namespaceIconName({ path: 'spBv1.0/G/NDATA/E' })).toBe('network');
    expect(namespaceIconName({ path: 'factory/a' })).toBeNull();
  });
});

describe('rate window', () => {
  it('is null until two samples exist', () => {
    const w = createRateWindow(10_000);
    expect(w.rate()).toBeNull();
    w.push(0, 100);
    expect(w.rate()).toBeNull();
  });

  it('computes messages/second from the counter delta over the window', () => {
    const w = createRateWindow(10_000);
    w.push(0, 0);
    w.push(2_000, 40);
    w.push(4_000, 80);
    expect(w.rate()).toBeCloseTo(20, 5);
  });

  it('slides: old samples fall out so a slowdown shows up', () => {
    const w = createRateWindow(4_000);
    for (let t = 0; t <= 10_000; t += 2_000) w.push(t, t / 10); // 100/s
    w.push(12_000, 1000); // then nothing arrives
    w.push(14_000, 1000);
    w.push(16_000, 1000);
    expect(w.rate()).toBeLessThan(10);
  });

  it('survives a counter reset (broker reconnect) without a negative rate', () => {
    const w = createRateWindow(10_000);
    w.push(0, 500);
    w.push(2_000, 600);
    w.push(4_000, 5);
    w.push(6_000, 25);
    expect(w.rate()).toBeCloseTo(10, 5);
  });

  it('sums the server counter for the brokers in scope', () => {
    const brokers = [
      { id: 'a', metrics: { messagesReceived: 10 } },
      { id: 'b', metrics: { messagesReceived: 5 } },
      { id: 'c' }
    ];
    expect(sumBrokerCounter(brokers, null)).toBe(15);
    expect(sumBrokerCounter(brokers, ['b'])).toBe(5);
    expect(sumBrokerCounter([{ id: 'c' }], null)).toBeNull();
  });

  it('formats rates', () => {
    expect(formatRate(0)).toBe('0');
    expect(formatRate(3.46)).toBe('3.5');
    expect(formatRate(1234.4)).toBe('1,234');
  });
});

describe('label level of detail', () => {
  const make = (n) => {
    const nodes = [{ id: 'root', label: 'root', kind: 'broker', x: 0, y: 0, degree: n }];
    const links = [];
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `b${i}`, label: `branch-${i}`, x: (i % 10) * 90, y: Math.floor(i / 10) * 70, degree: 3, meta: {} });
      links.push({ source: 'root', target: `b${i}` });
      for (let j = 0; j < 2; j++) {
        nodes.push({ id: `l${i}-${j}`, label: `leaf-${i}-${j}`, x: (i % 10) * 90 + j * 40, y: Math.floor(i / 10) * 70 + 30, degree: 1, meta: { isLeaf: true } });
        links.push({ source: `b${i}`, target: `l${i}-${j}` });
      }
    }
    return { nodes, links };
  };
  const view = (k) => ({ k, tx: 0, ty: 0, w: 1000, h: 800 });

  it('computes branch sizes from links', () => {
    const { nodes, links } = make(3);
    const sizes = computeBranchSizes(nodes, links);
    expect(sizes.get('b0')).toBe(3);
    expect(sizes.get('root')).toBe(nodes.length);
  });

  it('hides leaf labels until zoomed in', () => {
    const { nodes, links } = make(10);
    const ordered = orderByImportance(nodes, computeBranchSizes(nodes, links));
    const far = selectLabelIds(ordered, view(0.6), { maxLabels: 500 });
    expect([...far].some((id) => id.startsWith('l'))).toBe(false);
    const near = selectLabelIds(ordered, view(2), { maxLabels: 500 });
    expect([...near].some((id) => id.startsWith('l'))).toBe(true);
  });

  it('keeps labels that would overlap out, preferring the more important node', () => {
    const nodes = [
      { id: 'big', label: 'important-branch', x: 100, y: 100, degree: 9, meta: {} },
      { id: 'small', label: 'tiny-branch-1234', x: 102, y: 101, degree: 1, meta: {} }
    ];
    const links = [];
    const sizes = new Map([['big', 50], ['small', 2]]);
    const ordered = orderByImportance(nodes, sizes);
    const out = selectLabelIds(ordered, view(1), { maxLabels: 10 });
    expect(out.has('big')).toBe(true);
    expect(out.has('small')).toBe(false);
    expect(links).toHaveLength(0);
  });

  it('respects the label budget and always labels forced ids', () => {
    const { nodes, links } = make(100);
    const ordered = orderByImportance(nodes, computeBranchSizes(nodes, links));
    const out = selectLabelIds(ordered, view(3), { maxLabels: 5, forced: new Set(['l50-1']) });
    expect(out.has('l50-1')).toBe(true);
    expect(out.size).toBeLessThanOrEqual(6);
  });

  it('draws no unforced labels below the minimum zoom', () => {
    const { nodes, links } = make(5);
    const ordered = orderByImportance(nodes, computeBranchSizes(nodes, links));
    const out = selectLabelIds(ordered, view(LOD_MIN_ZOOM / 2), { forced: new Set(['b1']) });
    expect([...out]).toEqual(['b1']);
  });
});

describe('topic count derivation', () => {
  it('uses the server count when the client index only saw a subset (the "8 vs 325" bug)', () => {
    expect(deriveTopicCount(8, 325)).toBe(325);
  });
  it('uses the client index when it is ahead of the last stats tick', () => {
    expect(deriveTopicCount(330, 325)).toBe(330);
  });
  it('tolerates missing numbers', () => {
    expect(deriveTopicCount(undefined, undefined)).toBe(0);
    expect(deriveTopicCount(4, undefined)).toBe(4);
  });
  it('totals across brokers', () => {
    const brokers = [
      { id: 'a', metrics: { topicCount: 100 } },
      { id: 'b', metrics: { topicCount: 5 } }
    ];
    expect(totalTopicCount(brokers, (id) => (id === 'a' ? 3 : 9))).toBe(109);
  });
});

describe('Topics default view', () => {
  it('defaults to the tree above the threshold and the graph below it', () => {
    expect(resolveTopicsView(null, TREE_DEFAULT_THRESHOLD + 1)).toBe('tree');
    expect(resolveTopicsView(null, TREE_DEFAULT_THRESHOLD)).toBe('graph');
  });
  it('a remembered choice always wins', () => {
    expect(resolveTopicsView('graph', 5000)).toBe('graph');
    expect(resolveTopicsView('tree', 3)).toBe('tree');
  });
  it('ignores junk preferences', () => {
    expect(resolveTopicsView('weird', 10)).toBe('graph');
  });
});

describe('UNS theme contrast', () => {
  for (const mode of ['dark', 'light']) {
    const t = UNS_THEMES[mode];
    it(`${mode}: text colours meet WCAG AA (4.5:1) against the canvas`, () => {
      for (const key of ['name', 'sub', 'count', 'rate', 'value', 'valueOverdue', 'valueDead']) {
        expect(contrastRatio(t[key], t.bg), `${mode}.${key}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('layout, fit and mounts', () => {
  const broker = { id: 'b1', name: 'broker' };
  const mountRoot = () => {
    const root = { id: 'uns:mount:m', path: '', name: 'OPC', depth: 0, brokerId: 'mount:m', children: new Map(), topicCount: 0 };
    for (let i = 0; i < 300; i++) {
      root.children.set(`n${i}`, { id: `uns:mount:m:n${i}`, path: `n${i}`, name: `n${i}`, depth: 1, brokerId: 'mount:m', children: new Map(), topicCount: 1 });
    }
    root.topicCount = 300;
    return root;
  };

  it('seeds brokers open to level 1 and mounts collapsed', () => {
    const b = buildUnsTree(broker, [{ topic: 'a/x' }, { topic: 'b/y' }]);
    const keys = seedExpansion([b, mountRoot()]);
    expect(keys).toContain('b1:');
    expect(keys).toContain('b1:a');
    expect(keys.some((k) => k.startsWith('mount:'))).toBe(false);
  });

  it('lays out only the expanded portion', () => {
    const b = buildUnsTree(broker, [{ topic: 'a/x' }, { topic: 'b/y' }]);
    const collapsed = layoutForest([b], new Set());
    expect(collapsed.nodes).toHaveLength(1);
    const open = layoutForest([b], new Set(seedExpansion([b])));
    expect(open.nodes.length).toBe(5);
  });

  it('fits to broker trees, not to a huge expanded mount', () => {
    const b = buildUnsTree(broker, [{ topic: 'a/x' }, { topic: 'b/y' }]);
    const m = mountRoot();
    const expanded = new Set([...seedExpansion([b]), nodeKey(m)]);
    const layout = layoutForest([b, m], expanded);
    const posOf = (l) => ({ x: l.x, y: l.y });
    const size = { w: 1200, h: 800 };
    const withMounts = fitTransform(layout.nodes, posOf, size, { excludeMounts: false });
    const brokerFit = fitTransform(layout.nodes, posOf, size);
    expect(withMounts.k).toBeLessThanOrEqual(0.21); // clamped to the floor
    expect(brokerFit.k).toBeGreaterThan(0.5);
  });
});

describe('live state', () => {
  beforeEach(() => resetLiveState());

  it('stamps every ancestor and records the leaf value', () => {
    recordActivity({ brokerId: 'b', topic: 'a/b/c', payload: { v: 1 } }, 1000);
    expect(unsLiveMap.get('b:a')).toBe(1000);
    expect(unsLiveMap.get('b:a/b')).toBe(1000);
    expect(unsValueMap.get('b:a/b/c').value).toBe('{"v":1}');
  });

  it('ignores $SYS topics', () => {
    recordActivity({ brokerId: 'b', topic: '$SYS/x', payload: 1 }, 1);
    expect(unsLiveMap.size).toBe(0);
  });

  it('rolls counters into per-second rates', () => {
    recordActivity({ brokerId: 'b', topic: 'a/x', payload: 1 }, 1000);
    recordActivity({ brokerId: 'b', topic: 'a/y', payload: 1 }, 1100);
    rollRates();
    expect(unsRateMap.get('b:a')).toBe(2);
  });

  it('judges staleness against the topic\'s own cadence', () => {
    const node = { brokerId: 'b', path: 'a/x' };
    recordActivity({ brokerId: 'b', topic: 'a/x', payload: 1 }, 0);
    recordActivity({ brokerId: 'b', topic: 'a/x', payload: 1 }, 500);
    expect(staleness(node, 600)).toBe('fresh');
    expect(staleness(node, 20_000)).toBe('overdue');
    expect(staleness(node, 200_000)).toBe('dead');
  });
});
