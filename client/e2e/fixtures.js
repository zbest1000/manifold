import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  /** Console errors and uncaught page errors seen so far on the page. */
  consoleErrors: async ({ page }, use) => {
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await use(errors);
  }
});

export { expect };
