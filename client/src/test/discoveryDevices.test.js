import { describe, it, expect } from 'vitest';
import { buildScanOptions, parsePorts, isDeviceResult, identityText, draftFromResult, draftsFromResults, SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

const modbus = { host: '10.0.0.5', port: 502, kind: 'modbus', verified: true, protocol: 'modbus-tcp', identity: { unitId: 1, response: 'registers' }, suggestedDevice: { name: 'modbus-tcp 10.0.0.5', protocol: 'modbus-tcp', host: '10.0.0.5', port: 502 } };
const s7 = { host: '10.0.0.6', port: 102, kind: 's7', verified: true, protocol: 's7', identity: { cotp: 'CC', accepted: true, rack: 0, slot: 1 }, suggestedDevice: { name: 's7 10.0.0.6', protocol: 's7', host: '10.0.0.6', port: 102 } };
const eip = { host: '10.0.0.7', port: 44818, kind: 'ethernet-ip', verified: true, protocol: 'ethernet-ip', identity: { productName: '1756-L83E', vendorId: 1, revision: '33.11', serialNumber: '00c0ffee' }, suggestedDevice: { name: '1756-L83E 10.0.0.7', protocol: 'ethernet-ip', host: '10.0.0.7', port: 44818 } };
const mqtt = { host: '10.0.0.9', port: 1883, kind: 'mqtt', verified: true };

describe('scan options', () => {
  it('sends nothing for devices unless a protocol is ticked (the server opts in)', () => {
    expect(buildScanOptions({ range: ' 10.0.0.0/24 ', selected: {} })).toEqual({ range: '10.0.0.0/24' });
    expect(buildScanOptions({ selected: {} })).toEqual({});
  });
  it('maps each protocol to its server field with default or custom ports', () => {
    expect(buildScanOptions({ selected: { 'modbus-tcp': '502', s7: '102, 1102', 'ethernet-ip': '' } })).toEqual({ modbusPorts: [502], s7Ports: [102, 1102], eipPorts: [44818] });
  });
  it('knows the default ports', () => {
    expect(Object.fromEntries(SCAN_PROTOCOLS.map((p) => [p.id, p.port]))).toEqual({ 'modbus-tcp': 502, s7: 102, 'ethernet-ip': 44818, 'bacnet-ip': 47808 });
  });
  it('BACnet/IP is scanned only when ticked, on its UDP port', () => {
    expect(buildScanOptions({ selected: { 'bacnet-ip': '' } })).toEqual({ bacnetPorts: [47808] });
  });
  it('parses port lists and reports junk', () => {
    expect(parsePorts('502, 1502;502 x 70000')).toEqual({ ports: [502, 1502], bad: ['x', '70000'] });
  });
});

describe('results to device drafts', () => {
  it('recognises device results', () => {
    expect([modbus, s7, eip].every(isDeviceResult)).toBe(true);
    expect(isDeviceResult(mqtt)).toBe(false);
  });
  it('prefills from suggestedDevice and the identity', () => {
    expect(draftFromResult(modbus)).toEqual({ name: 'modbus-tcp 10.0.0.5', protocol: 'modbus-tcp', host: '10.0.0.5', port: 502, unitId: 1 });
    expect(draftFromResult(s7)).toMatchObject({ protocol: 's7', port: 102, rack: 0, slot: 1 });
    expect(draftFromResult(eip)).toEqual({ name: '1756-L83E 10.0.0.7', protocol: 'ethernet-ip', host: '10.0.0.7', port: 44818 });
  });
  it('BACnet/IP: the device instance is carried into the draft and the identity text', () => {
    const bac = { host: '10.0.0.9', port: 47808, kind: 'bacnet', verified: true, protocol: 'bacnet-ip', identity: { deviceInstance: 260001, vendorId: 5, vendorName: 'Acme Controls', modelName: 'AHU-9', objectName: 'AHU 9', firmwareRevision: '2.1' }, suggestedDevice: { name: 'AHU-9 10.0.0.9', protocol: 'bacnet-ip', host: '10.0.0.9', port: 47808, deviceInstance: 260001 } };
    expect(isDeviceResult(bac)).toBe(true);
    expect(draftFromResult(bac)).toEqual({ name: 'AHU-9 10.0.0.9', protocol: 'bacnet-ip', host: '10.0.0.9', port: 47808, deviceInstance: 260001 });
    expect(identityText(bac)).toBe('AHU-9 · Acme Controls · device 260001 · "AHU 9" · firmware 2.1');
    expect(identityText({ protocol: 'bacnet-ip', identity: { answered: 'reject' } })).toMatch(/identity not read/);
  });
  it('lists only devices, once per address, in address order', () => {
    const drafts = draftsFromResults([eip, mqtt, s7, modbus, { ...modbus }]);
    expect(drafts.map((d) => d.host)).toEqual(['10.0.0.5', '10.0.0.6', '10.0.0.7']);
  });
  it('describes the identity in plain words', () => {
    expect(identityText(modbus)).toContain('Modbus server, unit 1');
    expect(identityText({ ...modbus, identity: { unitId: 2, response: 'exception', exceptionCode: 2 } })).toContain('illegal data address');
    expect(identityText(s7)).toContain('rack 0 slot 1');
    expect(identityText({ ...s7, identity: { accepted: false } })).toContain('refused');
    expect(identityText(eip)).toBe('1756-L83E · vendor 1 · rev 33.11 · serial 00c0ffee');
  });
});
