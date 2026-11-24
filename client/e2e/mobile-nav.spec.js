import { test, expect } from './fixtures.js';

/**
 * Smoke flow: on a phone-width viewport the sidebar is replaced by a drawer. It
 * must open from the keyboard, trap focus inside, navigate, and close again.
 */
test('open the mobile nav drawer by keyboard and navigate', async ({ page, consoleErrors }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  const open = page.getByRole('button', { name: 'Open navigation menu' });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'false');

  // Reach the hamburger with the keyboard and activate it with Enter.
  await open.focus();
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');

  const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation menu' })).toBeFocused();

  // Tab to a destination and follow it with Enter.
  const target = drawer.getByRole('link', { name: 'Health' });
  for (let i = 0; i < 40 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/system$/);
  await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();
  await expect(drawer).toBeHidden();

  // Escape closes the drawer and hands focus back to the hamburger.
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(open).toBeFocused();

  expect(consoleErrors).toEqual([]);
});
