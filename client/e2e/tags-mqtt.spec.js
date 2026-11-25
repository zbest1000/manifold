import { test, expect } from './fixtures.js';
import { api, unique, subscribe, publisher, cleanup, cleanupRoutes } from './support.js';

const latestOf = (mqtt) => (topic) => mqtt.messages.filter((m) => m.topic === topic).at(-1)?.payload;
const shots = process.env.E2E_SHOTS_DIR;

/** Expand the topic tree down to `path` (folders by name) and select every topic under its last level. */
async function selectFolder(page, path) {
  const tree = page.getByRole('tree');
  const levels = path.split('/');
  for (const [i, level] of levels.entries()) {
    const item = tree.getByRole('treeitem', { name: new RegExp(`^${level}`) }).first();
    await expect(item).toBeVisible();
    if (i < levels.length - 1) {
      if ((await item.getAttribute('aria-expanded')) !== 'true') await item.click();
    } else {
      await item.getByRole('button', { name: /Select all/ }).click();
    }
  }
}

/**
 * An MQTT-topic source is a real mapping: topics picked in the tree get per-topic names below their
 * common prefix (two "temp" topics from different folders stay apart), a value/time/quality
 * envelope is read automatically (unit included), a per-topic field reads a value inside a JSON
 * object, and a silent topic turns Bad once with reason "stale" and Good again on its next message.
 * Everything is asserted at the broker, plus the retained _status and _meta documents.
 */
test('MQTT topics map as a mapping: envelope detection, field path, names by level, staleness, _status and _meta', async ({ page, consoleErrors }) => {
  const root = `e2e-src/${unique('m')}`;
  const bindingName = unique('E2E topics ');
  const asset = `e2e/${unique('site')}/area`;
  const pub = await publisher();
  const mqtt = await subscribe(`${asset}/#`);
  const latest = latestOf(mqtt);
  try {
    await pub.publish(`${root}/l1/temp`, { v: 21.5, t: Date.now(), q: 192, u: 'degC' }, { retain: true });
    await pub.publish(`${root}/l2/temp`, { value: 18, quality: 'good' }, { retain: true });
    await pub.publish(`${root}/l2/count`, { data: { n: 7 }, other: 'x' }, { retain: true });
    await expect.poll(async () => (await api.get(`/api/mqtt/brokers/e2e-broker/topics`)).json?.topics?.filter((t) => String(t.topic ?? t).startsWith(root)).length, { timeout: 15_000 }).toBe(3);

    await page.goto('/tags');
    await page.getByLabel('Source').selectOption({ label: 'E2E broker · topics' });
    await expect(page.getByRole('button', { name: /Create pipeline route/ })).toHaveCount(0);
    await selectFolder(page, root);
    const selected = page.getByRole('list', { name: /Selected topics/ });
    await expect(selected.getByRole('listitem')).toHaveCount(3);
    // identical names from different folders are told apart by their parent level
    await expect(selected.getByRole('listitem').filter({ hasText: '…/l1' })).toHaveCount(1);
    await expect(selected.getByRole('listitem').filter({ hasText: '…/l2' })).toHaveCount(1);
    // a unique name needs no path
    await expect(selected.getByRole('listitem').filter({ hasText: 'count' })).not.toContainText('…/');

    await page.getByRole('button', { name: /Add to UNS \(3\)/ }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('heading', { name: 'Add 3 topics to the UNS' })).toBeVisible();
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);
    await expect(editor.getByLabel(`Published name for ${root}/l1/temp`)).toHaveValue('l1/temp');
    await expect(editor.getByLabel(`Published name for ${root}/l2/count`)).toHaveValue('l2/count');
    // staleness for the whole mapping, a field path for one topic
    await editor.getByLabel('Mark stale after (ms)').first().fill('2000');
    await editor.getByRole('button', { name: `Details of l2/count` }).click();
    await editor.getByRole('region', { name: /Details of l2\/count/ }).getByLabel('Value field').fill('data.n');

    const preview = editor.getByRole('complementary', { name: 'Preview' });
    await expect(preview.getByText('Checked by the server', { exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: 'temp' })).toHaveCount(2);
    if (shots) await page.screenshot({ path: `${shots}/mqtt-source-mapping.png` });
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(bindingName) })).toBeVisible();

    // what arrives on the broker
    await expect.poll(() => latest(`${asset}/l1/temp`), { timeout: 20_000 }).toMatchObject({ v: 21.5, q: 192, u: 'degC' });
    await expect.poll(() => latest(`${asset}/l2/temp`), { timeout: 20_000 }).toMatchObject({ v: 18, q: 192 });
    await expect.poll(() => latest(`${asset}/l2/count`), { timeout: 20_000 }).toMatchObject({ v: 7, q: 192 });
    await expect.poll(() => latest(`${asset}/_status`), { timeout: 20_000 }).toMatchObject({ online: true });
    await expect.poll(() => JSON.stringify(latest(`${asset}/_meta`) || null), { timeout: 20_000 }).toContain(`${root}/l2/count`);
    expect(latest(`${asset}/_meta`).properties['l2/count'].source).toEqual({ brokerId: 'e2e-broker', topic: `${root}/l2/count`, field: 'data.n' });

    // a new message flows through; then silence: Bad once with reason stale; the next message is Good
    await pub.publish(`${root}/l1/temp`, { v: 22, q: 192 });
    await expect.poll(() => latest(`${asset}/l1/temp`)?.v, { timeout: 10_000 }).toBe(22);
    await expect.poll(() => latest(`${asset}/l1/temp`), { message: 'stale after 2 s of silence', timeout: 15_000 }).toMatchObject({ v: 22, q: 0, reason: 'stale' });
    const staleCount = mqtt.messages.filter((m) => m.topic === `${asset}/l1/temp` && m.payload?.reason === 'stale').length;
    await pub.publish(`${root}/l1/temp`, { v: 23, q: 192 });
    await expect.poll(() => latest(`${asset}/l1/temp`), { timeout: 10_000 }).toMatchObject({ v: 23, q: 192 });
    expect(latest(`${asset}/l1/temp`).reason).toBeUndefined();
    expect(staleCount).toBe(1);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [bindingName] });
    for (const t of ['l1/temp', 'l2/temp', 'l2/count']) await pub.publish(`${root}/${t}`, '', { retain: true });
    await pub.close();
    await mqtt.close();
  }
});

