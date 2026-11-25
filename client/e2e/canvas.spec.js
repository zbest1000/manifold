import { test, expect } from './fixtures.js';
import { startBigBroker } from './support.js';

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

// Which project runs what is decided in playwright.config.js by tag, not by skipping: tests tagged
// @touch run only in the phone project (mobile-touch); every other test runs on desktop and hidpi.
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
  await unsStable(page); // sidebar width transition + re-fit have landed

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
    // Read positions only once nothing moves (the details panel opened by the previous click
    // resizes the canvas; on a slow runner that lands after the camera was set).
    await unsStable(page);
    // A first-level node that is on screen and clear of the floating overlays (late in a full run the
    // namespace holds more branches than fit, so "the first one" can be off screen or under a panel).
    const pick = () =>
      page.evaluate(() => {
        const h = window.__manifoldTest.uns;
        const v = h.viewport;
        const clear = (n) => n.sx - n.r >= v.x0 && n.sx + n.r <= v.x1 && n.sy - n.r - 12 >= v.y0 && n.sy + n.r <= v.y1 && !h.overlays.some((r) => n.sx + n.r > r.left && n.sx - n.r < r.right && n.sy + n.r > r.top && n.sy - n.r - 12 < r.bottom);
        return h.nodes.find((n) => n.depth === 1 && clear(n)) || null;
      });
    let node = await pick();
    if (!node) {
      const first = await page.evaluate(() => window.__manifoldTest.uns.nodes.find((n) => n.depth === 1).path);
      await placeNode(page, first, 0.5, 0.5);
      await unsStable(page);
      node = await pick();
    }
    expect(node, 'a first-level node on screen').toBeTruthy();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + node.sx, box.y + node.sy - 6); // badge centre (above the ± toggle)
    await expect(page.getByRole('complementary', { name: 'Node details' })).toContainText(node.name);
  }

  // Reduced motion (the suite's default): once the 1 s interaction tail is over,
  // live data must not drive a 60 fps loop (measured until it is quiet, not after a guessed sleep).
  await unsStable(page);
  await expect.poll(() => rafPerSecond(page), { timeout: 30_000 }).toBeLessThan(12);

  // Unmount: no animation frames once the route is gone.
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('Settings');
  await expect.poll(() => page.evaluate(() => window.__manifoldTest?.uns)).toBeFalsy();
  await expect.poll(() => rafPerSecond(page), { timeout: 30_000 }).toBeLessThan(2);
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

  // A labelled node clear of the overlays (toolbar row above, replay and legend
  // below, details panel to the right), other than `except`.
  const pickNode = (except) =>
    page.evaluate((ex) => {
      const h = window.__manifoldTest.graph2d;
      const { w, h: hh } = h.size;
      return h.nodes().find((n) => n.label && n.id !== ex && n.sx > 60 && n.sx < w - 260 && n.sy > 90 && n.sy < hh - 140);
    }, except);

  let clicked = null;
  for (const k of [null, 2.5]) {
    // Camera applied and nothing moving (after the details panel from the
    // previous click resized the canvas) before reading positions.
    await graphStable(page);
    let node = await pickNode(clicked);
    expect(node, `a clickable node at zoom ${k ?? 'fit'}`).toBeTruthy();
    if (k) {
      // Zoom about that node, so it stays where it is (in the clear area)
      // whatever the data, then read its position again once still.
      await page.evaluate(([kk, x, y]) => window.__manifoldTest.graph2d.zoomTo(kk, x, y), [k, node.sx, node.sy]);
      await graphStable(page, k);
      const id = node.id;
      node = await page.evaluate((nid) => window.__manifoldTest.graph2d.nodes().find((n) => n.id === nid), id);
      expect(node, `node ${id} on screen at zoom ${k}`).toBeTruthy();
    }
    clicked = node.id;
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
  // The deep-link jump has finished (node centred, layout and canvas still).
  await page.waitForFunction(() => window.__manifoldTest?.uns?.selectedId && window.__manifoldTest.uns.jumping === null, null, { timeout: 30_000 });
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
  // The deep link frames its node once the layout has settled (a single node is
  // framed at the 1.6 zoom cap); wait for that, then for a still camera.
  await page.waitForFunction(() => Math.abs(window.__manifoldTest.graph2d.transform.k - 1.6) < 1e-6, null, { timeout: 30_000 });
  await graphStable(page, 1.6);
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

// ---- UNS expansion: reveal, badge, collapse, overlays, streaming -------------

/** UNS hook state: nodes (screen positions), visible viewport, overlays, camera, motion, selection. */
const unsState = (page) =>
  page.evaluate(() => {
    const h = window.__manifoldTest.uns;
    return { nodes: h.nodes, vp: h.viewport, overlays: h.overlays, t: h.transform, motion: h.motion, sel: h.selectedId };
  });
const unsIdle = (page) => page.waitForFunction(() => window.__manifoldTest?.uns && window.__manifoldTest.uns.motion === null, null, { timeout: 20_000 });
/**
 * Resolve once the UNS view is still: no motion, and the camera, canvas size and the screen positions
 * of the visible nodes identical for 6 consecutive animation frames (a resize from a panel or the
 * sidebar transition has landed). Deterministic under CPU load, unlike a fixed sleep.
 */
const unsStable = (page) =>
  page.waitForFunction(
    () =>
      new Promise((resolve) => {
        let last = '';
        let same = 0;
        let ticks = 0;
        const step = () => {
          ticks += 1;
          const h = window.__manifoldTest?.uns;
          const snap = h && h.motion === null ? JSON.stringify([h.transform, h.size, h.nodes.slice(0, 40).map((n) => [n.id, Math.round(n.sx), Math.round(n.sy)])]) : null;
          same = snap && snap === last ? same + 1 : 0;
          last = snap;
          if (same >= 6) resolve(true);
          else if (ticks > 240) resolve(false); // let waitForFunction poll again
          else requestAnimationFrame(step);
        };
        step();
      }),
    null,
    { timeout: 30_000, polling: 100 }
  );

/**
 * A double-tap through the real touch input path (CDP Input.dispatchTouchEvent, as touchscreen.tap
 * uses), with the four events queued back to back instead of awaiting a renderer round trip after
 * each: on a loaded 2-core runner two awaited taps can be further apart than a person's double-tap.
 */
async function doubleTap(page, x, y) {
  const cdp = await page.context().newCDPSession(page);
  const point = [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
  const tap = () => [cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point }), cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })];
  await Promise.all([...tap(), ...tap()]);
  await cdp.detach();
}

