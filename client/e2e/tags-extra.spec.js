import { test, expect } from './fixtures.js';
import { api, unique, startModbus, createModbusDevice, deviceByName, cleanup } from './support.js';

/**
 * Tags: choosing an MQTT-topic source says plainly that it makes a pipeline route (not a binding) and
 * links to Pipelines; a binding links to its place on the UNS page with a stable query string.
 */
test('MQTT-topic tags: the choice says "pipeline route, not a binding", and creating one links to Pipelines', async ({ page }) => {
  const base = `e2e-uns/${unique('mqtt')}`;
  let routeId;
  try {
    await page.goto('/tags');
    await page.getByLabel('Source').selectOption({ label: 'E2E broker · topics' });
    const note = page.getByRole('status').filter({ hasText: 'MQTT topics are mapped with a pipeline route, not a binding' });
    await expect(note).toBeVisible();
    await expect(note.getByRole('link', { name: 'Pipelines, Routes' })).toHaveAttribute('href', '/pipelines');
    // the action is named for what it does
    await expect(page.getByRole('button', { name: /Create pipeline route/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Add to UNS/ })).toHaveCount(0);

    await page.getByLabel('Source').selectOption({ label: 'E2E broker · topics' });
    await page.getByRole('treeitem', { name: /^plant/ }).getByRole('button', { name: /Select all/ }).click();
    await page.getByRole('button', { name: /Create pipeline route \(\d+\)/ }).click();
    const wizard = page.getByRole('dialog');
    await expect(wizard.getByRole('heading', { name: /Create a pipeline route for \d+ topics/ })).toBeVisible();
    await expect(wizard.getByRole('note')).toContainText('This creates a pipeline route, not a binding');
    await expect(wizard.getByRole('link', { name: 'Pipelines, Routes' })).toBeVisible();
    await wizard.getByLabel('Base path').fill(base);
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Create pipeline route' }).click();

    const toast = page.getByRole('status').filter({ hasText: 'Created a pipeline route' });
    await expect(toast).toBeVisible();
    await toast.getByRole('link', { name: 'Open Pipelines, Routes' }).click();
    await expect(page).toHaveURL(/\/pipelines/);
    await expect(page.getByRole('row').filter({ hasText: base })).toBeVisible();
    routeId = (await api.get('/api/pipelines')).json.routes.find((r) => JSON.stringify(r.transforms).includes(base))?.id;
    expect(routeId).toBeTruthy();
  } finally {
    if (routeId) await api.del(`/api/pipelines/${routeId}`);
  }
});

test('a binding links to its place on the UNS page (?broker=&path=)', async ({ page }) => {
  const deviceName = unique('E2E uns link ');
  const bindingName = unique('E2E uns binding ');
  const asset = `e2e/${unique('site')}/line9/mixer`;
  const sim = await startModbus({ value: 3 });
  try {
    const device = await createModbusDevice({ name: deviceName, port: sim.port, tags: [{ key: 'speed', address: '40101', property: 'speed' }] });
    const saved = await api.post('/api/tags/bindings', {
      name: bindingName,
      source: { type: 'device', deviceId: device.id, tags: [{ address: 'speed', name: 'speed' }] },
      target: { mode: 'mqtt', brokerId: 'e2e-broker', assetPath: asset, format: 'envelope', layout: 'topic-per-tag' }
    });
    expect(saved.status).toBe(201);
    await page.goto('/tags');
    await page.getByRole('button', { name: bindingName, exact: true }).click();
    const link = page.getByRole('link', { name: 'Show in UNS' });
    await expect(link).toBeVisible();
    const href = new URL(await link.getAttribute('href'), 'http://x');
    expect(href.pathname).toBe('/uns');
    expect(href.searchParams.get('broker')).toBe('e2e-broker');
    expect(href.searchParams.get('path')).toBe(asset);
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await sim.close();
    expect(await deviceByName(deviceName)).toBeNull();
  }
});

test('Esc in the bind wizard asks before discarding what was entered', async ({ page }) => {
  await page.goto('/tags');
  await page.getByLabel('Source').selectOption({ label: 'E2E broker · topics' });
  await page.getByRole('treeitem', { name: /^plant/ }).getByRole('button', { name: /Select all/ }).click();
  await page.getByRole('button', { name: /Create pipeline route \(\d+\)/ }).click();
  const wizard = page.getByRole('dialog');
  // untouched: closes at once
  await page.keyboard.press('Escape');
  await expect(wizard).toBeHidden();

  await page.getByRole('button', { name: /Create pipeline route \(\d+\)/ }).click();
  await wizard.getByLabel('Binding name').fill('half done');
  page.once('dialog', (d) => d.dismiss());
  await page.keyboard.press('Escape');
  await expect(wizard).toBeVisible();
  await expect(wizard.getByLabel('Binding name')).toHaveValue('half done');
  page.once('dialog', (d) => d.accept());
  await wizard.getByRole('button', { name: 'Cancel' }).click();
  await expect(wizard).toBeHidden();
});
