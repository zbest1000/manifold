import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { api, publisher, unique } from './support.js';

/**
 * Alerts, end to end against the real backend and real MQTT input:
 *   - a rule made in the UI fires from a published value, shows up as an active alarm (critical, counted
 *     on the Alerts menu item), is acknowledged with a note, clears, and is in the history (filters, CSV);
 *   - across a server restart (a second backend of this spec's own, so it can be stopped and started on
 *     the same data directory) the history is kept, the alarm that was active is closed "ended by
 *     restart", and the same condition firing again is a new, unacknowledged alarm.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../../server');

async function axeClean(page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(' | ')}`);
  expect(serious, 'axe violations').toEqual([]);
}

test('a rule fires from MQTT, is acknowledged with a note, clears, and is in the history', async ({ page, consoleErrors }) => {
  const name = unique('Tank hot ');
  const topic = `e2e/alarm/${unique('t')}/temp`;
  const pub = await publisher();
  let ruleId = null;
  try {
    // ---- create the rule in the UI, with a severity
    await page.goto('/alerts?tab=rules');
    await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
    await page.getByRole('button', { name: 'Add rule' }).first().click();
    const form = page.getByRole('dialog', { name: 'Add alert rule' });
    await form.getByRole('combobox', { name: /^Type/ }).selectOption('value-threshold');
    await form.getByLabel(/^Name/).fill(name);
    await form.getByRole('combobox', { name: /^Severity/ }).selectOption('critical');
    await form.getByLabel(/^Topic/).fill(topic);
    await form.getByLabel(/^Value/).fill('80');
    await form.getByLabel(/^Clear value/).fill('70');
    await form.getByRole('button', { name: 'Add rule' }).click();
    const ruleRow = page.getByRole('row', { name: new RegExp(name) });
    await expect(ruleRow).toContainText('Critical');
    ruleId = (await api.get('/api/alerts/rules')).json.rules.find((r) => r.name === name).id;

    // ---- a real value over the limit fires it
    await page.getByRole('tab', { name: /^Active/ }).click();
    await pub.publish(topic, '95');
    const row = page.getByTestId('alarm-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('Critical');
    await expect(row).toContainText('Firing, unacknowledged');
    await expect(row).toContainText(topic);
    await expect(row).toContainText('95');
    // counted on the menu item while unacknowledged
    const navAlerts = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Alerts\s*,\s*\d+ unacknowledged critical alarms?$/ });
    await expect(navAlerts).toBeVisible();
    // the duration ticks without a reload
    const duration = row.getByTestId('alarm-duration');
    const first = await duration.innerText();
    await expect.poll(() => duration.innerText(), { timeout: 5000 }).not.toBe(first);
    await axeClean(page);
    if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/alerts-active.png` });

    // ---- in the deadband (below the limit, above the clear value) it stays active
    await pub.publish(topic, '75');
    const current = async () => (await api.get('/api/alerts/active')).json.alarms.find((a) => a.ruleId === ruleId);
    await expect.poll(async () => (await current())?.value, { timeout: 10_000 }).toBe(75); // the server saw 75...
    expect((await current()).state).toBe('firing'); // ...and the alarm is still firing
    await expect(row).toBeVisible();

    // ---- acknowledge with a note
    await row.getByRole('button', { name: new RegExp(`^Acknowledge ${name}`) }).click();
    const dialog = page.getByRole('dialog', { name: 'Acknowledge alarm' });
    await expect(dialog.getByLabel(/^Note/)).toBeFocused();
    await dialog.getByLabel(/^Note/).fill('Checking the cooling loop');
    await dialog.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText('Alarm acknowledged')).toBeVisible();
    await expect(row).toContainText('Acknowledged');
    await expect(row).toContainText('by operator');
    await expect(row).toContainText('Checking the cooling loop');
    await expect(row.getByRole('button', { name: /^Acknowledge/ })).toHaveCount(0);
    const active = (await api.get('/api/alerts/active')).json.alarms.find((a) => a.ruleId === ruleId);
    expect(active.ack).toMatchObject({ by: 'operator', note: 'Checking the cooling loop' });

    // ---- it clears below the clear value
    await pub.publish(topic, '20');
    await expect(row).toHaveCount(0, { timeout: 20_000 });

    // ---- history: firing, acknowledged, resolved; filters; CSV
    await page.getByRole('tab', { name: 'History' }).click();
    await page.getByRole('searchbox', { name: 'Search' }).fill(name);
    const hist = page.getByTestId('history-row');
    await expect(hist).toHaveCount(3);
    await expect(hist.nth(0)).toContainText('Resolved');
    await expect(hist.nth(1)).toContainText('Acknowledged');
    await expect(hist.nth(1)).toContainText('Checking the cooling loop');
    await expect(hist.nth(2)).toContainText('Firing');
    await page.getByRole('combobox', { name: 'State' }).selectOption('acknowledged');
    await expect(hist).toHaveCount(1);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-alerts-')), 'alerts.csv');
    await download.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    expect(csv[0]).toBe('time,seq,state,severity,rule,ruleId,type,broker,topic,value,acknowledgedBy,note,detail');
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(`,acknowledged,critical,${name},`);
    expect(csv[1]).toContain(',operator,Checking the cooling loop,');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    await axeClean(page);
    if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/alerts-history.png` });
    expect(consoleErrors).toEqual([]);
  } finally {
    await pub.close();
    if (ruleId) await api.del(`/api/alerts/rules/${ruleId}`).catch(() => {});
  }
});

test('the Overview links a firing alarm to it on the Alerts page', async ({ page }) => {
  const name = unique('Linked ');
  const topic = `e2e/alarm/${unique('l')}/v`;
  const pub = await publisher();
  const rule = await api.post('/api/alerts/rules', { name, type: 'value-threshold', brokerId: 'e2e-broker', topic, op: '>', value: 1, severity: 'warning' });
  try {
    await pub.publish(topic, '5');
    await page.goto('/');
    const item = page.getByRole('link', { name: new RegExp(`Alert ${name}`) });
    await expect(item).toContainText('Firing', { timeout: 20_000 });
    await item.click();
    await expect(page).toHaveURL(/\/alerts\?alarm=/);
    const row = page.getByTestId('alarm-row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/shadow-\[inset/); // highlighted
  } finally {
    await pub.close();
    await api.del(`/api/alerts/rules/${rule.json.id}`).catch(() => {});
  }
});

// ---- restart ------------------------------------------------------------------------------------

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** A backend of this test's own on `dataDir` (wired to the e2e broker), so it can be restarted. */
async function startBackend({ dataDir, port }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), MANIFOLD_DATA_DIR: dataDir, MANIFOLD_AUTH_TOKEN: '' },
    stdio: 'ignore'
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${url}/api/mqtt/brokers`);
      if (r.ok && ((await r.json()).brokers || []).some((b) => b.status === 'connected')) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, p, body) => {
    const res = await fetch(`${url}${p}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return res.json();
  };
  return {
    url,
    get: (p) => call('GET', p),
    post: (p, body) => call('POST', p, body),
    async stop() {
      child.kill('SIGTERM'); // a clean shutdown flushes the queued history lines
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    }
  };
}

