import { describe, it, expect } from 'vitest';
import { fieldVisible } from '@/pages/devices/FormControls';
import { toPayload, extraColumns, probeSpec, addressExample } from '@/pages/devices/model';
import { cleanTag, parseTags } from '@/lib/deviceTags';
import { buildScanRequest, identityText, draftFromResult, SCAN_KINDS } from '@/lib/discoveryDevices';

const descriptor = {
  id: 'snmp',
  deviceFields: [
    { name: 'version', type: 'select', default: '2c' },
    { name: 'community', type: 'password', optional: true, showWhen: { version: ['1', '2c'] } },
    { name: 'securityLevel', type: 'select', default: 'authPriv', showWhen: { version: ['3'] } },
    { name: 'authPassword', type: 'password', optional: true, showWhen: { version: ['3'], securityLevel: ['authNoPriv', 'authPriv'] } }
  ],
  optionFields: []
};

describe('SNMP device form', () => {
  it('shows a field only while every showWhen condition holds', () => {
    const [, community, , auth] = descriptor.deviceFields;
    expect(fieldVisible(community, { version: '2c' })).toBe(true);
    expect(fieldVisible(community, { version: '3' })).toBe(false);
    expect(fieldVisible(auth, { version: '3', securityLevel: 'authPriv' })).toBe(true);
    expect(fieldVisible(auth, { version: '3', securityLevel: 'noAuthNoPriv' })).toBe(false);
    expect(fieldVisible({ name: 'x' }, {})).toBe(true);
  });

  it('a stored (null) or blank secret is not sent, so the server keeps it', () => {
    const draft = { name: 'S', protocol: 'snmp', host: 'h', port: 161, version: '2c', community: null, options: {}, limits: {}, pollGroups: [], tags: [] };
    expect('community' in toPayload(draft, descriptor)).toBe(false);
    expect('community' in toPayload({ ...draft, community: '' }, descriptor)).toBe(false);
    expect(toPayload({ ...draft, community: 'plant-ro' }, descriptor).community).toBe('plant-ro');
  });

  it('keeps the rate and encoding columns of SNMP tags, also through CSV', () => {
    expect(cleanTag({ key: 'a', address: 'ifInOctets.1', rate: true, encoding: 'hex' })).toEqual({ key: 'a', address: 'ifInOctets.1', rate: true, encoding: 'hex' });
    expect(cleanTag({ key: 'a', address: 'x', rate: false })).toEqual({ key: 'a', address: 'x' });
    const { tags } = parseTags('key,address,rate\nin,ifInOctets.1,yes\nup,sysUpTime.0,\n', ',');
    expect(tags).toEqual([{ key: 'in', address: 'ifInOctets.1', rate: true }, { key: 'up', address: 'sysUpTime.0' }]);
    expect(extraColumns({ id: 'snmp' })).toEqual({ always: ['rate'], advanced: ['encoding', 'description'] });
    expect(probeSpec('snmp').placeholder).toMatch(/sysUpTime\.0/);
    expect(addressExample({ id: 'snmp' })).toBe('sysUpTime.0');
  });
});

describe('SNMP discovery', () => {
  it('is an opt-in device kind on UDP 161', () => {
    const kind = SCAN_KINDS.find((k) => k.id === 'snmp');
    expect(kind).toMatchObject({ field: 'snmpPorts', ports: [161], device: true });
    expect(buildScanRequest({ kinds: { snmp: true } }).snmpPorts).toEqual([161]);
    expect(buildScanRequest({ kinds: {} }).snmpPorts).toBeUndefined();
  });

  it('describes a found agent and drafts a v2c device', () => {
    const r = { kind: 'snmp', protocol: 'snmp', host: '10.0.0.5', port: 161, identity: { sysName: 'sw1', sysDescr: 'Switch OS 1.2\nbuild 7', sysObjectID: '1.3.6.1.4.1.9' }, suggestedDevice: { name: 'sw1 10.0.0.5', protocol: 'snmp', host: '10.0.0.5', port: 161 } };
    expect(identityText(r)).toBe('sw1 · Switch OS 1.2 · object 1.3.6.1.4.1.9 (v2c, community public)');
    expect(draftFromResult(r)).toEqual({ name: 'sw1 10.0.0.5', protocol: 'snmp', host: '10.0.0.5', port: 161, version: '2c' });
  });
});