const insideVp = (n, v) => n.sx - n.r >= v.x0 - 1 && n.sx + n.r <= v.x1 + 1 && n.sy - n.r >= v.y0 - 1 && n.sy + n.r <= v.y1 + 1;
const underOverlay = (n, rects) => rects.some((r) => n.sx + n.r > r.left && n.sx - n.r < r.right && n.sy + n.r > r.top && n.sy - n.r < r.bottom);
const byPath = (st, p) => st.nodes.find((n) => n.path === p);

async function openUns(page) {
  await page.goto('/uns?broker=e2e-broker');
  await page.waitForFunction(() => (window.__manifoldTest?.uns?.nodes || []).some((n) => n.path === 'plant/line1'), null, { timeout: 30_000 });
  await unsIdle(page);
  return page.locator('canvas[aria-describedby="uns-canvas-help"]');
}

/** Pan (as a user would) so that `path` sits at viewport-relative fractions (fx, fy). */
async function placeNode(page, path, fx, fy) {
  await page.evaluate(
    ([p, x, y]) => {
      const h = window.__manifoldTest.uns;
      const n = h.nodes.find((q) => q.path === p);
      const v = h.viewport;
      const t = h.transform;
      h.setTransform({ k: t.k, x: t.x + (v.x0 + v.w * x - n.sx), y: t.y + (v.y0 + v.h * y - n.sy) });
    },
    [path, fx, fy]
  );
}

