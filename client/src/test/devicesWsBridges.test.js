import { describe, it, expect } from 'vitest';
import { browseNoun, addressExample, probeSpec, probeBody, nodesToTags } from '@/pages/devices/model';

const matter = { id: 'matter-server', tagTypes: ['number', 'bool', 'string', 'json'], tagTypeOptional: true, browseNoun: 'server', deviceFields: [], optionFields: [] };
const zwave = { id: 'zwave-js', tagTypes: ['number', 'bool', 'string', 'json'], tagTypeOptional: true, browseNoun: 'server', deviceFields: [], optionFields: [] };

describe('WebSocket bridge drivers (matter-server, zwave-js)', () => {
  it('call the browse source a server and use their own address examples', () => {
    expect(browseNoun(matter)).toBe('server');
    expect(addressExample(matter)).toBe('5/1/TemperatureMeasurement/MeasuredValue');
    expect(addressExample(zwave)).toBe('5/49/0/Air temperature');
  });

  it('probe takes an address only', () => {
    expect(probeSpec('matter-server').count).toBe(null);
    expect(probeSpec('zwave-js').placeholder).toBe('5/49/0/Air temperature');
    expect(probeBody('zwave-js', { address: ' 2/37/0/currentValue ', count: 3 })).toEqual({ address: '2/37/0/currentValue' });
  });

  it('browse import keeps the value id, maps lower-case types and carries the unit', () => {
    let n = 0;
    const rows = nodesToTags(
      [
        { id: 'v:2/49/0/Air temperature', name: 'Air temperature', kind: 'tag', address: '2/49/0/Air temperature', meta: { dataType: 'number', unit: '°C', description: 'min -40' } },
        { id: 'at:1/1/6/0', name: 'OnOff (0x0000)', kind: 'tag', address: '1/1/6/0', meta: { dataType: 'bool' } }
      ],
      { descriptor: zwave, existing: [], pollGroup: 'default', makeId: () => `id${n++}` }
    );
    expect(rows[0]).toMatchObject({ key: '2_49_0_Air_temperature', address: '2/49/0/Air temperature', type: 'number', unit: '°C', description: 'min -40' });
    expect(rows[1]).toMatchObject({ key: '1_1_6_0', address: '1/1/6/0', type: 'bool' });
  });
});
