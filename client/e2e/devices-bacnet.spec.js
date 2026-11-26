import { test, expect } from './fixtures.js';
import { startBacnet, unique, cleanup, deviceRow, openDevice } from './support.js';

/**
 * Devices: a BACnet/IP device added from the descriptor-driven form, polled from the in-process
 * UDP simulator. It must go Online with live values and status-derived quality; a point is then
 * imported from the device's object list with its object name, unit and description.
 */

const liveCell = (scope, key) => scope.locator(`tr[data-tag-key="${key}"] [data-quality]`);

test('BACnet/IP device: live values with quality, then import a point from the object list', async ({ page, consoleErrors }) => {
  const name = unique('E2E BACnet ');
  const sim = await startBacnet();
  try {
    await page.goto('/devices');
    await page.getByRole('button', { name: 'Add device' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Protocol', { exact: true }).selectOption('bacnet-ip');
    // The descriptor sets the default port and says what is (and is not) sent.
    await expect(page.getByLabel('Port', { exact: true })).toHaveValue('47808');
    await expect(page.getByRole('note').filter({ hasText: 'Verified only against a simulator' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Before you connect: BACnet\/IP/ })).toContainText('never writes');
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(sim.port));
    await page.getByLabel('Device instance').fill('1234');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('zoneTemp');
    await page.getByLabel('Address, row 1').fill('analog-input:1');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('fan');
    await page.getByLabel('Address, row 2').fill('binary-input:2');

    await page.getByRole('button', { name: 'Create device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    const row = deviceRow(page, name);
    await expect(row.getByText('Online', { exact: true })).toBeVisible();
    await expect(row).toContainText('device 1234');
    await expect(row.getByText('Experimental')).toBeVisible();

    let drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'zoneTemp')).toHaveText(/^\s*21\.5(?!\d)/);
    await expect(liveCell(drawer, 'zoneTemp')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'fan')).toHaveText(/true/i);

    // Import from the device's object list: types are folders, objects carry their object-name.
    await drawer.getByRole('button', { name: 'Import from device' }).click();
    const browse = page.getByRole('dialog', { name: /Import tags from/ });
    const tree = browse.getByRole('tree', { name: 'Device tags' });
    const folder = tree.getByRole('treeitem', { name: /analog-input \(2\)/ });
    await expect(folder).toBeVisible();
    await folder.focus();
    await page.keyboard.press('ArrowRight');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    const point = tree.getByRole('treeitem', { name: /Supply Pressure \(analog-input:2\)/ });
    await expect(point).toBeVisible();
    await point.focus();
    await page.keyboard.press('Space');
    await expect(browse.getByText('1 selected')).toBeVisible();
    await browse.getByRole('button', { name: 'Add 1 tag' }).click();
    await expect(browse).toBeHidden();

    await expect(page.getByLabel('Address, row 3')).toHaveValue('analog-input:2');
    // Mapping metadata from the device: object-name -> property, engineering units -> unit text.
    await expect(page.getByLabel('UNS property name, row 3')).toHaveValue('supplyPressure');
    await expect(page.getByLabel('Unit, row 3')).toHaveValue('kPa');
    await expect(page.locator('tr[data-tag-key="analog-input:2"]')).toBeVisible();

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    drawer = await openDevice(page, name, 'Tags');
    // The simulator reports this point with the fault status flag and reliability over-range: Bad.
    await expect(liveCell(drawer, 'analog-input:2')).toHaveAttribute('data-quality', 'bad');
    await expect(liveCell(drawer, 'zoneTemp')).toHaveAttribute('data-quality', 'good');
    expect(sim.sim.stats.writesReceived).toBe(0);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});
