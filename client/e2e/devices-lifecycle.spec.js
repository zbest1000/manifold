import { test, expect } from './fixtures.js';
import { api, unique, startModbus, createModbusDevice, deviceByName, cleanup, deviceRow, openDevice } from './support.js';

/**
 * Devices: disable/enable, and delete. A device that a binding still reads from cannot be deleted; the
 * dialog says so BEFORE the click (and names the bindings) instead of promising one thing and failing
 * with a toast afterwards.
 */
test('disable a device, then delete it: blocked while a binding uses it, allowed once the binding is gone', async ({ page }) => {
  const deviceName = unique('E2E life ');
  const bindingName = unique('E2E life binding ');
  const sim = await startModbus({ value: 9 });
  try {
    const device = await createModbusDevice({ name: deviceName, port: sim.port, tags: [{ key: 'a', address: '40101', property: 'a' }] });
    const saved = await api.post('/api/tags/bindings', {
      name: bindingName,
      source: { type: 'device', deviceId: device.id, tags: [{ address: 'a', name: 'a' }] },
      target: { mode: 'mqtt', brokerId: 'e2e-broker', assetPath: `e2e/${unique('life')}/x`, format: 'envelope', layout: 'topic-per-tag' }
    });
    expect(saved.status).toBe(201);

    await page.goto('/devices');
    const row = deviceRow(page, deviceName);
    const poll = row.getByRole('switch', { name: `Poll ${deviceName}` });
    await expect(poll).toBeChecked();
    await poll.click({ force: true }); // the native input is visually hidden; the label (the visible track) takes the click
    await expect(poll).not.toBeChecked();
    await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
    expect((await deviceByName(deviceName)).enabled).toBe(false);
    await poll.click({ force: true }); // the native input is visually hidden; the label (the visible track) takes the click
    await expect(poll).toBeChecked();
    expect((await deviceByName(deviceName)).enabled).toBe(true);

    // The same switch lives in the detail drawer.
    const drawer = await openDevice(page, deviceName);
    await expect(drawer.getByRole('switch', { name: 'Polling enabled' })).toBeChecked();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toBeHidden();

    await row.getByRole('button', { name: `Delete ${deviceName}` }).click();
    const dialog = page.getByRole('dialog', { name: `Delete ${deviceName}?` });
    await expect(dialog.getByRole('alert')).toContainText('cannot be deleted yet');
    await expect(dialog.getByRole('alert')).toContainText(bindingName);
    await expect(dialog.getByRole('link', { name: 'Tags page' })).toHaveAttribute('href', `/tags?source=device:${device.id}`);
    await expect(dialog.getByRole('button', { name: 'Delete device' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await cleanup({ bindings: [bindingName] });
    await row.getByRole('button', { name: `Delete ${deviceName}` }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Delete device' }).click();
    await expect(row).toBeHidden();
    expect(await deviceByName(deviceName)).toBeNull();
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await sim.close();
  }
});

test('a device is found by its name, and a deep link opens its detail', async ({ page }) => {
  const names = [unique('E2E find A '), unique('E2E find B '), unique('E2E find C '), unique('E2E find D '), unique('E2E find E ')];
  const sim = await startModbus({ value: 3 });
  try {
    const made = [];
    for (const n of names) made.push(await createModbusDevice({ name: n, port: sim.port, tags: [{ key: 'a', address: '40101' }] }));

    // More than a handful of devices: the table gets a filter, and it narrows the list.
    await page.goto('/devices');
    const filter = page.getByRole('textbox', { name: 'Filter devices' });
    await expect(filter).toBeVisible();
    await filter.fill(names[2]);
    await expect(deviceRow(page, names[2])).toBeVisible();
    await expect(deviceRow(page, names[0])).toHaveCount(0);
    await filter.fill('no such device');
    await expect(page.getByText('No devices match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(deviceRow(page, names[0])).toBeVisible();

    // /devices?device=ID opens the detail straight away (profiles and the overview link there).
    await page.goto(`/devices?device=${made[1].id}`);
    await expect(page.getByRole('dialog', { name: names[1] })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await cleanup({ devices: names });
    await sim.close();
  }
});
