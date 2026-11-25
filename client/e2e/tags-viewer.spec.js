import { test, expect } from './fixtures.js';
import { startAuthBackend, startBroker, startModbus, unique } from './support.js';

/**
 * The viewer role on the Tags page, against a real backend with authentication: everything that
 * would change something is disabled with the reason, while looking is allowed - the editor opens
 * read-only and the server preview still answers, the orphaned-topic dry run lists, CSV export works.
 */
let be;
let broker;
let sim;
test.beforeAll(async () => {
  be = await startAuthBackend();
  broker = await startBroker();
  sim = await startModbus({ value: 12 });
});
test.afterAll(async () => {
  await be?.stop();
  await broker?.close();
  await sim?.close();
});

async function admin(method, url, body) {
  const res = await fetch(`${be.url}${url}`, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${be.admin}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('viewer: the mapping editor is read-only with reasons; preview, dry run and CSV export still work', async ({ page }) => {
  const name = unique('Viewer map ');
  const b = await admin('POST', '/api/mqtt/brokers', { id: 'vb', name: 'Viewer broker', host: '127.0.0.1', port: broker.port, protocol: 'mqtt', reconnect: true });
  expect(b.status).toBe(202);
  const d = await admin('POST', '/api/devices', { name: unique('Viewer dev '), protocol: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1, enabled: true, pollGroups: [{ id: 'default', intervalMs: 500 }], tags: [{ key: 'temp', address: '40101', type: 'uint16', pollGroup: 'default', property: 'temperature' }] });
  expect(d.status).toBeLessThan(300);
  await expect.poll(async () => (await admin('GET', '/api/mqtt/brokers')).json?.brokers?.find((x) => x.id === 'vb')?.status, { timeout: 15_000 }).toBe('connected');
  const m = await admin('POST', '/api/tags/bindings', { name, source: { type: 'device', deviceId: d.json.id, tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'vb', assetPath: 'viewer/site/pump', format: 'envelope' } });
  expect(m.status).toBe(201);

  await page.goto(`${be.url}/tags?view=mappings`);
  await page.getByLabel('Access token').fill(be.viewer);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole('switch', { name: `Disable mapping ${name}` }).or(page.getByRole('checkbox', { name: `Disable mapping ${name}` }))).toBeDisabled();
  await expect(page.getByRole('button', { name: `Delete mapping ${name}` })).toBeDisabled();

  // the orphaned-topic dry run is a read: it lists; clearing is not offered
  await page.getByRole('button', { name: 'Clear orphaned retained topics' }).click();
  const cleanup = page.getByRole('dialog', { name: 'Clear orphaned retained topics' });
  await expect(cleanup.getByText(/Nothing to clear|would be cleared/)).toBeVisible();
  await expect(cleanup.getByRole('button', { name: /^Clear/ })).toBeDisabled();
  await cleanup.getByRole('button', { name: 'Close' }).first().click();

  // the editor: read-only, saving disabled with the reason, the server preview still answers
  await page.getByRole('button', { name: `View mapping ${name}` }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('status').filter({ hasText: 'Read-only session' })).toBeVisible();
  await expect(editor.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(editor.getByLabel('Published name for temp', { exact: true })).toBeDisabled();
  const save = editor.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute('title', /Read-only session/);
  await expect(editor.getByRole('button', { name: 'Import CSV' })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Import CSV' })).toHaveAttribute('title', /Read-only session/);
  await expect(editor.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), editor.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  await expect(editor.getByRole('list', { name: 'Payload fields in publish order' }).getByRole('button', { name: 'Move t up' })).toBeDisabled();
  await editor.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(editor).toBeHidden();

  // the map workspace: everything that creates is disabled with the reason
  await page.getByRole('tab', { name: 'Map tags' }).click();
  await expect(page.getByRole('button', { name: /Add to UNS/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Map by rule' })).toHaveAttribute('title', /Read-only session/);
  await expect(page.getByRole('button', { name: 'CSV' })).toBeDisabled();
});
