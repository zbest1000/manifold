import { describe, it, expect } from 'vitest';
import { latestOnly } from '@/lib/usePolled';

describe('usePolled sequence gate', () => {
  it('lets only the newest of overlapping loads apply', () => {
    const gate = latestOnly();
    const first = gate.next();
    const second = gate.next();
    expect(first()).toBe(false); // a slow first response must not overwrite the newer one
    expect(second()).toBe(true);
  });
  it('drops in-flight loads after invalidate (deps change or unmount)', () => {
    const gate = latestOnly();
    const pending = gate.next();
    gate.invalidate();
    expect(pending()).toBe(false);
    expect(gate.next()()).toBe(true);
  });
});
