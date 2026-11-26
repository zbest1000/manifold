import { describe, expect, it } from 'vitest';
import { filenameFrom, trendsExportUrl } from '@/lib/trendsExport';

describe('trends CSV export', () => {
  it('builds the URL with tags and units in chart order', () => {
    const url = trendsExportUrl({ source: 'historian', id: 'h 1', tags: ['plant/a,b', 'x'], units: ['°C'], from: 1000.4, to: 2000.2, mode: 'raw' });
    const u = new URL(url, 'http://localhost');
    expect(u.pathname).toBe('/api/trends/export.csv');
    expect(u.searchParams.get('source')).toBe('historian');
    expect(u.searchParams.get('id')).toBe('h 1');
    expect(u.searchParams.getAll('tag')).toEqual(['plant/a,b', 'x']);
    expect(u.searchParams.getAll('unit')).toEqual(['°C', '']);
    expect(u.searchParams.get('from')).toBe('1000');
    expect(u.searchParams.get('to')).toBe('2001');
    expect(u.searchParams.get('mode')).toBe('raw');
  });

  it('live is always raw', () => {
    const u = new URL(trendsExportUrl({ source: 'live', id: 'b', tags: ['t'], from: 1, to: 2, mode: 'bucketed' }), 'http://localhost');
    expect(u.searchParams.get('mode')).toBe('raw');
  });

  it('reads the file name from Content-Disposition', () => {
    expect(filenameFrom('attachment; filename="manifold-trends-raw-a-b.csv"')).toBe('manifold-trends-raw-a-b.csv');
    expect(filenameFrom(null)).toBe('manifold-trends.csv');
  });
});