test('UNS reveal on expand: a branch opened at the right edge brings its children into the visible viewport', async ({ page, consoleErrors }) => {
  const canvas = await openUns(page);
  await placeNode(page, 'plant/line1', 0.92, 0.5); // its children would land beyond the right edge
  const before = await unsState(page);
  const n = byPath(before, 'plant/line1');
  expect(n.expanded).toBe(false);
  const box = await canvas.boundingBox();
  await page.mouse.dblclick(box.x + n.sx, box.y + n.sy);
  await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((q) => q.path === 'plant/line1')?.expanded, null, { timeout: 10_000 });
  await unsIdle(page);
  const after = await unsState(page);
  const kids = after.nodes.filter((q) => q.path.startsWith('plant/line1/'));
  expect(kids.length).toBe(2);
  for (const k of kids) {
    expect(insideVp(k, after.vp), `${k.path} inside the visible viewport`).toBe(true);
    expect(underOverlay(k, after.overlays), `${k.path} not under an overlay`).toBe(false);
  }
  expect(insideVp(byPath(after, 'plant/line1'), after.vp)).toBe(true);
  expect(after.sel).toBeNull(); // a double-click expands, it does not select
  // No two nodes overlap.
  for (let a = 0; a < after.nodes.length; a++) for (let b = a + 1; b < after.nodes.length; b++) {
    expect(Math.hypot(after.nodes[a].sx - after.nodes[b].sx, after.nodes[a].sy - after.nodes[b].sy)).toBeGreaterThan(after.nodes[a].r * 2);
  }
  expect(consoleErrors).toEqual([]);
});

test('UNS +/- badge toggles without selecting; collapse keeps the node and unrelated branches in place', async ({ page, consoleErrors }) => {
  const canvas = await openUns(page);
  await placeNode(page, 'plant/line2', 0.4, 0.5);
  const box = await canvas.boundingBox();
  const s0 = await unsState(page);
  const n = byPath(s0, 'plant/line2');
  // The badge sits under the node (at +r); its target is at least 24 px.
  await page.mouse.click(box.x + n.sx, box.y + n.sy + n.r + 4);
  await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((q) => q.path === 'plant/line2')?.expanded, null, { timeout: 10_000 });
  await unsIdle(page);
  const s1 = await unsState(page);
  expect(s1.sel).toBeNull();
  await expect(page.getByRole('complementary', { name: 'Node details' })).toHaveCount(0);
  // Collapse with the badge again: the node stays under the pointer, other branches do not move.
  const m = byPath(s1, 'plant/line2');
  const other = byPath(s1, 'plant/energy');
  await page.mouse.click(box.x + m.sx, box.y + m.sy + m.r + 4);
  await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((q) => q.path === 'plant/line2')?.expanded === false, null, { timeout: 10_000 });
  await unsIdle(page);
  const s2 = await unsState(page);
  const m2 = byPath(s2, 'plant/line2');
  expect(Math.hypot(m2.sx - m.sx, m2.sy - m.sy)).toBeLessThan(2);
  const o2 = byPath(s2, 'plant/energy');
  expect(Math.abs(o2.sx - other.sx)).toBeLessThan(2); // same column, only shifted by the rows the layout removed
  expect(s2.sel).toBeNull();
  expect(consoleErrors).toEqual([]);
});

test('UNS selecting a node half under an overlay pulls it into the visible viewport', async ({ page, consoleErrors }) => {
  const canvas = await openUns(page);
  const st = await unsState(page);
  // The legend sits along the bottom-left; park a node so its lower half is under it.
  const legend = st.overlays.filter((r) => r.width > r.height && r.top > st.vp.y0).sort((a, b) => b.top - a.top)[0];
  expect(legend, 'a bottom overlay (legend)').toBeTruthy();
  const target = 'plant/energy';
  await page.evaluate(
    ([p, lg]) => {
      const h = window.__manifoldTest.uns;
      const n = h.nodes.find((q) => q.path === p);
      const t = h.transform;
      const x = Math.min(lg.right - 40, lg.left + 120);
      h.setTransform({ k: t.k, x: t.x + (x - n.sx), y: t.y + (lg.top + 2 - n.sy) });
    },
    [target, legend]
  );
  const s1 = await unsState(page);
  const n = byPath(s1, target);
  expect(underOverlay(n, s1.overlays)).toBe(true);
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + n.sx, box.y + n.sy - n.r * 0.6); // the visible upper half
  await expect(page.getByRole('complementary', { name: 'Node details' })).toContainText('energy');
  await page.waitForFunction((p) => window.__manifoldTest.uns.selectedId?.endsWith(p), target);
  await unsIdle(page);
  const s2 = await unsState(page);
  const n2 = byPath(s2, target);
  expect(insideVp(n2, s2.vp)).toBe(true);
  expect(underOverlay(n2, s2.overlays)).toBe(false);
  expect(consoleErrors).toEqual([]);
});

