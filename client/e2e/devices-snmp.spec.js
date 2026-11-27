import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { startSnmp, unique, cleanup, deviceRow, openDevice } from './support.js';

/**
 * SNMP: a v2c device added in the form against the in-process agent goes Online with live values,
 * its community is never shown again (the edit form keeps it without displaying it), the v3 fields
 * appear only for v3, and a tag is imported by walking the agent's system group.
 */

const liveCell = (scope, key) => scope.locator(`tr[data-tag-key="${key}"] [data-quality]`);

async function axeSerious(page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(' | ')}`);
}

test('SNMP v2c device: live values, a community that is never shown again, browse import', async ({ page, consoleErrors }) => {
  const name = unique('E2E SNMP ');
  const agent = await startSnmp({ communities: ['e2e-ro'] });
  try {
    await page.goto('/devices');
    await page.getByRole('button', { name: 'Add device' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Protocol', { exact: true }).selectOption('snmp');
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(agent.port));
    await expect(page.getByRole('note').filter({ hasText: 'Verified only against a simulator' })).toBeVisible();

    // v3 fields only for v3; the community only for v1/v2c.
    const version = page.getByLabel('SNMP version');
    await version.selectOption('3');
    await expect(page.getByLabel('User name')).toBeVisible();
    await expect(page.getByLabel('Authentication password')).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Community')).toHaveCount(0);
    await page.getByLabel('Security level').selectOption('noAuthNoPriv');
    await expect(page.getByLabel('Authentication password')).toHaveCount(0);
    expect(await axeSerious(page)).toEqual([]);
    await version.selectOption('2c');
    await expect(page.getByLabel('User name')).toHaveCount(0);
    const community = page.getByLabel('Community');
    await expect(community).toHaveAttribute('type', 'password');
    await community.fill('e2e-ro');

    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('sysname');
    await page.getByLabel('Address, row 1').fill('sysName.0');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 2').fill('hcIn');
    await page.getByLabel('Address, row 2').fill('ifHCInOctets.1');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 3').fill('inRate');
    await page.getByLabel('Address, row 3').fill('ifInOctets.1');
    await page.getByLabel('Rate per second, row 3').check();

    await page.getByRole('button', { name: 'Create device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    const row = deviceRow(page, name);
    await expect(row.getByText('Online', { exact: true })).toBeVisible();
    await expect(row).toContainText('SNMP v2c');

    let drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'sysname')).toHaveText(/sim-agent/);
    await expect(liveCell(drawer, 'sysname')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'hcIn')).toHaveText(/1,?099,?511,?640,?121/);

    // Import from the agent: walk the system group by keyboard and add sysLocation.0.
    await drawer.getByRole('button', { name: 'Import from agent' }).click();
    const browse = page.getByRole('dialog', { name: /Import tags from/ });
    const tree = browse.getByRole('tree');
    const system = tree.getByRole('treeitem', { name: / system \(1\.3\.6\.1\.2\.1\.1\)/ });
    await expect(system).toBeVisible();
    await system.focus();
    await page.keyboard.press('ArrowRight');
    await expect(system).toHaveAttribute('aria-expanded', 'true');
    const location = tree.getByRole('treeitem', { name: /sysLocation\.0 = Lab/ });
    await expect(location).toBeVisible();
    await location.focus();
    await page.keyboard.press('Space');
    await browse.getByRole('button', { name: 'Add 1 tag' }).click();
    await expect(browse).toBeHidden();
    await expect(page.locator('tr[data-tag-key="sysLocation.0"]')).toBeVisible();

    // The edit form never shows the stored community and saving without it keeps it.
    const stored = page.getByLabel('Community');
    await expect(stored).toHaveValue('');
    await expect(stored).toHaveAttribute('placeholder', 'stored, leave blank to keep');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
    await expect(deviceRow(page, name).getByText('Online', { exact: true })).toBeVisible();
    drawer = await openDevice(page, name, 'Tags');
    await expect(liveCell(drawer, 'sysLocation.0')).toHaveText(/Lab/);
    await expect(liveCell(drawer, 'sysLocation.0')).toHaveAttribute('data-quality', 'good');
    await expect(liveCell(drawer, 'inRate')).toHaveAttribute('data-quality', 'good'); // a rate once two polls exist
    expect(agent.sim.stats.pduTypes.every((t) => [0xa0, 0xa1, 0xa5].includes(t))).toBe(true);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [name] });
    await agent.close();
  }
});

test('the SNMP form is axe-clean in the light theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await page.getByLabel('Protocol', { exact: true }).selectOption('snmp');
  await expect(page.getByLabel('Community')).toBeVisible();
  expect(await axeSerious(page)).toEqual([]);
  await page.getByLabel('SNMP version').selectOption('3');
  await expect(page.getByLabel('Privacy password')).toBeVisible();
  expect(await axeSerious(page)).toEqual([]);
});
