import AxeBuilder from '@axe-core/playwright';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { api, baseUrl, unique } from './support.js';

/**
 * Broker canary, security posture and public-broker presets, against the real backend.
 *
 *   - the canary is opt-in from the connect form (and says it publishes), reaches OK through a real broker,
 *     stays out of the topic list, shows in /metrics, and an ACL refusal reads as "not permitted" in the
 *     details and in Overview's Needs attention;
 *   - the broker details list the security findings worst first, and the list carries a compact summary;
 *   - the presets fill the form with a narrow filter and a public-broker warning (the duplicate refusal for a
 *     preset is covered in server/test/posture.test.js, so no test connects to a public broker).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const requireServer = createRequire(path.resolve(here, '../../server/package.json'));
const mqttPort = () => Number(process.env.E2E_MQTT_PORT);

/** An in-process broker; `acl` are aedes authorize hooks. */
async function startBroker(acl = {}) {
  const aedesModule = requireServer('aedes');
  const Aedes = aedesModule.Aedes || aedesModule;
  const aedes = Aedes.createBroker ? await Aedes.createBroker(acl) : new Aedes(acl);
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => {
      await new Promise((r) => aedes.close(r));
      await new Promise((r) => server.close(r));
    }
  };
}

async function brokerByName(name) {
  const { json } = await api.get('/api/mqtt/brokers');
  return (json?.brokers || []).find((b) => b.name === name) || null;
}

async function axeSerious(page, include) {
  const results = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}: ${v.nodes[0]?.html.slice(0, 140)}`);
}

test('canary: opt in from the form, round trip reaches OK, stays out of the topic list, shows in /metrics', async ({ page }) => {
  const name = unique('E2E canary ');
  let id;
  try {
    await page.goto('/brokers');
    await page.getByRole('button', { name: 'Connect a broker' }).first().click();
    const form = page.getByRole('dialog', { name: 'Connect a broker' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Port', { exact: true }).fill(String(mqttPort()));
    await form.getByRole('button', { name: /Connection settings/ }).click();
    await form.getByLabel(/Subscription filter/).fill(`canary-e2e/${name.length}/#`);

    // Off by default, and it says plainly that it publishes.
    const probe = form.getByLabel('Probe this broker with a canary message');
    await expect(probe).not.toBeChecked();
    await expect(form.getByText(/publishes a small message to your broker/)).toBeVisible();
    await probe.check();
    await form.getByLabel('Probe every (seconds)').fill('5');
    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(form).toBeHidden();

    await expect.poll(async () => (await brokerByName(name))?.id).toBeTruthy();
    id = (await brokerByName(name)).id;

    // The row carries the canary state; the details show the numbers.
    await expect(page.getByTestId(`canary-line-${id}`)).toContainText(/Canary: OK/, { timeout: 30_000 });
    await page.getByRole('button', { name: `Details for ${name}`, exact: true }).first().click();
    const detail = page.getByTestId('broker-detail');
    await expect(detail.getByTestId('canary-state')).toHaveAttribute('data-state', 'ok');
    await expect(detail.getByText('Latency p95')).toBeVisible();
    await expect(detail.getByText(/Success rate/)).toBeVisible();
    await expect(detail.getByText(`manifold/canary/${id.slice(0, 8)}`)).toBeVisible();

    // Nothing of it in the topic tree, and Prometheus has it.
    await expect.poll(async () => (await api.get(`/api/mqtt/brokers/${id}/canary`)).json.sent).toBeGreaterThan(1);
    const topics = (await api.get(`/api/mqtt/brokers/${id}/topics`)).json.topics.map((t) => t.topic);
    expect(topics.filter((t) => t.startsWith('manifold/'))).toEqual([]);
    const metrics = await fetch(`${baseUrl()}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(new RegExp(`manifold_broker_canary_state\\{broker="${name}",state="ok"\\} 1`));
    expect(metrics).toContain(`manifold_broker_canary_latency_ms{broker="${name}",quantile="0.95"}`);
  } finally {
    if (id) await api.del(`/api/mqtt/brokers/${id}`);
  }
});

test('canary: a broker that refuses the subscription reads as not permitted, here and in Needs attention', async ({ page }) => {
  const acl = await startBroker({ authorizeSubscribe: (client, sub, cb) => cb(null, sub.topic.startsWith('manifold/canary/') ? null : sub) });
  const name = unique('E2E acl ');
  const created = await api.post('/api/mqtt/brokers', { name, host: '127.0.0.1', port: acl.port, subscribeFilter: 'plant/#', canary: { enabled: true, intervalSec: 5 } });
  expect(created.status).toBe(202);
  const id = created.json.brokerId;
  try {
    await expect.poll(async () => (await api.get(`/api/mqtt/brokers/${id}/canary`)).json.state, { timeout: 20_000 }).toBe('not-permitted');
    expect((await api.get(`/api/mqtt/brokers/${id}/canary`)).json.refused).toBe('subscribe');

    await page.goto('/brokers');
    await expect(page.getByTestId(`canary-line-${id}`)).toContainText('Not permitted (subscribe)');
    await page.getByRole('button', { name: `Details for ${name}`, exact: true }).first().click();
    const detail = page.getByTestId('broker-detail');
    await expect(detail.getByTestId('canary-state')).toHaveAttribute('data-state', 'not-permitted');
    await expect(detail.getByRole('status').filter({ hasText: 'refused the canary subscription' })).toBeVisible();

    await page.goto('/');
    await expect(page.getByText('Needs attention').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Broker canary ${name}`)).toBeVisible({ timeout: 20_000 });
  } finally {
    await api.del(`/api/mqtt/brokers/${id}`);
    await acl.close();
  }
});