test('after a server restart the history is kept and the active alarm is ended by restart, then fires anew', async ({ page }) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-e2e-alerts-'));
  fs.writeFileSync(
    path.join(dataDir, 'profiles.json'),
    JSON.stringify({ mqtt: { b: { config: { id: 'b', name: 'Restart broker', host: '127.0.0.1', port: Number(process.env.E2E_MQTT_PORT), protocol: 'mqtt', autoSubscribe: true, reconnect: true } } }, opcua: {} })
  );
  const port = await freePort();
  const topic = `e2e/restart/${unique('r')}/p`;
  const pub = await publisher();
  let be = await startBackend({ dataDir, port });
  try {
    const rule = await be.post('/api/alerts/rules', { name: 'Pressure high', type: 'value-threshold', brokerId: 'b', topic, op: '>', value: 10, severity: 'critical' });
    await pub.publish(topic, '50'); // not retained: after the restart nothing re-fires it until a new value
    await expect.poll(async () => (await be.get('/api/alerts/active')).alarms.length, { timeout: 20_000 }).toBe(1);

    await page.goto(`${be.url}/alerts`);
    const row = page.getByTestId('alarm-row').filter({ hasText: 'Pressure high' });
    await row.getByRole('button', { name: /^Acknowledge Pressure high/ }).click();
    await page.getByRole('dialog', { name: 'Acknowledge alarm' }).getByRole('button', { name: 'Acknowledge' }).click();
    await expect(row).toContainText('by operator');

    await be.stop();
    be = await startBackend({ dataDir, port });

    await page.goto(`${be.url}/alerts`);
    await expect(page.getByText('No active alarms', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'History' }).click();
    const hist = page.getByTestId('history-row');
    await expect(hist).toHaveCount(3);
    await expect(hist.nth(0)).toContainText('Ended');
    await expect(hist.nth(0)).toContainText('Ended by restart');
    await expect(hist.nth(1)).toContainText('Acknowledged');
    await expect(hist.nth(2)).toContainText('Firing');

    // the condition again: a new occurrence, unacknowledged
    await pub.publish(topic, '60');
    await page.getByRole('tab', { name: /^Active/ }).click();
    await expect(row).toContainText('Firing, unacknowledged', { timeout: 20_000 });
    expect(rule.id).toBeTruthy();
  } finally {
    await pub.close();
    await be.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
