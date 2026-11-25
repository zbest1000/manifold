import { describe, it, expect } from 'vitest';
import { engineAttention, isGrowing, recordPending } from '@/lib/attention';

describe('Overview: needs attention', () => {
  it('lists nothing when all is well', () => {
    const items = engineAttention({
      routes: { r1: { routed: 10, delivered: 10, pending: 0, rejected: 0, target: 'historian', historianId: 'h1' } },
      historians: { h1: { delivered: 10, rejected: 0, pending: 0 } },
      alertRules: [{ id: 'a1', name: 'Hot', state: { state: 'idle' } }, { id: 'a2', name: 'Off', state: { state: 'disabled' } }],
      mappings: [{ id: 'm1', name: 'Line 1' }],
      health: { m1: { state: 'publishing', reasons: [] } },
      broken: []
    });
    expect(items).toEqual([]);
  });

  it('routes and historians with rejected points, and pending only when it keeps growing', () => {
    const names = { routes: { r1: 'To influx' }, historians: { h1: 'Influx' } };
    const routes = { r1: { routed: 100, delivered: 60, pending: 30, rejected: 10, target: 'historian', historianId: 'h1' } };
    const historians = { h1: { delivered: 60, rejected: 10, pending: 30 } };
    const flat = engineAttention({ routes, historians, names, routePending: { r1: [30, 30, 30, 30] }, historianPending: { h1: [30, 30, 30, 30] } });
    expect(flat.map((i) => i.key)).toEqual(['r-rej-r1', 'h-rej-h1']);
    expect(flat[0]).toMatchObject({ tone: 'bad', what: 'Route To influx', to: '/pipelines' });
    expect(flat[0].detail).toContain('10 points rejected by historian Influx');
    expect(flat[1]).toMatchObject({ what: 'Historian Influx', to: '/pipelines?tab=historians' });

    const growing = engineAttention({ routes, historians, names, routePending: { r1: [5, 10, 20, 30] }, historianPending: { h1: [5, 10, 20, 30] } });
    expect(growing.map((i) => i.key)).toEqual(['r-rej-r1', 'r-pend-r1', 'h-rej-h1', 'h-pend-h1']);
    expect(growing[1]).toMatchObject({ tone: 'warn' });
    expect(growing[1].detail).toContain('30 points pending and growing');
  });

  it('alert rules firing, breached and broken link to the alert rules', () => {
    const items = engineAttention({
      alertRules: [
        { id: 'a1', name: 'Hot tank', state: { state: 'firing', topic: 'plant/t', value: 99 } },
        { id: 'a2', name: 'Warm', state: { state: 'breached', value: 70, remainingMs: 4200 } },
        { id: 'a3', name: 'Lost broker', state: { state: 'broken', broken: [{ kind: 'broker', id: 'b9', field: 'brokerId' }] } }
      ],
      broken: [{ type: 'alert rule', id: 'a3', name: 'Lost broker', missing: [{ kind: 'broker', id: 'b9' }] }]
    });
    expect(items.map((i) => [i.what, i.tone, i.to])).toEqual([
      ['Alert Hot tank', 'bad', '/settings?tab=alerts'],
      ['Alert Warm', 'warn', '/settings?tab=alerts'],
      ['Alert Lost broker', 'bad', '/settings?tab=alerts']
    ]);
    expect(items[0].detail).toBe('Firing on plant/t · value 99');
    expect(items[1].detail).toContain('fires in 5 s');
    expect(items[2].detail).toBe('Broken reference: broker b9 no longer exists');
  });

  it('mappings that do not publish, with the reason; disabled and waiting ones are not problems', () => {
    const items = engineAttention({
      mappings: [
        { id: 'm1', name: 'Pumps' },
        { id: 'm2', name: 'Gone source' },
        { id: 'm3', name: 'Off', enabled: false },
        { id: 'm4', name: 'New' }
      ],
      health: {
        m1: { state: 'problem', reasons: [{ message: 'The target broker b1 is not connected; nothing can be published until it is.' }] },
        m2: { state: 'source-missing', reasons: [{ message: 'The source broker x was removed.' }] },
        m3: { state: 'disabled', reasons: [] },
        m4: { state: 'waiting', reasons: [{ message: 'Waiting for the first value from the source.' }] }
      },
      broken: [{ type: 'mapping', id: 'm2', name: 'Gone source', missing: [{ kind: 'broker', id: 'x' }] }]
    });
    expect(items.map((i) => i.key)).toEqual(['m-m1', 'm-m2']);
    expect(items[0]).toMatchObject({ what: 'Mapping Pumps', to: '/tags?view=mappings', detail: 'Not publishing: The target broker b1 is not connected; nothing can be published until it is.' });
  });

  it('broken references link to where each kind is edited', () => {
    const items = engineAttention({
      broken: [
        { type: 'route', id: 'r1', name: 'Old route', missing: [{ kind: 'historian', id: 'h0' }] },
        { type: 'recording', id: 'c1', name: 'Rec', missing: [{ kind: 'broker', id: 'b0' }] },
        { type: 'model', id: 'x1', name: 'Model', missing: [{ kind: 'broker', id: 'b0' }] },
        { type: 'contract', id: 'k1', name: 'Shape', missing: [{ kind: 'broker', id: 'b0' }] }
      ]
    });
    expect(items.map((i) => [i.what, i.to])).toEqual([
      ['Route Old route', '/pipelines'],
      ['Recording Rec', '/pipelines?tab=recorder'],
      ['Model Model', '/pipelines?tab=models'],
      ['Contract Shape', '/pipelines?tab=contracts']
    ]);
    expect(items[0].detail).toBe('Broken reference: historian h0 no longer exists');
  });

  it('pending history: bounded samples, growing only on a sustained rise', () => {
    let h = {};
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) h = recordPending(h, { r: v });
    expect(h.r).toEqual([3, 4, 5, 6, 7, 8]);
    expect(isGrowing([1, 2, 3, 4])).toBe(true);
    expect(isGrowing([1, 2, 2, 4])).toBe(false);
    expect(isGrowing([1, 2, 3])).toBe(false);
  });
});
