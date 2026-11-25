import { test, expect } from './fixtures.js';
import { api, unique, startModbus, startHistorianStub, createModbusDevice, cleanup, deviceByName } from './support.js';

/**
 * Concurrent edits, duplicate brokers, dangling references, honest route counters and live alert state,
 * against the real backend (Brokers, Devices, Pipelines and Settings pages).
 *
 *   - two browser contexts edit the same device: the second save is refused with a dialog that shows the
 *     differing fields; Cancel keeps the edit, Take theirs loads the saved version, Keep mine overwrites
 *   - a second identical broker connection is refused inline, naming the existing one
 *   - a broker that routes (and other objects) still use cannot be removed; the dialog names the users
 *   - a route into a historian that rejects everything shows routed vs delivered/rejected diverging
 *   - an alert rule shows "Breached" with a countdown inside its sustain window, then "Firing"
 */

const mqttPort = () => Number(process.env.E2E_MQTT_PORT);

test('two tabs edit the same device: the second save shows what differs and never overwrites silently', async ({ browser }) => {
  const sim = await startModbus();
  const name = unique('Conc device ');
  await createModbusDevice({ name, port: sim.port, tags: [{ key: 'count', address: '40101' }] });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  try {
    const openEditor = async (page, current = name) => {
      await page.goto('/devices');
      await page.getByRole('button', { name: current, exact: true }).click();
      await page.getByRole('dialog', { name: current }).getByRole('button', { name: 'Edit device' }).click();
      await expect(page.getByRole('heading', { name: `Edit ${current}` })).toBeVisible();
    };
    await openEditor(pageA);
    await openEditor(pageB);

    // B saves a new name first
    const renamed = `${name} (B)`;
    await pageB.getByLabel('Name', { exact: true }).fill(renamed);
    await pageB.getByRole('button', { name: 'Save changes' }).click();
    await expect(pageB.getByText(/updated/)).toBeVisible();

    // A, still on the old revision, edits the same field and the host port description and saves
    const mine = `${name} (A)`;
    await pageA.getByLabel('Name', { exact: true }).fill(mine);
    await pageA.getByRole('button', { name: 'Save changes' }).click();
    const dialog = pageA.getByRole('dialog', { name: /was changed elsewhere/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('conflict-mine')).toContainText(mine);
    await expect(dialog.getByTestId('conflict-theirs')).toContainText(renamed);
    expect((await deviceByName(renamed)).name).toBe(renamed); // nothing was overwritten yet

    // Cancel: back in the editor with the unsaved edit intact
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(pageA.getByLabel('Name', { exact: true })).toHaveValue(mine);

    // Take theirs: the editor shows the saved version
    await pageA.getByRole('button', { name: 'Save changes' }).click();
    await pageA.getByRole('dialog', { name: /was changed elsewhere/ }).getByRole('button', { name: 'Take theirs' }).click();
    await expect(pageA.getByLabel('Name', { exact: true })).toHaveValue(renamed);
    expect((await deviceByName(renamed)).name).toBe(renamed);

    // Edit again on top of the saved version: it saves cleanly (the editor now holds the current revision)
    await pageA.getByLabel('Name', { exact: true }).fill(mine);
    await pageA.getByRole('button', { name: 'Save changes' }).click();
    await expect(pageA.getByText(/updated/)).toBeVisible();
    expect((await deviceByName(mine)).name).toBe(mine);

    // Keep mine: both open the editor on the current version, A saves, then B (now stale) overwrites on purpose
    await openEditor(pageA, mine);
    await openEditor(pageB, mine);
    await pageA.getByLabel('Name', { exact: true }).fill(`${name} (A2)`);
    await pageA.getByRole('button', { name: 'Save changes' }).click();
    await expect(pageA.getByText(/updated/).last()).toBeVisible();
    await pageB.getByLabel('Name', { exact: true }).fill(`${name} (B2)`);
    await pageB.getByRole('button', { name: 'Save changes' }).click();
    await pageB.getByRole('dialog', { name: /was changed elsewhere/ }).getByRole('button', { name: 'Keep mine (overwrite)' }).click();
    await expect(pageB.getByText(/updated/).last()).toBeVisible();
    expect((await deviceByName(`${name} (B2)`)).name).toBe(`${name} (B2)`);
    expect(await deviceByName(`${name} (A2)`)).toBeNull();
  } finally {
    await a.close();
    await b.close();
    await cleanup({ devices: [name, `${name} (A)`, `${name} (A2)`, `${name} (B)`, `${name} (B2)`] });
    await sim.close();
  }
});

test('connecting the same broker twice is refused inline, naming the one that exists', async ({ page }) => {
  await page.goto('/brokers');
  await page.getByRole('button', { name: 'Connect a broker' }).first().click();
  const form = page.getByRole('dialog', { name: 'Connect a broker' });
  await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('Port', { exact: true }).fill(String(mqttPort()));
  await form.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(form.getByTestId('broker-duplicate')).toContainText('E2E broker');
  await expect(form.getByRole('alert')).toContainText('already connected');
  // still one connection to that broker
  const { json } = await api.get('/api/mqtt/brokers');
  expect(json.brokers.filter((x) => x.port === mqttPort() && x.host === '127.0.0.1')).toHaveLength(1);

  // a different subscribe filter is a legitimate second connection: no refusal
  await form.getByRole('button', { name: /Connection settings/ }).click();
  await form.getByLabel(/Subscription filter/).fill('only/this/#');
  await form.getByLabel('Host', { exact: true }).fill('localhost'); // another name for the same machine: only the filter makes it distinct
  await form.getByLabel('Port', { exact: true }).fill(String(mqttPort()));
  await form.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(form).toBeHidden();
  const second = (await api.get('/api/mqtt/brokers')).json.brokers.find((x) => x.subscribeFilter === 'only/this/#');
  expect(second).toBeTruthy();
  await api.del(`/api/mqtt/brokers/${second.id}`);
});

test('a broker that routes still use cannot be removed: the dialog names them; then it can', async ({ page }) => {
  const created = await api.post('/api/mqtt/brokers', { name: unique('Used broker '), host: '127.0.0.1', port: mqttPort(), subscribeFilter: `used/${unique('f')}/#` });
  expect(created.status).toBe(202);
  const id = created.json.brokerId;
  const routeName = unique('uses broker ');
  const route = await api.post('/api/pipelines', { name: routeName, source: { brokerId: id, filter: 'used/#' }, target: { type: 'mqtt', brokerId: id } });
  expect(route.status).toBe(201);
  const rule = await api.post('/api/alerts/rules', { name: unique('rule on broker '), type: 'topic-silent', brokerId: id, topic: 'used/x' });
  try {
    await page.goto('/brokers');
    const brokerName = created.json.name || (await api.get('/api/mqtt/brokers')).json.brokers.find((x) => x.id === id).name;
    await page.getByRole('button', { name: `Disconnect and remove ${brokerName}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect and remove' }).click();
    const refused = page.getByRole('dialog', { name: /Can't remove/ });
    await expect(refused.getByTestId('broker-in-use')).toContainText(routeName);
    await expect(refused.getByTestId('broker-in-use')).toContainText('rule on broker');
    await expect(refused.getByTestId('broker-in-use')).toContainText('route');
    await refused.getByRole('button', { name: 'Close', exact: true }).first().click();
    expect((await api.get('/api/mqtt/brokers')).json.brokers.some((x) => x.id === id)).toBe(true);

    await api.del(`/api/pipelines/${route.json.id}`);
    await api.del(`/api/alerts/rules/${rule.json.id}`);
    await page.getByRole('button', { name: `Disconnect and remove ${brokerName}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect and remove' }).click();
    await expect(page.getByText('Disconnected and removed')).toBeVisible();
  } finally {
    await api.del(`/api/pipelines/${route.json.id}`).catch(() => {});
    await api.del(`/api/alerts/rules/${rule.json.id}`).catch(() => {});
    await api.del(`/api/mqtt/brokers/${id}`).catch(() => {});
  }
});

test('a route into a historian that rejects everything: routed climbs, delivered stays 0, rejected rises', async ({ page }) => {
  const stub = await startHistorianStub();
  stub.fail(400);
  const hname = unique('Rejecting historian ');
  const hid = (await api.post('/api/historians', { type: 'timebase', name: hname, url: stub.url, dataset: 'E2E set' })).json.id;
  const routeName = unique('to rejecting ');
  const route = await api.post('/api/pipelines', { name: routeName, source: { brokerId: 'e2e-broker', filter: 'plant/line1/#' }, transforms: [{ type: 'numeric', field: 'value' }], target: { type: 'historian', historianId: hid } });
  try {
    await page.goto('/pipelines');
    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('route-rejected')).not.toHaveText('0', { timeout: 40_000 });
    const routed = Number(await row.getByTestId('route-routed').innerText());
    expect(routed).toBeGreaterThan(0);
    await expect(row.getByTestId('route-delivered')).toHaveText('0');
    await expect(row.getByText('Historian rejecting')).toBeVisible();

    // the same story on the Historians tab, with the split explained in plain words
    await page.goto('/pipelines?tab=historians');
    const hrow = page.getByRole('row', { name: new RegExp(hname) });
    await expect(hrow.getByTestId('hist-rejected')).not.toHaveText('0', { timeout: 40_000 });
    await expect(hrow.getByTestId('hist-delivered')).toHaveText('0');
    await expect(hrow.getByTestId('hist-admitted')).not.toHaveText('0');
    await page.getByRole('button', { name: 'Delivered' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('accepted');

    // the historian recovers: new points are delivered
    stub.fail(null);
    await page.goto('/pipelines');
    await expect(page.getByRole('row', { name: new RegExp(routeName) }).getByTestId('route-delivered')).not.toHaveText('0', { timeout: 40_000 });
    expect(stub.received.length).toBeGreaterThan(0);
  } finally {
    await api.del(`/api/pipelines/${route.json.id}`).catch(() => {});
    await api.del(`/api/historians/${hid}`).catch(() => {});
    await stub.close();
  }
});

test('an alert rule shows Breached with a countdown inside its sustain window, then Firing', async ({ page }) => {
  const name = unique('Sustained ');
  const created = await api.post('/api/alerts/rules', { name, type: 'value-threshold', brokerId: 'e2e-broker', topic: 'plant/line2/count', field: 'value', op: '>', value: 0, sustainMs: 9000 });
  expect(created.status).toBe(201);
  try {
    await page.goto('/settings?tab=alerts');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row.getByText('Breached', { exact: true })).toBeVisible({ timeout: 20_000 });
    const countdown = row.getByTestId('alert-countdown');
    await expect(countdown).toBeVisible();
    const first = await countdown.innerText();
    await expect.poll(async () => countdown.innerText(), { timeout: 5000 }).not.toBe(first); // it ticks
    await expect(row.getByText('Firing', { exact: true })).toBeVisible({ timeout: 30_000 });

    // per-rule drill-down
    await row.getByRole('button', { name: new RegExp(`recent events of ${name}`) }).click();
    await expect(page.getByTestId(`alert-events-${created.json.id}`)).toContainText('Firing');
  } finally {
    await api.del(`/api/alerts/rules/${created.json.id}`).catch(() => {});
  }
});

test('a route whose broker disappeared is marked broken, with the missing id and a Fix action', async ({ page }) => {
  const routeName = unique('ghost route ');
  const routeId = unique('ghost-id-');
  // A config import bypasses the save-time check, which is how a dangling reference gets in (so does a hand-edited profile).
  const imp = await api.post('/api/system/config/import', {
    manifoldConfig: 1,
    pipelines: [{ id: routeId, name: routeName, enabled: true, source: { brokerId: 'deleted-broker-id', filter: 'ghost/#' }, transforms: [], target: { type: 'mqtt', brokerId: 'e2e-broker' } }]
  });
  expect(imp.status).toBe(200);
  try {
    await page.goto('/pipelines');
    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(row.getByText('Broken reference')).toBeVisible();
    await expect(row.getByTestId('route-broken')).toContainText('deleted-broker-id');
    await row.getByRole('button', { name: 'Fix' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit route' })).toBeVisible();
  } finally {
    await api.del(`/api/pipelines/${routeId}`).catch(() => {});
  }
});
