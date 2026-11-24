import { test, expect } from './fixtures.js';
import { api, unique, startHistorianStub } from './support.js';

/**
 * Pipelines. The historian here is a STUB (a local HTTP server that accepts the Timebase write
 * endpoint and records the request); no real historian is involved.
 *
 *   - historian create / test write through the UI, store-and-forward and dead-letter visibility
 *   - a route into a historian from a topic carrying a {v,t,q} envelope: the page offers the numeric
 *     transform (and not for a plain topic), and the stored value really is a number
 *   - a historian that routes still write to cannot be removed
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
    await page.getByRole('combobox', { name: /^Type/ }).selectOption('timebase');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('URL').fill(stub.url);
    await page.getByLabel('Dataset').fill('E2E set');
    await page.getByRole('button', { name: 'Add historian' }).last().click();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    id = (await api.get('/api/historians')).json.historians.find((h) => h.name === name).id;

    await row.getByRole('button', { name: `Test write to ${name}` }).click();
    await expect(row.getByText('Test write succeeded')).toBeVisible();
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
    await page.getByLabel('Name', { exact: true }).fill(routeName);
    await page.getByLabel('Source filter').fill('plant/env/tvq');
    await page.getByRole('combobox', { name: /^Type/ }).selectOption('historian');
    // the hint appears for the envelope topic ...
    const hint = page.getByRole('status').filter({ hasText: 'value/time/quality envelope' });
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('stores a JSON object as text');
    // ... not for a plain one
    await page.getByLabel('Source filter').fill('plant/line1/temperature');
    await expect(hint).toBeHidden();
    await page.getByLabel('Source filter').fill('plant/env/tvq');
    await expect(hint).toBeVisible();

    await hint.getByRole('button', { name: 'Add numeric transform on v' }).click();
    await expect(hint).toBeHidden(); // done: the offer goes away
    await expect(page.getByLabel('Transform 2: field (optional)')).toHaveValue('v');
    await page.getByRole('button', { name: 'Save route' }).click();
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

test('a historian that still has a route cannot be removed, and rejected points are visible', async ({ page }) => {
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

    await row.getByRole('button', { name: `Delete historian ${hname}` }).click();
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Remove historian' }).click();
    await expect(page.getByText(/Historian is still used by 1 item/)).toBeVisible();
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

test('the selected Pipelines tab is part of the URL', async ({ page }) => {
  await page.goto('/pipelines?tab=recorder');
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Contracts' }).click();
  await expect(page).toHaveURL(/tab=contracts/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Lock a payload contract' })).toBeVisible();
  await page.getByRole('button', { name: 'Routes' }).click();
  await expect(page).not.toHaveURL(/tab=/);
});

test('malformed topics are refused with a message and nothing is saved', async ({ page }) => {
  await page.goto('/pipelines');
  await page.getByRole('button', { name: /Create the first route|New route/ }).click();
  await page.getByLabel('Source filter').fill('plant/#/x');
  const before = (await api.get('/api/pipelines')).json.routes.length;
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page.getByText(/has a # wildcard that is not the last level/)).toBeVisible();
  expect((await api.get('/api/pipelines')).json.routes.length).toBe(before);
  // the editor still holds what was typed
  await expect(page.getByLabel('Source filter')).toHaveValue('plant/#/x');
});

test('recorder: pause keeps what was captured, resume continues', async ({ page }) => {
  const name = unique('rec ');
  let id;
  try {
    await page.goto('/pipelines?tab=recorder');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Filter', { exact: true }).fill('plant/line1/#');
    await page.getByRole('button', { name: 'Start recording' }).click();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    id = (await api.get('/api/recorder')).json.recordings.find((r) => r.name === name).id;
    await expect(row.getByText('recording', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: `Pause recording ${name}` }).click();
    await expect(row.getByText('paused', { exact: true })).toBeVisible();
    expect((await api.get('/api/recorder')).json.recordings.find((r) => r.id === id).enabled).toBe(false);
    await row.getByRole('button', { name: `Resume recording ${name}` }).click();
    await expect(row.getByText('recording', { exact: true })).toBeVisible();
    expect((await api.get('/api/recorder')).json.recordings.find((r) => r.id === id).enabled).toBe(true);
  } finally {
    if (id) await removeAll('recorder', [id]);
  }
});

test('contracts: an inferred schema belongs to the topic it was inferred from', async ({ page }) => {
  await page.goto('/pipelines?tab=contracts');
  await page.getByLabel(/Topic \(or filter/).fill('plant/line1/temperature');
  await page.getByRole('button', { name: 'Infer schema from latest payload' }).click();
  const lock = page.getByRole('button', { name: 'Lock contract' });
  await expect(lock).toBeVisible();
  await expect(page.getByRole('region', { name: 'Inferred schema' })).toContainText('value');
  // editing the topic invalidates the inference: the old schema can no longer be locked under the new name
  await page.getByLabel(/Topic \(or filter/).fill('plant/line2/status');
  await expect(lock).toBeHidden();
  await expect(page.getByRole('region', { name: 'Inferred schema' })).toBeHidden();
});
