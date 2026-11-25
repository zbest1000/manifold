import { describe, expect, it } from 'vitest';
import { BROKER_VIEW_KEY, dismissNote, loadSavedView, noteDismissed, saveView, VIEW_KEY } from '@/pages/topics/viewPref';

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

describe('Topics view choice per broker', () => {
  it('remembers an explicit choice for that broker only', () => {
    const s = store();
    saveView('graph', 'big', s);
    expect(loadSavedView('big', s)).toBe('graph');
    expect(loadSavedView('other', s)).toBe(null); // other brokers keep the size default
    expect(JSON.parse(s.m.get(BROKER_VIEW_KEY))).toEqual({ big: 'graph' });
  });
  it('falls back to the legacy global choice for a broker without its own', () => {
    const s = store({ [VIEW_KEY]: 'tree' });
    expect(loadSavedView('a', s)).toBe('tree');
    saveView('3d', 'a', s);
    expect(loadSavedView('a', s)).toBe('3d');
    expect(loadSavedView('b', s)).toBe('tree');
  });
  it('ignores unknown views and broken storage', () => {
    const s = store({ [BROKER_VIEW_KEY]: '{bad' });
    expect(loadSavedView('a', s)).toBe(null);
    saveView('weird', 'a', s);
    expect(loadSavedView('a', s)).toBe(null);
    const blocked = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
    expect(loadSavedView('a', blocked)).toBe(null);
    expect(() => saveView('graph', 'a', blocked)).not.toThrow();
  });
  it('the tree note is dismissed per broker', () => {
    const s = store();
    expect(noteDismissed('a', s)).toBe(false);
    dismissNote('a', s);
    expect(noteDismissed('a', s)).toBe(true);
    expect(noteDismissed('b', s)).toBe(false);
  });
});
