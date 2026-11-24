import { test, expect } from './fixtures.js';
import { startModbus, unique, cleanup } from './support.js';

/**
 * Device profiles: define a profile with a parameter ({reg} in a tag address), create one device
 * from it giving the parameter a value, and see that device come online and read through the
 * substituted address.
 */
test('create a profile with a parameter, instantiate a device from it, see it online', async ({ page, consoleErrors }) => {
  const profileName = unique('E2E profile ');
  const deviceName = unique('E2E from profile ');
  const sim = await startModbus({ value: 7 }); // holding register 40101 = 7
  try {
    await page.goto('/devices?tab=profiles');
    await expect(page.getByRole('tab', { name: /^Profiles/ })).toHaveAttribute('aria-selected', 'true');

    // --- the profile --------------------------------------------------------------------
    await page.getByRole('button', { name: 'New profile' }).first().click();
    const form = page.getByRole('dialog', { name: 'New device profile' });
    await form.getByLabel('Name', { exact: true }).fill(profileName);

    await form.getByRole('button', { name: 'Add parameter' }).click();
    await form.getByLabel('Parameter name, row 1').fill('reg');
    await form.getByLabel('Default value, row 1').fill('40001'); // each device overrides it

    await form.getByRole('button', { name: 'Add tag' }).click();
    await form.getByLabel('Key, row 1').fill('count');
    await form.getByLabel('Address, row 1').fill('{reg}');
    await form.getByLabel('Type, row 1').selectOption('uint16');
    await form.getByLabel('Poll group, row 1').selectOption('default');
    await form.getByRole('button', { name: 'Create profile' }).click();
    await expect(form).toBeHidden();

    const row = page.getByRole('row', { name: new RegExp(profileName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('reg=40001');
    await expect(row).toContainText('unused');

    // --- one device from it -------------------------------------------------------------
    await row.getByRole('button', { name: `New device from ${profileName}` }).click();
    const inst = page.getByRole('dialog').filter({ hasText: `New device from profile` });
    await inst.getByLabel('Name', { exact: true }).fill(deviceName);
    await inst.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await inst.getByLabel('Port', { exact: true }).fill(String(sim.port));
    await inst.getByLabel('Unit ID').fill('1');
    await inst.getByLabel('reg', { exact: true }).fill('40101');
    // The preview shows the placeholder already substituted, exactly as the server will.
    await expect(inst.locator('tr[data-tag-key="count"]')).toContainText('40101');
    await inst.getByRole('button', { name: 'Create device' }).click();
    await expect(inst).toBeHidden();

    // The profile now lists its instance...
    await expect(row.getByRole('link', { name: deviceName })).toBeVisible();

    // ...and the device is online on the Devices tab, reading the register through {reg}.
    await page.getByRole('tab', { name: /^Devices/ }).click();
    const card = page.locator('li', { has: page.getByRole('heading', { level: 2, name: deviceName, exact: true }) });
    await expect(card.getByText('Online', { exact: true })).toBeVisible();
    await expect(card).toContainText('from profile');
    await expect(card).toContainText('reg=40101');

    await page.getByRole('button', { name: `Edit ${deviceName}` }).click();
    const editor = page.getByRole('dialog').filter({ hasText: `Edit ${deviceName}` });
    await expect(editor.locator('tr[data-tag-key="count"] td').nth(5)).toHaveText('7OK');
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [deviceName], profiles: [profileName] });
    await sim.close();
  }
});
