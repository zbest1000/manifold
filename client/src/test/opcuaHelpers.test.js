import { describe, it, expect } from 'vitest';
import { statusDetail, activeValues, nodeValueMap } from '@/pages/opcua/helpers';

describe('OPC UA page helpers (live values)', () => {
  it('statusDetail names the status code only when it says more than the quality word', () => {
    expect(statusDetail('BadSensorFailure (0x808D0000)')).toBe('BadSensorFailure');
    expect(statusDetail('UncertainLastUsableValue (0x40900000)')).toBe('UncertainLastUsableValue');
    expect(statusDetail('Good (0x00000000)')).toBeNull();
    expect(statusDetail('Bad')).toBeNull();
    expect(statusDetail(undefined)).toBeNull();
  });

  it('activeValues keeps only nodes the server still monitors', () => {
    const values = { a: { value: 1 }, b: { value: 2 } };
    expect(activeValues({ monitoredNodes: ['b', 'c'] }, values)).toEqual({ b: { value: 2 } });
    expect(activeValues({}, values)).toBe(values); // an older server without the list: show everything
    expect(activeValues(null, undefined)).toEqual({});
  });

  it('nodeValueMap marks values that are not Good', () => {
    expect(nodeValueMap('c', { n: { value: 3, status: 'BadSensorFailure (0x808D0000)' } })).toEqual({ 'opcua:c:n': { text: '3 · Bad' } });
    expect(nodeValueMap('c', { n: { value: 3, status: 'Good (0x00000000)' } })).toEqual({ 'opcua:c:n': { text: '3' } });
  });
});
