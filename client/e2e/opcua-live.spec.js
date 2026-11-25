import { test, expect } from './fixtures.js';
import { unique, startOpcua, cleanupOpcua } from './support.js';

/**
 * The OPC UA page driven live against a REAL OPC UA server (node-opcua, started in the test worker):
 * connect through the form, browse with the keyboard, monitor values, Bad quality, a server restart
 * (reconnecting -> connected, values resume), edit and delete.
 */

let srv;
test.beforeEach(async () => {
  srv = await startOpcua();
});
test.afterEach(async () => {
  await srv?.close();
});

/** Screenshots for review go to E2E_SHOTS_DIR when it is set (nothing is written otherwise). */
async function shot(page, name) {
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/${name}.png` });
}

const explorer = (page) => page.getByRole('region', { name: 'Address space explorer' });
const tree = (page) => explorer(page).getByRole('tree', { name: 'Nodes' });
const item = (page, name) => tree(page).getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) });

/** Focus a tree row, then expand it with ArrowRight and wait for children. */
async function expandWithKeyboard(page, name, child) {
  const row = item(page, name);
  await row.focus();
  await row.press('ArrowRight');
  await expect(item(page, child)).toBeVisible();
}

test('connect (None) through the form, browse with the keyboard, monitor live values and see Bad quality', async ({ page, consoleErrors }) => {
  const name = unique('opc-none-');
  try {
    await page.goto('/opcua');
    await page.getByRole('button', { name: 'Connect a server' }).first().click();
    const form = page.getByRole('dialog', { name: 'New OPC UA connection' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Endpoint URL').fill(srv.endpointUrl);
    await form.getByRole('button', { name: 'Discover' }).click();
    const endpoints = form.getByRole('list', { name: 'Discovered endpoints' });
    await expect(endpoints.getByRole('button')).toHaveCount(5);
    await endpoints.getByRole('button', { name: /^None · None/ }).click();
    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(form).toBeHidden();

    const table = page.getByRole('table', { name: 'OPC UA server connections' });
    const row = table.getByRole('row').filter({ hasText: name });
    await expect(row.getByText('Connected', { exact: true })).toBeVisible();

    // Tree view, keyboard only: server -> Objects -> Manifold -> Scalars -> Double
    await explorer(page).getByRole('radio', { name: 'Tree' }).click();
    await expandWithKeyboard(page, name, 'Objects');
    await item(page, name).press('ArrowDown');
    await expect(item(page, 'Objects')).toBeFocused();
    await expandWithKeyboard(page, 'Objects', 'Manifold');
    await expandWithKeyboard(page, 'Manifold', 'Scalars');
    await expandWithKeyboard(page, 'Scalars', 'Double');
    await item(page, 'Double').press('Enter');

    const details = page.getByRole('complementary', { name: 'Node details' });
    await expect(details.getByText(srv.nodeId('Scalars.Double'), { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Monitor value' }).click();
    await expect(details.getByRole('button', { name: 'Stop monitoring' })).toBeVisible();

    const live = details.getByRole('region', { name: 'Live value' });
    srv.set('Scalars.Double', 12.25);
    await expect(live.getByText('12.25', { exact: true })).toBeVisible();
    srv.set('Scalars.Double', 13.5);
    await expect(live.getByText('13.5', { exact: true })).toBeVisible();
    await expect(live.getByText('Good', { exact: true })).toBeVisible();

    // Bad quality with the value unchanged is shown as Bad, in the panel and in the list
    srv.setStatus('Scalars.Double', 'BadSensorFailure');
    await expect(live.getByText('Bad', { exact: true })).toBeVisible();
    await expect(live.getByText(/BadSensorFailure/)).toBeVisible();
    const list = page.getByRole('table', { name: 'Monitored values' });
    await expect(list.getByRole('row').filter({ hasText: 'Double' }).getByText('Bad', { exact: true })).toBeVisible();

    // selecting another node does not stop the first one
    await item(page, 'Int32').click();
    await expect(details.getByText(srv.nodeId('Scalars.Int32'), { exact: true })).toBeVisible();
    srv.set('Scalars.Double', 99.5);
    await expect(list.getByRole('row').filter({ hasText: 'Double' }).getByText('99.5', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Monitor value' }).click();
    srv.set('Scalars.Int32', 4242);
    await expect(list.getByRole('row').filter({ hasText: 'Int32' }).getByText('4242', { exact: true })).toBeVisible();
    srv.setStatus('Scalars.Double', 'BadSensorFailure');
    await expect(list.getByRole('row').filter({ hasText: 'Double' }).getByText('Bad', { exact: true })).toBeVisible();

    await shot(page, 'opcua-explorer-live-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'opcua-explorer-live-light');
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanupOpcua({ connections: [name] });
  }
});

/** Connect through the form with the given fields; returns the dialog. */
async function openForm(page) {
  await page.goto('/opcua');
  await page.getByRole('button', { name: 'Connect a server' }).first().click();
  return page.getByRole('dialog', { name: 'New OPC UA connection' });
}

const connRow = (page, name) => page.getByRole('table', { name: 'OPC UA server connections' }).getByRole('row').filter({ hasText: name });

test('secure connect (SignAndEncrypt, user name): the untrusted server certificate is explained, trusted in the form, then the session opens', async ({ page }) => {
  const name = unique('opc-sec-');
  try {
    const form = await openForm(page);
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Endpoint URL').fill(srv.endpointUrl);
    await form.getByRole('button', { name: 'Discover' }).click();
    await form.getByRole('list', { name: 'Discovered endpoints' }).getByRole('button', { name: /^SignAndEncrypt · Basic256Sha256/ }).click();
    await expect(form.getByRole('combobox', { name: /^Security mode/ })).toHaveValue('SignAndEncrypt');
    await form.getByLabel('Username (optional)').fill('operator');
    await form.getByLabel('Password').fill('secret');
    await expect(form.getByRole('button', { name: /Certificates and trust/ })).toHaveAttribute('aria-expanded', 'true');
    await shot(page, 'opcua-form-secure');

    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(form.getByText(/certificate is not trusted/i).first()).toBeVisible({ timeout: 30_000 });
    // the refused certificate is waiting in step 3 without reopening anything
    const trust = form.getByRole('button', { name: /^Trust certificate/ });
    await expect(trust).toBeVisible();
    await shot(page, 'opcua-form-secure-trust');
    await trust.click();
    await expect(form.getByText(/1 server certificate is already trusted/)).toBeVisible();

    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 30_000 });
    await expect(connRow(page, name).getByText('Connected', { exact: true })).toBeVisible();
    await expect(connRow(page, name).getByText('SignAndEncrypt · Basic256Sha256')).toBeVisible();
  } finally {
    await cleanupOpcua({ connections: [name] });
  }
});

test('server restart: the state goes reconnecting -> connected and monitored values resume; edit in place; delete', async ({ page }) => {
  const name = unique('opc-rs-');
  try {
    const form = await openForm(page);
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Endpoint URL').fill(srv.endpointUrl);
    await form.getByLabel('Endpoint URL').press('Enter');
    await expect(connRow(page, name).getByText('Connected', { exact: true })).toBeVisible();

    await explorer(page).getByRole('radio', { name: 'Tree' }).click();
    await expandWithKeyboard(page, name, 'Objects');
    await expandWithKeyboard(page, 'Objects', 'Manifold');
    await expandWithKeyboard(page, 'Manifold', 'Quality');
    await expandWithKeyboard(page, 'Quality', 'Value');
    await item(page, 'Value').click();
    const details = page.getByRole('complementary', { name: 'Node details' });
    await details.getByRole('button', { name: 'Monitor value' }).click();
    const live = details.getByRole('region', { name: 'Live value' });
    srv.set('Quality.Value', 5);
    await expect(live.getByText('5', { exact: true })).toBeVisible();

    await srv.stop();
    await expect(connRow(page, name).getByText('Reconnecting', { exact: true })).toBeVisible();
    await expect(page.getByText('Last values received; live values resume when the connection is back.')).toBeVisible();
    await shot(page, 'opcua-reconnecting');
    await srv.start();
    await expect(connRow(page, name).getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    srv.set('Quality.Value', 6);
    await expect(live.getByText('6', { exact: true })).toBeVisible();
    await expect(page.getByText('Last values received; live values resume when the connection is back.')).toBeHidden();

    // edit in place: rename, the session is rebuilt and keeps the monitored node
    await connRow(page, name).getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.getByRole('dialog', { name: 'Edit OPC UA connection' });
    await edit.getByLabel('Name', { exact: true }).fill(`${name}-b`);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    await expect(connRow(page, `${name}-b`).getByText('Connected', { exact: true })).toBeVisible();
    await expect(connRow(page, `${name}-b`).getByRole('cell', { name: '1', exact: true })).toBeVisible();
    srv.set('Quality.Value', 7);
    await expect(page.getByRole('table', { name: 'Monitored values' }).getByText('7', { exact: true })).toBeVisible();

    // delete
    await connRow(page, `${name}-b`).getByRole('button', { name: `Disconnect and remove ${name}-b` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect and remove' }).click();
    await expect(connRow(page, `${name}-b`)).toHaveCount(0);
    await expect.poll(() => srv.sessionCount()).toBe(0);
  } finally {
    await cleanupOpcua({ connections: [name, `${name}-b`] });
  }
});

test('phone width: the connection table and explorer stay usable at 390 px without page overflow', async ({ page }) => {
  const name = unique('opc-m-');
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const form = await openForm(page);
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Endpoint URL').fill(srv.endpointUrl);
    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(connRow(page, name).getByText('Connected', { exact: true })).toBeVisible();
    await explorer(page).getByRole('radio', { name: 'Tree' }).click();
    await expandWithKeyboard(page, name, 'Objects');
    await expandWithKeyboard(page, 'Objects', 'Manifold');
    await expandWithKeyboard(page, 'Manifold', 'Deep');
    for (let i = 1; i <= 8; i++) await expandWithKeyboard(page, i === 1 ? 'Deep' : `L${i - 1}`, `L${i}`);
    await expandWithKeyboard(page, 'L8', 'Leaf');
    await item(page, 'Leaf').click();
    const details = page.getByRole('complementary', { name: 'Node details' });
    await expect(details.getByText(srv.nodeId(srv.deepLeaf()), { exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'opcua-mobile-deep');
    await details.getByRole('button', { name: 'Close node details' }).click();
    await expect(details).toBeHidden();
  } finally {
    await cleanupOpcua({ connections: [name] });
  }
});
