import { test, expect } from './fixtures.js';

/**
 * Canvas / WebGL renderer regressions, asserted deterministically (no stored
 * pixel baselines):
 *   - the backing store is round(CSS size x devicePixelRatio), also after a
 *     window resize and after the container alone changes (sidebar collapse);
 *   - a view with data is not blank / not one flat colour;
 *   - clicking a node at its reported screen position selects THAT node, at two
 *     zoom levels (and at DPR 2 in the `hidpi` project);
 *   - no requestAnimationFrame activity once the canvas route is unmounted, and
 *     a quiet (reduced-motion) view does not repaint at 60 fps;
 *   - the 3D view survives a WebGL context loss.
 *
 * Renderers expose read-only state through `window.__manifoldTest`, which is
 * only registered when localStorage['manifold.e2e'] = '1' (or ?e2e=1).
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('manifold.e2e', '1');
    // Count animation frames the page schedules (wrapped before any app code runs).
    window.__rafCount = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      raf((ts) => {
        window.__rafCount += 1;
        cb(ts);
      });
  });
});

/** Canvas metrics + whether its pixels vary (2D canvases only). */
async function canvasState(locator) {
  return locator.evaluate((c) => {
    const out = { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: window.devicePixelRatio, distinct: -1 };
    const ctx = c.getContext('2d');
    if (ctx) {
      const seen = new Set();
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      const stride = Math.max(4, Math.floor(img.length / 4 / 4000) * 4);
      for (let i = 0; i < img.length; i += stride) seen.add(`${img[i]},${img[i + 1]},${img[i + 2]}`);
      out.distinct = seen.size;
    }
    return out;
  });
}

function expectCrisp(s) {
  expect(s.cw).toBeGreaterThan(50);
  expect(s.w).toBe(Math.round(s.cw * s.dpr));
  expect(s.h).toBe(Math.round(s.ch * s.dpr));
}

async function rafPerSecond(page, ms = 1500) {
  const a = await page.evaluate(() => window.__rafCount);
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => window.__rafCount);
  return ((b - a) * 1000) / ms;
}

test('UNS topology: crisp at any size, not blank, click hits the node, quiet when idle, silent when unmounted', async ({ page, consoleErrors }) => {
  await page.goto('/uns');
  const canvas = page.locator('canvas[aria-describedby="uns-canvas-help"]');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => (window.__manifoldTest?.uns?.nodes || []).some((n) => n.depth === 1));

  const s0 = await canvasState(canvas);
  expectCrisp(s0);
  expect(s0.distinct).toBeGreaterThan(8); // badges, text, edges — not a flat fill

  // Container-only resize: collapsing the sidebar changes the canvas box without a window resize.
  await page.keyboard.press('[');
  await expect.poll(async () => (await canvasState(canvas)).cw).not.toBe(s0.cw);
  expectCrisp(await canvasState(canvas));
  await page.keyboard.press('[');
  // Window resize.
  const vp = page.viewportSize();
  await page.setViewportSize({ width: Math.round(vp.width * 0.8), height: Math.round(vp.height * 0.8) });
  await expect.poll(async () => (await canvasState(canvas)).cw).toBeLessThan(s0.cw);
  expectCrisp(await canvasState(canvas));
  await page.setViewportSize(vp);
  await expect.poll(async () => (await canvasState(canvas)).cw).toBe(s0.cw);
  await page.waitForTimeout(400); // sidebar width transition + re-fit

  // Click a node at its reported position, at the fitted zoom and zoomed in.
  for (const k of [null, 1.6]) {
    if (k) {
      await page.evaluate((kk) => {
        const h = window.__manifoldTest.uns;
        const n = h.nodes.find((x) => x.depth === 1);
        const { w, h: hh } = h.size;
        h.setTransform({ k: kk, x: w / 2 - n.x * kk, y: hh / 2 - n.y * kk });
      }, k);
    }
    const node = await page.evaluate(() => window.__manifoldTest.uns.nodes.find((n) => n.depth === 1));
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + node.sx, box.y + node.sy - 6); // badge centre (above the ± toggle)
    await expect(page.getByRole('complementary', { name: 'Node details' })).toContainText(node.name);
  }

  // Reduced motion (the suite's default): once the 1 s interaction tail is over,
  // live data must not drive a 60 fps loop.
  await page.waitForTimeout(1200);
  expect(await rafPerSecond(page)).toBeLessThan(12);

  // Unmount: no animation frames once the route is gone.
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('Settings');
  await page.waitForTimeout(300);
  expect(await rafPerSecond(page)).toBeLessThan(2);
  expect(await page.evaluate(() => window.__manifoldTest?.uns)).toBeFalsy();
  expect(consoleErrors).toEqual([]);
});

