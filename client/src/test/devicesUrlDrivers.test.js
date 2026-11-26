import { describe, it, expect } from 'vitest';
import { browseNoun, addressExample, probeSpec, probeBody, nodesToTags, blankDevice, toPayload } from '@/pages/devices/model';

const http = {
  id: 'http-json',
  tagTypes: ['number', 'bool', 'string'],
  addressForms: ['/api/status#$.power.total'],
  browseNoun: 'device',
  limits: { requestDeadlineMs: 5000, connectTimeoutMs: 5000, interRequestDelayMs: 0 },
  deviceFields: [{ name: 'scheme', default: 'http' }],
  optionFields: []
};
const mtc = { id: 'mtconnect', tagTypes: ['number', 'bool', 'string'], addressForms: ['Xact'], browseNoun: 'agent', deviceFields: [], optionFields: [] };
const modbus = { id: 'modbus-tcp', tagTypes: ['int16'], deviceFields: [], optionFields: [] };

describe('URL-based drivers (http-json, mtconnect)', () => {
  it("names the driver's own tag list, defaulting to controller", () => {
    expect(browseNoun(http)).toBe('device');
    expect(browseNoun(mtc)).toBe('agent');
    expect(browseNoun(modbus)).toBe('controller');
  });

  it("uses the driver's own address example and a probe that takes only an address", () => {
    expect(addressExample(http)).toBe('/api/status#$.power.total');
    expect(addressExample(mtc)).toBe('Xact');
    expect(probeSpec('http-json').count).toBe(null);
    expect(probeBody('http-json', { address: ' /a#$.b ', count: 5, unitId: 1 })).toEqual({ address: '/a#$.b' });
  });

  it('browse import matches type names without regard to case and carries unit and description', () => {
    let n = 0;
    const rows = nodesToTags(
      [
        { id: 'item:Xload', name: 'Xload (LOAD)', kind: 'tag', address: 'Xload', meta: { dataType: 'number', unit: '%', description: 'sample LOAD, PERCENT' } },
        { id: 'item:exec', name: 'exec', kind: 'tag', address: 'exec', meta: { dataType: 'string' } },
        { id: 'item:z', name: 'z', kind: 'tag', address: 'z', meta: { dataType: '' } }
      ],
      { descriptor: mtc, existing: [], pollGroup: 'default', makeId: () => `id${n++}` }
    );
    expect(rows[0]).toMatchObject({ key: 'Xload', address: 'Xload', type: 'number', unit: '%', description: 'sample LOAD, PERCENT' });
    expect(rows[1].type).toBe('string');
    expect(rows[1].unit).toBeUndefined();
    expect(rows[2].type).toBe('');
  });

  it("a new device starts from the driver's own limits", () => {
    expect(blankDevice(http).limits).toEqual({ requestDeadlineMs: 5000, connectTimeoutMs: 5000, interRequestDelayMs: 0 });
    expect(blankDevice(modbus).limits.requestDeadlineMs).toBe(2000);
  });

  it('the payload keeps a masked secret as sent and drops a blank one, so the server keeps the stored value', () => {
    const desc = { ...http, deviceFields: [{ name: 'authToken', type: 'password', optional: true }, { name: 'authPassword', type: 'password', optional: true }] };
    const out = toPayload({ ...blankDevice(desc), name: 'm', host: 'h', port: 80, authToken: '********', authPassword: '' }, desc);
    expect(out.authToken).toBe('********');
    expect('authPassword' in out).toBe(false);
  });
});
