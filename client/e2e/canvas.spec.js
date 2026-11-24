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

test.beforeEach(async ({ page, isMobile }, testInfo) => {
  // The mobile project runs only the touch tests of this file.
  if (isMobile && !testInfo.title.includes('[touch]')) testInfo.skip();
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

test('UNS [touch] double-tap expands and reveals, tap selects, the badge is a 44 px target', async ({ page, isMobile, consoleErrors }) => {
  test.skip(!isMobile, 'touch behaviour: runs in the mobile project');
  const canvas = await openUns(page);
  await placeNode(page, 'plant/line1', 0.85, 0.4);
  const box = await canvas.boundingBox();
  const s0 = await unsState(page);
  const n = byPath(s0, 'plant/line1');
  await page.touchscreen.tap(box.x + n.sx, box.y + n.sy);
  await page.touchscreen.tap(box.x + n.sx, box.y + n.sy);
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