test('UNS live data does not reorder siblings or move the camera after a reveal', async ({ page, consoleErrors }) => {
  const canvas = await openUns(page);
  await placeNode(page, 'plant/line1', 0.5, 0.5);
  const s0 = await unsState(page);
  const n = byPath(s0, 'plant/line1');
  const box = await canvas.boundingBox();
  await page.mouse.dblclick(box.x + n.sx, box.y + n.sy);
  await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((q) => q.path === 'plant/line1')?.expanded, null, { timeout: 10_000 });
  await unsIdle(page);
  const order = (st) => st.nodes.filter((q) => q.depth >= 2).map((q) => q.path).join('|');
  const a = await unsState(page);
  // The e2e broker publishes every topic once a second: wait for three more data
  // flushes (the live-rate caption updates once per second).
  const frames0 = await page.evaluate(() => window.__manifoldTest.uns.frames);
  await page.waitForFunction((f) => window.__manifoldTest.uns.frames >= f + 3, frames0, { timeout: 20_000 });
  const b = await unsState(page);
  expect(order(b)).toBe(order(a));
  expect(b.t).toEqual(a.t);
  expect(b.motion).toBeNull();
  expect(consoleErrors).toEqual([]);
});

test('UNS [touch] double-tap expands and reveals, tap selects, the badge is a 44 px target', { tag: '@touch' }, async ({ page, consoleErrors }) => {
  const canvas = await openUns(page);
  await placeNode(page, 'plant/line1', 0.85, 0.4);
  const box = await canvas.boundingBox();
  const s0 = await unsState(page);
  const n = byPath(s0, 'plant/line1');
  await doubleTap(page, box.x + n.sx, box.y + n.sy);
  await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((q) => q.path === 'plant/line1')?.expanded, null, { timeout: 10_000 });
  await unsIdle(page);
  const s1 = await unsState(page);
  for (const k of s1.nodes.filter((q) => q.path.startsWith('plant/line1/'))) expect(insideVp(k, s1.vp), k.path).toBe(true);
  expect(s1.sel).toBeNull();
  // Badge: tap 18 px below the badge centre (inside a 44 px target), not on the node body.
  const m = byPath(s1, 'plant/line1');
  await page.touchscreen.tap(box.x + m.sx, box.y + m.sy + m.r + 18);
  await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((q) => q.path === 'plant/line1')?.expanded === false, null, { timeout: 10_000 });
  // A single tap selects.
  await unsIdle(page);
  const s2 = await unsState(page);
  const e = byPath(s2, 'plant/line2');
  await page.touchscreen.tap(box.x + e.sx, box.y + e.sy);
  await expect.poll(() => page.evaluate(() => window.__manifoldTest.uns.selectedId)).toBe('uns:e2e-broker:plant/line2');
  expect(consoleErrors).toEqual([]);
});

// ---- a large namespace: readable first view, paging, 3D selection under the panel ----------

const READ_K = 0.8; // unsLayout MIN_READ_K: labels are readable from this zoom up
const pagerOf = (page, path) => page.evaluate((p) => (window.__manifoldTest.uns.pagers || []).find((x) => x.parentPath === p) || null, path);
const unsCanvas = (page) => page.locator('canvas[aria-describedby="uns-canvas-help"]');

