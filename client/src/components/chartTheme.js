/**
 * The chart theme (pure, no uPlot / DOM): every colour a uPlot canvas draws,
 * derived from the design tokens. Kept apart from charts.jsx so it is
 * unit-tested in node (src/test/canvasTheme.test.js).
 */
import { FALLBACK_TOKENS, FONT, getCanvasTokens } from '@/graph/canvasTokens';
import { SERIES, SERIES_DASH } from '@/graph/dataPalette';
import { mix } from '@/graph/colorMath';

/**
 * THE theme object for every uPlot chart (sparklines, the health popup, topic
 * history, Trends), derived from the design tokens for a theme. Axis text is
 * `text-subtle` (AA on both the page and panel surfaces in both themes, see
 * src/test/canvasTheme.test.js), grid lines are a hairline step, the series
 * palette is the data palette (dataPalette.js).
 */
const themeCache = new WeakMap();
export function buildChartTheme(tokens) {
  const hit = themeCache.get(tokens);
  if (hit) return hit;
  const dark = tokens.mode !== 'light';
  const theme = {
    mode: tokens.mode,
    surface: tokens.panel, // charts sit on panels
    accent: tokens.accent,
    good: tokens.good,
    warn: tokens.warn,
    bad: tokens.bad,
    axis: tokens.textSubtle, // tick labels
    axisLine: tokens.borderStrong,
    grid: mix(tokens.panel, tokens.borderStrong, dark ? 0.75 : 0.65),
    gap: tokens.textFaint,
    palette: SERIES[dark ? 'dark' : 'light'],
    dash: SERIES_DASH,
    font: `400 12px ${FONT}`,
    labelFont: `500 12px ${FONT}`
  };
  themeCache.set(tokens, theme);
  return theme;
}

/** Live view of the chart theme for the CURRENT app theme (for code outside a chart). */
export const CHART_THEME = {};
for (const key of Object.keys(buildChartTheme(FALLBACK_TOKENS.dark))) {
  Object.defineProperty(CHART_THEME, key, { enumerable: true, get: () => buildChartTheme(getCanvasTokens())[key] });
}

