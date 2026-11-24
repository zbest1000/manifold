import { test, expect } from './fixtures.js';
import { startModbus, createModbusDevice, unique, cleanup } from './support.js';

/**
 * A Modbus outage: the device vanishes (the simulator stops listening and resets its
 * connections). Every tag row must flip to Bad quality and the device must leave "Online";
 * when the device comes back on the same port both must recover on their own, without a reload.
 */
test('a Modbus outage shows Bad quality rows and recovers', async ({ page }) => {
  const name = unique('E2E outage ');
  const sim = await startModbus({ value: 11 });
  try {
    await createModbusDevice({
      name,
      port: sim.port,
      tags: [
        { key: 'first', address: '40101' },
        { key: 'second', address: '40102' }
      ]
    });

    await page.goto('/devices');
    const card = page.locator('li', { has: page.getByRole('heading', { level: 2, name, exact: true }) });
    await expect(card.getByText('Online', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: `Edit ${name}` }).click();
    const editor = page.getByRole('dialog').filter({ hasText: `Edit ${name}` });
    const cell = (key) => editor.locator(`tr[data-tag-key="${key}"] [data-quality]`);
    for (const key of ['first', 'second']) await expect(cell(key)).toHaveAttribute('data-quality', 'good');
    await expect(cell('first')).toHaveText(/^\s*11(?!\d)/);
    // A value changing proves the live (socket) path is flowing before the outage starts.
    sim.set(13);
    await expect(cell('first')).toHaveText(/^\s*13(?!\d)/);

    // --- the device goes away ---------------------------------------------------------------
    await sim.outage();
    for (const key of ['first', 'second']) {
      await expect(cell(key)).toHaveAttribute('data-quality', 'bad', { timeout: 45_000 });
      await expect(cell(key)).toContainText('Bad');
    }
    await expect(card.getByText('Online', { exact: true })).toHaveCount(0);

    // --- and comes back with a new value ----------------------------------------------------
    sim.set(14);
    await sim.restore();
    for (const key of ['first', 'second']) await expect(cell(key)).toHaveAttribute('data-quality', 'good', { timeout: 60_000 });
    await expect(cell('first')).toHaveText(/^\s*14(?!\d)/);
    await expect(card.getByText('Online', { exact: true })).toBeVisible();
  } finally {
    await cleanup({ devices: [name] });
    await sim.close();
  }
});
