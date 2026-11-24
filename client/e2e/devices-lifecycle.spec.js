import { test, expect } from './fixtures.js';
import { api, unique, startModbus, createModbusDevice, deviceByName, cleanup } from './support.js';

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
    const card = page.locator('li', { has: page.locator('h2', { hasText: deviceName }) });
    await card.getByRole('switch', { name: `Disable ${deviceName}` }).click();
    await expect(card.getByRole('switch', { name: `Enable ${deviceName}` })).toBeVisible();
    expect((await deviceByName(deviceName)).enabled).toBe(false);
    await card.getByRole('switch', { name: `Enable ${deviceName}` }).click();
    await expect(card.getByRole('switch', { name: `Disable ${deviceName}` })).toBeVisible();

    await card.getByRole('button', { name: `Delete ${deviceName}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('cannot be deleted yet');
    await expect(dialog.getByRole('alert')).toContainText(bindingName);
    await expect(dialog.getByRole('link', { name: 'Tags page' })).toHaveAttribute('href', `/tags?source=device:${device.id}`);
    await expect(dialog.getByRole('button', { name: 'Delete device' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await cleanup({ bindings: [bindingName] });
    await card.getByRole('button', { name: `Delete ${deviceName}` }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Delete device' }).click();
    await expect(card).toBeHidden();
    expect(await deviceByName(deviceName)).toBeNull();
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await sim.close();
  }
});
