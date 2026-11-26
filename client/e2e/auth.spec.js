import { test, expect } from './fixtures.js';
import { startAuthBackend } from './support.js';

/**
 * Authentication on (a second real backend with an admin token and a viewer token):
 *   - the unlock screen, and an explained refusal of a wrong token;
 *   - the admin session can change things;
 *   - a viewer session sees every page but every control that would change something is disabled WITH
 *     the reason (never a click that ends in a raw 403), and the server really refuses the call;
 *   - Settings shows who you are and lets you sign out to use a different token.
 */
let be;
test.beforeAll(async () => {
  be = await startAuthBackend();
});
test.afterAll(async () => {
  await be?.stop();
});

const READ_ONLY = /Read-only session/;

async function signIn(page, token, path = '/devices') {
  await page.goto(`${be.url}${path}`);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

test('the unlock screen refuses a wrong token and explains it; the admin token opens the app', async ({ page }) => {
  await page.goto(`${be.url}/devices`);
  await expect(page.getByText('Manifold is locked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled(); // nothing typed yet

  await page.getByLabel('Access token').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('That token was rejected by the server');
  await expect(page.getByText('Manifold is locked')).toBeVisible();

  await page.getByLabel('Access token').fill(be.admin);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add device' }).first()).toBeEnabled();
  await expect(page.getByText(READ_ONLY).first()).toBeHidden();

  // the token survives a reload: no unlock screen again
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
});

test('a viewer cannot change anything and is told why on every page', async ({ page, request }) => {
  await signIn(page, be.viewer, '/devices');
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Read-only session' }).first()).toBeVisible();

  // Devices
  const add = page.getByRole('button', { name: 'Add device' }).first();
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute('title', /Read-only session/);
  await expect(page.getByRole('button', { name: 'From profile' })).toBeDisabled();
  await page.getByRole('tab', { name: /Profiles/ }).click();
  await expect(page.getByRole('button', { name: 'New profile' }).first()).toBeDisabled();

  // Pipelines: every tab's create button
  await page.goto(`${be.url}/pipelines`);
  await expect(page.getByRole('status').filter({ hasText: 'Read-only session' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Create the first route|New route/ })).toBeDisabled();
  await page.getByRole('tab', { name: 'Models' }).click();
  await expect(page.getByRole('button', { name: /Create the first model|New model/ })).toBeDisabled();
  await page.getByRole('tab', { name: 'Historians' }).click();
  await expect(page.getByRole('button', { name: /Add a historian|Add historian/ })).toBeDisabled();
  await page.getByRole('tab', { name: 'Recorder' }).click();
  await expect(page.getByRole('button', { name: 'New recording' }).first()).toBeDisabled();
  await page.getByRole('tab', { name: 'Contracts' }).click();
  await expect(page.getByRole('button', { name: 'Lock a payload contract' }).first()).toBeDisabled();

  // Tags, OPC UA, Discovery, CESMII, i3X, Settings
  await page.goto(`${be.url}/tags`);
  await expect(page.getByRole('button', { name: /Add to UNS/ })).toBeDisabled();
  await page.goto(`${be.url}/opcua`);
  await expect(page.getByRole('button', { name: 'Connect a server' }).first()).toBeDisabled();
  await page.goto(`${be.url}/discovery`);
  await expect(page.getByRole('button', { name: 'Start scan' })).toBeDisabled();
  await page.goto(`${be.url}/cesmii`);
  await expect(page.getByRole('button', { name: 'Connect to SMIP' })).toBeDisabled();
  await page.goto(`${be.url}/i3x`);
  await expect(page.getByRole('button', { name: 'Connect to i3X' })).toBeDisabled();
  await page.goto(`${be.url}/settings`);
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
  await expect(page.getByText('Viewer (read-only)')).toBeVisible();
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(page.getByText('Import config')).toBeVisible();
  await expect(page.locator('input[type=file][accept=".json"]')).toBeDisabled();
  await page.goto(`${be.url}/alerts?tab=rules`);
  await expect(page.getByRole('button', { name: 'Add rule' })).toHaveAttribute('title', /Read-only session/);

  // and the server really says no (the UI is a courtesy, not the guard)
  const res = await request.post(`${be.url}/api/devices`, { headers: { Authorization: `Bearer ${be.viewer}` }, data: { name: 'x', protocol: 'modbus-tcp', host: '127.0.0.1' } });
  expect(res.status()).toBe(403);
});

test('Settings > Session: sign out returns to the unlock screen so a viewer can switch to the admin token', async ({ page }) => {
  await signIn(page, be.viewer, '/settings');
  await expect(page.getByText('Viewer (read-only)')).toBeVisible();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByText('Manifold is locked')).toBeVisible();
  await page.getByLabel('Access token').fill(be.admin);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Administrator')).toBeVisible();
  // (this backend has no broker, so the button stays disabled for a different reason: no read-only explanation)
  await page.goto(`${be.url}/alerts?tab=rules`);
  await expect(page.getByRole('button', { name: 'Add rule' })).not.toHaveAttribute('title', /Read-only session/);
});

test('a token that stops being valid while the page is open sends you back to the unlock screen', async ({ page }) => {
  await signIn(page, be.admin, '/devices');
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('tc.authToken', 'rotated-away'));
  await page.getByRole('button', { name: 'Refresh device list' }).click();
  await expect(page.getByText('Manifold is locked')).toBeVisible();
});
