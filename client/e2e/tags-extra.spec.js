import { test, expect } from './fixtures.js';
import { api, unique, startModbus, createModbusDevice, deviceByName, subscribe, cleanup } from './support.js';

/**
 * Tags: a mapping links to its place on the UNS page with a stable query string; the editor asks
 * before throwing work away; per-tag settings reach the broker and _meta. (MQTT-topic mappings:
 * tags-mqtt.spec.js.)
 */
test('a mapping links to its place on the UNS page (?broker=&path=)', async ({ page }) => {
  const deviceName = unique('E2E uns link ');
  const bindingName = unique('E2E uns binding ');
  const asset = `e2e/${unique('site')}/line9/mixer`;
  const sim = await startModbus({ value: 3 });
  try {
    const device = await createModbusDevice({ name: deviceName, port: sim.port, tags: [{ key: 'speed', address: '40101', property: 'speed' }] });
    const saved = await api.post('/api/tags/bindings', {
      name: bindingName,
      source: { type: 'device', deviceId: device.id, tags: [{ address: 'speed', name: 'speed' }] },
      target: { mode: 'mqtt', brokerId: 'e2e-broker', assetPath: asset, format: 'envelope', layout: 'topic-per-tag' }
    });
    expect(saved.status).toBe(201);
    await page.goto('/tags?view=mappings');
    await page.getByRole('button', { name: bindingName, exact: true }).click();
    const link = page.getByRole('link', { name: 'Show in UNS' });
    await expect(link).toBeVisible();
    const href = new URL(await link.getAttribute('href'), 'http://x');
    expect(href.pathname).toBe('/uns');
    expect(href.searchParams.get('broker')).toBe('e2e-broker');
    expect(href.searchParams.get('path')).toBe(asset);
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await sim.close();
    expect(await deviceByName(deviceName)).toBeNull();
  }
});

test('Esc in the mapping editor asks before discarding what was entered', async ({ page }) => {
  await page.goto('/tags');
  await page.getByLabel('Source').selectOption({ label: 'E2E broker · topics' });
  await page.getByRole('treeitem', { name: /^plant/ }).getByRole('button', { name: /Select all/ }).click();
  await page.getByRole('button', { name: /Add to UNS \(\d+\)/ }).click();
  const editor = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /Add \d+ topics to the UNS/ }) });
  // untouched: closes at once
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  await page.getByRole('button', { name: /Add to UNS \(\d+\)/ }).click();
  await editor.getByLabel('Name', { exact: true }).fill('half done');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('half done');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await confirm.getByRole('button', { name: 'Discard' }).click();
  await expect(editor).toBeHidden();
});

/**
 * The per-tag table: rename inline, give a unit, scale one tag in its details, switch one tag off,
 * and paste a column of descriptions. The broker gets exactly what the table says, and _meta
 * carries the unit and the descriptions.
 */
test('per-tag table: rename, unit, scale, switch off and paste reach the broker and _meta', async ({ page, consoleErrors }) => {
  const deviceName = unique('E2E per tag ');
  const bindingName = unique('E2E per tag map ');
  const asset = `e2e/${unique('site')}/line3/press`;
  const sim = await startModbus({ value: 40 });
  const mqtt = await subscribe(`${asset}/#`);
  const latest = (t) => mqtt.messages.filter((m) => m.topic === t).at(-1)?.payload;
  try {
    const device = await createModbusDevice({
      name: deviceName,
      port: sim.port,
      tags: [
        { key: 'a', address: '40101', property: 'force' },
        { key: 'b', address: '40101', property: 'stroke' },
        { key: 'c', address: '40101', property: 'cycle' }
      ]
    });
    await expect.poll(async () => (await deviceByName(deviceName))?.status?.state, { timeout: 30_000 }).toBe('online');
    await page.goto(`/tags?source=device:${device.id}`);
    for (const n of ['force', 'stroke', 'cycle']) await page.getByRole('checkbox', { name: `Select ${n}`, exact: true }).click();
    await page.getByRole('button', { name: /Add to UNS \(3\)/ }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);

    await editor.getByLabel('Published name for a').fill('pressForce');
    await editor.getByLabel(/^Unit for pressForce/).fill('kN');
    await editor.getByRole('button', { name: 'Details of pressForce' }).click();
    const details = editor.getByRole('region', { name: 'Details of pressForce' });
    await details.getByLabel('Scale', { exact: true }).fill('0.5');
    await expect(details).toContainText('published = raw × 0.5');
    const off = editor.getByRole('switch', { name: 'Publish c' });
    await off.locator('xpath=..').click();
    await expect(off).not.toBeChecked();
    // paste two descriptions down the column from the first row
    await editor.getByLabel(/^Description for pressForce/).focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Press force\nStroke length\n');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(editor.getByLabel(/^Description for stroke/)).toHaveValue('Stroke length');

    await expect(editor.getByText('Checked by the server', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    await expect.poll(() => latest(`${asset}/pressForce`), { timeout: 30_000 }).toMatchObject({ v: 20, u: 'kN', q: 192 });
    await expect.poll(() => latest(`${asset}/_meta`)?.properties?.pressForce, { timeout: 30_000 }).toMatchObject({ unit: 'kN', description: 'Press force', scale: 0.5 });
    expect(latest(`${asset}/_meta`).properties.stroke).toMatchObject({ description: 'Stroke length' });
    expect(latest(`${asset}/_meta`).properties.cycle).toBeUndefined();
    expect(mqtt.messages.some((m) => m.topic === `${asset}/cycle`)).toBe(false);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await mqtt.close();
    await sim.close();
  }
});
