import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { api, baseUrl, publisher, startBroker, startHistorianStub, startOpcua, cleanupOpcua, unique } from './support.js';

/**
 * UX audit (November 2026) against the real backend, with data present rather than empty states:
 *   - a wildcard value rule firing on two topics, one acknowledged, is one Overview line that
 *     counts them and links to the Active list, not one topic name;
 *   - IoT over MQTT, a broker with detection on shows a one-line summary and the device list
 *     on the first screen; the settings open with a button;
 *   - a focused search box shows one focus indicator (its ring), not the global outline too;
 *   - axe on the Routes table with routes (sortable headers with hints) and on OPC UA with a
 *     connection (the Explore / Exploring button), where the empty pages had nothing to find.
 */

async function seriousAxe(page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(' | ')}`);
}

test('a wildcard rule firing on two topics, one acknowledged, is counted on the Overview', async ({ page }) => {
  const tag = unique('w');
  const ruleName = unique('Robot hot ');
  const topics = [`e2e/${tag}/robot-a/temperature`, `e2e/${tag}/robot-b/temperature`];
  const pub = await publisher();
  let ruleId = null;
  try {
    const created = await api.post('/api/alerts/rules', { name: ruleName, type: 'value-threshold', brokerId: 'e2e-broker', topic: `e2e/${tag}/+/temperature`, field: 'value', op: '>', value: 39, sustainMs: 0 });
    expect(created.ok, created.text).toBe(true);
    ruleId = created.json.rule?.id || created.json.id;
    for (const t of topics) await pub.publish(t, { value: 45 });
    await expect.poll(async () => ((await api.get('/api/alerts/active')).json?.alarms || []).filter((a) => a.ruleId === ruleId).length, { timeout: 20_000 }).toBe(2);
    const ack = await api.post('/api/alerts/ack', { ruleId, topic: topics[0], note: 'on it' });
    expect(ack.ok, ack.text).toBe(true);

    await page.goto('/');
    const item = page.getByRole('link', { name: new RegExp(`^Alert ${ruleName}`) });
    await expect(item).toContainText('Firing on 2 topics · 1 unacknowledged', { timeout: 30_000 });
    await expect(item).not.toContainText('robot-a');
    await expect(item).toHaveAttribute('href', '/alerts');

    // The Active list keeps Acknowledge in view: the table fits at 1440 px, and a tablet gets cards
    await item.click();
    await expect(page.getByTestId('alarm-row').filter({ hasText: ruleName }).first()).toBeVisible();
    const region = page.getByRole('region', { name: 'Active alarms' });
    expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth), 'Active alarms table scrolls sideways at 1440 px').toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1024, height: 768 });
    const cards = page.getByRole('list', { name: 'Active alarms' });
    await expect(cards.getByRole('button', { name: /^Acknowledge/ }).first()).toBeInViewport();
  } finally {
    if (ruleId) await api.del(`/api/alerts/rules/${ruleId}`).catch(() => {});
    await pub.close();
  }
});

test('with detection on, the IoT tab summarises it and shows the device list first', async ({ page }) => {
  const broker = await startBroker();
  const brokerId = unique('s15');
  const brokerName = unique('S15 broker ');
  try {
    const reg = await api.post('/api/mqtt/brokers', { id: brokerId, name: brokerName, host: '127.0.0.1', port: broker.port, protocol: 'mqtt', autoSubscribe: true, reconnect: true, reconnectPeriod: 1000 });
    expect(reg.ok, reg.text).toBe(true);
    await expect.poll(async () => (await api.get(`/api/iot/brokers/${brokerId}`)).json?.status, { timeout: 15_000 }).toBe('connected');
    const all = ['zigbee2mqtt', 'zwavejs', 'homeassistant', 'tasmota', 'shelly', 'chirpstack'];
    const put = await fetch(`${baseUrl()}/api/iot/brokers/${brokerId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conventions: Object.fromEntries(all.map((c) => [c, { enabled: true }])) }) });
    expect(put.ok, await put.text()).toBe(true);

    await page.goto('/devices?tab=iot');
    const detection = page.getByRole('region', { name: 'Detection' });
    await detection.getByLabel('Broker').selectOption({ label: brokerName });
    await expect(detection.getByTestId('iot-detection-summary')).toContainText('Reading Zigbee2MQTT, Z-Wave JS UI, Home Assistant MQTT discovery');
    await expect(detection.getByRole('switch')).toHaveCount(0);
    const box = await detection.boundingBox();
    expect(box.y + box.height, 'the Detection panel leaves most of the first screen to the device list').toBeLessThan(450);
    const edit = detection.getByRole('button', { name: 'Edit detection settings' });
    await expect(edit).toHaveAttribute('aria-expanded', 'false');
    await edit.click();
    await expect(detection.getByRole('switch', { name: 'Tasmota' })).toBeChecked();
    await expect(detection.getByRole('button', { name: 'Hide detection settings' })).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await api.del(`/api/mqtt/brokers/${brokerId}`).catch(() => {});
    await broker.close();
  }
});

test('a focused search box shows one focus indicator', async ({ page }) => {
  await page.goto('/uns');
  const search = page.getByRole('combobox').or(page.getByRole('searchbox')).first();
  await expect(search).toBeVisible();
  await search.focus();
  await page.keyboard.type('plant');
  const outline = await search.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, color: s.outlineColor, width: s.outlineWidth };
  });
  // Tailwind's outline-hidden is a transparent outline: either none or fully transparent
  expect(outline.style === 'none' || /rgba\(0, 0, 0, 0\)|transparent/.test(outline.color), JSON.stringify(outline)).toBe(true);
  // ...while the field's own ring is there
  const ring = await search.evaluate((el) => {
    for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).boxShadow !== 'none') return getComputedStyle(p).boxShadow;
    return 'none';
  });
  expect(ring).not.toBe('none');
});

test('axe with data: Routes table with sortable hinted headers, OPC UA with a connection', async ({ page }) => {
  const stub = await startHistorianStub();
  const hid = (await api.post('/api/historians', { type: 'timebase', name: unique('UX historian '), url: stub.url, dataset: 'UX' })).json.id;
  const route = await api.post('/api/pipelines', { name: unique('UX route '), source: { brokerId: 'e2e-broker', filter: 'plant/line1/#' }, transforms: [{ type: 'numeric', field: 'value' }], target: { type: 'historian', historianId: hid } });
  const ua = await startOpcua();
  const uaName = unique('UX OPC UA ');
  try {
    expect(route.ok, route.text).toBe(true);
    await page.goto('/pipelines');
    await expect(page.getByRole('button', { name: 'Delivered' })).toBeVisible();
    expect(await page.locator('button button').count(), 'no button inside a button').toBe(0);
    expect(await seriousAxe(page)).toEqual([]);

    const conn = await api.post('/api/opcua/connections', { name: uaName, endpointUrl: ua.endpointUrl });
    expect(conn.ok, conn.text).toBe(true);
    await page.goto('/opcua');
    await expect(page.getByRole('button', { name: new RegExp(`^Explor(e|ing) ${uaName}`) })).toBeVisible({ timeout: 20_000 });
    expect(await seriousAxe(page)).toEqual([]);
  } finally {
    if (route.json?.id) await api.del(`/api/pipelines/${route.json.id}`).catch(() => {});
    await api.del(`/api/historians/${hid}`).catch(() => {});
    await cleanupOpcua({ connections: [uaName] });
    await ua.close();
    await stub.close();
  }
});
