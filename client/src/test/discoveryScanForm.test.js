import { describe, it, expect, vi } from 'vitest';
import { buildScanRequest, rangeProblem, formatDuration, identityText, groupOf, endpointSortKey, portsFor, SCAN_KINDS } from '@/lib/discoveryDevices';

const handlers = {};
vi.mock('@/lib/socket', () => ({
  socket: { on: (name, fn) => ((handlers[name] ||= []).push(fn), undefined), off: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  reconnectSocket: vi.fn()
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
const { useStore, initRealtime } = await import('@/store/store');
const fire = (name, payload) => (handlers[name] || []).forEach((fn) => fn(payload));

const kinds = (extra = {}) => ({ mqtt: true, opcua: true, i3x: true, ...extra });

describe('scan request from the form', () => {
  it('sends explicit port lists: defaults for ticked kinds, an empty list for unticked brokers and servers', () => {
    expect(buildScanRequest({ range: ' 10.0.0.0/24 ', kinds: kinds() })).toEqual({
      range: '10.0.0.0/24',
      mqttPorts: [1883, 8883],
      opcuaPorts: [4840, 50000],
      i3xPorts: [80, 443, 8080]
    });
    expect(buildScanRequest({ kinds: kinds({ mqtt: false, i3x: false }) })).toEqual({ mqttPorts: [], opcuaPorts: [4840, 50000], i3xPorts: [] });
  });
  it('adds device protocols only when ticked, with custom ports', () => {
    const body = buildScanRequest({ kinds: kinds({ modbus: true, s7: true }), ports: { modbus: '5020, 1502', s7: '' } });
    expect(body.modbusPorts).toEqual([5020, 1502]);
    expect(body.s7Ports).toEqual([102]);
    expect(body.eipPorts).toBeUndefined();
  });
  it('carries WebSocket ports only for a ticked MQTT, and the pacing fields only when filled', () => {
    expect(buildScanRequest({ kinds: kinds(), mqttWs: '9001' }).mqttWsPorts).toEqual([9001]);
    expect(buildScanRequest({ kinds: kinds({ mqtt: false }), mqttWs: '9001' }).mqttWsPorts).toBeUndefined();
    const body = buildScanRequest({ kinds: kinds(), advanced: { concurrency: '8', perHost: '', timeoutMs: ' 2000 ' } });
    expect(body.concurrency).toBe(8);
    expect(body.timeoutMs).toBe(2000);
    expect('perHost' in body).toBe(false);
  });
  it('knows the default ports of every kind', () => {
    expect(Object.fromEntries(SCAN_KINDS.map((k) => [k.id, k.ports]))).toEqual({
      mqtt: [1883, 8883],
      opcua: [4840, 50000],
      i3x: [80, 443, 8080],
      modbus: [502],
      s7: [102],
      'ethernet-ip': [44818],
      bacnet: [47808]
    });
    expect(portsFor(SCAN_KINDS[3], 'x')).toEqual([502]);
  });
});

describe('range validation', () => {
  it('accepts blank (the server scans its own subnet), IPv4, CIDR and hostnames', () => {
    for (const ok of ['', '  ', '192.168.1.0/24', '10.0.0.5', '10.0.0.5/32', 'plc-1.plant.local']) expect(rangeProblem(ok)).toBe('');
  });
  it('explains what is wrong', () => {
    expect(rangeProblem('fe80::1')).toMatch(/IPv6/);
    expect(rangeProblem('999.1.1.0/24')).toMatch(/Not an IPv4/);
    expect(rangeProblem('10.0.0.0/33')).toMatch(/0 to 32/);
    expect(rangeProblem('10.0.0.0/x')).toMatch(/0 to 32/);
    expect(rangeProblem('host/24')).toMatch(/CIDR/);
    expect(rangeProblem('bad host!')).toMatch(/hostname/);
  });
});

describe('text helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(400)).toBe('1 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(6 * 60_000)).toBe('6 min');
    expect(formatDuration(3 * 3600_000)).toBe('3.0 h');
    expect(formatDuration(30 * 3600_000)).toBe('30 h');
  });
  it('describes identities the server now returns', () => {
    expect(identityText({ protocol: 'modbus-tcp', identity: { response: 'device-id', unitId: 1, vendorName: 'Acme', productName: 'Pump ctl', revision: 'V1.4' } })).toBe('Pump ctl · Acme · rev V1.4 (unit 1, device identification)');
    expect(identityText({ protocol: 's7', identity: { accepted: true, rack: 0, slot: 1, moduleTypeName: 'CPU 1516-3 PN/DP', orderCode: '6ES7 516-3AN02-0AB0', firmware: 'V2.9.4', cpuState: 'RUN' } })).toBe(
      'Siemens CPU 1516-3 PN/DP · 6ES7 516-3AN02-0AB0 · V2.9.4 · RUN · rack 0 slot 1'
    );
    expect(identityText({ protocol: 'ethernet-ip', identity: { productName: '1769-L33ER', vendor: 'Rockwell Automation / Allen-Bradley', deviceTypeName: 'Programmable Logic Controller', productCode: 166, revision: '32.11', serialNumber: '006c5f2a', stateName: 'operational' } })).toBe(
      '1769-L33ER · Rockwell Automation / Allen-Bradley · Programmable Logic Controller · product code 166 · rev 32.11 · serial 006c5f2a · operational'
    );
    expect(identityText({ kind: 'mqtt', verified: true, identity: { anonymousAccess: false } })).toBe('Authentication required');
    expect(identityText({ kind: 'mqtt', verified: false })).toMatch(/did not answer an MQTT CONNECT/);
    expect(identityText({ kind: 'opcua', verified: true, applicationName: 'Line 1', applicationUri: 'urn:x', identity: { securityModes: ['None', 'Sign'] } })).toBe('Line 1 · urn:x · security None, Sign');
    expect(identityText({ kind: 'opcua', verified: false, method: 'ua-hello', note: 'Answered the OPC UA Hello, but GetEndpoints failed: x.' })).toMatch(/GetEndpoints failed/);
    expect(identityText({ kind: 'opcua', verified: false, method: 'ua-hello', identity: { accepted: true } })).toMatch(/not GetEndpoints/);
  });
  it('groups results and sorts addresses numerically', () => {
    expect(groupOf({ kind: 'mqtt' })).toBe('mqtt');
    expect(groupOf({ kind: 's7', suggestedDevice: { protocol: 's7', host: 'h' } })).toBe('device');
    const keys = ['10.0.0.9:80', '10.0.0.10:80', '10.0.0.9:8080'].map((e) => endpointSortKey({ host: e.split(':')[0], port: Number(e.split(':')[1]) }));
    expect([...keys].sort()).toEqual([keys[0], keys[2], keys[1]]);
  });
});