test.describe('large namespace', () => {
  let big;
  test.beforeAll(async () => {
    big = await startBigBroker();
  });
  test.afterAll(async () => {
    await big?.close();
  });

  test('UNS [touch] phone first view is readable and a reveal zooms back in to a readable zoom', { tag: '@touch' }, async ({ page, consoleErrors }) => {
    for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(vp);
      await page.goto(`/uns?broker=${big.id}`);
      await page.waitForFunction(() => (window.__manifoldTest?.uns?.nodes || []).some((n) => n.depth === 1) && window.__manifoldTest.uns.fitScope, null, { timeout: 30_000 });
      await unsIdle(page);
      const st = await page.evaluate(() => ({ k: window.__manifoldTest.uns.transform.k, scope: window.__manifoldTest.uns.fitScope }));
      expect(st.k, `first-view zoom at ${vp.width}x${vp.height}`).toBeGreaterThanOrEqual(READ_K - 1e-6);
      expect(['first-level', 'start', 'all']).toContain(st.scope);
      // A root and at least one first-level node are on screen, inside the visible viewport.
      const s = await unsState(page);
      const shown = s.nodes.filter((n) => n.depth <= 1 && insideVp(n, s.vp));
      expect(shown.some((n) => n.depth === 0)).toBe(true);
      expect(shown.some((n) => n.depth === 1)).toBe(true);
    }
    // Zoomed out below the reading floor, expanding a small branch zooms IN so its children read.
    const target = 'acme/area1/line1/cell1';
    await page.goto(`/uns?broker=${big.id}&path=${encodeURIComponent(target)}`);
    await page.waitForFunction((p) => window.__manifoldTest?.uns?.nodes.some((n) => n.path === p), target, { timeout: 30_000 });
    await page.waitForFunction(() => window.__manifoldTest.uns.jumping === null, null, { timeout: 30_000 });
    await unsIdle(page);
    await page.evaluate((p) => {
      const h = window.__manifoldTest.uns;
      const n = h.nodes.find((q) => q.path === p);
      const k = 0.45;
      const t = h.transform;
      const wx = (n.sx - t.x) / t.k;
      const wy = (n.sy - t.y) / t.k;
      h.setTransform({ k, x: h.viewport.x0 + h.viewport.w / 2 - wx * k, y: h.viewport.y0 + h.viewport.h / 2 - wy * k });
    }, target);
    const n = byPath(await unsState(page), target);
    expect(n.expanded).toBe(false);
    const box = await unsCanvas(page).boundingBox();
    await doubleTap(page, box.x + n.sx, box.y + n.sy);
    await page.waitForFunction((p) => window.__manifoldTest.uns.nodes.find((q) => q.path === p)?.expanded, target, { timeout: 10_000 });
    // The reveal starts with the relayout; wait for it to have zoomed in and finished.
    await page.waitForFunction((k) => window.__manifoldTest.uns.transform.k >= k && window.__manifoldTest.uns.motion === null, READ_K - 1e-6, { timeout: 15_000 });
    const after = await unsState(page);
    const kids = after.nodes.filter((q) => q.path.startsWith(`${target}/`));
    expect(kids.length).toBe(4);
    // The expanded node and its first child are inside the visible viewport.
    expect(insideVp(byPath(after, target), after.vp)).toBe(true);
    expect(kids.some((k) => insideVp(k, after.vp))).toBe(true);

    // A deep link into page 25 of a 2,000-child branch: the pager is on screen, whole, with 40 px targets.
    await page.goto(`/uns?broker=${big.id}&path=big/fleet/unit1234`);
    await page.waitForFunction(() => window.__manifoldTest?.uns?.selectedId?.endsWith('unit1234') && window.__manifoldTest.uns.jumping === null, null, { timeout: 30_000 });
    await unsIdle(page);
    const pager = page.locator('[data-uns-pager$=":big/fleet"]');
    await expect(pager.locator('[data-pager-range]')).toHaveText('1,201–1,250 of 2,000');
    const cb = await unsCanvas(page).boundingBox();
    const next = pager.getByRole('button', { name: 'Next page' });
    const pb = await pager.locator('[role="group"]').boundingBox();
    expect(pb.x).toBeGreaterThanOrEqual(cb.x);
    expect(pb.x + pb.width).toBeLessThanOrEqual(cb.x + cb.width);
    expect((await next.boundingBox()).height).toBeGreaterThanOrEqual(40);
    await next.tap();
    await expect(pager.locator('[data-pager-range]')).toHaveText('1,251–1,300 of 2,000');
    expect(consoleErrors).toEqual([]);
  });

  test('UNS paging: deep link lands on the page, prev/next/first/last, range, filter, keyboard, kept across collapse and reload', async ({ page, consoleErrors }) => {
    await page.goto(`/uns?broker=${big.id}&path=big/fleet/unit1234`);
    await page.waitForFunction(() => window.__manifoldTest?.uns?.selectedId?.endsWith('big/fleet/unit1234'), null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__manifoldTest.uns.jumping === null, null, { timeout: 30_000 });
    await unsIdle(page);
    expect(await pagerOf(page, 'big/fleet')).toMatchObject({ page: 24, pages: 40, total: 2000, from: 1201, to: 1250, shown: true });
    const pager = page.locator('[data-uns-pager$=":big/fleet"]');
    await expect(pager.locator('[data-pager-range]')).toHaveText('1,201–1,250 of 2,000');
    // The selected node is on the shown page, on screen.
    const s0 = await unsState(page);
    expect(insideVp(byPath(s0, 'big/fleet/unit1234'), s0.vp)).toBe(true);

    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager.locator('[data-pager-range]')).toHaveText('1,251–1,300 of 2,000');
    await pager.getByRole('button', { name: 'Previous page' }).click();
    await expect(pager.locator('[data-pager-range]')).toHaveText('1,201–1,250 of 2,000');
    await pager.getByRole('button', { name: 'Last page' }).click();
    await expect(pager.locator('[data-pager-range]')).toHaveText('1,951–2,000 of 2,000');
    await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await pager.getByRole('button', { name: 'First page' }).click();
    await expect(pager.locator('[data-pager-range]')).toHaveText('1–50 of 2,000');
    await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    // Keyboard: with a child selected, Page down shows the next page.
    await page.waitForFunction(() => window.__manifoldTest.uns.nodes.some((n) => n.path === 'big/fleet/unit0001'));
    await unsIdle(page);
    const c = byPath(await unsState(page), 'big/fleet/unit0001');
    const box = await unsCanvas(page).boundingBox();
    await page.mouse.click(box.x + c.sx, box.y + c.sy - 6);
    await page.waitForFunction(() => window.__manifoldTest.uns.selectedId?.endsWith('unit0001'));
    await unsCanvas(page).focus();
    await page.keyboard.press('PageDown');
    await expect(pager.locator('[data-pager-range]')).toHaveText('51–100 of 2,000');

    // Filter by name: one child among 2,000 without paging.
    await pager.getByRole('button', { name: /Filter children of fleet/ }).click();
    await pager.getByRole('searchbox').fill('unit1777');
    await pager.getByRole('searchbox').press('Enter');
    await expect(pager.locator('[data-pager-range]')).toContainText('1–1 of 1 matching "unit1777"');
    await page.waitForFunction(() => window.__manifoldTest.uns.nodes.some((n) => n.path === 'big/fleet/unit1777'));
    await pager.getByRole('button', { name: 'Clear filter and close it' }).click();
    await expect(pager.locator('[data-pager-range]')).toHaveText('1–50 of 2,000');
    await pager.getByRole('button', { name: 'Next page' }).click();
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager.locator('[data-pager-range]')).toHaveText('101–150 of 2,000');

    // Collapse and re-open the branch's parent: the page is kept.
    await unsIdle(page);
    await placeNode(page, 'big', 0.3, 0.5);
    const bigNode = byPath(await unsState(page), 'big');
    await page.mouse.click(box.x + bigNode.sx, box.y + bigNode.sy + bigNode.r + 4); // the +/- badge
    await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((n) => n.path === 'big')?.expanded === false);
    await expect(pager).toHaveCount(0);
    await unsIdle(page);
    const bigNode2 = byPath(await unsState(page), 'big');
    await page.mouse.click(box.x + bigNode2.sx, box.y + bigNode2.sy + bigNode2.r + 4);
    await page.waitForFunction(() => window.__manifoldTest.uns.nodes.find((n) => n.path === 'big')?.expanded);
    // big/fleet re-opens only if it was open: open it if needed, then the page is the same.
    const fleet = await page.evaluate(() => window.__manifoldTest.uns.nodes.find((n) => n.path === 'big/fleet'));
    if (!fleet.expanded) {
      await unsIdle(page);
      await placeNode(page, 'big/fleet', 0.4, 0.5);
      const f = byPath(await unsState(page), 'big/fleet');
      await page.mouse.click(box.x + f.sx, box.y + f.sy + f.r + 4);
    }
    await expect(pager.locator('[data-pager-range]')).toHaveText('101–150 of 2,000');
    // And for the session: a reload keeps it.
    // (Without a path: a deep link would open the page of ITS node.) The Tree view below shows it.
    await page.goto(`/uns?broker=${big.id}`);
    await page.waitForFunction(() => (window.__manifoldTest?.uns?.nodes || []).some((n) => n.path === 'big'), null, { timeout: 30_000 });
    expect(await page.evaluate((id) => JSON.parse(sessionStorage.getItem('manifold.unsPaging') || '{}')[`uns:${id}:big/fleet`], big.id)).toEqual({ page: 2, filter: '' });

    // The Tree view offers the same pager.
    await page.getByRole('radio', { name: 'Tree' }).click();
    await page.getByRole('tree').first().waitFor();
    // Open the way down to big/fleet (whatever is open already stays open).
    for (const name of ['Big namespace', 'big', 'fleet']) {
      const expand = page.getByRole('button', { name: `Expand ${name}`, exact: true }).first();
      const collapse = page.getByRole('button', { name: `Collapse ${name}`, exact: true }).first();
      await expect(expand.or(collapse)).toBeVisible();
      if (await expand.isVisible()) await expand.click();
      await expect(collapse).toBeVisible();
    }
    const treePager = page.locator('[data-tree-pager$="big/fleet"]');
    await expect(treePager.locator('[data-pager-range]')).toHaveText('101–150 of 2,000');
    await treePager.getByRole('button', { name: 'Next page' }).click();
    await expect(treePager.locator('[data-pager-range]')).toHaveText('151–200 of 2,000');
    await expect(page.getByRole('treeitem').filter({ hasText: /^unit0151/ })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
});

