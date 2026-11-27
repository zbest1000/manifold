import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { api, unique, subscribe, cleanup, startBroker } from './support.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireServer = createRequire(path.resolve(here, '../../server/package.json'));

/**
 * IoT devices over MQTT, end to end against the real backend: an in-worker broker carries simulated
 * Zigbee2MQTT and Home Assistant discovery traffic (server/test/support/iotMqttSimulator.js). The
 * user turns detection on from the suggestion, sees the devices labelled by convention and broker,
 * opens one and watches live values, then maps a tag into the UNS from the Tags workspace and the
 * value arrives on the broker with the unit the bridge described.
 */
test('IoT over MQTT: turn on detection, see devices and live values, map one into the UNS', async ({ page, consoleErrors }) => {
  const broker = await startBroker();
  const brokerId = unique('iot');
  const brokerName = unique('Home broker ');
  const bindingName = unique('E2E IoT ');
  const asset = `e2e/${unique('home')}/living`;
  const { startIotSimulator } = requireServer('./test/support/iotMqttSimulator.js');
  let sim = null;
  const mqtt = await subscribe(`${asset}/#`);
  try {
    const reg = await api.post('/api/mqtt/brokers', { id: brokerId, name: brokerName, host: '127.0.0.1', port: broker.port, protocol: 'mqtt', autoSubscribe: true, reconnect: true, reconnectPeriod: 1000 });
    expect(reg.ok, reg.text).toBe(true);
    await expect.poll(async () => (await api.get(`/api/iot/brokers/${brokerId}`)).json?.status, { timeout: 15_000 }).toBe('connected');
    sim = await startIotSimulator({ port: broker.port });
    await sim.publishRetained();
    sim.live(700);

    await page.goto('/devices?tab=iot');
    await expect(page.getByRole('tab', { name: /IoT over MQTT/ })).toHaveAttribute('aria-selected', 'true');
    const detection = page.getByRole('region', { name: 'Detection' });
    await detection.getByLabel('Broker').selectOption({ label: brokerName });
    // the traffic was recognised: a suggestion turns the convention on
    await detection.getByRole('button', { name: 'Turn on Zigbee2MQTT' }).click();
    await expect(page.getByText(`Detection settings saved for ${brokerName}`)).toBeVisible();
    // another convention by its switch, then save
    const haSwitch = detection.getByRole('switch', { name: 'Home Assistant MQTT discovery' });
    await haSwitch.click({ force: true }); // the native input is visually hidden; the label takes the click
    await expect(haSwitch).toBeChecked();
    await expect(detection.getByLabel('Discovery prefix')).toHaveValue('homeassistant');
    await detection.getByRole('button', { name: 'Save detection settings' }).click();

    const devices = page.getByRole('region', { name: 'IoT devices' });
    const row = devices.getByRole('row').filter({ has: page.getByRole('button', { name: 'living_room/climate', exact: true }) });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(`via ${brokerName}`);
    await expect(row).toContainText('Zigbee2MQTT');
    await expect(devices.getByRole('button', { name: 'Garage environment', exact: true })).toBeVisible();
    await devices.getByLabel('Filter IoT devices').fill('garage');
    await expect(devices.getByRole('button', { name: 'living_room/climate', exact: true })).toHaveCount(0);
    await devices.getByLabel('Filter IoT devices').fill('');

    // detail drawer with tags and live values
    await devices.getByRole('button', { name: 'living_room/climate', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'living_room/climate' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Aqara');
    await expect(drawer).toContainText('does not pair, configure or control');
    const tempRow = drawer.locator('tr[data-tag="temperature"]');
    await expect(tempRow).toContainText('°C');
    await expect(tempRow).toContainText('Good');
    const first = await tempRow.getByTestId('iot-value').textContent();
    await expect.poll(() => tempRow.getByTestId('iot-value').textContent(), { timeout: 15_000, message: 'live value updates' }).not.toBe(first);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

    // map one tag into the UNS from the Tags workspace (source preselected by the link)
    await drawer.getByRole('button', { name: 'Map to UNS' }).click();
    await expect(page).toHaveURL(/\/tags\?source=iot/);
    await expect(page.getByLabel('Source')).toHaveValue(`iot:${brokerId}|z2m:${sim.ieee.climate}`);
    const tree = page.getByRole('tree');
    await tree.getByRole('checkbox', { name: 'Select Temperature', exact: true }).check();
    await page.getByRole('button', { name: /Add to UNS \(1\)/ }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Target broker').selectOption('e2e-broker');
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);
    await expect(editor.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    const latest = (topic) => mqtt.messages.filter((m) => m.topic === topic).at(-1)?.payload;
    await expect.poll(() => latest(`${asset}/Temperature`), { timeout: 20_000 }).toMatchObject({ q: 192, u: '°C' });
    expect(typeof latest(`${asset}/Temperature`).v).toBe('number');
    await expect.poll(() => latest(`${asset}/_meta`)?.properties?.Temperature?.source, { timeout: 20_000 }).toEqual({ brokerId, iotDeviceId: `z2m:${sim.ieee.climate}`, address: 'temperature' });
    // the device going offline at the bridge shows as Bad quality in the UNS
    sim.stopLive();
    await sim.setZigbeeAvailability('living_room/climate', 'offline');
    await expect.poll(() => latest(`${asset}/Temperature`)?.q, { timeout: 20_000 }).toBe(0);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [bindingName] });
    await api.del(`/api/mqtt/brokers/${brokerId}`).catch(() => {});
    await sim?.close().catch(() => {});
    await mqtt.close();
    await broker.close();
  }
});
