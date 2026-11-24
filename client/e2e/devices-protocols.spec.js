import { test, expect } from './fixtures.js';
import { startS7, startEip, unique, cleanup, deviceRow, openDevice } from './support.js';

/**
 * Devices: a Siemens S7 device built with a preset and an EtherNet/IP device, each polled from
 * its in-process simulator. Both must go Online and show live values; for EtherNet/IP a tag is
 * then imported through the "Import from controller" browse dialog.
 */

async function openAddDevice(page) {
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
}

async function fillConnection(page, { name, port, protocol }) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (protocol) await page.getByLabel('Protocol', { exact: true }).selectOption(protocol);
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(port));
}

/** The live cell of a tag row in a device's detail. */
const liveCell = (scope, key) => scope.locator(`tr[data-tag-key="${key}"] [data-quality]`);

test('S7 device from a preset goes online with live values', async ({ page, consoleErrors }) => {
  const name = unique('E2E S7 ');
  const sim = await startS7();
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: sim.port, protocol: 's7' });

    // The experimental status is stated quietly, before the first connect.
    await expect(page.getByRole('note').filter({ hasText: 'Verified only against a simulator' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Before you connect: Siemens S7/ })).toBeVisible();

    // The preset sets rack/slot for the CPU family; the selected segment shows which one is active.
    const s7300 = page.getByRole('radio', { name: 'S7-300 / S7-400' });
    await s7300.click();
    await expect(s7300).toBeChecked();
    await expect(page.getByRole('radio', { name: 'S7-1200 / S7-1500' })).not.toBeChecked();
    await expect(page.getByLabel('Slot')).toHaveValue('2');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('level');
    await page.getByLabel('Address, row 1').fill('DB1.DBW0');
    await page.getByLabel('Type, row 1').selectOption('INT');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('pressure');
    await page.getByLabel('Address, row 2').fill('DB1.DBD2');
    await page.getByLabel('Type, row 2').selectOption('REAL');

    // A STRING tag's length is optional: the form says what happens when it is blank.
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Type, row 3').selectOption('STRING');
    const length = page.getByLabel('Length, row 3');
    await expect(length).toHaveAttribute('placeholder', 'default 254');
    await expect(length).toHaveAttribute('title', /Defaults to 254 when blank/);
    await expect(length).not.toHaveAttribute('aria-required', 'true');
    await page.getByLabel('Delete row 3').click();

    await page.getByRole('button', { name: 'Create device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();

    const row = deviceRow(page, name);
    await expect(row.getByText('Online', { exact: true })).toBeVisible();
    await expect(row).toContainText('rack 0 / slot 2');
    await expect(row.getByText('Experimental')).toBeVisible();

    const drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'level')).toHaveText(/^\s*123(?!\d)/);
    await expect(liveCell(drawer, 'level')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'pressure')).toHaveText(/^\s*6\.5(?!\d)/);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});

test('EtherNet/IP device: live value, then import a tag from the controller', async ({ page, consoleErrors }) => {
  const name = unique('E2E EIP ');
  const sim = await startEip();
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: sim.port, protocol: 'ethernet-ip' });
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('real');
    await page.getByLabel('Address, row 1').fill('RealTag');
    await page.getByRole('button', { name: 'Create device' }).click();

    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();
    let drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'real')).toHaveText(/^\s*3\.5(?!\d)/);

    // Import from the controller's own tag list (from the detail, straight into the editor); the dialog is a tree, driven here by the keyboard.
    await drawer.getByRole('button', { name: 'Import from controller' }).click();
    const browse = page.getByRole('dialog', { name: /Import tags from/ });
    const tree = browse.getByRole('tree', { name: 'Controller tags' });
    const folder = tree.getByRole('treeitem', { name: /Controller tags/ });
    await expect(folder).toBeVisible();
    await folder.focus();
    await page.keyboard.press('ArrowRight'); // expand: the folder's tags load
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    const dint = tree.getByRole('treeitem', { name: /DintTag/ });
    await expect(dint).toBeVisible();
    await dint.focus();
    await page.keyboard.press('Space');
    await expect(browse.getByText('1 selected')).toBeVisible();
    await expect(dint).toHaveAttribute('aria-selected', 'true');
    await browse.getByRole('button', { name: 'Add 1 tag' }).click();
    await expect(browse).toBeHidden();

    // The imported row is in the table with a generated key and the controller's data type...
    await expect(page.locator('tr[data-tag-key="DintTag"]')).toBeVisible();
    await expect(page.getByLabel('Address, row 2')).toHaveValue('DintTag');
    await expect(page.getByLabel('Type, row 2')).toHaveValue('DINT');

    // ...and once the device is saved it reads live.
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'DintTag')).toHaveText(/^\s*123,456(?!\d)/);
    await expect(liveCell(drawer, 'DintTag')).toHaveAttribute('data-quality', 'good');
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});
