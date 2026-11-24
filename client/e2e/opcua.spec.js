import { test, expect } from './fixtures.js';
import { api } from './support.js';

/**
 * OPC UA, failure paths only: no OPC UA server is available to the suite (node-opcua's server is not a
 * dependency), so what is covered is validation before anything is sent (and not before the first
 * attempt), Enter to submit, and what a refused connection leaves behind.
 */
test('the connect form validates before sending, submits with Enter, and a refused connection leaves no ghost row', async ({ page }) => {
  await page.goto('/opcua');
  await page.getByRole('button', { name: 'Connect a server' }).first().click();
  const form = page.getByRole('dialog', { name: 'New OPC UA connection' });
  const url = form.getByLabel('Endpoint URL');
  await expect(form.getByRole('alert')).toHaveCount(0); // a fresh form flags nothing

  await url.fill('http://plc:4840');
  await form.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('The endpoint URL must look like opc.tcp://host:4840')).toBeVisible();

  await url.fill('opc.tcp://plc:4840');
  await form.getByRole('combobox', { name: /^Security mode/ }).selectOption('Sign');
  await form.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText(/Security mode Sign needs a security policy/)).toBeVisible();
  expect((await api.get('/api/opcua/connections')).json.connections).toHaveLength(0); // nothing was sent
  await form.getByRole('combobox', { name: /^Security mode/ }).selectOption('None');

  // a refused connection: the server's message is shown in plain words, the form keeps what was typed,
  // and no half-created "connecting" entry stays in the list
  await url.fill('opc.tcp://127.0.0.1:1');
  await url.press('Enter');
  await expect(page.getByText('Connection refused — nothing is listening on that host and port.').first()).toBeVisible({ timeout: 30_000 });
  await expect(form.getByLabel('Endpoint URL')).toHaveValue('opc.tcp://127.0.0.1:1');
  await expect(page.getByRole('table', { name: 'OPC UA server connections' })).toBeHidden();
  expect((await api.get('/api/opcua/connections')).json.connections).toHaveLength(0);
});
