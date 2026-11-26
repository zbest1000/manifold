import { test, expect } from './fixtures.js';
import { startCoap, unique, cleanup, deviceRow, openDevice } from './support.js';

/**
 * Devices: a CoAP (UDP) sensor read from its in-process simulator. The device is added in the UI,
 * goes Online and shows live values (a polled JSON member and an observed resource that follows
 * notifications); a SenML record is then imported from the device's own resource list with its unit.
 * A coaps:// host is refused with the reason.
 */

async function openAddDevice(page) {
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
}

const liveCell = (scope, key) => scope.locator(`tr[data-tag-key="${key}"] [data-quality]`);

test('CoAP device: live values, an observed resource, and a SenML record imported with its unit', async ({ page, consoleErrors }) => {
  const name = unique('E2E CoAP ');
  const sim = await startCoap();
  try {
    await openAddDevice(page);
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Protocol', { exact: true }).selectOption('coap');
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(sim.port));

    // The status and the limits are stated before the first connect.
    await expect(page.getByRole('note').filter({ hasText: 'Verified only against a simulator' })).toBeVisible();
    const notice = page.getByRole('region', { name: /Before you connect: CoAP/ });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('DTLS');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('temp');
    await page.getByLabel('Address, row 1').fill('/json#temperature');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('live');
    await page.getByLabel('Address, row 2').fill('observe:/obs');
    await page.getByRole('button', { name: 'Create device' }).click();

    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();
    await expect(deviceRow(page, name).getByText('Experimental')).toBeVisible();
    let drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'temp')).toHaveText(/^\s*21\.5(?!\d)/);
    await expect(liveCell(drawer, 'temp')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'live')).toHaveText(/^\s*1(?!\d)/);
    sim.notify(2);
    await expect(liveCell(drawer, 'live')).toHaveText(/^\s*2(?!\d)/);

    // Import from the device's own resource list: /senml expands into its records.
    await drawer.getByRole('button', { name: 'Import from device' }).click();
    const browse = page.getByRole('dialog', { name: /Import tags from/ });
    const tree = browse.getByRole('tree', { name: 'Device tags' });
    const senml = tree.getByRole('treeitem', { name: /(Expand|Collapse) \/senml Select/ });
    await expect(senml).toBeVisible();
    await senml.focus();
    await page.keyboard.press('ArrowRight');
    await expect(senml).toHaveAttribute('aria-expanded', 'true');
    const temp = tree.getByRole('treeitem', { name: /urn:dev:ow:10e2073a01080063:temp/ });
    await expect(temp).toBeVisible();
    await temp.focus();
    await page.keyboard.press('Space');
    await expect(browse.getByText('1 selected')).toBeVisible();
    await browse.getByRole('button', { name: 'Add 1 tag' }).click();
    await expect(browse).toBeHidden();

    // The imported row has the SenML name as its selector and the record's unit.
    await expect(page.getByLabel('Address, row 3')).toHaveValue('/senml#urn:dev:ow:10e2073a01080063:temp');
    await expect(page.getByLabel('Unit, row 3')).toHaveValue('Cel');
    const importedKey = await page.getByLabel('Key, row 3').inputValue();
    expect(importedKey).toContain('temp');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, importedKey)).toHaveText(/^\s*21\.5(?!\d)/);

    expect(sim.nonGet()).toBe(0);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});

test('CoAP over DTLS is refused with the reason', async ({ page }) => {
  await openAddDevice(page);
  await page.getByLabel('Name', { exact: true }).fill(unique('E2E CoAPS '));
  await page.getByLabel('Protocol', { exact: true }).selectOption('coap');
  await page.getByLabel('Host', { exact: true }).fill('coaps://sensor.example');
  await page.getByRole('button', { name: 'Create device' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'DTLS' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
});
