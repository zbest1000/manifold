import { test, expect } from './fixtures.js';
import { api, unique, startModbus, subscribe, cleanup } from './support.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A device-profile mapping made in the editor: every tag of the profile ("all", by rule), an asset
 * path template with one instance overriding its own path, and a 10 % deadband. At the broker:
 * instance A publishes under the template, B under its override; the percent band is taken from
 * the range when the tag has one (temp, 0..200 -> 20) and from the last published value when it
 * has none (raw). Saving the mapping again untouched keeps tags "all" and the override.
 */
test('profile mapping: per-instance path override, percent deadband with and without a range on the wire, tags "all" round trip', async ({ page }) => {
  const profileName = unique('E2E meter ');
  const name = unique('E2E profile map ');
  const root = `e2e/${unique('prof')}`;
  const sim = await startModbus({ value: 100 });
  const mqtt = await subscribe(`${root}/#`);
  const devices = [];
  try {
    const prof = await api.post('/api/devices/profiles', {
      name: profileName,
      protocol: 'modbus-tcp',
      params: [{ name: 'site' }],
      tags: [
        { key: 'temp', address: '40101', type: 'uint16', property: 'temp', range: { min: 0, max: 200 } },
        { key: 'raw', address: '40101', type: 'uint16', property: 'raw' }
      ]
    });
    expect(prof.ok, prof.text).toBe(true);
    for (const [dn, site] of [['meter A', 'ham'], ['meter B', 'ber']]) {
      const r = await api.post('/api/devices', { name: unique(`${dn} `), protocol: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1, enabled: true, profileId: prof.json.id, params: { site }, pollGroups: [{ id: 'default', intervalMs: 300 }] });
      expect(r.ok, r.text).toBe(true);
      devices.push(r.json);
    }
    const [a, b] = devices;

    await page.goto('/tags');
    await page.getByRole('button', { name: 'Map a device profile' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Device profile').selectOption(prof.json.id);
    await editor.getByLabel('Name', { exact: true }).fill(name);
    await editor.locator('#asset-path-template').fill(`${root}/{site}/{device}`);
    await editor.getByLabel(`Own asset path for ${b.name}`).fill(`${root}/special/b`);
    await editor.locator('#map-delivery').getByLabel('Deadband').selectOption('percent');
    await editor.locator('#map-delivery').getByLabel('Value (%)').fill('10');
    await expect(editor.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    const slugA = a.name.trim().replace(/[\s/+#]+/g, '_');
    const at = (topic) => mqtt.messages.filter((m) => m.topic === topic).map((m) => m.payload?.v);
    await expect.poll(() => at(`${root}/ham/${slugA}/temp`).length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => at(`${root}/special/b/temp`).length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(mqtt.messages.some((m) => m.topic.startsWith(`${root}/ber/`))).toBe(false);

    for (const v of [110, 115, 120, 125]) {
      sim.set(v);
      await sleep(1200);
    }
    await expect.poll(() => at(`${root}/ham/${slugA}/raw`), { timeout: 10_000 }).toEqual([100, 110, 125]);
    expect(at(`${root}/ham/${slugA}/temp`)).toEqual([100, 120]);

    // an untouched save keeps tags "all" and the instance override
    await page.goto('/tags?view=mappings');
    await page.getByRole('button', { name: `Edit mapping ${name}` }).click();
    const again = page.getByRole('dialog');
    await expect(again.getByRole('radio', { name: 'All tags by rule' })).toHaveAttribute('aria-checked', 'true');
    await expect(again.getByLabel(`Own asset path for ${b.name}`)).toHaveValue(`${root}/special/b`);
    await expect(again.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
    await again.getByRole('button', { name: 'Save changes' }).click();
    await expect(again).toBeHidden();
    const stored = (await api.get('/api/tags/bindings')).json.bindings.find((x) => x.name === name);
    expect(stored.source.tags).toBe('all');
    expect(stored.target.assetPaths).toEqual({ [b.id]: `${root}/special/b` });
    expect(stored.rbe.deadband).toEqual({ type: 'percent', value: 10 });
  } finally {
    await cleanup({ bindings: [name], devices: devices.map((d) => d.name), profiles: [profileName] });
    await mqtt.close();
    await sim.close();
  }
});
