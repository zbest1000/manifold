import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { startMatterServer, startZwaveJsServer, unique, cleanup, deviceRow, openDevice } from './support.js';

/**
 * Devices: the WebSocket bridge drivers. A Matter Server device and a Z-Wave JS Server device
 * are added in the UI against their in-process simulators, go Online and show live values that
 * the simulators push; the Z-Wave value is imported through the browse dialog. The simulators
 * refuse and record any non-read command; none may arrive.
 */

async function openAddDevice(page) {
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
}

async function fillConnection(page, { name, port, protocol }) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Protocol', { exact: true }).selectOption(protocol);
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(port));
}

const liveCell = (scope, key) => scope.locator(`tr[data-tag-key="${key}"] [data-quality]`);

test('Matter Server device: connection test, live value pushed by the server', async ({ page, consoleErrors }) => {
  const name = unique('E2E Matter ');
  const m = await startMatterServer();
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: m.port, protocol: 'matter-server' });
    await expect(page.getByLabel('Path', { exact: true })).toHaveValue('/ws');
    await expect(page.getByLabel('Do not verify the TLS certificate')).toHaveCount(0); // only for wss
    await expect(page.getByRole('note').filter({ hasText: 'Verified only against a simulator' })).toBeVisible();

    await page.getByRole('button', { name: 'Test connection' }).click();
    const ok = page.getByText(/^Connected/);
    await expect(ok).toBeVisible();
    await expect(page.getByText('Nodes', { exact: true })).toBeVisible();
    await expect(page.getByText('API schema', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('temperature');
    await page.getByLabel('Address, row 1').fill('1/1/TemperatureMeasurement/MeasuredValue');
    await page.getByRole('button', { name: 'Create device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();

    const drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'temperature')).toHaveText(/^\s*21\.34(?!\d)/);
    await expect(liveCell(drawer, 'temperature')).toHaveAttribute('data-quality', 'good');
    m.sim.setAttribute(1, '1/1026/0', 2275);
    await expect(liveCell(drawer, 'temperature')).toHaveText(/^\s*22\.75(?!\d)/);
    expect(m.sim.violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await m.close();
  }
});

test('Z-Wave JS Server device: import a value from the server, live update', async ({ page, consoleErrors }) => {
  const name = unique('E2E ZWave ');
  const z = await startZwaveJsServer();
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: z.port, protocol: 'zwave-js' });
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('battery');
    await page.getByLabel('Address, row 1').fill('2/Battery/0/level');
    await page.getByRole('button', { name: 'Create device' }).click();
    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();

    let drawer = await openDevice(page, name, 'Tags');
    // Node 2 is asleep: last value, Good quality.
    await expect(liveCell(drawer, 'battery')).toHaveText(/^\s*87(?!\d)/);
    await expect(liveCell(drawer, 'battery')).toHaveAttribute('data-quality', 'good');

    await drawer.getByRole('button', { name: 'Import from server' }).click();
    const browse = page.getByRole('dialog', { name: /Import tags from/ });
    const tree = browse.getByRole('tree', { name: 'Server tags' });
    const node = tree.getByRole('treeitem', { name: /Node 3 - Zooz ZEN15/ });
    await node.focus();
    await page.keyboard.press('ArrowRight');
    const cc = tree.getByRole('treeitem', { name: /Binary Switch \(0x25\)/ });
    await cc.focus();
    await page.keyboard.press('ArrowRight');
    const value = tree.getByRole('treeitem', { name: /Select Current value/ });
    await value.focus();
    await page.keyboard.press('Space');
    await browse.getByRole('button', { name: 'Add 1 tag' }).click();
    await expect(browse).toBeHidden();
    await expect(page.getByLabel('Address, row 2')).toHaveValue('3/37/0/currentValue');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();

    drawer = await openDevice(page, name, 'Tags');
    const key = '3_37_0_currentValue';
    await expect(liveCell(drawer, key)).toHaveText(/true/);
    z.sim.valueUpdated(3, { commandClass: 37, endpoint: 0, property: 'currentValue' }, false);
    await expect(liveCell(drawer, key)).toHaveText(/false/);
    expect(z.sim.violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await z.close();
  }
});

for (const theme of ['dark', 'light']) {
  test(`bridge device form (wss, token) has no serious axe violations (${theme} theme)`, async ({ page, consoleErrors }) => {
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('tc.theme', t);
      } catch {
        /* storage unavailable */
      }
    }, theme);
    await openAddDevice(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await fillConnection(page, { name: unique('E2E axe '), port: 5580, protocol: 'zwave-js' });
    // A whole URL in Host is split into scheme, host, port and path when the field is left.
    await page.getByLabel('Host', { exact: true }).fill('wss://bridge.example:8443/zwave');
    await page.getByLabel('Host', { exact: true }).press('Tab');
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('bridge.example');
    await expect(page.getByLabel('Port', { exact: true })).toHaveValue('8443');
    await expect(page.getByLabel('Scheme', { exact: true })).toHaveValue('wss');
    await expect(page.getByLabel('Path', { exact: true })).toHaveValue('/zwave');
    await expect(page.getByLabel('Do not verify the TLS certificate')).toBeVisible();
    await expect(page.getByLabel('Bearer token', { exact: true })).toHaveAttribute('type', 'password');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
    expect(serious).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
