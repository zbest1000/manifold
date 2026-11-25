import { test, expect } from './fixtures.js';
import { createQualityRecording, startBigBroker } from './support.js';

/**
 * Units and quality end to end (recorder file -> read API -> Trends chart), the
 * Topics "showing the tree" note with its per-broker memory, and the Health
 * page's one name. The chart exposes read-only state on window.__manifoldTest.trendChart.
 */
let big;
let rec;
test.beforeAll(async () => {
  big = await startBigBroker({ id: 'e2e-big-trends', branchSize: 200 });
  rec = await createQualityRecording(big);
});
test.afterAll(async () => {
  await rec?.remove();
  await big?.close();
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('manifold.e2e', '1'));
});

test('recording series carry units and quality; the API says so and downsampling follows the bucket rules', async ({ request }) => {
  const q = (mp) => request.get(`/api/recorder/${rec.id}/series?tags=${rec.tags.map(encodeURIComponent).join(',')}&maxPoints=${mp}`).then((r) => r.json());
  const raw = await q(5000);
  expect(raw.meta.quality).toBe('stored');
  const [temp, press] = rec.tags.map((t) => raw.series.find((s) => s.tag === t));
  expect(temp.unit).toBe('C');
  expect(press.unit).toBe('bar');
  expect(temp.points).toHaveLength(1500);
  expect(temp.points.filter((p) => p[1] === null && p[2] === 0)).toHaveLength(30 + 15); // the run + every 97th (one inside the run)
  expect(press.points.every((p) => p[2] === 192 && Number.isFinite(p[1]))).toBe(true);
  const down = await q(500);
  const t2 = down.series.find((s) => s.tag === rec.tags[0]);
  expect(t2.points.length).toBeLessThanOrEqual(500);
  const partial = t2.points.filter((p) => p[3] === 1);
  expect(partial.length).toBeGreaterThan(5);
  for (const p of partial) {
    expect(p[2]).toBe(0); // worst quality in the bucket
    expect(p[1]).toBeLessThan(30); // the Bad 999s are never averaged in
  }
  expect(t2.points.some((p) => p[1] === null)).toBe(true); // Bad-only buckets: gaps
});

test('Trends: units on two axes, Bad samples as gaps with markers, partial buckets marked, the readout says so', async ({ page, consoleErrors }) => {
  await page.goto('/trends');
  await page.getByRole('radio', { name: 'Recording' }).click();
  await page.locator('select').first().selectOption(rec.id);
  const input = page.getByPlaceholder(/Search topics|Type the tag/);
  for (const t of rec.tags) {
    await input.fill(t);
    await input.press('Enter');
  }
  await page.waitForFunction(() => window.__manifoldTest?.trendChart?.series.length === 2 && window.__manifoldTest.trendChart.markers().length > 0, null, { timeout: 30_000 });
  const hook = await page.evaluate(() => ({ axes: window.__manifoldTest.trendChart.axes, series: window.__manifoldTest.trendChart.series, markers: window.__manifoldTest.trendChart.markers() }));
  expect(hook.axes.map((a) => a.label)).toEqual([expect.stringMatching(/^Time/), 'C', 'bar']);
  expect(hook.series.map((s) => s.scale)).toEqual(['y', 'y2']);
  expect(hook.series[0].label).toMatch(/Temperature \(C\)$/);
  const bad = hook.markers.filter((m) => m.kind === 'bad');
  const partial = hook.markers.filter((m) => m.kind === 'partial');
  expect(bad.length).toBeGreaterThan(0);
  expect(partial.length).toBeGreaterThan(0);
  expect(bad.every((m) => m.series === 0 && m.value === null)).toBe(true);
  const read = await page.evaluate(([b, p]) => ({ bad: window.__manifoldTest.trendChart.readout(0, b), partial: window.__manifoldTest.trendChart.readout(0, p), gap: window.__manifoldTest.trendChart.plotted(0, b) }), [bad[0].idx, partial[0].idx]);
  expect(read.gap).toBeNull();
  expect(read.bad).toBe('Bad quality: no value');
  expect(read.partial).toMatch(/ C · partial \(some samples Bad\)$/);
  await expect(page.getByTestId('quality-key')).toContainText('Bad quality');
  await expect(page.getByTestId('quality-key')).toContainText('Partial');
  await expect(page.getByRole('list', { name: 'Series' })).toContainText('C · left axis');
  await expect(page.getByRole('list', { name: 'Series' })).toContainText('bar · right axis');
  // Normalize: one axis in % of range; the readout keeps the real value and unit.
  await page.getByText('Normalize', { exact: true }).click();
  await page.waitForFunction(() => window.__manifoldTest.trendChart.axes.length === 2 && window.__manifoldTest.trendChart.axes[1].label === '% of range');
  const p0 = await page.evaluate(() => window.__manifoldTest.trendChart.readout(1, 5));
  expect(p0).toMatch(/ bar \(\d+(\.\d+)? %\)$/);
  expect(consoleErrors).toEqual([]);
});

test('Topics opens in Tree above 200 topics with a dismissible note, and remembers an explicit choice per broker', async ({ page, consoleErrors }) => {
  await page.goto(`/topics?broker=${big.id}`);
  const note = page.getByTestId('tree-default-note');
  await expect(note).toContainText(/Showing the tree because this broker has [\d,]+ topics/);
  await expect(page.getByRole('radio', { name: 'Tree' })).toBeChecked();
  await note.getByRole('button', { name: 'Switch to Graph' }).click();
  await expect(page.getByRole('radio', { name: 'Graph' })).toBeChecked();
  await expect(note).toHaveCount(0);
  // Remembered for this broker; the small e2e broker keeps its own default (Graph, no note).
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Graph' })).toBeChecked();
  await expect(page.getByTestId('tree-default-note')).toHaveCount(0);
  await page.goto('/topics?broker=e2e-broker');
  await expect(page.getByRole('radio', { name: 'Graph' })).toBeChecked();
  // Dismissing the note (without switching) keeps the tree and hides the note for good.
  await page.evaluate(() => localStorage.removeItem('tc.topicsView.byBroker'));
  await page.goto(`/topics?broker=${big.id}`);
  await page.getByTestId('tree-default-note').getByRole('button', { name: 'Dismiss this note' }).click();
  await expect(page.getByTestId('tree-default-note')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Tree' })).toBeChecked();
  await expect(page.getByTestId('tree-default-note')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test('Health: nav item, heading and document title share one name', async ({ page }) => {
  await page.goto('/system');
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  await expect(page).toHaveTitle('Health · Manifold');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Health' })).toHaveAttribute('aria-current', 'page');
});
