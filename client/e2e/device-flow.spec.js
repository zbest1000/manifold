import { test, expect } from './fixtures.js';
import { cleanup, deviceRow, openDevice } from './support.js';

/**
 * Smoke flow: add a Modbus device through the UI against the in-process simulator
 * (a holding register at 40103 that counts up every 500 ms) and watch its live
 * value arrive and keep changing in the device detail, without any reload.
 */
test('add a Modbus device and see a live value', async ({ page, consoleErrors }) => {
  const modbusPort = process.env.E2E_MODBUS_PORT;
  expect(modbusPort, 'global-setup must export E2E_MODBUS_PORT').toBeTruthy();

  try {
    await page.goto('/devices');
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();

    await page.getByRole('button', { name: 'Add device' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();

    // A required field is not called out before the user tries to save.
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.getByLabel('Name', { exact: true }).fill('E2E meter');
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(modbusPort);
    await page.getByLabel('Unit ID').fill('1');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('count');
    await page.getByLabel('Address, row 1').fill('40103');
    await page.getByLabel('Type, row 1').selectOption('uint16');
    await page.getByLabel('Poll group, row 1').selectOption('default');

    await page.getByRole('button', { name: 'Create device' }).click();

    // The device is a row of the table, and goes online.
    const row = deviceRow(page, 'E2E meter');
    await expect(row).toBeVisible();
    await expect(row.getByText('Online', { exact: true })).toBeVisible();

    // A click on the row opens the detail; its tag table shows the live value next to the tag.
    const drawer = await openDevice(page, 'E2E meter', 'Tags');
    const live = drawer.locator('tr[data-tag-key="count"] [data-quality]');
    await expect(live).toBeVisible();
    await expect(live).toHaveText(/^\s*\d+/);
    await expect(live).toHaveAttribute('data-quality', 'good');

    // ...and the value moves on its own as the simulator register counts up.
    const first = await live.innerText();
    await expect.poll(async () => live.innerText(), { message: 'live value should change without a reload', timeout: 30_000 }).not.toBe(first);

    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: ['E2E meter'] });
  }
});