test('Topics graph: crisp, not blank, node hit-testing at two zoom levels, settles', async ({ page, consoleErrors }) => {
  await page.addInitScript(() => localStorage.setItem('tc.topicsView', 'graph'));
  await page.goto('/topics');
  const canvas = page.getByTestId('graph2d');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => window.__manifoldTest?.graph2d?.settled && window.__manifoldTest.graph2d.nodes().length >= 5, null, { timeout: 30_000 });

  const s = await canvasState(canvas);
  expectCrisp(s);
  expect(s.distinct).toBeGreaterThan(4);

  for (const k of [null, 2.5]) {
    if (k) {
      await page.evaluate((kk) => {
        const h = window.__manifoldTest.graph2d;
        h.zoomTo(kk, h.size.w / 2, h.size.h / 2);
      }, k);
      await page.waitForTimeout(100);
    }
    // A leaf away from the floating toolbar / legend overlays.
    const node = await page.evaluate(() => {
      const h = window.__manifoldTest.graph2d;
      const { w, h: hh } = h.size;
      return h.nodes().find((n) => n.label && n.sx > 60 && n.sx < w - 260 && n.sy > 90 && n.sy < hh - 140);
    });
    expect(node, `a clickable node at zoom ${k ?? 'fit'}`).toBeTruthy();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + node.sx, box.y + node.sy);
    await expect(page.getByRole('complementary', { name: 'Topic details' })).toContainText(node.label);
    // The details panel narrows the canvas: the backing store must follow.
    await expect.poll(async () => {
      const c = await canvasState(canvas);
      return c.w === Math.round(c.cw * c.dpr);
    }).toBe(true);
  }
  expect(consoleErrors).toEqual([]);
});

test('Topics 3D: framed, not blank, survives WebGL context loss, no idle render loop', async ({ page, consoleErrors }) => {
  await page.addInitScript(() => localStorage.setItem('tc.topicsView', '3d'));
  await page.goto('/topics');
  await page.waitForFunction(() => window.__manifoldTest?.graph3d && window.__manifoldTest.graph3d.nodes(10).length > 0, null, { timeout: 30_000 });
  const size = await page.evaluate(() => window.__manifoldTest.graph3d.size);
  expect(size.bw).toBe(Math.round(size.w * (await page.evaluate(() => devicePixelRatio))));

  // Camera framed on the layout: every node projects inside the viewport.
  const nodes = await page.evaluate(() => window.__manifoldTest.graph3d.nodes(5000));
  const total = await page.evaluate(() => window.__manifoldTest.graph3d.camera);
  expect(total.z).toBeGreaterThan(total.radius); // camera outside the layout sphere
  expect(nodes.length).toBeGreaterThan(5);

  expect((await page.evaluate(() => window.__manifoldTest.graph3d.sample(window.__manifoldTest.graph3d.nodes(40)))).distinct).toBeGreaterThan(1);
  await page.evaluate(() => window.__manifoldTest.graph3d.loseContext());
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__manifoldTest.graph3d.restoreContext());
  await expect.poll(() => page.evaluate(() => window.__manifoldTest.graph3d.sample())).toMatchObject({ lost: false });
  expect((await page.evaluate(() => window.__manifoldTest.graph3d.sample(window.__manifoldTest.graph3d.nodes(40)))).distinct).toBeGreaterThan(1);

  // On-demand rendering: once the interaction tail is over, no frames.
  await page.waitForTimeout(2200);
  expect(await rafPerSecond(page)).toBeLessThan(2);
  expect(consoleErrors.filter((e) => !/context lost|CONTEXT_LOST/i.test(e))).toEqual([]);
});
