import { test, expect } from './fixtures.js';

/**
 * Smoke flow: add a Modbus device through the UI against the in-process simulator
 * (a holding register at 40103 that counts up every 500 ms) and watch its live
 * value arrive and keep changing, without any reload.
 */
test('add a Modbus device and see a live value', async ({ page, consoleErrors }) => {
  const modbusPort = process.env.E2E_MODBUS_PORT;
  expect(modbusPort, 'global-setup must export E2E_MODBUS_PORT').toBeTruthy();

  await page.goto('/devices');
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();

  await page.getByRole('button', { name: 'Add device' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add device' })).toBeVisible();

  await dialog.getByLabel('Name', { exact: true }).fill('E2E meter');
  await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(modbusPort);
  await dialog.getByLabel('Unit ID').fill('1');

  await dialog.getByRole('button', { name: 'Add tag' }).click();
  await dialog.getByLabel('Key, row 1').fill('count');
  await dialog.getByLabel('Address, row 1').fill('40103');
  await dialog.getByLabel('Type, row 1').selectOption('uint16');
  await dialog.getByLabel('Poll group, row 1').selectOption('default');

  await dialog.getByRole('button', { name: 'Create device' }).click();

  // The device card appears.
  const card = page.locator('h2', { hasText: 'E2E meter' });
  await expect(card).toBeVisible();

  // Open it for editing: the tag table shows the live value next to the tag.
  await page.getByRole('button', { name: 'Edit E2E meter' }).click();
  const live = page.getByRole('dialog').locator('tr[data-tag-key="count"] [data-quality]');
  await expect(live).toBeVisible();
  const numeric = /^\s*\d+/;
  await expect(live).toHaveText(numeric);

  // ...and the value moves on its own as the simulator register counts up.
  const first = await live.innerText();
  await expect.poll(async () => live.innerText(), { message: 'live value should change without a reload', timeout: 30_000 }).not.toBe(first);

  expect(consoleErrors).toEqual([]);
});
