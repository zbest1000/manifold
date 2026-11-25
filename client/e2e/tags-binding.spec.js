import { test, expect } from './fixtures.js';
import { api, startModbus, createModbusDevice, deviceByName, subscribe, unique, cleanup } from './support.js';

const latestOf = (mqtt) => (topic) => mqtt.messages.filter((m) => m.topic === topic).at(-1)?.payload;

/**
 * Tags: with a Modbus device online and the e2e MQTT broker connected, select two device tags in
 * the tree using only the keyboard, set the asset path in the mapping editor (envelope payloads),
 * create the mapping, and watch the broker for what Manifold publishes: a value topic per tag,
 * the retained `_status` document and the retained `_meta` document.
 */
test('select tags by keyboard, map them to an asset path, see value, _status and _meta on MQTT', async ({ page, consoleErrors }) => {
  const deviceName = unique('E2E bound ');
  const bindingName = unique('E2E binding ');
  const asset = `e2e/${unique('site')}/line1/pump`;
  const sim = await startModbus({ value: 21 }); // holding 40101 = 21
  const mqtt = await subscribe(`${asset}/#`);
  try {
    const device = await createModbusDevice({
      name: deviceName,
      port: sim.port,
      tags: [
        { key: 'speed', address: '40101', property: 'speed', unit: 'rpm' },
        { key: 'speedCopy', address: '40101', property: 'speedCopy' }
      ]
    });
    await expect.poll(async () => (await deviceByName(deviceName))?.status?.state, { message: 'device should go online', timeout: 30_000 }).toBe('online');

    // --- keyboard selection in the tree -------------------------------------------------------
    await page.goto(`/tags?source=device:${device.id}`);
    await expect(page.getByLabel('Source')).toHaveValue(`device:${device.id}`);
    const tree = page.getByRole('tree', { name: new RegExp(deviceName) });
    const items = tree.getByRole('treeitem');
    await expect(items).toHaveCount(2);
    await items.first().focus();
    await page.keyboard.press('Space'); // select the focused tag
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(items.first()).toHaveAttribute('aria-selected', 'true');
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: /Selected tags/ })).toContainText('2');

    // --- the mapping editor --------------------------------------------------------------------
    await page.getByRole('button', { name: /Add to UNS \(2\)/ }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('heading', { name: 'Add 2 tags to the UNS' })).toBeVisible();
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);
    await expect(editor.getByRole('radio', { name: 'Topic per tag' })).toHaveAttribute('aria-checked', 'true');
    await expect(editor.getByRole('radio', { name: 'Envelope' })).toHaveAttribute('aria-checked', 'true');

    // The per-tag table holds one row per tag, named from the device property.
    await expect(editor.getByLabel('Published name for speed', { exact: true })).toHaveValue('speed');
    await expect(editor.getByLabel('Published name for speedCopy')).toHaveValue('speedCopy');

    // The preview beside the form is the server's answer.
    const preview = editor.getByRole('complementary', { name: 'Preview' });
    await expect(preview.getByText('Checked by the server', { exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: 'speed', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();
    // Saving opens the Mappings list with the new mapping.
    await expect(page.getByRole('tab', { name: /Mappings/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('row', { name: new RegExp(bindingName) })).toBeVisible();

    // --- what arrives on the broker -----------------------------------------------------------
    const latest = latestOf(mqtt);
    await expect.poll(() => latest(`${asset}/speed`), { message: 'value topic', timeout: 30_000 }).toMatchObject({ v: 21 });
    // The envelope carries value (v), time (t), quality (q, 192 = good) and the unit (u).
    expect(latest(`${asset}/speed`)).toMatchObject({ v: 21, q: 192, u: 'rpm', t: expect.any(Number) });
    expect(latest(`${asset}/speedCopy`)).toMatchObject({ v: 21, q: 192 });

    await expect.poll(() => latest(`${asset}/_status`), { message: '_status document', timeout: 30_000 }).toBeTruthy();
    expect(latest(`${asset}/_status`)).toMatchObject({ online: true });
    await expect.poll(() => latest(`${asset}/_meta`), { message: '_meta document', timeout: 30_000 }).toBeTruthy();
    expect(JSON.stringify(latest(`${asset}/_meta`))).toContain('speed');

    // The value keeps flowing: a new register value shows up on the topic.
    sim.set(22);
    await expect.poll(() => latest(`${asset}/speed`)?.v, { message: 'updated value', timeout: 30_000 }).toBe(22);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await mqtt.close();
    await sim.close();
  }
});

/**
 * Choosing what to map and adding context: all tags of a device by rule with an exclude pattern
 * (the editor counts what matches), an asset context key with a placeholder that must reach
 * `_meta`, a field selection without the timestamp, then an edit that switches one tag off.
 */
test('map by rule with an exclude, asset context in _meta, fields without t, then switch a tag off', async ({ page, consoleErrors }) => {
  const deviceName = unique('E2E rules ');
  const bindingName = unique('E2E rule map ');
  const asset = `e2e/${unique('site')}/line2/filler`;
  const sim = await startModbus({ value: 5 });
  const mqtt = await subscribe(`${asset}/#`);
  const latest = latestOf(mqtt);
  try {
    const device = await createModbusDevice({
      name: deviceName,
      port: sim.port,
      tags: [
        { key: 'speed', address: '40101', property: 'speed', unit: 'rpm' },
        { key: 'temp', address: '40101', property: 'temperature', unit: 'degC' },
        { key: 'DB10_spare', address: '40101' }
      ]
    });
    await expect.poll(async () => (await deviceByName(deviceName))?.status?.state, { timeout: 30_000 }).toBe('online');

    await page.goto(`/tags?source=device:${device.id}`);
    await page.getByRole('button', { name: 'Map by rule' }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('radio', { name: 'All tags by rule' })).toHaveAttribute('aria-checked', 'true');
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);

    // rule selection: exclude by glob; the count updates as you type
    await editor.getByLabel('Exclude').fill('*spare*');
    await editor.getByLabel('Exclude').press('Enter');
    const what = editor.locator('#map-what');
    await expect(what).toContainText('2 of 3 tags match');
    await expect(what.getByRole('button', { name: '1 excluded' })).toBeVisible();
    await expect(what).toContainText('Tags added to the device later are picked up automatically');

    // asset context with a placeholder
    const ctx = editor.locator('#map-context');
    await ctx.getByRole('button', { name: 'Add key' }).click();
    await ctx.getByLabel(/^Key/).last().fill('site');
    await ctx.getByLabel(/^Value of/).last().fill('e2e');
    await ctx.getByRole('button', { name: 'Add key' }).click();
    await ctx.getByLabel(/^Key/).last().fill('equipmentId');
    await ctx.getByLabel(/^Value of/).last().click();
    await ctx.getByRole('button', { name: /^Insert \{deviceId\}/ }).click();
    await expect(ctx.getByLabel('Value of equipmentId')).toHaveValue('{deviceId}');

    // field selection: drop the timestamp
    await editor.getByRole('checkbox', { name: /^t timestamp/ }).uncheck();
    await expect(editor.getByRole('button', { name: 'Use defaults' }).first()).toBeVisible();

    await expect(editor.getByText('Checked by the server', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    await expect.poll(() => latest(`${asset}/speed`), { timeout: 30_000 }).toBeTruthy();
    expect(latest(`${asset}/speed`)).toEqual({ v: 5, q: 192, u: 'rpm' }); // no t
    await expect.poll(() => latest(`${asset}/_meta`)?.context, { timeout: 30_000 }).toEqual({ site: 'e2e', equipmentId: device.id });
    expect(Object.keys(latest(`${asset}/_meta`).properties).sort()).toEqual(['speed', 'temperature']);
    expect(mqtt.messages.some((m) => m.topic.endsWith('/spare') || m.topic.endsWith('/DB10_spare'))).toBe(false);

    // per-tag on/off: switch temperature off in the table and save
    await page.getByRole('button', { name: `Edit mapping ${bindingName}` }).click();
    await expect(editor.getByText('Checked by the server', { exact: true })).toBeVisible();
    const sw = editor.getByRole('switch', { name: 'Publish temp' });
    await expect(sw).toBeChecked();
    await sw.locator('xpath=..').click();
    await expect(sw).not.toBeChecked();
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor).toBeHidden();
    const stored = (await api.get('/api/tags/bindings')).json.bindings.find((b) => b.name === bindingName);
    expect(stored.source).toMatchObject({ tags: 'all', select: { exclude: ['*spare*'] }, overrides: { temp: { enabled: false } } });
    await expect.poll(() => Object.keys(latest(`${asset}/_meta`)?.properties || {}), { timeout: 30_000 }).toEqual(['speed']);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [bindingName], devices: [deviceName] });
    await mqtt.close();
    await sim.close();
  }
});
