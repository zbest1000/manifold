import { describe, it, expect } from 'vitest';
import { splitUrlHost, infoLabel } from '@/pages/devices/model';

// The URL-device fields every URL driver shares (see server/drivers/common/urlTarget.js).
const http = { id: 'http-json', defaultPort: 80, deviceFields: [{ name: 'scheme', type: 'select', options: ['http', 'https'] }, { name: 'path', type: 'string', optional: true }] };
const matter = { id: 'matter-server', defaultPort: 5580, deviceFields: [{ name: 'scheme', type: 'select', options: ['ws', 'wss'] }, { name: 'path', type: 'string', default: '/ws' }] };
const modbus = { id: 'modbus-tcp', defaultPort: 502, deviceFields: [{ name: 'unitId', type: 'number' }] };

describe('a URL pasted into Host', () => {
  it('splits into scheme, host, port and path for HTTP drivers', () => {
    expect(splitUrlHost('https://meter.local:8443/api/v1/', http)).toEqual({ scheme: 'https', host: 'meter.local', port: 8443, path: '/api/v1' });
    expect(splitUrlHost('http://10.0.0.5', http)).toEqual({ scheme: 'http', host: '10.0.0.5', port: 80, path: '' });
    expect(splitUrlHost('  https://[fd00::5]/x?y=1#z ', http)).toEqual({ scheme: 'https', host: 'fd00::5', port: 443, path: '/x' });
  });

  it('splits WebSocket URLs, with the driver default path when the URL has none', () => {
    expect(splitUrlHost('ws://ha.local:5580/ws', matter)).toEqual({ scheme: 'ws', host: 'ha.local', port: 5580, path: '/ws' });
    expect(splitUrlHost('wss://proxy.example:8443', matter)).toEqual({ scheme: 'wss', host: 'proxy.example', port: 8443, path: '/ws' });
  });

  it('leaves everything else alone', () => {
    expect(splitUrlHost('meter.local', http)).toBe(null);
    expect(splitUrlHost('ws://ha.local:5580/ws', http)).toBe(null); // not one of this driver's schemes
    expect(splitUrlHost('https://user:pw@meter.local/', http)).toBe(null); // credentials are not split into the host
    expect(splitUrlHost('http://10.0.0.5:502', modbus)).toBe(null); // not a URL-based driver
    expect(splitUrlHost('http://', http)).toBe(null);
  });
});

describe('connection test labels', () => {
  it('are readable instead of raw field names', () => {
    expect(infoLabel('schemaVersion')).toBe('API schema');
    expect(infoLabel('nodeCount')).toBe('Nodes');
    expect(infoLabel('serverVersion')).toBe('Server version');
    expect(infoLabel('driverVersion')).toBe('Driver version');
    expect(infoLabel('vendorId')).toBe('Vendor ID');
    expect(infoLabel('url')).toBe('URL');
    expect(infoLabel('server')).toBe('Server');
  });
});