test('security: findings are listed worst first in the details, with a compact summary in the list', async ({ page }) => {
  // 0.0.0.0 reaches this machine but is not a loopback name, so plaintext and the password are judged as on a network.
  const name = unique('E2E posture ');
  const created = await api.post('/api/mqtt/brokers', { name, host: '0.0.0.0', port: mqttPort(), username: 'manifold', password: 'secret', subscribeFilter: '#', autoSubscribe: true });
  expect(created.status).toBe(202);
  const id = created.json.brokerId;
  try {
    await expect.poll(async () => (await brokerByName(name))?.status).toBe('connected');
    await page.goto('/brokers');
    await expect(page.getByTestId(`posture-${id}`)).toContainText(/1 high, 1 medium, \d low/);

    await page.getByRole('button', { name: new RegExp(`Security: .* Open details for ${name}`) }).click();
    const section = page.getByTestId('posture-section');
    const items = section.getByRole('list', { name: /Security findings/ }).getByRole('listitem');
    await expect(items.first()).toHaveAttribute('data-severity', 'high');
    await expect(section.getByTestId('finding-password-plaintext')).toContainText('What to change');
    const order = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-severity')));
    const rank = { high: 0, medium: 1, low: 2, info: 3 };
    expect(order).toEqual([...order].sort((a, b) => rank[a] - rank[b]));
    expect(order).toEqual(expect.arrayContaining(['high', 'medium', 'low']));
    await expect(section.getByText('Nothing is probed')).toBeVisible();
    // The password is never shown anywhere.
    await expect(page.locator('body')).not.toContainText('secret');

    // The quiet loopback broker has no medium or high finding.
    const quiet = (await api.get('/api/mqtt/brokers/e2e-broker/posture')).json;
    expect(quiet.summary.high + quiet.summary.medium).toBe(0);
  } finally {
    await api.del(`/api/mqtt/brokers/${id}`);
  }
});

for (const theme of ['dark', 'light']) {
  test(`the connect form with presets and the broker details are axe-clean (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('tc.theme', t);
      } catch {
        /* storage unavailable */
      }
    }, theme);
    await page.goto('/brokers');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    await page.getByRole('button', { name: 'Connect a broker' }).first().click();
    const form = page.getByRole('dialog', { name: 'Connect a broker' });
    await form.getByTestId('preset-emqx').click();
    await form.getByLabel('Probe this broker with a canary message').check();
    await expect(form.getByTestId('canary-fields')).toBeVisible();
    expect(await axeSerious(page, '[role="dialog"]')).toEqual([]);
    await form.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Details for E2E broker', exact: true }).first().click();
    await expect(page.getByTestId('broker-detail')).toBeVisible();
    await expect(page.getByTestId('posture-section').getByRole('list', { name: /Security findings/ })).toBeVisible();
    expect(await axeSerious(page, '[role="dialog"]')).toEqual([]);
  });
}

test('presets fill the form with a narrow filter and a public-broker warning; ', async ({ page }) => {
  await page.goto('/brokers');
  await page.getByRole('button', { name: 'Connect a broker' }).first().click();
  const form = page.getByRole('dialog', { name: 'Connect a broker' });
  await expect(form.getByTestId('broker-presets')).toContainText('anything you publish is visible to everyone');
  await expect(form.getByTestId('broker-presets')).toContainText('Do not use them with plant data');

  await form.getByTestId('preset-hivemq').click();
  await expect(form.getByLabel('Host', { exact: true })).toHaveValue('broker.hivemq.com');
  await expect(form.getByLabel('Port', { exact: true })).toHaveValue('1883');
  await expect(form.getByTestId('preset-note')).toContainText('testtopic/#');
  await form.getByRole('button', { name: /Connection settings/ }).click();
  await expect(form.getByLabel(/Subscription filter/)).toHaveValue('testtopic/#');

  await form.getByTestId('preset-emqx-tls').click();
  await expect(form.getByLabel('Host', { exact: true })).toHaveValue('broker.emqx.io');
  await expect(form.getByLabel('Port', { exact: true })).toHaveValue('8883');
  await expect(form.getByLabel('Protocol')).toHaveValue('mqtts');
  await expect(form.getByLabel('Verify TLS certificate')).toBeChecked();
  await form.getByRole('button', { name: 'Cancel' }).click();

  // Not offered when editing an existing broker.
  await page.getByRole('button', { name: 'Edit E2E broker', exact: true }).click();
  await expect(page.getByTestId('broker-presets')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});
