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

/** The most frequent colour on a 2D canvas (its background), as [r, g, b]. */
async function dominantColor(locator) {
  return locator.evaluate((c) => {
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const counts = new Map();
    const stride = Math.max(4, Math.floor(img.length / 4 / 3000) * 4);
    for (let i = 0; i < img.length; i += stride) {
      const k = `${img[i]},${img[i + 1]},${img[i + 2]}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  });
}

/** The page surface token (--bg) of the current theme, as [r, g, b]. */
async function surfaceToken(page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().split(/\s+/).map(Number));
}

const near = (a, b, tol = 2) => a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function switchTheme(page, name) {
  await page.getByRole('group', { name: 'Colour theme' }).getByRole('button', { name: `${name} theme` }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', name.toLowerCase());
}

/**
 * Resolve once the 2D graph is still: the layout has settled, a zoom target (if
 * given) is applied, and the camera, canvas size and the screen positions of the
 * visible nodes are identical for 6 consecutive animation frames. Deterministic
 * under CPU load, unlike a fixed sleep.
 */
async function graphStable(page, k = null) {
  await page.waitForFunction(
    (kk) =>
      new Promise((resolve) => {
        const h = window.__manifoldTest?.graph2d;
        let last = '';
        let same = 0;
        let ticks = 0;
        const step = () => {
          ticks += 1;
          const snap = h && h.settled && (kk == null || Math.abs(h.transform.k - kk) < 1e-6) ? JSON.stringify([h.transform, h.size, h.nodes(40).map((n) => [n.id, Math.round(n.sx), Math.round(n.sy)])]) : null;
          same = snap && snap === last ? same + 1 : 0;
          last = snap;
          if (same >= 6) resolve(true);
          else if (ticks > 240) resolve(false); // let waitForFunction poll again
          else requestAnimationFrame(step);
        };
        step();
      }),
    k,
    { timeout: 30_000, polling: 100 }
  );
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
  await graphStable(page);

  const s = await canvasState(canvas);
  expectCrisp(s);
  expect(s.distinct).toBeGreaterThan(4);

  for (const k of [null, 2.5]) {
    if (k) {
      await page.evaluate((kk) => {
        const h = window.__manifoldTest.graph2d;
        h.zoomTo(kk, h.size.w / 2, h.size.h / 2);
      }, k);
    }
    // Camera applied and nothing moving (after the zoom, and after the details
    // panel from the previous click resized the canvas) before reading positions.
    await graphStable(page, k);
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

test('UNS deep link selects and centres the node, the URL follows the selection, a missing path says so', async ({ page, consoleErrors }) => {
  const path = 'plant/line1/temperature';
  await page.goto(`/uns?broker=e2e-broker&path=${encodeURIComponent(path)}`);
  const details = page.getByRole('complementary', { name: 'Node details' });
  await expect(details).toContainText('temperature');
  await expect.poll(() => page.evaluate(() => window.__manifoldTest?.uns?.selectedId)).toBe(`uns:e2e-broker:${path}`);
  // Centred: the selected node sits in the middle of the canvas.
  await expect
    .poll(async () =>
      page.evaluate((p) => {
        const h = window.__manifoldTest.uns;
        const n = h.nodes.find((x) => x.path === p);
        if (!n) return false;
        return Math.abs(n.sx - h.size.w / 2) < h.size.w * 0.1 && Math.abs(n.sy - h.size.h / 2) < h.size.h * 0.1;
      }, path)
    )
    .toBe(true);

  // Selecting another node rewrites the URL in place (shareable selection).
  const other = await page.evaluate(() => window.__manifoldTest.uns.nodes.find((n) => n.path === 'plant/line1/pressure') || window.__manifoldTest.uns.nodes.find((n) => n.depth === 2 && !n.path.endsWith('temperature')));
  expect(other).toBeTruthy();
  const canvas = page.locator('canvas[aria-describedby="uns-canvas-help"]');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + other.sx, box.y + other.sy - 6);
  await expect(details).toContainText(other.name);
  await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(other.path);
  expect(new URL(page.url()).searchParams.get('broker')).toBe('e2e-broker');

  // A path that does not exist (yet): a short inline note naming it.
  await page.goto('/uns?path=plant/nowhere/sensor');
  await expect(page.getByRole('status').filter({ hasText: 'plant/nowhere/sensor' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('theme switch recolours the UNS map in place: same canvas, camera and selection; light canvas = page surface', async ({ page, consoleErrors }) => {
  await page.addInitScript(() => localStorage.setItem('tc.theme', 'dark'));
  await page.goto('/uns?broker=e2e-broker&path=plant/line1');
  const canvas = page.locator('canvas[aria-describedby="uns-canvas-help"]');
  await expect(page.getByRole('complementary', { name: 'Node details' })).toBeVisible();
  await page.waitForTimeout(600);
  await canvas.evaluate((c) => (c.dataset.mark = 'same'));
  const before = await page.evaluate(() => ({ t: window.__manifoldTest.uns.transform, sel: window.__manifoldTest.uns.selectedId }));
  const darkBg = await dominantColor(canvas);
  expect(near(darkBg, await surfaceToken(page))).toBe(true);

  await switchTheme(page, 'Light');
  await expect.poll(async () => near(await dominantColor(canvas), await surfaceToken(page))).toBe(true);
  const lightBg = await dominantColor(canvas);
  expect(lightBg).not.toEqual(darkBg);
  expect(lightBg.reduce((a, b) => a + b, 0) / 3).toBeGreaterThan(200); // not a dark slab in the light theme
  await expect(canvas).toHaveAttribute('data-mark', 'same'); // no remount
  const after = await page.evaluate(() => ({ t: window.__manifoldTest.uns.transform, sel: window.__manifoldTest.uns.selectedId }));
  expect(after).toEqual(before);
  expect(consoleErrors).toEqual([]);
});

test('theme switch recolours the Topics graph (2D and 3D) without a remount, keeping camera and selection', async ({ page, consoleErrors }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tc.theme', 'dark');
    localStorage.setItem('tc.topicsView', 'graph');
  });
  await page.goto('/topics?broker=e2e-broker&topic=plant/line1/temperature');
  const canvas = page.getByTestId('graph2d');
  await expect(page.getByRole('complementary', { name: 'Topic details' })).toContainText('temperature');
  await page.waitForFunction(() => window.__manifoldTest?.graph2d?.settled, null, { timeout: 30_000 });
  await page.waitForTimeout(1200); // the deep-link framing
  await canvas.evaluate((c) => (c.dataset.mark = 'same'));
  const t0 = await page.evaluate(() => window.__manifoldTest.graph2d.transform);
  const dark2d = await dominantColor(canvas);
  expect(near(dark2d, await surfaceToken(page))).toBe(true);
  await switchTheme(page, 'Light');
  await expect.poll(async () => near(await dominantColor(canvas), await surfaceToken(page))).toBe(true);
  expect(await dominantColor(canvas)).not.toEqual(dark2d);
  await expect(canvas).toHaveAttribute('data-mark', 'same');
  expect(await page.evaluate(() => window.__manifoldTest.graph2d.transform)).toEqual(t0);
  await expect(page.getByRole('complementary', { name: 'Topic details' })).toContainText('temperature');
  expect(new URL(page.url()).searchParams.get('topic')).toBe('plant/line1/temperature');

  // 3D: materials and background update in place (same canvas, same camera).
  await page.getByRole('radio', { name: '3D' }).click();
  await page.waitForFunction(() => window.__manifoldTest?.graph3d && window.__manifoldTest.graph3d.nodes(5).length > 0, null, { timeout: 30_000 });
  const c3 = page.getByTestId('graph3d');
  await c3.evaluate((c) => (c.dataset.mark = 'same'));
  const cam0 = await page.evaluate(() => ({ cam: window.__manifoldTest.graph3d.camera, rot: window.__manifoldTest.graph3d.rotation }));
  const light3d = await page.evaluate(() => window.__manifoldTest.graph3d.bgPixel());
  expect(near(light3d, await surfaceToken(page), 3)).toBe(true);
  await switchTheme(page, 'Dark');
  await expect.poll(async () => near(await page.evaluate(() => window.__manifoldTest.graph3d.bgPixel()), await surfaceToken(page), 3)).toBe(true);
  await expect(c3).toHaveAttribute('data-mark', 'same');
  expect(await page.evaluate(() => ({ cam: window.__manifoldTest.graph3d.camera, rot: window.__manifoldTest.graph3d.rotation }))).toEqual(cam0);
  expect(consoleErrors).toEqual([]);
});
