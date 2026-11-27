import { test, expect } from './fixtures.js';

/**
 * Storage degraded: when GET /api/system/status says the configuration store or the alert history cannot
 * be written, Overview lists it under "Needs attention" and the Health page says what failed and that
 * changes are not being saved. The server side (an unwritable data directory reported as `degraded`) is
 * covered in server/test/audit-api.test.js; here the status answer is replaced in the browser, since the
 * shared e2e backend must keep writing.
 */

const DEGRADED = {
  status: 'degraded',
  storage: {
    profiles: { ok: false, error: 'ENOSPC: no space left on device, write', since: Date.now() },
    alertJournal: { ok: false, writeErrors: 4, lastError: 'EACCES: permission denied' }
  }
};

async function degrade(page) {
  await page.route('**/api/system/status', async (route) => {
    const res = await route.fetch();
    const real = await res.json();
    await route.fulfill({ response: res, json: { ...real, ...DEGRADED } });
  });
}

test('Overview lists degraded storage under Needs attention and links to Health', async ({ page }) => {
  await degrade(page);
  await page.goto('/');
  const config = page.getByRole('link', { name: /^Configuration storage\b/ });
  await expect(config).toBeVisible();
  await expect(config).toContainText('Changes are not being saved');
  await expect(config).toContainText('ENOSPC');
  await expect(page.getByRole('link', { name: /^Alert history\b/ })).toContainText('4 writes to the alert history failed');
  await config.click();
  await expect(page).toHaveURL(/\/system$/);
  const banner = page.getByTestId('storage-degraded');
  await expect(page.getByText('Storage degraded: changes are not being saved')).toBeVisible();
  await expect(banner).toContainText('Configuration storage.');
  await expect(banner).toContainText('Alert history.');
});

test('Health shows nothing about storage while it writes', async ({ page }) => {
  await page.goto('/system');
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  await expect(page.getByText(/Updated .* from \/metrics/)).toBeVisible();
  await expect(page.getByTestId('storage-degraded')).toHaveCount(0);
});
