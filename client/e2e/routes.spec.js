import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';

/**
 * Every route, at desktop and mobile width (the two Playwright projects):
 *   1. loads with zero console errors / uncaught exceptions,
 *   2. has no content clipped by, or sticking out of, the viewport,
 *   3. has no axe violations of impact serious or critical.
 */
const ROUTES = [
  { path: '/', heading: 'Overview' },
  { path: '/topics', heading: 'Topics' },
  { path: '/uns', heading: 'Namespace' },
  { path: '/flows', heading: 'Flows' },
  { path: '/trends', heading: 'Trends' },
  { path: '/pipelines', heading: 'Pipelines' },
  { path: '/tags', heading: 'Tags' },
  { path: '/brokers', heading: 'MQTT Brokers', text: 'E2E broker' },
  { path: '/devices', heading: 'Devices' },
  { path: '/opcua', heading: 'OPC UA' },
  { path: '/cesmii', heading: 'CESMII SMIP' },
  { path: '/i3x', heading: 'i3X' },
  { path: '/discovery', heading: 'Discovery' },
  { path: '/system', heading: 'System' },
  { path: '/settings', heading: 'Settings' }
];

/**
 * Documented allowlist of axe rule ids per route. Empty on purpose: every
 * serious/critical finding must be fixed, not waived. If a finding is genuinely
 * unfixable (for example inside a component another team owns), add
 * `{ '/route': ['rule-id'] }` here WITH the reason.
 */
const AXE_ALLOWLIST = {};

/** Console messages that are noise, not defects (none today). */
const IGNORED_CONSOLE = [];

async function settle(page) {
  // The page heading renders only once the lazy route chunk has loaded...
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // ...and skeleton/busy placeholders are gone once its data has arrived.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // Let layout settle (fonts, charts, first live updates) without sleeping a fixed time.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Elements whose box leaves the viewport horizontally, outside any scroller that is meant to clip or scroll them. */
function findOverflow() {
  const vw = document.documentElement.clientWidth;
  const clips = (el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll|hidden|clip)/.test(s.overflowX);
  };
  const out = [];
  const page = { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw };
  if (page.scrollWidth > page.clientWidth + 1) out.push(`page scrolls horizontally (${page.scrollWidth} > ${page.clientWidth})`);
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('[aria-hidden="true"], [hidden], canvas, svg')) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    // Inside a scroller/clipper (table wrapper, tree, code block): it scrolls or clips by design.
    let p = el.parentElement;
    let guarded = false;
    while (p && p !== document.body) {
      if (clips(p)) {
        guarded = true;
        break;
      }
      p = p.parentElement;
    }
    if (guarded) continue;
    out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).slice(0, 60)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}px`);
  }
  return out.slice(0, 10);
}

async function audit(page, key, consoleErrors) {
  const overflow = await page.evaluate(findOverflow);
  expect(overflow, 'content overflowing the viewport').toEqual([]);

  const allowed = AXE_ALLOWLIST[key] || [];
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const serious = results.violations
    .filter((v) => (v.impact === 'serious' || v.impact === 'critical') && !allowed.includes(v.id))
    .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.html.slice(0, 160)).join(' | ')}`);
  expect(serious, 'axe violations').toEqual([]);

  const errors = consoleErrors.filter((e) => !IGNORED_CONSOLE.some((re) => re.test(e)));
  expect(errors, 'console errors').toEqual([]);
}

for (const route of ROUTES) {
  test(`${route.path} - no console errors, no overflow, no serious axe violations`, async ({ page, consoleErrors }) => {
    await page.goto(route.path);
    await settle(page);
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(route.heading);
    // Pages that show data must show the seeded data, not an empty state.
    if (route.text) await expect(page.getByText(route.text).first()).toBeVisible();
    await audit(page, route.path, consoleErrors);
  });
}

// Second-level views that a plain route visit does not reach.
test('/flows consumers view', async ({ page, consoleErrors }) => {
  await page.goto('/flows');
  await settle(page);
  await page.getByRole('button', { name: /Consumers/ }).click();
  await expect(page.getByRole('region', { name: 'Broker admin connection' })).toBeVisible();
  await audit(page, '/flows#consumers', consoleErrors);
});

// The detector must actually bite: prove it flags a wide element and a scrolling page.
test('overflow detector flags content wider than the viewport', async ({ page }) => {
  await page.setContent('<body><div style="width:3000px;height:20px">wide</div></body>');
  const found = await page.evaluate(findOverflow);
  expect(found.length).toBeGreaterThan(0);
});
