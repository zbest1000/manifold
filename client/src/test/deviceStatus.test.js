import { describe, it, expect } from 'vitest';
import { deviceBadge, cycleHealth, worstHealth, hostIssues, hostFor, qualityInfo, formatValue, formatMs } from '@/lib/deviceStatus';

const dev = { enabled: true };

describe('deviceBadge', () => {
  it('disabled beats everything', () => {
    expect(deviceBadge({ enabled: false }, { phase: 'online' }).key).toBe('disabled');
  });
  it('maps phases', () => {
    expect(deviceBadge(dev, { phase: 'online' })).toMatchObject({ key: 'online', status: 'connected' });
    expect(deviceBadge(dev, { phase: 'connecting' }).status).toBe('connecting');
    expect(deviceBadge(dev, { phase: 'stopped' }).key).toBe('stopped');
  });
  it('shows the reason in backoff', () => {
    const b = deviceBadge(dev, { phase: 'backoff', reason: 'ECONNREFUSED' });
    expect(b.label).toContain('ECONNREFUSED');
    expect(b.status).toBe('reconnecting');
  });
  it('live socket state overrides REST status', () => {
    expect(deviceBadge(dev, { phase: 'online' }, { phase: 'backoff', reason: 'timeout' }).key).toBe('backoff');
  });
  it('a parked host marks the device', () => {
    expect(deviceBadge(dev, { phase: 'online' }, null, { state: 'parked' }).key).toBe('parked');
  });
});

describe('cycleHealth', () => {
  it('ok when cycles fit', () => {
    expect(cycleHealth({ intervalMs: 1000, effectiveIntervalMs: 1000, lastCycleMs: 200, avgCycleMs: 180, overruns: 0 }).level).toBe('ok');
  });
  it('slowed when the scheduler stretched the interval', () => {
    const h = cycleHealth({ intervalMs: 500, effectiveIntervalMs: 1500, lastCycleMs: 400, avgCycleMs: 380, overruns: 0 });
    expect(h.level).toBe('slowed');
    expect(h.ratio).toBeCloseTo(380 / 1500);
  });
  it('overrun when a cycle exceeds the interval or overruns were counted', () => {
    expect(cycleHealth({ intervalMs: 500, effectiveIntervalMs: 500, lastCycleMs: 700, avgCycleMs: 600, overruns: 0 }).level).toBe('overrun');
    expect(cycleHealth({ intervalMs: 500, effectiveIntervalMs: 500, lastCycleMs: 100, avgCycleMs: 100, overruns: 3 }).level).toBe('overrun');
  });
  it('is safe on missing data', () => {
    expect(cycleHealth(undefined).level).toBe('ok');
  });
  it('worstHealth picks the most severe group', () => {
    expect(worstHealth({ a: { intervalMs: 1000, effectiveIntervalMs: 1000 }, b: { intervalMs: 100, effectiveIntervalMs: 300 } })).toBe('slowed');
    expect(worstHealth({})).toBe('ok');
  });
});

describe('misc', () => {
  it('hostIssues reports parked and backoff hosts only', () => {
    const i = hostIssues({ h1: { protocol: 'modbus-tcp', state: 'parked', restarts: 5 }, h2: { state: 'running' }, h3: { protocol: 's7', state: 'backoff', restarts: 1 } });
    expect(i.map((x) => [x.id, x.level])).toEqual([['h1', 'error'], ['h3', 'warn']]);
  });
  it('qualityInfo', () => {
    expect(qualityInfo(192).key).toBe('good');
    expect(qualityInfo(64).key).toBe('uncertain');
    expect(qualityInfo(0).key).toBe('bad');
    expect(qualityInfo(undefined).key).toBe('bad');
  });
  it('formats', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(12.3456789123)).toBe('12.34568');
    expect(formatMs(250)).toBe('250 ms');
    expect(formatMs(2500)).toBe('2.5 s');
  });
});

describe('hostFor', () => {
  const hosts = { a: { protocol: 'modbus-tcp', state: 'running' }, b: { protocol: 'modbus-tcp', state: 'parked' }, c: { protocol: 's7', state: 'running' } };
  it('uses an explicit hostId', () => {
    expect(hostFor({ hostId: 'a', protocol: 'modbus-tcp' }, hosts).state).toBe('running');
  });
  it('falls back to the worst host of the protocol', () => {
    expect(hostFor({ protocol: 'modbus-tcp' }, hosts).state).toBe('parked');
    expect(hostFor({ protocol: 'enip' }, hosts)).toBeUndefined();
  });
});
