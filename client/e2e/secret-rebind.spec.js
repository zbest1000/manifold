import { test, expect } from './fixtures.js';
import { api, unique, cleanup, deviceByName, openDevice } from './support.js';

/**
 * A stored secret never follows an address change: editing a broker or a device, changing its host and
 * leaving the password blank is refused by the server (400 secret-required), and the form shows why next
 * to the password field instead of a toast. Typing the password again saves.
 */

test('broker: a new host with the password left blank is refused next to the password field', async ({ page }) => {
  const name = unique('E2E rebind broker ');
  const created = await api.post('/api/mqtt/brokers', { name, host: '127.0.0.1', port: 1, protocol: 'mqtt', username: 'u', password: 'stored-pw', reconnect: false });
  expect(created.status).toBe(202);
  const id = created.json.brokerId;
  try {
    await page.goto('/brokers');
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).first().click();
    const form = page.getByRole('dialog', { name: `Edit ${name}` });
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.2');
    await form.getByRole('button', { name: 'Save changes' }).click();

    const password = form.getByLabel('Password (optional)');
    await expect(form.getByRole('alert').filter({ hasText: 'The address changed, so the password must be entered again.' })).toBeVisible();
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(form).toBeVisible(); // nothing was saved; the dialog stays open
    expect((await api.get(`/api/mqtt/brokers/${id}`)).json.broker.host).toBe('127.0.0.1');

    await password.fill('new-pw');
    await expect(form.getByText('The address changed, so the password must be entered again.')).toHaveCount(0);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    await expect.poll(async () => (await api.get(`/api/mqtt/brokers/${id}`)).json?.broker?.host).toBe('127.0.0.2');
  } finally {
    await api.del(`/api/mqtt/brokers/${id}`);
  }
});

test('device: a new host with the stored token left blank is refused next to the token field', async ({ page }) => {
  const name = unique('E2E rebind device ');
  const created = await api.post('/api/devices', {
    name,
    protocol: 'http-json',
    host: '127.0.0.1',
    port: 1,
    enabled: false,
    authType: 'bearer',
    authToken: 'stored-token',
    tags: [{ key: 'k', address: '/m#$.a', type: 'number' }]
  });
  expect(created.status).toBe(201);
  try {
    await page.goto('/devices');
    const drawer = await openDevice(page, name);
    await drawer.getByRole('button', { name: 'Edit device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Edit ${name}` })).toBeVisible();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.2');
    await page.getByRole('button', { name: 'Save changes' }).click();

    const token = page.getByLabel('Bearer token');
    await expect(page.getByRole('alert').filter({ hasText: 'The address changed, so the token must be entered again.' })).toBeVisible();
    await expect(token).toHaveAttribute('aria-invalid', 'true');
    expect((await deviceByName(name)).host).toBe('127.0.0.1');

    await token.fill('new-token');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    expect((await deviceByName(name)).host).toBe('127.0.0.2');
  } finally {
    await cleanup({ devices: [name] });
  }
});