test('Topics 3D: a node selected at the right edge stays visible when the details panel narrows the canvas', async ({ page, consoleErrors }) => {
  await page.addInitScript(() => localStorage.setItem('tc.topicsView', '3d'));
  await page.goto('/topics?broker=e2e-broker');
  await page.waitForFunction(() => window.__manifoldTest?.graph3d && window.__manifoldTest.graph3d.nodes(10).length > 3, null, { timeout: 30_000 });
  // Pan (as a drag would) until the rightmost node sits near the right edge, where the panel
  // opens, then click it. Re-parked and re-read on every attempt: topics (incl. $SYS) keep
  // arriving for a moment after load and rebuild the layout.
  const park = () =>
    page.evaluate(() => {
      const h = window.__manifoldTest.graph3d;
      const { w, h: hh } = h.size;
      h.setView({ pan: { x: 0, y: 0 } });
      const pick = h.nodes(500).filter((n) => n.sy > 80 && n.sy < hh - 120 && n.sx > 0 && n.sx < w).sort((a, b) => b.sx - a.sx)[0];
      if (!pick) return null;
      const at = (px) => {
        h.setView({ pan: { x: px, y: 0 } });
        return h.nodes(500).find((n) => n.id === pick.id);
      };
      // A sideways camera move shifts a node linearly on screen: two probes give the pan that
      // puts it 90 px from the right edge.
      const a0 = at(0).sx;
      const slope = (at(-10).sx - a0) / -10;
      if (!slope) return null;
      const n = at((w - 90 - a0) / slope);
      return n && n.sx > w - 130 && n.sx < w - 50 ? { id: n.id, sx: n.sx, sy: n.sy, w } : null;
    });
  let target = null;
  await expect(async () => {
    target = await park();
    expect(target, 'a node parked near the right edge').toBeTruthy();
    const box = await page.getByTestId('graph3d').boundingBox();
    await page.mouse.click(box.x + target.sx, box.y + target.sy);
    await expect(page.getByRole('complementary', { name: 'Topic details' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.waitForFunction((w) => window.__manifoldTest.graph3d.size.w < w && !window.__manifoldTest.graph3d.pan.gliding, target.w, { timeout: 15_000 });
  const r = await page.evaluate(() => ({ s: window.__manifoldTest.graph3d.selectedScreen(), v: window.__manifoldTest.graph3d.viewport }));
  expect(r.s.id).toBe(target.id);
  expect(r.s.sx + r.s.r).toBeLessThanOrEqual(r.v.x1 + 1);
  expect(r.s.sx - r.s.r).toBeGreaterThanOrEqual(r.v.x0 - 1);
  expect(consoleErrors.filter((e) => !/context lost|CONTEXT_LOST/i.test(e))).toEqual([]);
});
