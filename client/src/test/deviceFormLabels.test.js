import { describe, it, expect } from 'vitest';
import { descriptorLabel } from '@/pages/devices/FormControls';

describe('device form descriptor labels (S17)', () => {
  it('adds "optional" once, inside a label\'s own parenthesis', () => {
    expect(descriptorLabel({ name: 'localTsap', label: 'Local TSAP (advanced)', optional: true })).toBe('Local TSAP (advanced, optional)');
    expect(descriptorLabel({ name: 'path', label: 'Path', optional: true })).toBe('Path (optional)');
    expect(descriptorLabel({ name: 'rack', label: 'Rack' })).toBe('Rack');
    expect(descriptorLabel({ name: 'gap', label: 'Max gap (bytes)' })).toBe('Max gap (bytes)');
    expect(descriptorLabel({ name: 'community', optional: true })).toBe('community (optional)');
  });
});
