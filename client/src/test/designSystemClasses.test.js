import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The Tailwind compatibility layer is gone: legacy palette names (slate, surface, rose, amber,
// emerald, sky, white/x glass, ...) no longer map onto the tokens, so a class like that renders
// nothing. Keep them out of the source (docs/design/ui-design-system.md, section 11).

const ROOT = path.resolve(__dirname, '..');
const HUES = 'slate|gray|zinc|neutral|stone|sky|rose|red|pink|amber|yellow|orange|emerald|green|lime|blue|indigo|teal|cyan|violet|purple|fuchsia|surface';
const LEGACY = [
  new RegExp(`\\b(bg|text|border|ring|divide|from|to|via|fill|stroke|accent|outline|shadow|placeholder|decoration|caret)-(${HUES})-\\d+`),
  /\b(bg|border|ring|divide|text)-(white|black)\/[\d[]/,
  /\b(accent|good|warn|bad|info|aux)-(50|[1-9]00|950)\b/,
  /\bbackdrop-blur\b|\bbg-gradient-to-|\banimate-ping\b|\blabel-xs\b/,
  /\brounded-(xl|2xl|3xl)\b|\bshadow-(sm|md|lg|xl|2xl|inner)\b|\btext-3xl\b|\btext-\[(9|10)px\]/,
  /\buppercase\b[^'"`]*\btracking-(wide|wider|widest)\b/
];

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'test') out.push(...files(p));
    } else if (/\.(jsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('design system: no legacy Tailwind idioms', () => {
  it('no source file uses a class the removed compatibility layer used to remap', () => {
    const hits = [];
    for (const f of files(ROOT)) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (LEGACY.some((re) => re.test(line))) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
