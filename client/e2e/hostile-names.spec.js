import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { api, baseUrl, publisher, startBroker, unique } from './support.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireServer = createRequire(path.resolve(here, '../../server/package.json'));

/**
 * Untrusted text from the network, rendered through the real backend: MQTT topic names and payloads,
 * a bridge-reported device name and configuration URL (Home Assistant discovery), an alert rule name
 * and an acknowledgement note. Each carries markup that runs script if any page puts it into the DOM
 * as HTML. The pages must show it as text, never as markup, render no `javascript:` link, and the
 * served Content-Security-Policy must hold (no violation reported while the pages run).
 */

const XSS = (tag) => `<img src=x onerror="window.__xss=(window.__xss||[]).concat('${tag}')">`;
const SVG = (tag) => `<svg onload="window.__xss=(window.__xss||[]).concat('${tag}')"></svg>`;

async function watchPage(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

async function assertInert(page, where) {
  // let any injected handler (image error, svg load) run first
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__xss || null), `script ran on ${where}`).toBeNull();
  expect(await page.locator('img[src="x"], svg[onload]').count(), `markup was parsed on ${where}`).toBe(0);
  const jsLinks = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)));
  expect(jsLinks, `script URL rendered as a link on ${where}`).toEqual([]);
  expect(await page.evaluate(() => window.__csp), `CSP violations on ${where}`).toEqual([]);
}

test('the served page carries a Content-Security-Policy that fits the client', async ({ page, consoleErrors }) => {
  await watchPage(page);
  const res = await page.goto('/');
  const csp = res.headers()['content-security-policy'] || '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'"); // nothing embeds Manifold, itself included
  expect(csp).not.toContain('upgrade-insecure-requests'); // plants serve Manifold over plain http on an IP
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  // the app works under it: live socket data arrives and a lazy page with a worker renders
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await page.goto('/topics');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([]);
});

