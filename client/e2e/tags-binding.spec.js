import { test, expect } from './fixtures.js';
import { startModbus, createModbusDevice, deviceByName, subscribe, unique, cleanup } from './support.js';

/**
 * Tags: with a Modbus device online and the e2e MQTT broker connected, select two device tags in
 * the tree using only the keyboard, walk the three wizard steps to an asset path with the
 * envelope payload format, create the binding, and watch the broker for what Manifold publishes:
 * a value topic per tag, the retained `_status` document and the retained `_meta` document.
 */
test('select tags by keyboard, bind them to an asset path, see value, _status and _meta on MQTT', async ({ page, consoleErrors }) => {
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
    await expect(page.getByRole('heading', { name: /Selected tags/ })).toContainText('(2)');

    // --- the wizard ---------------------------------------------------------------------------
    await page.getByRole('button', { name: /Add to UNS \(2\)/ }).click();
    const wizard = page.getByRole('dialog');
    await expect(wizard.getByRole('heading', { name: 'Add 2 tags to the UNS' })).toBeVisible();

    // 1. Target: name, asset path, one topic per tag.
    await wizard.getByLabel('Binding name').fill(bindingName);
    await wizard.getByLabel('Asset path', { exact: true }).fill(asset);
    await wizard.getByRole('radio', { name: /One topic per tag/ }).check();
    await wizard.getByRole('button', { name: 'Next' }).click();

    // 2. Naming: the server previews the topics; choose the envelope format.
    await expect(wizard.getByRole('region', { name: 'Naming' })).toBeVisible();
    await wizard.getByRole('radio', { name: /Envelope/ }).check();
    await expect(wizard.getByText('Checked by the server')).toBeVisible();
    await expect(wizard.getByText(`${asset}/speed`, { exact: true })).toBeVisible();
    await wizard.getByRole('button', { name: 'Next' }).click();

    // 3. Options: defaults are fine; create.
    await expect(wizard.getByRole('region', { name: 'Options' })).toBeVisible();
    await wizard.getByRole('button', { name: 'Create binding' }).click();
    await expect(wizard).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(bindingName) })).toBeVisible();

    // --- what arrives on the broker -----------------------------------------------------------
    const latest = (topic) => mqtt.messages.filter((m) => m.topic === topic).at(-1)?.payload;
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
