import { test, expect } from './fixtures.js';
import { startModbus, unique, cleanup, deviceRow, openDevice } from './support.js';

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
    await inst.getByRole('button', { name: 'Create device' }).click(); // nothing typed yet: the fields say what is missing, nothing is sent
    await expect(inst.getByText('Give the device a name')).toBeVisible();
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
    const deviceR = deviceRow(page, deviceName);
    await expect(deviceR.getByText('Online', { exact: true })).toBeVisible();
    await expect(deviceR).toContainText(`from ${profileName}`);

    const drawer = await openDevice(page, deviceName);
    await expect(drawer.getByText('Parameter reg')).toBeVisible();
    await expect(drawer.getByText('40101', { exact: true })).toBeVisible();
    await drawer.getByRole('tab', { name: /^Tags/ }).click();
    await expect(drawer.locator('tr[data-tag-key="count"] [data-quality]')).toHaveText('7');

    // In the editor the profile's tag is a read-only row marked "Profile", with its live value.
    await drawer.getByRole('button', { name: 'Edit device' }).click();
    const profileRow = page.locator('tr[data-tag-key="count"][data-origin="profile"]');
    await expect(profileRow).toContainText('Profile');
    await expect(profileRow.locator('[data-quality]')).toHaveText(/^\s*7(?!\d)/);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [deviceName], profiles: [profileName] });
    await sim.close();
  }
});
