import { test, expect } from './fixtures.js';
import { api, unique, cleanup, deviceByName, startModbus } from './support.js';

/**
 * Devices: bulk creation is all-or-nothing, the Advanced section (Modbus unmapped ranges, per-device
 * process isolation) really reaches the stored device, and a device the driver could never run is
 * refused at save time with the driver's own message instead of sitting offline.
 */
test('bulk create from a profile is all-or-nothing: one rejected row creates nothing, fixing it creates everything', async ({ page }) => {
  const profileName = unique('Bulk profile ');
  const taken = unique('Taken ');
  const names = [unique('Bulk A '), taken, unique('Bulk C ')];
  const created = [];
  try {
    const profile = await api.post('/api/devices/profiles', { name: profileName, protocol: 'modbus-tcp', params: [{ name: 'line' }], tags: [{ key: 'kw', address: 'holding:1', type: 'uint16' }] });
    expect(profile.status).toBe(201);
    // an existing device whose name the second row will clash with (the table cannot know that; the server does)
    expect((await api.post('/api/devices', { name: taken, protocol: 'modbus-tcp', host: '127.0.0.1', port: 5999, enabled: false })).status).toBe(201);
    created.push(taken);

    await page.goto('/devices?tab=profiles');
    await page.getByRole('button', { name: `Create several devices from ${profileName}` }).click();
    const dialog = page.getByRole('dialog');
    const csv = `name,host,port,line\n${names[0]},127.0.0.1,5001,l1\n${names[1]},127.0.0.1,5002,l2\n${names[2]},127.0.0.1,5003,l3\n`;
    await dialog.getByLabel('Devices (CSV or pasted table)').fill(csv);
    await expect(dialog.getByRole('button', { name: 'Create 3 devices' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Create 3 devices' }).click();

    // the server rejects row 2 by name; the other two are valid but are NOT created
    await expect(dialog.getByRole('status').filter({ hasText: 'Nothing was created' })).toContainText('1 row was rejected');
    await expect(dialog.getByRole('row', { name: new RegExp(taken) })).toContainText(/already used by another device/);
    await expect(dialog.getByRole('row', { name: new RegExp(names[0]) })).toContainText(/not created because another row was rejected/);
    expect(await deviceByName(names[0])).toBeNull();
    expect(await deviceByName(names[2])).toBeNull();

    // fix the clash and run again: all three exist afterwards
    names[1] = unique('Bulk B ');
    await dialog.getByLabel('Devices (CSV or pasted table)').fill(csv.replace(taken, names[1]));
    await dialog.getByRole('button', { name: 'Create 3 devices' }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Created 3 devices' })).toBeVisible();
    for (const n of names) expect((await deviceByName(n))?.profileId).toBe(profile.json.id);
    created.push(...names);
    await expect(dialog.getByRole('button', { name: /Create \d+ device/ })).toBeDisabled(); // nothing left to create: no double submit
  } finally {
    await cleanup({ devices: created, profiles: [profileName] });
  }
});

test('a table with a problem row cannot be sent at all and says why', async ({ page }) => {
  const profileName = unique('Bulk guard ');
  try {
    await api.post('/api/devices/profiles', { name: profileName, protocol: 'modbus-tcp', params: [{ name: 'line' }], tags: [{ key: 'kw', address: 'holding:1', type: 'uint16' }] });
    await page.goto('/devices?tab=profiles');
    await page.getByRole('button', { name: `Create several devices from ${profileName}` }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Devices (CSV or pasted table)').fill('name,host,line\nok,127.0.0.1,l1\n,127.0.0.1,l2\n');
    await expect(dialog.getByText('1 row has problems')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create 1 device' })).toBeDisabled();
    await expect(dialog.getByRole('row', { name: /Problem/ })).toContainText('name is required');
  } finally {
    await cleanup({ profiles: [profileName] });
  }
});

test('Advanced: unmapped register ranges and per-device isolation are saved, shown again, and an impossible range is refused', async ({ page }) => {
  const sim = await startModbus({ value: 5 });
  const name = unique('Adv ');
  try {
    await page.goto('/devices');
    await page.getByRole('button', { name: 'Add device' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await dialog.getByLabel('Port', { exact: true }).fill(String(sim.port));
    await dialog.getByLabel('Unit ID').fill('1');

    await dialog.getByText('Advanced', { exact: true }).click();
    await expect(dialog.getByText(/Registers this device does not implement/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add unmapped range' }).click();
    await expect(dialog.getByLabel('Table', { exact: true })).toHaveValue('holding'); // the common case is preselected
    await dialog.getByLabel('From offset').fill('9');
    await dialog.getByLabel('To offset').fill('5');
    await expect(dialog.getByText('Needs 0-65535, from ≤ to')).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Run this device in its own driver process' }).check();

    // the impossible range is refused by the server with the driver's message; the form keeps everything typed
    await dialog.getByRole('button', { name: 'Create device' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'options.unmapped must be' })).toBeVisible();
    expect(await deviceByName(name)).toBeNull();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);

    // fix the range: saved with both settings
    await dialog.getByLabel('To offset').fill('12');
    await dialog.getByRole('button', { name: 'Create device' }).click();
    await expect(page.locator('h2', { hasText: name })).toBeVisible();
    const stored = await deviceByName(name);
    expect(stored.isolate).toBe(true);
    expect(stored.options.unmapped).toEqual([{ table: 'holding', from: 9, to: 12 }]);

    // reopening the device shows them (the section opens by itself because something is set)
    await page.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByRole('checkbox', { name: 'Run this device in its own driver process' })).toBeChecked();
    await expect(edit.getByLabel('From offset')).toHaveValue('9');
    await expect(edit.getByLabel('To offset')).toHaveValue('12');
    // switching isolation off removes it from the stored device
    await edit.getByRole('checkbox', { name: 'Run this device in its own driver process' }).uncheck();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    expect((await deviceByName(name)).isolate).toBeUndefined();
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});

test('a device name must be unique and the form keeps what you typed when saving fails', async ({ page }) => {
  const name = unique('Dup ');
  try {
    expect((await api.post('/api/devices', { name, protocol: 'modbus-tcp', host: '127.0.0.1', port: 5998, enabled: false })).status).toBe(201);
    await page.goto('/devices');
    await page.getByRole('button', { name: 'Add device' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await dialog.getByRole('button', { name: 'Create device' }).click();
    await expect(dialog.getByRole('alert')).toContainText(`name "${name}" is already used by another device`);
    await expect(dialog.getByLabel('Host', { exact: true })).toHaveValue('127.0.0.1');
    await dialog.getByLabel('Name', { exact: true }).fill(`${name} 2`);
    await dialog.getByRole('button', { name: 'Create device' }).click();
    await expect(page.locator('h2', { hasText: `${name} 2` })).toBeVisible();
  } finally {
    await cleanup({ devices: [name, `${name} 2`] });
  }
});

test('Esc does not throw away a pasted table without asking', async ({ page }) => {
  const profileName = unique('Bulk esc ');
  try {
    await api.post('/api/devices/profiles', { name: profileName, protocol: 'modbus-tcp', params: [{ name: 'line' }], tags: [{ key: 'kw', address: 'holding:1', type: 'uint16' }] });
    await page.goto('/devices?tab=profiles');
    await page.getByRole('button', { name: `Create several devices from ${profileName}` }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Devices (CSV or pasted table)').fill('name,host,line\nkeep me,127.0.0.1,l1\n');
    page.once('dialog', (d) => d.dismiss()); // "Discard the table you pasted?" -> keep editing
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Devices (CSV or pasted table)')).toHaveValue(/keep me/);
    page.once('dialog', (d) => d.accept());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await cleanup({ profiles: [profileName] });
  }
});