/**
 * Loop safety in the editor: a mapping that would publish under the very filter it reads on the
 * same broker is refused by the server's check before saving, with the reason; publishing outside
 * the filter is accepted.
 */
test('a mapping that would read its own output is refused in the editor, with the reason', async ({ page }) => {
  const root = `e2e-loop/${unique('l')}`;
  const bindingName = unique('E2E loop ');
  const pub = await publisher();
  try {
    await pub.publish(`${root}/raw/a`, 1, { retain: true });
    await expect.poll(async () => (await api.get(`/api/mqtt/brokers/e2e-broker/topics`)).json?.topics?.some((t) => String(t.topic ?? t) === `${root}/raw/a`), { timeout: 15_000 }).toBe(true);
    await page.goto('/tags');
    await page.getByLabel('Source').selectOption({ label: 'E2E broker · topics' });
    await page.getByRole('button', { name: 'Map by filter' }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('radio', { name: 'All topics under a filter' })).toHaveAttribute('aria-checked', 'true');
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Topic filter').fill(`${root}/#`);
    await expect(editor.locator('#map-what')).toContainText('1 of 1 topics match');
    await editor.getByLabel('Asset path', { exact: true }).fill(`${root}/uns`);
    const refused = editor.getByRole('alert').filter({ hasText: 'The server would refuse this mapping' });
    await expect(refused).toBeVisible();
    await expect(refused).toContainText('loop');
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor.getByRole('status').filter({ hasText: /problem/ })).toBeVisible();
    await expect(editor).toBeVisible();
    expect((await api.get('/api/tags/bindings')).json.bindings.some((b) => b.name === bindingName)).toBe(false);

    // outside the filter it is fine
    await editor.getByLabel('Asset path', { exact: true }).fill(`e2e/${unique('ok')}/uns`);
    await expect(refused).toBeHidden();
    await expect(editor.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
  } finally {
    await cleanup({ bindings: [bindingName] });
    await pub.publish(`${root}/raw/a`, '', { retain: true });
    await pub.close();
  }
});

/**
 * Routes the old Tags flow created for MQTT topics are offered as mappings: the review shows the
 * route and the equivalent mapping, nothing changes before confirming, and afterwards the route
 * is disabled (and not offered again) while the mapping publishes the same topics.
 */
test('old Tags-page routes: reviewable migration to a mapping, route disabled after confirming', async ({ page }) => {
  const root = `e2e-mig/${unique('r')}`;
  const base = `e2e/${unique('mig')}`;
  const routeName = `tags -> ${base}`;
  const pub = await publisher();
  const mqtt = await subscribe(`${base}/#`);
  try {
    const created = await api.post('/api/pipelines', { name: routeName, source: { brokerId: 'e2e-broker', filter: `${root}/#` }, transforms: [{ type: 'repath', to: `${base}/{3-}` }, { type: 'envelope' }], target: { type: 'mqtt', brokerId: 'e2e-broker', retain: false, qos: 0 } });
    expect(created.ok, created.text).toBe(true);
    await page.goto('/tags?view=mappings');
    const banner = page.getByRole('status').filter({ hasText: /pipeline routes? can become/ });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move topic routes to mappings' });
    const item = dialog.getByRole('listitem').filter({ hasText: routeName });
    await expect(item).toContainText(`${root}/#`);
    await expect(item).toContainText(base);
    await expect(item).toContainText('Adds a retained _status document');
    if (shots) await page.screenshot({ path: `${shots}/migration-review.png` });
    await item.getByRole('button', { name: 'Create mapping' }).click();
    const confirm = page.getByRole('dialog', { name: `Replace route ${routeName}?` });
    await expect(confirm).toContainText('disabled');
    // cancelling changes nothing
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect((await api.get('/api/pipelines')).json.routes.find((r) => r.name === routeName).enabled).not.toBe(false);
    await item.getByRole('button', { name: 'Create mapping' }).click();
    await page.getByRole('dialog', { name: `Replace route ${routeName}?` }).getByRole('button', { name: 'Create mapping, disable route' }).click();
    await expect(item).toContainText('the route was disabled');
    const route = (await api.get('/api/pipelines')).json.routes.find((r) => r.name === routeName);
    expect(route.enabled).toBe(false);
    const mapping = (await api.get('/api/tags/bindings')).json.bindings.find((b) => b.id === route.migratedTo);
    expect(mapping.source).toEqual({ type: 'mqtt', brokerId: 'e2e-broker', tags: 'all', filter: `${root}/#` });
    expect(mapping.target).toMatchObject({ assetPath: base, format: 'envelope' });
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(banner).toBeHidden();

    // the mapping publishes where the route did
    await pub.publish(`${root}/x/y`, 5);
    await expect.poll(() => latestOf(mqtt)(`${base}/x/y`), { timeout: 15_000 }).toMatchObject({ v: 5, q: 192 });
    await cleanup({ bindings: [mapping.name] });
  } finally {
    await cleanupRoutes(base);
    await pub.close();
    await mqtt.close();
  }
});
