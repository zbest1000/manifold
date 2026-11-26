import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { startHttpJson, startMtconnect, unique, cleanup, deviceRow, openDevice, deviceByName } from './support.js';

/**
 * Devices: an HTTP/JSON device and an MTConnect agent added through the form, each polled from its
 * in-process simulator. Both go Online and show live values; the HTTP device is also checked for
 * its credential handling (hidden after saving, kept on edit) and the MTConnect one for the
 * import-from-agent dialog.
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

for (const theme of ['dark', 'light']) {
  test(`the HTTP/JSON and MTConnect forms have no serious axe violations (${theme} theme)`, async ({ page, consoleErrors }) => {
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('tc.theme', t);
      } catch {
        /* storage unavailable */
      }
    }, theme);
    await openAddDevice(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const protocol of ['http-json', 'mtconnect']) {
      await page.getByLabel('Protocol', { exact: true }).selectOption(protocol);
      await page.getByLabel('Scheme', { exact: true }).selectOption('https');
      await page.getByLabel('Authentication', { exact: true }).selectOption('basic');
      await expect(page.getByLabel('Password')).toBeVisible();
      await expect(page.getByLabel(/^Pinned certificate fingerprint \(SHA-256/)).toBeVisible();
      await page.getByRole('button', { name: 'Add tag' }).click();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(' | ')}`);
      expect(serious, `${protocol} form`).toEqual([]);
    }
    expect(consoleErrors).toEqual([]);
  });
}

const liveCell = (scope, key) => scope.locator(`tr[data-tag-key="${key}"] [data-quality]`);

test('HTTP/JSON device with bearer authentication: live values, secret never shown again', async ({ page, consoleErrors }) => {
  const name = unique('E2E HTTP ');
  const device = await startHttpJson();
  device.sim.requireHeader('authorization', 'Bearer e2e-secret-token');
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: device.port, protocol: 'http-json' });
    await expect(page.getByRole('note').filter({ hasText: 'Verified only against a simulator' })).toBeVisible();

    // Credential fields appear only for the chosen scheme; TLS fields only for https.
    await expect(page.getByLabel('Bearer token')).toHaveCount(0);
    await expect(page.getByLabel('Do not verify the TLS certificate')).toHaveCount(0);
    await page.getByLabel('Authentication', { exact: true }).selectOption('bearer');
    await page.getByLabel('Bearer token').fill('e2e-secret-token');
    await expect(page.getByLabel('Bearer token')).toHaveAttribute('type', 'password');
    await page.getByLabel('Path (optional)', { exact: true }).fill('/api');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('power');
    await page.getByLabel('Address, row 1').fill('/meter#$.power.total');
    await page.getByLabel('Type, row 1').selectOption('number');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('state');
    await page.getByLabel('Address, row 2').fill('/meter#$.state');
    await page.getByLabel('Type, row 2').selectOption('string');

    await page.getByRole('button', { name: 'Create device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();

    const row = deviceRow(page, name);
    await expect(row.getByText('Online', { exact: true })).toBeVisible();
    await expect(row.getByText('Experimental')).toBeVisible();
    const drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'power')).toHaveText(/^\s*12\.5(?!\d)/);
    await expect(liveCell(drawer, 'power')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'state')).toContainText('OK');

    // The API never returns the token; the stored device still has it.
    const stored = await deviceByName(name);
    expect(stored.authToken).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('e2e-secret-token');

    // Everything the server sent to the simulator was a GET.
    expect(device.sim.requests.length).toBeGreaterThan(0);
    expect(device.sim.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await device.close();
  }
});

test('HTTP/JSON device: a bad HTTP status shows as Bad with its reason', async ({ page, consoleErrors }) => {
  const name = unique('E2E HTTP bad ');
  const device = await startHttpJson();
  device.sim.setStatus('/api/broken', 500, '{}');
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: device.port, protocol: 'http-json' });
    await page.getByLabel('Path (optional)', { exact: true }).fill('/api');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('good');
    await page.getByLabel('Address, row 1').fill('/meter#$.power.total');
    await page.getByLabel('Type, row 1').selectOption('number');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('broken');
    await page.getByLabel('Address, row 2').fill('/broken#$.v');
    await page.getByLabel('Type, row 2').selectOption('number');
    await page.getByRole('button', { name: 'Create device' }).click();

    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();
    const drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'good')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'broken')).toHaveAttribute('data-quality', 'bad');
    await expect(drawer.locator('tr[data-tag-key="broken"]')).toContainText('http-500');
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await device.close();
  }
});

test('MTConnect agent: live values, then import a data item from the agent with its unit', async ({ page, consoleErrors }) => {
  const name = unique('E2E MTC ');
  const agent = await startMtconnect();
  try {
    await openAddDevice(page);
    await fillConnection(page, { name, port: agent.port, protocol: 'mtconnect' });
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('xpos');
    await page.getByLabel('Address, row 1').fill('Xact');
    await page.getByLabel('Type, row 1').selectOption('number');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('exec');
    await page.getByLabel('Address, row 2').fill('exec');
    await page.getByLabel('Type, row 2').selectOption('string');
    await page.getByRole('button', { name: 'Create device' }).click();

    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();
    const drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'xpos')).toHaveText(/^\s*12\.5(?!\d)/);
    await expect(liveCell(drawer, 'exec')).toContainText('ACTIVE');

    // The agent changes a value: it arrives without a reload.
    agent.sim.setValue('Xact', 20.25);
    await expect(liveCell(drawer, 'xpos')).toHaveText(/^\s*20\.25(?!\d)/);

    await drawer.getByRole('button', { name: 'Import from agent' }).click();
    const browse = page.getByRole('dialog', { name: /Import tags from/ });
    const tree = browse.getByRole('tree', { name: 'Agent tags' });
    const machine = tree.getByRole('treeitem', { name: /mill-1/ });
    await expect(machine).toBeVisible();
    await machine.focus();
    await page.keyboard.press('ArrowRight');
    const axes = tree.getByRole('treeitem', { name: /Axes/ });
    await expect(axes).toBeVisible();
    await axes.focus();
    await page.keyboard.press('ArrowRight');
    const x = tree.getByRole('treeitem', { name: /^Expand X / });
    await expect(x).toBeVisible();
    await x.focus();
    await page.keyboard.press('ArrowRight');
    const load = tree.getByRole('treeitem', { name: /Xload/ });
    await expect(load).toBeVisible();
    await load.focus();
    await page.keyboard.press('Space');
    await expect(browse.getByText('1 selected')).toBeVisible();
    await browse.getByRole('button', { name: 'Add 1 tag' }).click();
    await expect(browse).toBeHidden();

    // The imported row carries the data item id, a number type and the unit from /probe.
    await expect(page.getByLabel('Address, row 3')).toHaveValue('Xload');
    await expect(page.getByLabel('Type, row 3')).toHaveValue('number');
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await agent.close();
  }
});
