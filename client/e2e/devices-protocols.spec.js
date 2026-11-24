import { test, expect } from './fixtures.js';
import { startS7, startEip, unique, cleanup } from './support.js';

/**
 * Devices: a Siemens S7 device built with a preset and an EtherNet/IP device, each polled from
 * its in-process simulator. Both must go Online and show live values; for EtherNet/IP a tag is
 * then imported through the "Import from controller" browse dialog.
 */

const card = (page, name) => page.locator('li', { has: page.getByRole('heading', { level: 2, name, exact: true }) });

async function openAddDevice(page) {
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add device' })).toBeVisible();
  return dialog;
}

async function fillConnection(dialog, { name, port, protocol }) {
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  if (protocol) await dialog.getByLabel('Protocol', { exact: true }).selectOption(protocol);
  await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(String(port));
}

async function openEditor(page, name) {
  await page.getByRole('button', { name: `Edit ${name}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Edit ${name}` })).toBeVisible();
  return dialog;
}

/** The live cell of a tag row in the edit dialog. */
const liveCell = (dialog, key) => dialog.locator(`tr[data-tag-key="${key}"] [data-quality]`);

test('S7 device from a preset goes online with live values', async ({ page, consoleErrors }) => {
  const name = unique('E2E S7 ');
  const sim = await startS7();
  try {
    const dialog = await openAddDevice(page);
    await fillConnection(dialog, { name, port: sim.port, protocol: 's7' });

    // The preset sets rack/slot for the CPU family; the pressed state shows which one is active.
    const s7300 = dialog.getByRole('button', { name: 'S7-300 / S7-400' });
    await s7300.click();
    await expect(s7300).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'S7-1200 / S7-1500' })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByLabel('Slot')).toHaveValue('2');

    await dialog.getByRole('button', { name: 'Add tag' }).click();
    await dialog.getByLabel('Key, row 1').fill('level');
    await dialog.getByLabel('Address, row 1').fill('DB1.DBW0');
    await dialog.getByLabel('Type, row 1').selectOption('INT');
    await dialog.getByRole('button', { name: 'Add tag' }).click();
    await dialog.getByLabel('Key, row 2').fill('pressure');
    await dialog.getByLabel('Address, row 2').fill('DB1.DBD2');
    await dialog.getByLabel('Type, row 2').selectOption('REAL');

    // A STRING tag's length is optional: the form says what happens when it is blank.
    await dialog.getByRole('button', { name: 'Add tag' }).click();
    await dialog.getByLabel('Type, row 3').selectOption('STRING');
    const length = dialog.getByLabel('Length, row 3');
    await expect(length).toHaveAttribute('placeholder', 'default 254');
    await expect(length).toHaveAttribute('title', /Defaults to 254 when blank/);
    await expect(length).not.toHaveAttribute('aria-required', 'true');
    await dialog.getByLabel('Delete row 3').click();

    await dialog.getByRole('button', { name: 'Create device' }).click();
    await expect(dialog).toBeHidden();

    await expect(card(page, name).getByText('Online', { exact: true })).toBeVisible();
    await expect(card(page, name)).toContainText('rack 0 / slot 2');

    const editor = await openEditor(page, name);
    await expect(liveCell(editor, 'level')).toHaveText(/^\s*123(?!\d)/);
    await expect(liveCell(editor, 'level')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(editor, 'pressure')).toHaveText(/^\s*6\.5(?!\d)/);
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
    const dialog = await openAddDevice(page);
    await fillConnection(dialog, { name, port: sim.port, protocol: 'ethernet-ip' });
    await dialog.getByRole('button', { name: 'Add tag' }).click();
    await dialog.getByLabel('Key, row 1').fill('real');
    await dialog.getByLabel('Address, row 1').fill('RealTag');
    await dialog.getByRole('button', { name: 'Create device' }).click();
    await expect(dialog).toBeHidden();

    await expect(card(page, name).getByText('Online', { exact: true })).toBeVisible();
    let editor = await openEditor(page, name);
    await expect(liveCell(editor, 'real')).toHaveText(/^\s*3\.5(?!\d)/);

    // Import from the controller's own tag list; the dialog is a tree, driven here by the keyboard.
    await editor.getByRole('button', { name: 'Import from controller' }).click();
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
    await expect(editor.locator('tr[data-tag-key="DintTag"]')).toBeVisible();
    await expect(editor.getByLabel('Address, row 2')).toHaveValue('DintTag');
    await expect(editor.getByLabel('Type, row 2')).toHaveValue('DINT');

    // ...and once the device is saved it reads live.
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor).toBeHidden();
    editor = await openEditor(page, name);
    await expect(liveCell(editor, 'DintTag')).toHaveText(/^\s*123456(?!\d)/);
    await expect(liveCell(editor, 'DintTag')).toHaveAttribute('data-quality', 'good');
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});
