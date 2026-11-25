import { describe, it, expect, vi } from 'vitest';

const handlers = {};
vi.mock('@/lib/socket', () => ({
  socket: { on: (name, fn) => ((handlers[name] ||= []).push(fn), undefined), off: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  reconnectSocket: vi.fn()
}));
const toast = vi.fn();
toast.success = vi.fn();
toast.error = vi.fn();
vi.mock('react-hot-toast', () => ({ default: toast, Toaster: () => null }));
const { useStore, initRealtime } = await import('@/store/store');
const fire = (name, payload) => (handlers[name] || []).forEach((fn) => fn(payload));

describe('app-wide warnings for events that used to be silent', () => {
  initRealtime();

  it('a QoS downgrade is logged as a warning and toasted', () => {
    fire('subscription-downgraded', { brokerId: 'b1', topic: '#', from: 1, to: 0, reason: 'broker refused the grant' });
    const entry = useStore.getState().logs.find((l) => l.source === 'mqtt' && /downgraded/.test(l.message));
    expect(entry.level).toBe('warning');
    expect(entry.message).toMatch(/QoS 1 to 0/);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('contract violations are all logged, toasted at most once a minute per contract', () => {
    toast.mockClear();
    const evt = { contractId: 'c1', contractName: 'Line temps', brokerId: 'b1', topic: 'plant/t', problems: [{ path: 'temp', kind: 'type-changed' }] };
    fire('contract-violation', evt);
    fire('contract-violation', evt);
    const entries = useStore.getState().logs.filter((l) => l.source === 'contract');
    expect(entries[0].message).toBe('Contract "Line temps" violated on plant/t (temp: type changed)');
    expect(entries[0].count || 1).toBeGreaterThanOrEqual(1);
    expect(toast).toHaveBeenCalledTimes(1);
    fire('contract-violation', { ...evt, contractId: 'c2', contractName: 'Other' });
    expect(toast).toHaveBeenCalledTimes(2);
  });
});
