import path from 'node:path';
import { test, expect } from './fixtures.js';
import { cleanup, deviceRow, openDevice, startDiscoveryLab, unique } from './support.js';

/**
 * Network discovery, for real. The backend (global-setup) runs with MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 and
 * no MANIFOLD_ALLOW_PRIVATE_TARGETS, so:
 *
 *   - a scan of 127.0.0.1/32 is REAL: the page asks the server to scan, the server connects to simulators
 *     started in this worker (Modbus, S7, EtherNet/IP, an MQTT broker on TCP and WebSocket, a UA-TCP server,
 *     a silent port, a tarpit, a resetting port) and identifies them with their real protocols. Nothing is
 *     mocked or stubbed on either side;
 *   - the refusal states are the real server's too: a private LAN range is refused because that flag is off.
 *
 * Set E2E_SHOTS_DIR to also write screenshots there.
 */
const shot = async (page, name) => {
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, `${name}.png`), fullPage: true });
};

const endpoint = (page, port) => page.locator(`tr[data-endpoint="127.0.0.1:${port}"]`);
// Pacing fields carry a help line in their accessible name ("Label Help text"), the port boxes do not.
const portsBox = (page, name) => page.getByRole('textbox', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}( |$)`) });

async function openAdvanced(page) {
  const toggle = page.getByRole('button', { name: 'Advanced options' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test('scan the loopback simulators from the UI, add a Modbus device, re-scan: it is already added', async ({ page, consoleErrors }) => {
  const lab = await startDiscoveryLab();
  const deviceName = unique('Scanned meter ');
  const knownBrokerPort = process.env.E2E_MQTT_PORT; // the backend's own "E2E broker": a broker Manifold already has
  try {
    await page.goto('/discovery');
    await expect(page.getByRole('heading', { level: 1, name: 'Discovery' })).toBeVisible();
    await expect(page.getByText('No scan yet')).toBeVisible();

    // The range, then what to look for: i3X off (not probed on loopback), the three PLC protocols on.
    await page.getByLabel('Range: CIDR, IP address or hostname').fill('127.0.0.1/32');
    await page.getByRole('checkbox', { name: /^i3X servers/ }).uncheck();
    for (const name of [/^Modbus TCP/, /^Siemens S7/, /^EtherNet\/IP/]) await page.getByRole('checkbox', { name }).check();

    // Device probing needs an explicit acknowledgement first; until then the scan cannot start.
    await expect(page.getByText('Looking for PLCs and meters touches an OT network')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start scan' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /^I understand/ }).click();
    await expect(page.getByRole('checkbox', { name: /^I understand/ })).toHaveCount(0); // now just a reminder
    await expect(page.getByRole('button', { name: 'Start scan' })).toBeEnabled();

    // Ports in Advanced options: where the simulators actually listen.
    await openAdvanced(page);
    await portsBox(page, 'MQTT brokers ports').fill(`${lab.mqttPort}, ${lab.silent.port}${knownBrokerPort ? `, ${knownBrokerPort}` : ''}`);
    await portsBox(page, 'MQTT over WebSocket ports').fill(String(lab.mqttWsPort));
    await portsBox(page, 'OPC UA servers ports').fill(String(lab.opcua.port));
    await portsBox(page, 'Modbus TCP ports').fill(`${lab.modbus.port}, ${lab.reset.port}`);
    await portsBox(page, 'Siemens S7 ports').fill(String(lab.s7.port));
    await portsBox(page, 'EtherNet/IP ports').fill(String(lab.eip.port));
    await portsBox(page, 'Identify timeout (ms)').fill('1500');

    // The server's own planner reports what is about to happen.
    const plan = page.getByTestId('scan-plan');
    await expect(plan).toContainText('1 host');
    await expect(plan).toContainText('probes');
    await expect(plan).toContainText('Usually about');
    await shot(page, '1-scan-options');

    await page.getByRole('button', { name: 'Start scan' }).click();

    // Every protocol is identified, with the identity text it answered.
    await expect(endpoint(page, lab.mqttPort)).toContainText('MQTT broker');
    await expect(endpoint(page, lab.mqttPort)).toContainText('Anonymous access allowed');
    await expect(endpoint(page, lab.mqttPort)).toContainText('Verified');
    await expect(endpoint(page, lab.mqttWsPort)).toContainText('WebSocket');
    await expect(endpoint(page, lab.opcua.port)).toContainText('OPC UA server');
    await expect(endpoint(page, lab.opcua.port)).toContainText('UA-TCP server answered the Hello');
    await expect(endpoint(page, lab.modbus.port)).toContainText('Modbus TCP');
    await expect(endpoint(page, lab.modbus.port)).toContainText('Identified');
    await expect(endpoint(page, lab.modbus.port)).toContainText('Modbus server, unit 1');
    await expect(endpoint(page, lab.s7.port)).toContainText('Siemens CPU 1516-3 PN/DP');
    await expect(endpoint(page, lab.s7.port)).toContainText('6ES7 516-3AN02-0AB0');
    await expect(endpoint(page, lab.s7.port)).toContainText('V2.9.4');
    await expect(endpoint(page, lab.eip.port)).toContainText('1769-L33ER/A LOGIX5333ER');
    await expect(endpoint(page, lab.eip.port)).toContainText('Rockwell Automation / Allen-Bradley');
    await expect(endpoint(page, lab.eip.port)).toContainText('Programmable Logic Controller');

    // A port that is open and silent is an honestly labelled "open port", never a device; the reset port is absent.
    await expect(endpoint(page, lab.silent.port)).toContainText('Open port');
    await expect(endpoint(page, lab.silent.port)).toContainText('did not answer an MQTT CONNECT');
    await expect(endpoint(page, lab.reset.port)).toHaveCount(0);
    // A broker Manifold already has is marked by the server.
    if (knownBrokerPort) {
      await expect(endpoint(page, knownBrokerPort)).toContainText('Already added');
      await expect(endpoint(page, knownBrokerPort).getByRole('link', { name: /E2E broker/ })).toHaveAttribute('href', '/brokers');
    }
    await expect(page.getByText('Last scan of 127.0.0.1/32')).toBeVisible();
    await shot(page, '3-results-all-protocols');

    // Identification never wrote anything and left nothing open.
    expect(lab.writes()).toEqual({ modbus: 0, s7: 0, eip: 0 });
    await expect.poll(() => lab.totalOpen(), { message: 'the scan must not leak sockets' }).toBe(0);

    // The filter narrows the table.
    await page.getByRole('radio', { name: /^Devices/ }).click();
    await expect(endpoint(page, lab.modbus.port)).toBeVisible();
    await expect(endpoint(page, lab.mqttPort)).toHaveCount(0);
    await page.getByRole('radio', { name: /^All/ }).click();

    // Add the Modbus device from its result: the Devices form opens prefilled, nothing is created yet.
    await page.getByRole('button', { name: `Add 127.0.0.1:${lab.modbus.port} as device` }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add device' })).toBeVisible();
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('127.0.0.1');
    await expect(page.getByLabel('Port', { exact: true })).toHaveValue(String(lab.modbus.port));
    await page.getByLabel('Name', { exact: true }).fill(deviceName);
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByLabel('Key, row 1').fill('reg');
    await page.getByLabel('Address, row 1').fill('40001');
    await page.getByLabel('Type, row 1').selectOption('uint16');
    await page.getByLabel('Poll group, row 1').selectOption('default');
    await shot(page, '5-add-as-device');
    await page.getByRole('button', { name: 'Create device' }).click();

    // It goes online with a live value read from the simulator.
    const row = deviceRow(page, deviceName);
    await expect(row.getByText('Online', { exact: true })).toBeVisible();
    const drawer = await openDevice(page, deviceName, 'Tags');
    const live = drawer.locator('tr[data-tag-key="reg"] [data-quality]');
    await expect(live).toHaveText(/^\s*7/);
    await expect(live).toHaveAttribute('data-quality', 'good');
    await drawer.getByRole('button', { name: 'Close' }).click();

    // Back on Discovery the last results are still there; a re-scan marks the device as already added.
    await page.goto('/discovery');
    await expect(endpoint(page, lab.modbus.port)).toBeVisible();
    // The form starts from its defaults again (the page does not remember the last scan's options), so the
    // re-scan asks for the simulator ports once more; only Modbus is ticked this time.
    await page.getByLabel('Range: CIDR, IP address or hostname').fill('127.0.0.1/32');
    await page.getByRole('checkbox', { name: /^i3X servers/ }).uncheck();
    for (const name of [/^MQTT brokers/, /^OPC UA servers/, /^Siemens S7/, /^EtherNet\/IP/]) await page.getByRole('checkbox', { name }).uncheck();
    await page.getByRole('checkbox', { name: /^Modbus TCP/ }).check();
    await openAdvanced(page);
    await portsBox(page, 'Modbus TCP ports').fill(String(lab.modbus.port));
    await page.getByRole('button', { name: 'Start scan' }).click();
    await expect(endpoint(page, lab.modbus.port)).toContainText('Already added');
    await expect(endpoint(page, lab.modbus.port).getByRole('link', { name: new RegExp(deviceName) })).toHaveAttribute('href', '/devices');
    await expect(endpoint(page, lab.modbus.port).getByRole('button', { name: /^Add 127\.0\.0\.1:\d+ as device again$/ })).toBeVisible();
    await expect(page.getByText('Last scan of 127.0.0.1/32')).toBeVisible();

    // A page reload shows the same results (the server keeps the last scan), with the marker.
    await page.reload();
    await expect(endpoint(page, lab.modbus.port)).toContainText('Already added');
    await expect(endpoint(page, lab.modbus.port)).toContainText('Modbus server, unit 1'); // from the second scan
    await expect(endpoint(page, lab.eip.port)).toHaveCount(0); // the second scan replaced the first one's results
    expect(lab.writes()).toEqual({ modbus: 0, s7: 0, eip: 0 });

    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ devices: [deviceName] });
    await lab.close();
  }
});

test('a running scan shows live progress and Cancel stops it without leaving connections', async ({ page }) => {
  const lab = await startDiscoveryLab();
  try {
    await page.goto('/discovery');
    await page.getByLabel('Range: CIDR, IP address or hostname').fill('127.0.0.1/32');
    await page.getByRole('checkbox', { name: /^MQTT brokers/ }).uncheck();
    await page.getByRole('checkbox', { name: /^OPC UA servers/ }).uncheck();
    await page.getByRole('checkbox', { name: /^i3X servers/ }).uncheck();
    await page.getByRole('checkbox', { name: /^Modbus TCP/ }).check();
    await page.getByRole('checkbox', { name: /^I understand/ }).click(); // a fresh browser context remembers nothing
    await openAdvanced(page);
    await portsBox(page, 'Modbus TCP ports').fill(`${lab.tarpit.port}, ${lab.silent.port}, ${lab.modbus.port}`);
    await portsBox(page, 'Identify timeout (ms)').fill('15000');
    await portsBox(page, 'Connections per host').fill('1');
    await page.getByRole('button', { name: 'Start scan' }).click();

    const progress = page.getByRole('region', { name: 'Scan progress' });
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Scanning 127.0.0.1/32');
    await expect(progress).toContainText('of 3 probes');
    await expect(progress.getByRole('progressbar')).toBeVisible();
    await expect(progress).toContainText('left');
    await expect.poll(() => lab.tarpit.open).toBeGreaterThan(0); // a connection really is in flight
    await shot(page, '2-in-progress');

    const t0 = Date.now();
    await progress.getByRole('button', { name: 'Cancel scan' }).click();
    await expect(page.getByText('Scan cancelled')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start scan' })).toBeEnabled();
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect.poll(() => lab.totalOpen(), { message: 'cancel must leave no sockets open' }).toBe(0);
  } finally {
    await lab.close();
  }
});

test('refusals name the exact setting, or say that nothing will allow the range', async ({ page }) => {
  await page.goto('/discovery');
  const range = page.getByLabel('Range: CIDR, IP address or hostname');

  // A LAN range: refused because MANIFOLD_ALLOW_PRIVATE_TARGETS is not set on this backend.
  await range.fill('192.168.1.0/24');
  const banner = page.getByRole('status').filter({ hasText: 'This server will not scan that range' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('MANIFOLD_ALLOW_PRIVATE_TARGETS=1');
  await expect(banner).not.toContainText('MANIFOLD_ALLOW_LOOPBACK_DEVICES');
  await expect(page.getByRole('button', { name: 'Start scan' })).toBeDisabled();
  await shot(page, '4-refused');

  // A documentation range: no flag exists for it.
  await range.fill('192.0.2.0/24');
  await expect(banner).toContainText('No setting allows this range');
  await expect(banner.locator('code')).toHaveCount(0);

  // A range that is too large says so, with size and the limit.
  await range.fill('10.0.0.0/16');
  const big = page.getByRole('status').filter({ hasText: 'That range is too large for one scan' });
  await expect(big).toContainText('65,534 hosts');
  await expect(big).toContainText('MANIFOLD_DISCOVERY_MAX_HOSTS');

  // Bad input is explained next to the field, before anything is sent.
  await range.fill('300.1.1.0/24');
  await expect(page.getByText('Not an IPv4 address. Use the form 192.168.1.0/24.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start scan' })).toBeDisabled();
  await range.fill('fe80::1');
  await expect(page.getByText(/IPv6 is not supported/)).toBeVisible();

  // The same server accepts loopback (its flag IS set), so the refusal above is about the range, not the page.
  await range.fill('127.0.0.1/32');
  await expect(page.getByTestId('scan-plan')).toContainText('1 host');
  await expect(page.getByRole('button', { name: 'Start scan' })).toBeEnabled();
});

test('the page works by keyboard, in the light theme, and at phone width', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/discovery');
  const range = page.getByLabel('Range: CIDR, IP address or hostname');
  await range.focus();
  await range.fill('127.0.0.1/32');
  await page.keyboard.press('Tab'); // the "This subnet" helper (when the server detected one) or the first checkbox
  await expect(page.locator(':focus')).toBeVisible();
  // a checkbox reachable and toggled with the keyboard alone
  const mqtt = page.getByRole('checkbox', { name: /^MQTT brokers/ });
  await mqtt.focus();
  await page.keyboard.press('Space');
  await expect(mqtt).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(mqtt).toBeChecked();
  const toggle = page.getByRole('button', { name: 'Advanced options' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // no horizontal page scroll at 390 px
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, '6-phone-light');
});
