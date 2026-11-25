import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FALLBACK, FALLBACK_TOKENS, TOKEN_NAMES } from '@/graph/canvasTokens';
import { contrastRatio, deltaE, paletteReport, parseColor, simulateCvd, toHex, VISION_MODES } from '@/graph/colorMath';
import { SERIES, levelPalette } from '@/graph/dataPalette';
import { buildUnsTheme } from '@/graph/unsTheme';
import { resolveGraphStyle, resolveStyleId, STYLE_LIST, GRAPH_STYLES } from '@/graph/graphStyles';
import { buildChartTheme } from '@/components/chartTheme';
import { alignSeries, isBadQuality } from '@/components/chartMath';
import { displayValue } from '@/graph/unsLive';

const MODES = ['dark', 'light'];

/** Token values from index.css: the dark block (`:root, :root[data-theme='dark']`) and the light block. */
function cssTokens() {
  const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
  const block = (selector) => {
    const i = css.indexOf(selector);
    const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
    const out = {};
    for (const m of body.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) out[m[1]] = toHex([Number(m[2]), Number(m[3]), Number(m[4])]);
    return out;
  };
  return { dark: block(":root[data-theme='dark'] {"), light: block(":root[data-theme='light'] {") };
}

describe('canvas tokens', () => {
  it('the fallback snapshot mirrors index.css exactly (both themes)', () => {
    const css = cssTokens();
    for (const mode of MODES) {
      for (const name of TOKEN_NAMES) expect(FALLBACK[mode][name], `${mode} --${name}`).toBe(css[mode][name]);
    }
  });
});

describe('colour math', () => {
  it('computes WCAG contrast, CIEDE2000 and CVD simulation sanely', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(deltaE('#336699', '#336699')).toBe(0);
    expect(deltaE('#ff0000', '#00ff00')).toBeGreaterThan(50);
    expect(simulateCvd('#123456', 'normal')).toBe('#123456');
    // red and green collapse for a deuteranope
    expect(deltaE(simulateCvd('#d03030', 'deutan'), simulateCvd('#30a030', 'deutan'))).toBeLessThan(deltaE('#d03030', '#30a030') / 2);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3]);
    expect(parseColor('15 15 16')).toEqual([15, 15, 16]);
  });
});

describe('data palette', () => {
  for (const mode of MODES) {
    const bg = FALLBACK_TOKENS[mode].bg;
    const panel = FALLBACK_TOKENS[mode].panel;
    it(`${mode}: ten series colours, each >= 3:1 on the canvas and the panel (WCAG 1.4.11)`, () => {
      expect(SERIES[mode]).toHaveLength(10);
      expect(new Set(SERIES[mode]).size).toBe(10);
      for (const c of SERIES[mode]) {
        expect(contrastRatio(c, bg), c).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(c, panel), c).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${mode}: slots stay apart for normal vision and simulated protan / deutan / tritan (CIEDE2000)`, () => {
      const r = paletteReport(SERIES[mode], bg);
      for (const v of VISION_MODES) {
        expect(r.adjacent[v], `adjacent ${v}`).toBeGreaterThanOrEqual(7.5);
        expect(r.any[v], `any pair ${v}`).toBeGreaterThanOrEqual(7.5);
      }
    });
    it(`${mode}: ISA-95 level rings are distinct from their neighbours and from the namespaces`, () => {
      const lv = levelPalette(FALLBACK_TOKENS[mode]);
      for (let i = 1; i < lv.levels.length; i++) {
        const d = Math.min(...VISION_MODES.map((v) => deltaE(simulateCvd(lv.levels[i - 1], v), simulateCvd(lv.levels[i], v))));
        expect(d, `levels ${i - 1}/${i}`).toBeGreaterThanOrEqual(7.5);
      }
      for (const c of [...lv.levels, lv.sparkplug, lv.system]) expect(contrastRatio(c, bg)).toBeGreaterThanOrEqual(3);
      expect(lv.sparkplug).not.toBe(lv.system);
    });
  }
});

describe('canvas themes follow the tokens', () => {
  for (const mode of MODES) {
    const tk = FALLBACK_TOKENS[mode];
    it(`${mode}: UNS canvas = page surface, states are exactly the good / warn / bad tokens, selection = accent`, () => {
      const t = buildUnsTheme(tk);
      expect(t.bg).toBe(tk.bg);
      expect([t.statusLive, t.statusOverdue, t.statusDead]).toEqual([tk.good, tk.warn, tk.bad]);
      expect([t.valueOverdue, t.valueDead, t.edgeLive]).toEqual([tk.warn, tk.bad, tk.good]);
      expect(t.selected).toBe(tk.accent);
      for (const key of ['name', 'sub', 'count', 'rate', 'value', 'valueOverdue', 'valueDead']) expect(contrastRatio(t[key], t.bg), key).toBeGreaterThanOrEqual(4.5);
    });
    it(`${mode}: graph styles draw on the page surface with AA labels`, () => {
      for (const s of STYLE_LIST) {
        const st = resolveGraphStyle(s.id, tk);
        expect(st.background).toBe(tk.bg);
        expect(st.selectedRing).toBe(tk.accent);
        expect(contrastRatio(st.label.color, st.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(st.value, st.background)).toBeGreaterThanOrEqual(4.5);
        for (const c of st.palette) expect(contrastRatio(c, st.background), `${s.id} ${c}`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${mode}: chart axis text >= 4.5:1 on the panel and the page surface`, () => {
      const ct = buildChartTheme(tk);
      expect(contrastRatio(ct.axis, tk.panel)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ct.axis, tk.bg)).toBeGreaterThanOrEqual(4.5);
      expect([ct.good, ct.warn, ct.bad, ct.accent]).toEqual([tk.good, tk.warn, tk.bad, tk.accent]);
      expect(ct.palette).toEqual(SERIES[mode]);
    });
  }

  it('maps the old preset ids users may have stored onto the new styles', () => {
    expect(resolveStyleId('constellation')).toBe('standard');
    expect(resolveStyleId('blueprint')).toBe('schematic');
    expect(resolveStyleId('slate')).toBe('mono');
    expect(resolveStyleId('nonsense')).toBe('standard');
    expect(GRAPH_STYLES.constellation.palette).toHaveLength(9);
  });
});

describe('chart data and labels', () => {
  it('flags Bad-quality samples and brackets outages for the overlay', () => {
    expect([isBadQuality(192), isBadQuality(0), isBadQuality('bad'), isBadQuality(undefined), isBadQuality(false)]).toEqual([false, true, true, false, true]);
    const pts = [[1000, 1], [2000, 2, 0], [3000, 3], [4000, 4], [30000, 5], [31000, 6]];
    const d = alignSeries([{ tag: 'a', points: pts }]);
    expect(d.bad[0]).toHaveLength(1);
    expect(d[0][d.bad[0][0]]).toBe(2);
    expect(d.gaps[0]).toHaveLength(1);
    const [a, b] = d.gaps[0][0];
    expect([d[1][a], d[1][b]]).toEqual([4, 5]);
  });
  it('shows value envelopes on the map as value and unit', () => {
    expect(displayValue({ v: 57, t: 1, q: 192, u: 'C' })).toBe('57 C');
    expect(displayValue({ value: 4.23456, unit: 'bar' })).toBe('4.23 bar');
    expect(displayValue(12)).toBe('12');
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
  });
});
