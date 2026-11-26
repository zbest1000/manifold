import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { api, publisher, startBigBroker, unique } from './support.js';

/**
 * Payload codecs, the Trends CSV export, and the UNS / Topics search-and-pick and Expand all,
 * against the real backend and the e2e broker.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('manifold.e2e', '1'));
});

const PROTO = 'syntax = "proto3";\npackage plant;\nmessage Pump {\n  double temp = 1;\n  int32 rpm = 2;\n  string state = 3;\n}\n';
// Pump { temp: 21.5, rpm: 1450, state: "run" }
const PUMP_BYTES = Buffer.from('09000000000080354010aa0b1a0372756e', 'hex');
// CBOR { "temp": 22, "unit": "C" } (half float 22.0)
const CBOR_BYTES = Buffer.from('a26474656d70f94d8064756e69746143', 'hex');

async function topicOf(topic) {
  const r = await api.get('/api/mqtt/brokers/e2e-broker/topics?limit=100000');
  return (r.json?.topics || []).find((t) => t.topic === topic) || null;
}

async function waitTopic(topic, pred) {
  for (let i = 0; i < 100; i++) {
    const t = await topicOf(topic);
    if (t && pred(t)) return t;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`topic ${topic} never matched`);
}

test.describe('payload codecs', () => {
  const created = [];
  test.afterAll(async () => {
    for (const id of created) await api.del(`/api/codecs/${id}`).catch(() => {});
  });

  test('a Protobuf binding made in the UI decodes on ingest; the topic names the codec; counters count', async ({ page, consoleErrors }) => {
    const base = unique('codec');
    const topic = `e2e/${base}/pump1`;
    await page.goto('/pipelines?tab=codecs');
    await page.getByRole('button', { name: /Add a codec binding/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a codec binding' });
    await dialog.getByLabel('Name').fill(`Pumps ${base}`);
    await dialog.getByLabel('Topic filter').fill(`e2e/${base}/+`);
    await dialog.getByLabel('Codec').selectOption('protobuf');
    // A broken schema is refused with the parser's message, and nothing is saved.
    await dialog.getByLabel('Schema (.proto)').fill('syntax = "proto3";\nmessage Pump {\n  double temp = \n}');
    await dialog.getByRole('button', { name: 'Save binding' }).click();
    await expect(dialog.getByTestId('codec-save-error')).toContainText(/does not parse.*line/i);
    await dialog.getByLabel('Schema (.proto)').fill(PROTO);
    // Try it before saving: the unsaved schema decodes a pasted payload.
    await dialog.getByTestId('codec-try-payload').fill(PUMP_BYTES.toString('hex'));
    await dialog.getByRole('button', { name: 'Decode' }).click();
    await expect(dialog.getByTestId('codec-test-output')).toContainText('"rpm": 1450');
    await dialog.getByRole('button', { name: 'Save binding' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: `Pumps ${base}` });
    await expect(row).toContainText('Protobuf');
    await expect(row).toContainText('plant.Pump');
    const list = await api.get('/api/codecs');
    const binding = list.json.codecs.find((c) => c.name === `Pumps ${base}`);
    created.push(binding.id);

    const pub = await publisher();
    await pub.publish(topic, PUMP_BYTES);
    await pub.close();
    const t = await waitTopic(topic, (x) => x.payload && typeof x.payload === 'object');
    expect(t.payload).toEqual({ temp: 21.5, rpm: 1450, state: 'run' });
    expect(t.codec).toMatchObject({ name: 'protobuf', bindingId: binding.id });
    await expect(row.getByTestId('codec-decoded')).not.toHaveText('0', { timeout: 15_000 });
    await expect(row).toContainText('Decoding');

    // The topic detail says which codec decoded it.
    await page.goto(`/topics?broker=e2e-broker&topic=${encodeURIComponent(topic)}`);
    await expect(page.getByTestId('topic-codec')).toHaveText(`Decoded by Protobuf (binding Pumps ${base})`);
    // The only failed request is the deliberate save of the broken schema.
    expect(consoleErrors.filter((e) => !/status of 400/.test(e))).toEqual([]);
    expect(consoleErrors.filter((e) => /status of 400/.test(e))).toHaveLength(1);
  });

  test('binary CBOR without a binding is auto-detected; text and undecodable binary are left alone', async () => {
    const base = unique('auto');
    const pub = await publisher();
    await pub.publish(`e2e/${base}/cbor`, CBOR_BYTES);
    await pub.publish(`e2e/${base}/text`, 'a1 64 not cbor');
    await pub.publish(`e2e/${base}/junk`, Buffer.from('fffe00019c', 'hex'));
    await pub.close();
    const c = await waitTopic(`e2e/${base}/cbor`, (x) => x.codec);
    expect(c.payload).toEqual({ temp: 22, unit: 'C' });
    expect(c.codec).toEqual({ name: 'cbor', auto: true });
    const text = await waitTopic(`e2e/${base}/text`, () => true);
    expect(text.payload).toBe('a1 64 not cbor');
    expect(text.codec).toBeUndefined();
    const junk = await waitTopic(`e2e/${base}/junk`, () => true);
    expect(junk.lastPayloadFormat).toBe('binary');
    expect(junk.payload).toBe(Buffer.from('fffe00019c', 'hex').toString('base64'));
  });

  test('the test box decodes hex with auto-detection and reports a failure', async ({ page }) => {
    await page.goto('/pipelines?tab=codecs');
    const box = page.getByRole('region', { name: 'Test a payload' });
    await box.getByTestId('codec-test-payload').fill(CBOR_BYTES.toString('hex').replace(/(..)/g, '$1 '));
    await box.getByRole('button', { name: 'Decode' }).click();
    await expect(box.getByTestId('codec-test-output')).toContainText('"temp": 22');
    await expect(box).toContainText('Decoded as CBOR (16 bytes)');
    await box.getByLabel('Decode with').selectOption('msgpack');
    await box.getByTestId('codec-test-payload').fill('c1');
    await box.getByRole('button', { name: 'Decode' }).click();
    await expect(box.getByTestId('codec-test-error')).toContainText('never used');
  });
});

test.describe('Trends CSV export', () => {
  let recId;
  let topic;
  test.beforeAll(async () => {
    topic = `e2e/${unique('csv')}/temp`;
    const res = await api.post('/api/recorder', { name: `CSV ${topic}`, brokerId: 'e2e-broker', filter: topic, target: { type: 'file' } });
    recId = res.json.id;
    const pub = await publisher();
    for (let i = 0; i < 6; i++) {
      await pub.publish(topic, i === 3 ? { v: null, q: 0, u: 'C' } : { v: 20 + i, q: 192, u: 'C' });
      await new Promise((resolve) => setTimeout(resolve, 250)); // one per flush: the tap coalesces per 100 ms
    }
    await pub.close();
    for (let i = 0; i < 100; i++) {
      const r = await api.get(`/api/recorder/${recId}/data?limit=1`);
      if ((r.json?.total || 0) >= 6) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  test.afterAll(async () => {
    if (recId) await api.del(`/api/recorder/${recId}`).catch(() => {});
  });

  test('downloads the shown series raw and bucketed, stating which, with units, quality and gaps', async ({ page }) => {
    await page.goto('/trends');
    await page.getByRole('radio', { name: 'Recording' }).click();
    await page.locator('select').first().selectOption(recId);
    const input = page.getByPlaceholder(/Search topics|Type the tag/);
    await input.fill(topic);
    await input.press('Enter');
    await page.waitForFunction(() => (window.__manifoldTest?.trendChart?.series || []).length === 1, null, { timeout: 30_000 });

    await page.getByRole('combobox', { name: 'CSV values' }).selectOption('raw');
    const [raw] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(raw.suggestedFilename()).toMatch(/^manifold-trends-raw-\d{8}T\d{6}Z-\d{8}T\d{6}Z\.csv$/);
    const rawText = fs.readFileSync(await raw.path(), 'utf8');
    expect(rawText).toMatch(/^# Manifold Trends export\n# Source: recording "CSV /);
    expect(rawText).toContain('# Values: raw samples');
    const rows = rawText.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(rows[0]).toBe(`time,${topic} (C),${topic} quality`);
    expect(rows).toHaveLength(7);
    for (const r of rows.slice(1)) expect(r).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,/);
    expect(rows.filter((r) => r.endsWith(',,0'))).toHaveLength(1); // the Bad sample: a gap with its quality
    expect(rows[1]).toMatch(/,20,192$/);

    await page.getByRole('combobox', { name: 'CSV values' }).selectOption('bucketed');
    const [bucketed] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(bucketed.suggestedFilename()).toMatch(/^manifold-trends-bucketed-/);
    expect(fs.readFileSync(await bucketed.path(), 'utf8')).toContain('# Values: bucketed as charted');
  });
});

test.describe('UNS and Topics: search and pick, Expand all', () => {
  let big;
  test.beforeAll(async () => {
    big = await startBigBroker({ id: 'e2e-big-search' });
  });
  test.afterAll(async () => {
    await big?.close();
  });

  const unsNodes = (page) => page.evaluate(() => window.__manifoldTest.uns.nodes.map((n) => ({ path: n.path, sx: n.sx, sy: n.sy, pager: n.pager })));

  test('Expand all opens the big namespace within the cap and stays responsive; Collapse all closes it', async ({ page, consoleErrors }) => {
    await page.goto(`/uns?broker=${big.id}`);
    await page.waitForFunction(() => (window.__manifoldTest?.uns?.nodes || []).length > 3, null, { timeout: 30_000 });
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Expand all' }).click();
    await page.waitForFunction(() => window.__manifoldTest.uns.nodes.some((n) => n.path === 'acme/area3/line5/cell5/temperature'), null, { timeout: 15_000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    const nodes = await unsNodes(page);
    expect(nodes.length).toBeGreaterThan(400);
    expect(nodes.length).toBeLessThanOrEqual(2500);
    expect(nodes.filter((n) => n.path.startsWith('big/fleet/unit'))).toHaveLength(50); // one page of the long branch
    await expect(page.getByTestId('uns-bulk-note')).toContainText(/Expanded all \d+ branches/);
    // Still painting and answering input after the expansion.
    const frames0 = await page.evaluate(() => window.__manifoldTest.uns.frames);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForFunction((f) => window.__manifoldTest.uns.frames > f, frames0, { timeout: 5000 });
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await page.waitForFunction(() => !window.__manifoldTest.uns.nodes.some((n) => n.path.startsWith('acme/area1/')), null, { timeout: 10_000 });
    await expect(page.getByTestId('uns-bulk-note')).toContainText('Collapsed every branch');
    expect(consoleErrors).toEqual([]);
  });

  test('UNS search: arrows and Enter pick a node on a later page, which is selected and revealed; Escape closes then clears', async ({ page, consoleErrors }) => {
    await page.goto(`/uns?broker=${big.id}`);
    await page.waitForFunction(() => (window.__manifoldTest?.uns?.nodes || []).length > 3, null, { timeout: 30_000 });
    const box = page.getByRole('combobox', { name: 'Find a node in the namespace' });
    await box.fill('unit177');
    const list = page.getByRole('listbox', { name: /Find a node in the namespace: results/ });
    await expect(list.getByRole('option')).toHaveCount(10); // unit1770..unit1779
    await expect(page.getByTestId('uns-search').getByRole('status')).toHaveText('10 matches');
    await box.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', /opt-0$/);
    await box.press('ArrowDown');
    await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    const label = await list.getByRole('option').nth(1).locator('span').first().textContent();
    await box.press('Enter');
    await expect(list).toBeHidden();
    await page.waitForFunction((name) => window.__manifoldTest.uns.selectedId?.endsWith(`big/fleet/${name}`), label, { timeout: 15_000 });
    await expect(page.getByTestId('uns-search').getByRole('status')).toHaveText(`Selected big/fleet/${label}`);
    // Revealed: on the map, inside the visible viewport.
    await page.waitForFunction(
      (name) => {
        const u = window.__manifoldTest.uns;
        const n = u.nodes.find((x) => x.path === `big/fleet/${name}`);
        const v = u.viewport;
        return n && n.sx >= v.x0 && n.sx <= v.x1 && n.sy >= v.y0 && n.sy <= v.y1;
      },
      label,
      { timeout: 15_000 }
    );
    await expect(page).toHaveURL(new RegExp(`path=big%2Ffleet%2F${label}`));
    // Escape: first closes the list, then clears the box.
    await box.fill('cell');
    await expect(list).toBeVisible();
    await box.press('Escape');
    await expect(list).toBeHidden();
    await expect(box).toHaveValue('cell');
    await box.press('Escape');
    await expect(box).toHaveValue('');
    // An MQTT filter works too.
    await box.fill('acme/+/line1/cell1/power');
    await expect(list.getByRole('option')).toHaveCount(3);
    expect(consoleErrors).toEqual([]);
  });

  test('Topics graph search: picking a result selects the topic and opens its details', async ({ page, consoleErrors }) => {
    await page.goto(`/topics?broker=${big.id}`);
    await page.getByRole('radio', { name: 'Graph' }).click();
    const box = page.getByRole('combobox', { name: 'Search nodes' });
    await box.fill('cell3');
    const list = page.getByRole('listbox', { name: /Search nodes: results/ });
    await expect(list.getByRole('option').first()).toBeVisible();
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(page).toHaveURL(/topic=acme%2Farea\d%2Fline\d%2Fcell3/);
    await expect(list).toBeHidden();
    expect(consoleErrors).toEqual([]);
  });
});

test.describe('accessibility of the new controls, both themes', () => {
  for (const theme of ['dark', 'light']) {
    test(`codec dialog, test output and the UNS results list have no serious axe findings (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('tc.theme', t), theme);
      const scan = async () => {
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
        return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(' | ')}`);
      };
      await page.goto('/pipelines?tab=codecs');
      await page.getByRole('button', { name: /Add a codec binding/ }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Add a codec binding' });
      await dialog.getByLabel('Codec').selectOption('protobuf');
      await dialog.getByTestId('codec-try-payload').fill('08 96 01');
      await dialog.getByRole('button', { name: 'Decode' }).click();
      await expect(dialog.getByTestId('codec-test-error')).toBeVisible();
      expect(await scan()).toEqual([]);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      const box = page.getByRole('region', { name: 'Test a payload' });
      await box.getByTestId('codec-test-payload').fill(CBOR_BYTES.toString('hex'));
      await box.getByRole('button', { name: 'Decode' }).click();
      await expect(box.getByTestId('codec-test-output')).toBeVisible();
      expect(await scan()).toEqual([]);

      await page.goto('/uns');
      const search = page.getByRole('combobox', { name: 'Find a node in the namespace' });
      await search.fill('e2e');
      await search.press('ArrowDown');
      await expect(page.getByRole('listbox', { name: /results/ })).toBeVisible();
      expect(await scan()).toEqual([]);
    });
  }
});
