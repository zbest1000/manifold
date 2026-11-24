import { test, expect } from './fixtures.js';
import { api, unique } from './support.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Settings: config export/import (the same file can be imported twice in a row) and alert rules
 * (editing brings the editor into view and focuses it; deleting asks first and says it happened).
 */
test('config: export downloads a file, importing the same file twice asks and reports both times', async ({ page }) => {
  await page.goto('/settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export config' }).click()]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-config-')), 'manifold-config.json');
  await download.saveAs(file);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).manifoldConfig).toBe(1);

  const input = page.locator('input[type=file][accept=".json"]');
  for (let attempt = 1; attempt <= 2; attempt++) {
    await input.setInputFiles(file);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Import this configuration?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import and overwrite' }).click();
    await expect(page.getByText(/^Imported:/)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss message' }).click();
  }

  // a file that is not a config says so instead of failing silently
  const junk = path.join(path.dirname(file), 'junk.json');
  fs.writeFileSync(junk, '{"hello": 1}');
  await input.setInputFiles(junk);
  await page.getByRole('dialog').getByRole('button', { name: 'Import and overwrite' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not a Manifold config export' })).toBeVisible();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('alert rules: add, edit (the editor is focused), delete with confirmation', async ({ page }) => {
  const topic = `plant/${unique('quiet')}/x`;
  await page.goto('/settings');
  const form = page.getByRole('form', { name: 'Add alert rule' });
  await form.getByRole('combobox', { name: /^Type/ }).selectOption('topic-silent');
  await form.getByLabel('Topic', { exact: true }).fill(topic);
  await form.getByRole('button', { name: 'Add rule' }).click();
  const row = page.getByRole('row', { name: new RegExp(topic.replace(/\//g, '\\/')) });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /^Edit alert rule/ }).click();
  const editForm = page.getByRole('form', { name: 'Edit alert rule' });
  await expect(editForm).toBeVisible();
  await expect(editForm.getByRole('combobox').first()).toBeFocused(); // clicking Edit lands you in the editor
  await expect(editForm.getByLabel('Topic', { exact: true })).toHaveValue(topic);
  await editForm.getByLabel('Threshold (s)').fill('90');
  await editForm.getByRole('button', { name: 'Save rule' }).click();
  await expect(row).toContainText('90s');

  await row.getByRole('button', { name: /^Delete alert rule/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete rule' }).click();
  await expect(row).toBeHidden();
  await expect(page.getByText('Alert rule deleted')).toBeVisible();
  expect((await api.get('/api/alerts/rules')).json.rules.filter((r) => r.topic === topic)).toHaveLength(0);
});
