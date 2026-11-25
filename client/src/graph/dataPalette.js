/**
 * Manifold's data palette: the colours DATA gets on every canvas (chart series,
 * graph node groups, UNS levels and namespaces). Chrome colours (surfaces, text,
 * state, accent) are NOT here: they come from the design tokens at runtime
 * (canvasTokens.js) so they match the DOM exactly.
 *
 * Categorical series, one set per theme, same hue family per slot in both
 * (blue, orange, violet, gold, teal, pink, sky, magenta, green, red), so a
 * series keeps its identity when the theme changes. Designed numerically
 * (OKLCH, lightness spread so colours stay apart when hue information is lost)
 * and asserted in src/test/canvasTheme.test.js:
 *   - every slot >= 3:1 against the canvas (WCAG 1.4.11, non-text);
 *   - adjacent slots >= 7.5 CIEDE2000 apart for normal vision AND simulated
 *     protanopia, deuteranopia and tritanopia (Machado 2009, full severity);
 *   - any two slots >= 7.5 apart in every one of those four views.
 * The state-like hues (green, red) sit last so typical charts (1-7 series)
 * never show a "good green" or "bad red" line. Series 6-10 are also dashed in
 * charts, so identity never depends on hue alone.
 */
export const SERIES = {
  dark: ['#81b7fc', '#c56c0c', '#9e7cf1', '#bca422', '#169b86', '#d887ae', '#9cdffe', '#b55fba', '#77b868', '#fcc4bf'],
  light: ['#0256a9', '#b4620c', '#8460d2', '#4d4206', '#0c4d42', '#843b61', '#14799c', '#69126f', '#4d8c3e', '#b02a2d']
};

/** Line dash per series slot (CSS px): solid for 1-5, dashed for 6-10. */
export const SERIES_DASH = [null, null, null, null, null, [6, 3], [2, 3], [8, 3, 2, 3], [4, 4], [1, 2]];

export const seriesColor = (tokens, i) => SERIES[tokens.mode === 'light' ? 'light' : 'dark'][i % 10];

/**
 * ISA-95 level ring colours by depth (0 = the namespace root ... 6 = node),
 * plus the two namespaces that are NOT ISA-95. The root and the deepest level
 * are neutral (structure); the levels in between take distinct series hues, so
 * adjacent columns of the tidy tree never share a colour.
 */
export function levelPalette(tokens) {
  const s = SERIES[tokens.mode === 'light' ? 'light' : 'dark'];
  return {
    levels: [tokens.textMuted, s[0], s[2], s[4], s[1], s[6], tokens.textSubtle],
    sparkplug: s[7],
    system: s[3]
  };
}
