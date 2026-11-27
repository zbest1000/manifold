import { test, expect } from './fixtures.js';
import { api, unique, startHistorianStub } from './support.js';

/**
 * Overview "Needs attention", against the real backend: a route into a historian that rejects every
 * point, an alert rule that fires, a mapping that cannot publish (its target broker is not connected)
 * and a stored route with a broken reference each appear with the reason and a link to the place to
 * fix it; once they are fixed or removed, they are gone.
 */
test('needs attention: rejected points, a firing alert, a mapping not publishing and a broken reference, each linking to the fix', async ({ page }) => {
  const stub = await startHistorianStub();
  stub.fail(400);
  const hname = unique('Overview historian ');
  const hid = (await api.post('/api/historians', { type: 'timebase', name: hname, url: stub.url, dataset: 'E2E set' })).json.id;
  const routeName = unique('Overview route ');
  const route = await api.post('/api/pipelines', { name: routeName, source: { brokerId: 'e2e-broker', filter: 'plant/line1/#' }, transforms: [{ type: 'numeric', field: 'value' }], target: { type: 'historian', historianId: hid } });
  const ruleName = unique('Overview alert ');
  const rule = await api.post('/api/alerts/rules', { name: ruleName, type: 'value-threshold', brokerId: 'e2e-broker', topic: 'plant/line2/count', field: 'value', op: '>', value: -1, sustainMs: 0 });
  // a broker nothing listens on: a mapping that publishes to it cannot publish
  const deadBroker = unique('ov-dead');
  const dead = await api.post('/api/mqtt/brokers', { id: deadBroker, name: deadBroker, host: '127.0.0.1', port: 1, protocol: 'mqtt', reconnect: true, reconnectPeriod: 60000 });
  const mapName = unique('Overview mapping ');
  const mapping = await api.post('/api/tags/bindings', {
    name: mapName,
    source: { type: 'mqtt', brokerId: 'e2e-broker', tags: [{ address: 'plant/line1/temperature', name: 'temperature' }] },
    target: { mode: 'mqtt', brokerId: deadBroker, assetPath: `e2e/${unique('ov')}`, format: 'envelope' }
  });
  // a route whose broker is gone (imported: the save-time check is bypassed)
  const ghostId = unique('ov-ghost-');
  const ghostName = unique('Overview ghost ');
  const imported = await api.post('/api/system/config/import', {
    manifoldConfig: 1,
    pipelines: [{ id: ghostId, name: ghostName, enabled: true, source: { brokerId: 'gone-broker', filter: 'ghost/#' }, transforms: [], target: { type: 'mqtt', brokerId: 'e2e-broker' } }]
  });
  const item = (text) => page.getByRole('link', { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) });
  try {
    expect(route.status, route.text).toBe(201);
    expect(rule.status, rule.text).toBe(201);
    expect(dead.ok, dead.text).toBe(true);
    expect(mapping.status, mapping.text).toBe(201);
    expect(imported.status, imported.text).toBe(200);

    await page.goto('/');
    await expect(item(`Route ${routeName}`)).toContainText('rejected by historian', { timeout: 40_000 });
    await expect(item(`Route ${routeName}`)).toHaveAttribute('href', '/pipelines');
    await expect(item(`Historian ${hname}`)).toContainText('rejected');
    await expect(item(`Historian ${hname}`)).toHaveAttribute('href', '/pipelines?tab=historians');
    await expect(item(`Alert ${ruleName}`)).toContainText('Firing', { timeout: 40_000 });
    await expect(item(`Alert ${ruleName}`)).toHaveAttribute('href', `/alerts?alarm=${encodeURIComponent(`${rule.json.id}|plant/line2/count`)}`);
    await expect(item(`Mapping ${mapName}`)).toContainText(`Not publishing: The target broker ${deadBroker} is not connected`);
    await expect(item(`Mapping ${mapName}`)).toHaveAttribute('href', '/tags?view=mappings');
    await expect(item(`Route ${ghostName}`)).toContainText('Broken reference: broker gone-broker no longer exists');
    if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/overview-attention.png` });

    // following a link lands on the place to fix it
    await item(`Mapping ${mapName}`).click();
    await expect(page).toHaveURL(/\/tags\?view=mappings/);
    await expect(page.getByRole('row', { name: new RegExp(mapName) })).toContainText('Not publishing');

    // fixed or removed: gone from the list
    await api.del(`/api/tags/bindings/${mapping.json.id}`);
    await api.del(`/api/alerts/rules/${rule.json.id}`);
    await api.del(`/api/pipelines/${route.json.id}`);
    await api.del(`/api/pipelines/${ghostId}`);
    await api.del(`/api/historians/${hid}`);
    await page.goto('/');
    for (const t of [`Route ${routeName}`, `Historian ${hname}`, `Alert ${ruleName}`, `Mapping ${mapName}`, `Route ${ghostName}`]) await expect(item(t)).toHaveCount(0, { timeout: 20_000 });
  } finally {
    if (mapping.json?.id) await api.del(`/api/tags/bindings/${mapping.json.id}`).catch(() => {});
    if (rule.json?.id) await api.del(`/api/alerts/rules/${rule.json.id}`).catch(() => {});
    if (route.json?.id) await api.del(`/api/pipelines/${route.json.id}`).catch(() => {});
    await api.del(`/api/pipelines/${ghostId}`).catch(() => {});
    await api.del(`/api/historians/${hid}`).catch(() => {});
    await api.del(`/api/mqtt/brokers/${deadBroker}`).catch(() => {});
    await stub.close();
  }
});
