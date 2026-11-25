import { test, expect } from './fixtures.js';
import { api, unique, startHistorianStub } from './support.js';

/**
 * Pipelines. The historian here is a STUB (a local HTTP server that accepts the Timebase write
 * endpoint and records the request); no real historian is involved.
 *
 *   - historian create / test write through the UI, store-and-forward and dead-letter visibility
 *   - a route into a historian from a topic carrying a {v,t,q} envelope: the page offers the numeric
 *     transform (and not for a plain topic), and the stored value really is a number
 *   - a historian that routes still write to cannot be removed, and the dialog says what uses it
 *   - recorder pause / resume, contract inference that cannot be locked under a different topic,
 *     the tab living in the URL, malformed topics refused with a message
 */
async function historianViaApi(stub, name) {
  const res = await api.post('/api/historians', { type: 'timebase', name, url: stub.url, dataset: 'E2E set' });
  expect(res.status).toBe(201);
  return res.json.id;
}
const removeAll = async (kind, ids) => {
  for (const id of ids) await api.del(`/api/${kind}/${id}`).catch(() => {});
};

test('add a Timebase historian in the UI, test the write, and see what the stub received', async ({ page }) => {
  const stub = await startHistorianStub();
  const name = unique('Stub historian ');
  let id;
  try {
    await page.goto('/pipelines?tab=historians');
    await page.getByRole('button', { name: /Add a historian|Add historian/ }).first().click();
    const form = page.getByRole('dialog', { name: 'Add historian' });
    // nothing is flagged before the first attempt to save
    await expect(form.getByRole('alert')).toHaveCount(0);
    await form.getByRole('combobox', { name: /^Type/ }).selectOption('timebase');
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByRole('button', { name: 'Add historian' }).click();
    await expect(form.getByRole('alert').filter({ hasText: 'Enter the historian URL' })).toBeVisible();
    await form.getByLabel('URL').fill(stub.url);
    await form.getByLabel(/^Dataset/).fill('E2E set');
    await form.getByRole('button', { name: 'Add historian' }).click();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    id = (await api.get('/api/historians')).json.historians.find((h) => h.name === name).id;

    await row.getByRole('button', { name: `Test write to ${name}` }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Test write succeeded' })).toBeVisible();
    expect(stub.received.at(-1).url).toBe('/api/datasets/E2E%20set/data');
    expect(Object.keys(stub.received.at(-1).body)).toEqual(['manifold/connection-test']);
  } finally {
    if (id) await removeAll('historians', [id]);
    await stub.close();
  }
});

test('a route into a historian from a {v,t,q} topic: the page offers the numeric transform, and a number is stored', async ({ page }) => {
  const stub = await startHistorianStub();
  const hid = await historianViaApi(stub, unique('TVQ historian '));
  const routeName = unique('tvq route ');
  try {
    await page.goto('/pipelines');
    await page.getByRole('button', { name: /Create the first route|New route/ }).click();
    const editor = page.getByRole('dialog', { name: 'New route' });
    await editor.getByLabel('Name', { exact: true }).fill(routeName);
    await editor.getByLabel('Source filter').fill('plant/env/tvq');
    await editor.getByRole('combobox', { name: /^Type/ }).selectOption('historian');
    // the hint appears for the envelope topic ...
    const hint = editor.getByRole('status').filter({ hasText: 'value/time/quality envelope' });
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('stores a JSON object as text');
    // ... not for a plain one
    await editor.getByLabel('Source filter').fill('plant/line1/temperature');
    await expect(hint).toBeHidden();
    await editor.getByLabel('Source filter').fill('plant/env/tvq');
    await expect(hint).toBeVisible();

    await hint.getByRole('button', { name: 'Add numeric transform on v' }).click();
    await expect(hint).toBeHidden(); // done: the offer goes away
    await expect(editor.getByLabel('Transform 2: field (optional)')).toHaveValue('v');

    // the chain can be reordered: the numeric transform moves above the re-path and keeps its value
    await editor.getByRole('button', { name: 'Move transform 2 up' }).click();
    await expect(editor.getByLabel('Transform 1: field (optional)')).toHaveValue('v');
    await editor.getByRole('button', { name: 'Move transform 1 down' }).click();
    await expect(editor.getByLabel('Transform 2: field (optional)')).toHaveValue('v');

    // the dry run shows input and output side by side
    await editor.getByRole('button', { name: 'Run dry run' }).click();
    await expect(editor.getByRole('region', { name: 'Dry-run preview' })).toContainText('plant/env/tvq');

    await editor.getByRole('button', { name: 'Save route' }).click();
    await expect(page.getByRole('row', { name: new RegExp(routeName) })).toBeVisible();

    // what the historian received: the number itself (JSON number, not an object or text)
    await expect.poll(() => stub.received.some((r) => typeof Object.values(r.body)[0]?.[0]?.v === 'number'), { timeout: 30_000 }).toBe(true);
    const point = stub.received.map((r) => Object.values(r.body)[0]?.[0]).find((p) => typeof p?.v === 'number');
    expect(point.v).toBeGreaterThanOrEqual(12.5);
    expect(point.v).toBeLessThanOrEqual(14.5);
  } finally {
    const routes = (await api.get('/api/pipelines')).json.routes.filter((r) => r.name === routeName).map((r) => r.id);
    await removeAll('pipelines', routes);
    await removeAll('historians', [hid]);
    await stub.close();
  }
});

test('a historian that still has a route cannot be removed, the dialog says what uses it, and rejected points are visible', async ({ page }) => {
  const stub = await startHistorianStub();
  stub.fail(400); // a permanent rejection: the points are dead-lettered, not retried forever
  const hname = unique('Busy historian ');
  const hid = (await api.post('/api/historians', { type: 'timebase', name: hname, url: stub.url, dataset: 'E2E set' })).json.id;
  const route = await api.post('/api/pipelines', { name: unique('uses historian '), source: { brokerId: 'e2e-broker', filter: 'plant/line1/#' }, transforms: [{ type: 'numeric', field: 'value' }], target: { type: 'historian', historianId: hid } });
  try {
    await page.goto('/pipelines?tab=historians');
    const row = page.getByRole('row', { name: new RegExp(hname) });
    await expect(row).toBeVisible();
    await expect(row.getByText(/rejected by the historian/)).toBeVisible({ timeout: 40_000 });

    // the dialog names what still writes to it and offers no way to remove it
    await row.getByRole('button', { name: `Delete historian ${hname}` }).click();
    const blocked = page.getByRole('dialog', { name: /is still in use/ });
    await expect(blocked).toContainText('Route "uses historian');
    await expect(blocked.getByRole('button', { name: 'Remove historian' })).toHaveCount(0);
    await blocked.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(row).toBeVisible();

    await api.del(`/api/pipelines/${route.json.id}`);
    await row.getByRole('button', { name: `Delete historian ${hname}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove historian' }).click();
    await expect(row).toBeHidden();
  } finally {
    await removeAll('pipelines', [route.json.id]);
    await removeAll('historians', [hid]);
    await stub.close();
  }
});

test('pick and rename transforms keep what is typed (commas, half-typed pairs)', async ({ page }) => {
  await page.goto('/pipelines');
  await page.getByRole('button', { name: /Create the first route|New route/ }).click();
  const editor = page.getByRole('dialog', { name: 'New route' });
  const chain = editor.getByRole('list', { name: 'Transform chain' });
  const before = (await chain.count()) ? await chain.getByRole('listitem').count() : 0;
  await editor.getByRole('combobox', { name: 'Add a transform' }).selectOption('pick');
  await editor.getByRole('combobox', { name: 'Add a transform' }).selectOption('rename');
  const pick = editor.getByLabel(`Transform ${before + 1}: fields to keep`);
  const rename = editor.getByLabel(`Transform ${before + 2}: rename map`);
  await pick.pressSequentially('temp,unit');
  await expect(pick).toHaveValue('temp,unit');
  await rename.pressSequentially('temp:temperature,u');
  await expect(rename).toHaveValue('temp:temperature,u');
  await rename.blur(); // tidied on blur: the incomplete pair goes
  await expect(rename).toHaveValue('temp:temperature');
  await editor.getByRole('button', { name: 'Cancel' }).click();
});

test('the selected Pipelines tab is part of the URL', async ({ page }) => {
  await page.goto('/pipelines?tab=recorder');
  await expect(page.getByRole('tab', { name: 'Recorder' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'New recording' }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Contracts' }).click();
  await expect(page).toHaveURL(/tab=contracts/);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Contracts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Lock a payload contract' }).first()).toBeVisible();
  // the keyboard moves between tabs and the URL follows
  await page.getByRole('tab', { name: 'Contracts' }).press('Home');
  await expect(page.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/tab=/);
});

test('malformed topics are refused with a message and nothing is saved', async ({ page }) => {
  await page.goto('/pipelines');
  await page.getByRole('button', { name: /Create the first route|New route/ }).click();
  const editor = page.getByRole('dialog', { name: 'New route' });
  // nothing is flagged before the first attempt to save
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await editor.getByLabel('Source filter').fill('plant/#/x');
  const before = (await api.get('/api/pipelines')).json.routes.length;
  await editor.getByRole('button', { name: 'Save route' }).click();
  await expect(editor.getByText(/has a # wildcard that is not the last level/)).toBeVisible();
  expect((await api.get('/api/pipelines')).json.routes.length).toBe(before);
  // the editor still holds what was typed
  await expect(editor.getByLabel('Source filter')).toHaveValue('plant/#/x');
  // an empty filter is explained on the field, only once a save was attempted
  await editor.getByLabel('Source filter').fill('');
  await editor.getByRole('button', { name: 'Save route' }).click();
  await expect(editor.getByRole('alert').filter({ hasText: 'Enter the topic filter' })).toBeVisible();
});

test('recorder: pause keeps what was captured, resume continues', async ({ page }) => {
  const name = unique('rec ');
  let id;
  try {
    await page.goto('/pipelines?tab=recorder');
    await page.getByRole('button', { name: 'New recording' }).first().click();
    const form = page.getByRole('dialog', { name: 'New recording' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel(/^Filter/).fill('plant/line1/#');
    await form.getByRole('button', { name: 'Start recording' }).click();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    id = (await api.get('/api/recorder')).json.recordings.find((r) => r.name === name).id;
    await expect(row.getByText('Recording', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: `Pause recording ${name}` }).click();
    await expect(row.getByText('Paused', { exact: true })).toBeVisible();
    expect((await api.get('/api/recorder')).json.recordings.find((r) => r.id === id).enabled).toBe(false);
    await row.getByRole('button', { name: `Resume recording ${name}` }).click();
    await expect(row.getByText('Recording', { exact: true })).toBeVisible();
    expect((await api.get('/api/recorder')).json.recordings.find((r) => r.id === id).enabled).toBe(true);
  } finally {
    if (id) await removeAll('recorder', [id]);
  }
});

test('contracts: an inferred schema belongs to the topic it was inferred from', async ({ page }) => {
  await page.goto('/pipelines?tab=contracts');
  await page.getByRole('button', { name: 'Lock a payload contract' }).first().click();
  const form = page.getByRole('dialog', { name: 'Lock a payload contract' });
  await form.getByLabel(/Topic \(or filter/).fill('plant/line1/temperature');
  await form.getByRole('button', { name: 'Infer schema from latest payload' }).click();
  const lock = form.getByRole('button', { name: 'Lock contract' });
  await expect(lock).toBeVisible();
  await expect(form.getByRole('region', { name: 'Inferred schema' })).toContainText('value');
  // editing the topic invalidates the inference: the old schema can no longer be locked under the new name
  await form.getByLabel(/Topic \(or filter/).fill('plant/line2/status');
  await expect(lock).toBeHidden();
  await expect(form.getByRole('region', { name: 'Inferred schema' })).toBeHidden();
});