describe('discovery socket handling in the store', () => {
  initRealtime();
  const state = () => useStore.getState().discovery;

  it('follows a scan: started, monotonic progress, results, complete', () => {
    fire('discovery-started', { scanId: 'a', range: '10.0.0.0/30', totalProbes: 12, startedAt: 't0', estimate: { worstCaseMs: 5000 } });
    expect(state()).toMatchObject({ scanning: true, results: [], progress: { total: 12, completed: 0 }, scan: { status: 'running', range: '10.0.0.0/30' } });

    fire('discovery-progress', { scanId: 'a', completed: 5, total: 12, found: 0, etaMs: 3000 });
    fire('discovery-progress', { scanId: 'a', completed: 3, total: 12, found: 0, etaMs: 4000 }); // late, older
    expect(state().progress.completed).toBe(5);
    fire('discovery-progress', { scanId: 'zzz', completed: 11, total: 12, found: 0 }); // another scan
    expect(state().progress.completed).toBe(5);

    fire('discovery-result', { host: '10.0.0.1', port: 502, kind: 'modbus', known: null });
    fire('discovery-result', { host: '10.0.0.1', port: 502, kind: 'modbus', known: { kind: 'device', id: 'd', name: 'n' } }); // same endpoint again replaces
    expect(state().results).toHaveLength(1);

    fire('discovery-complete', { scanId: 'a', range: '10.0.0.0/30', status: 'complete', found: 1, completed: 12, total: 12, elapsedMs: 900, results: [{ host: '10.0.0.1', port: 502, kind: 'modbus', known: null }] });
    expect(state().scanning).toBe(false);
    expect(state().scan).toMatchObject({ status: 'complete', completed: 12, totalProbes: 12, found: 1 });
    expect(state().results[0].known).toBeNull(); // the server's final list wins
  });

  it('records a cancelled scan and a failed one', () => {
    fire('discovery-started', { scanId: 'b', range: '10.0.0.0/30', totalProbes: 12 });
    fire('discovery-complete', { scanId: 'b', range: '10.0.0.0/30', status: 'cancelled', aborted: true, found: 0, completed: 4, total: 12, results: [] });
    expect(state().scan.status).toBe('cancelled');
    fire('discovery-started', { scanId: 'c', range: '10.0.0.0/30', totalProbes: 12 });
    fire('discovery-error', { error: 'boom' });
    expect(state()).toMatchObject({ scanning: false, scan: { status: 'error', error: 'boom' } });
  });
});