test('hostile topic names, payloads, device names, config URLs, rule names and notes render as text', async ({ page }) => {
  test.setTimeout(150_000);
  const tag = unique('x');
  const topicBase = `e2e/hostile/${tag}`;
  const hostileTopic = `${topicBase}/${XSS('topic')}`;
  const ruleName = `Rule ${XSS('rule')}`;
  const note = `Note ${SVG('note')} ${XSS('note')}`;
  const pub = await publisher();
  const broker = await startBroker();
  const brokerId = unique('hostile');
  const deviceName = `Lab ${XSS('device')}`;
  let ruleId = null;
  let sim = null;
  try {
    // ---- MQTT: a topic name and a payload with markup on the suite's broker
    await pub.publish(hostileTopic, { value: 5, label: XSS('payload') }, { retain: true });
    await pub.publish(`${topicBase}/text`, `${XSS('raw-payload')}`, { retain: true });

    // ---- an alert rule with a hostile name, fired and acknowledged with a hostile note
    const created = await api.post('/api/alerts/rules', { name: ruleName, type: 'value-threshold', brokerId: 'e2e-broker', topic: `${topicBase}/+`, field: 'value', op: '>', value: 1, severity: 'critical' });
    expect(created.ok, created.text).toBe(true);
    ruleId = created.json.rule?.id || created.json.id;
    await pub.publish(hostileTopic, { value: 9 }, { retain: true });
    await expect.poll(async () => ((await api.get('/api/alerts/active')).json?.alarms || []).some((a) => a.ruleId === ruleId), { timeout: 20_000 }).toBe(true);
    const ack = await api.post('/api/alerts/ack', { ruleId, all: true, note });
    expect(ack.ok, ack.text).toBe(true);

    // ---- a Home Assistant discovery device whose name and configuration_url are hostile
    const reg = await api.post('/api/mqtt/brokers', { id: brokerId, name: unique('Hostile broker '), host: '127.0.0.1', port: broker.port, protocol: 'mqtt', autoSubscribe: true, reconnect: true, reconnectPeriod: 1000 });
    expect(reg.ok, reg.text).toBe(true);
    await expect.poll(async () => (await api.get(`/api/iot/brokers/${brokerId}`)).json?.status, { timeout: 15_000 }).toBe('connected');
    const put = await fetch(`${baseUrl()}/api/iot/brokers/${brokerId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conventions: { homeassistant: { enabled: true } } }) });
    expect(put.ok, await put.text()).toBe(true);
    const mqtt = requireServer('mqtt');
    sim = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { reconnectPeriod: 0 });
    await new Promise((resolve, reject) => {
      sim.once('connect', resolve);
      sim.once('error', reject);
    });
    const dev = { ids: [`hostile_${tag}`], name: deviceName, mf: XSS('maker'), mdl: XSS('model'), cu: 'javascript:window.__xss=["config-url"]', configuration_url: 'javascript:window.__xss=["config-url"]' };
    const cfg = { name: XSS('entity'), stat_t: `hostile/${tag}/state`, unit_of_meas: XSS('unit'), uniq_id: `hostile_${tag}_t`, dev };
    await new Promise((resolve) => sim.publish(`homeassistant/sensor/hostile_${tag}/t/config`, JSON.stringify(cfg), { retain: true, qos: 1 }, resolve));
    await new Promise((resolve) => sim.publish(`hostile/${tag}/state`, XSS('state'), { retain: true, qos: 1 }, resolve));
    await expect.poll(async () => ((await api.get(`/api/iot/devices?brokerId=${brokerId}`)).json?.devices || []).length, { timeout: 15_000 }).toBeGreaterThan(0);

    await watchPage(page);

    // ---- every page that shows these strings
    await page.goto('/');
    await expect(page.getByText(ruleName).first()).toBeVisible({ timeout: 20_000 });
    await assertInert(page, 'Overview');

    await page.goto('/alerts');
    await expect(page.getByTestId('alarm-row').filter({ hasText: ruleName }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(XSS('note'), { exact: false }).first()).toBeVisible();
    await assertInert(page, 'Alerts, Active');
    await page.goto('/alerts?tab=history');
    await expect(page.locator('table').getByText(ruleName).first()).toBeVisible({ timeout: 20_000 });
    await assertInert(page, 'Alerts, History');
    await page.goto('/alerts?tab=rules');
    await expect(page.locator('table').getByText(ruleName).first()).toBeVisible();
    await assertInert(page, 'Alerts, Rules');

    await page.goto(`/topics?broker=e2e-broker&topic=${encodeURIComponent(hostileTopic)}`);
    await page.waitForTimeout(2000);
    await assertInert(page, 'Topics (deep link to the hostile topic)');

    await page.goto('/uns?broker=e2e-broker');
    await page.waitForTimeout(2000);
    await assertInert(page, 'UNS');

    await page.goto('/devices?tab=iot');
    const devices = page.getByRole('region', { name: 'IoT devices' });
    const devButton = devices.getByRole('button', { name: deviceName, exact: true });
    await expect(devButton).toBeVisible({ timeout: 20_000 });
    await assertInert(page, 'Devices, IoT over MQTT');
    await devButton.click();
    const drawer = page.getByRole('dialog', { name: deviceName });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(XSS('maker'));
    await assertInert(page, 'IoT device drawer');

    await page.goto(`/tags?source=${encodeURIComponent(`iot:${brokerId}|ha:hostile_${tag}`)}`);
    await page.waitForTimeout(1500);
    await assertInert(page, 'Tags');

    await page.goto('/flows');
    await page.waitForTimeout(1500);
    await assertInert(page, 'Flows');
  } finally {
    if (ruleId) await api.del(`/api/alerts/rules/${ruleId}`).catch(() => {});
    await api.del(`/api/mqtt/brokers/${brokerId}`).catch(() => {});
    await pub.publish(hostileTopic, '', { retain: true }).catch(() => {});
    await pub.publish(`${topicBase}/text`, '', { retain: true }).catch(() => {});
    await pub.close();
    if (sim) await new Promise((resolve) => sim.end(true, {}, resolve));
    await broker.close();
  }
});
