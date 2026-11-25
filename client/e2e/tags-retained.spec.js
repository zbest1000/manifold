import { test, expect } from './fixtures.js';
import { api, unique, startBroker, cleanup } from './support.js';

const shots = process.env.E2E_SHOTS_DIR;

async function brokerStatus(id) {
  const { json } = await api.get('/api/mqtt/brokers');
  return (json?.brokers || json || []).find((b) => b.id === id)?.status;
}

/**
 * Retained cleanup that survives a broker outage, and "why is nothing publishing" per mapping:
 * a mapping publishes retained topics to a second broker; that broker goes away; the Mappings
 * table says the target broker is not connected; the mapping is deleted; "Clear orphaned retained
 * topics" first SHOWS what it would clear (a dry run: only topics Manifold recorded as its own),
 * marked as waiting for their broker; once the broker is back the topics are cleared at the
 * broker. Removing the broker a mapping reads from is refused, naming the mapping; a mapping whose
 * broker is missing (imported from another instance) shows "Source missing" with the fix.
 */
test('orphaned retained topics: dry run while the broker is away, cleared once it is back; source missing and reasons in the table', async ({ page, consoleErrors }) => {
  const brokerId = unique('orph');
  const asset = `e2e/${unique('ret')}/line`;
  const out = unique('E2E retained ');
  const inName = unique('E2E from gone ');
  const extra = await startBroker();
  try {
    const added = await api.post('/api/mqtt/brokers', { id: brokerId, name: brokerId, host: '127.0.0.1', port: extra.port, protocol: 'mqtt', reconnect: true, reconnectPeriod: 500 });
    expect(added.ok, added.text).toBe(true);
    await expect.poll(() => brokerStatus(brokerId), { timeout: 15_000 }).toBe('connected');
    const m1 = await api.post('/api/tags/bindings', { name: out, source: { type: 'mqtt', brokerId: 'e2e-broker', tags: [{ address: 'plant/line1/temperature', name: 'temperature' }] }, target: { mode: 'mqtt', brokerId, assetPath: asset, format: 'envelope', retain: true } });
    expect(m1.status, m1.text).toBe(201);
    const m2 = await api.post('/api/tags/bindings', { name: inName, source: { type: 'mqtt', brokerId, tags: [{ address: 'x/y', name: 'y' }] }, target: { mode: 'mqtt', brokerId: 'e2e-broker', assetPath: `e2e/${unique('in')}`, format: 'envelope' } });
    expect(m2.status, m2.text).toBe(201);
    await expect.poll(async () => Boolean(await extra.retained(`${asset}/temperature`)), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => Boolean(await extra.retained(`${asset}/_status`)), { timeout: 20_000 }).toBe(true);

    // the broker goes away: the table says why the mapping does not publish
    await extra.pause();
    await expect.poll(() => brokerStatus(brokerId), { timeout: 15_000 }).not.toBe('connected');
    await page.goto('/tags?view=mappings');
    const row = page.getByRole('row', { name: new RegExp(out) });
    await expect(row).toContainText('Not publishing');
    await expect(row).toContainText(`The target broker ${brokerId} is not connected`);
    await expect(page.getByRole('row', { name: new RegExp(inName) })).toContainText('The source is offline');

    // delete it while the broker is away: nothing can be cleared yet
    await page.getByRole('button', { name: `Delete mapping ${out}` }).click();
    await page.getByRole('dialog', { name: `Delete ${out}?` }).getByRole('button', { name: 'Delete mapping' }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear orphaned retained topics' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear orphaned retained topics' });
    const table = dialog.getByRole('table', { name: /Orphaned retained topics/ });
    // (the Path component spaces the levels: match the leaf and the mapping)
    const orphan = (leaf) => table.getByRole('row').filter({ hasText: out }).filter({ hasText: leaf });
    await expect(table.getByRole('row').filter({ hasText: out })).toHaveCount(3);
    for (const t of ['temperature', '_status', '_meta']) await expect(orphan(t)).toContainText('mapping deleted');
    await expect(orphan('_status')).toContainText('not connected: cleared later');
    await expect(dialog.getByRole('button', { name: /^Clear/ })).toBeDisabled();
    if (shots) await page.screenshot({ path: `${shots}/orphan-dry-run.png` });
    // the dry run cleared nothing
    await dialog.getByRole('button', { name: 'Close' }).first().click();

    // back: cleared at the broker (on the retry, or with the button if it is quicker)
    await extra.resume();
    await expect.poll(() => brokerStatus(brokerId), { timeout: 20_000 }).toBe('connected');
    await page.getByRole('button', { name: 'Clear orphaned retained topics' }).click();
    const clear = dialog.getByRole('button', { name: /^Clear \d+ topic/ });
    if (await clear.isEnabled().catch(() => false)) await clear.click();
    await expect.poll(async () => Boolean(await extra.retained(`${asset}/temperature`)), { message: 'retained value cleared at the broker', timeout: 30_000 }).toBe(false);
    await expect.poll(async () => Boolean(await extra.retained(`${asset}/_status`)), { timeout: 30_000 }).toBe(false);
    await dialog.getByRole('button', { name: 'Close' }).first().click();

    // Removing the broker a mapping reads from is refused, naming the mapping (the reference check)
    await page.goto('/brokers');
    await page.getByRole('button', { name: `Disconnect and remove ${brokerId}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect and remove' }).click();
    const refused = page.getByRole('dialog', { name: /Can't remove/ });
    await expect(refused.getByTestId('broker-in-use')).toContainText(inName);
    await expect(refused.getByTestId('broker-in-use')).toContainText('mapping');
    await refused.getByRole('button', { name: 'Close' }).last().click();
    expect(await brokerStatus(brokerId)).toBeTruthy(); // still there

    // "Source missing" arises for real when a mapping arrives without its broker: a config file from
    // another instance (import does not check references; the mapping shows as broken instead).
    const missingBroker = unique('gone');
    const imported = await api.post('/api/system/config/import', {
      manifoldConfig: 1,
      bindings: [{ id: unique('imp'), name: inName + ' imported', enabled: true, source: { type: 'mqtt', brokerId: missingBroker, tags: [{ address: 'x/y', name: 'y' }] }, target: { mode: 'mqtt', brokerId: 'e2e-broker', assetPath: `e2e/${unique('imp')}`, format: 'envelope' } }]
    });
    expect(imported.status, imported.text).toBe(200);
    await page.goto('/tags?view=mappings');
    const gone = page.getByRole('row', { name: new RegExp(`${inName} imported`) });
    await expect(gone).toContainText('Source missing', { timeout: 15_000 });
    await expect(gone).toContainText(`The source broker ${missingBroker} was removed.`);
    await expect(gone).toContainText('Add the broker again under Brokers');
    if (shots) {
      await page.screenshot({ path: `${shots}/mappings-reasons-dark.png` });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.reload();
      await expect(gone).toContainText('Source missing');
      await page.waitForTimeout(300); // let the theme transition settle for the picture
      await page.screenshot({ path: `${shots}/mappings-reasons-light.png` });
    }
    // the refused removal is a 409 the browser logs; nothing else may be
    expect(consoleErrors.filter((e) => !/status of 409 \(Conflict\)/.test(e))).toEqual([]);
  } finally {
    await cleanup({ bindings: [out, inName, `${inName} imported`] });
    await api.del(`/api/mqtt/brokers/${brokerId}`).catch(() => {});
    await extra.close();
  }
});
