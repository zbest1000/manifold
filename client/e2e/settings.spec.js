import { test, expect } from './fixtures.js';
import { api, unique } from './support.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Settings: the tabs live in the URL, config export/import (the same file can be imported twice in a row)
 * and alert rules (editing opens the editor with focus in it; deleting asks first and says it happened).
 */
test('the Settings tab is part of the URL and the theme switch agrees with the sidebar', async ({ page }) => {
  await page.goto('/settings?tab=alerts');
  await expect(page.getByRole('tab', { name: 'Alert rules' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();

  await page.getByRole('radio', { name: 'Light' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: 'Dark' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('config: export downloads a file, importing the same file twice asks and reports both times', async ({ page }) => {
  await page.goto('/settings?tab=configuration');
  await expect(page.getByText(/Redacted: tokens, passwords/)).toBeVisible(); // what is left out is stated
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
  await page.goto('/settings?tab=alerts');
  await page.getByRole('button', { name: 'Add rule' }).click();
  const form = page.getByRole('dialog', { name: 'Add alert rule' });
  await form.getByRole('combobox', { name: /^Type/ }).selectOption('topic-silent');
  // nothing is flagged until a save is attempted
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert').filter({ hasText: 'Enter the topic to watch' })).toBeVisible();
  await form.getByLabel(/^Topic/).fill(topic);
  await form.getByRole('button', { name: 'Add rule' }).click();
  const row = page.getByRole('row', { name: new RegExp(topic.replace(/\//g, '\\/')) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Idle')).toBeVisible();

  await row.getByRole('button', { name: /^Edit alert rule/ }).click();
  const editForm = page.getByRole('dialog', { name: 'Edit alert rule' });
  await expect(editForm).toBeVisible();
  await expect(editForm.getByRole('combobox').first()).toBeFocused(); // opening Edit lands you in the editor
  await expect(editForm.getByLabel(/^Topic/)).toHaveValue(topic);
  await editForm.getByLabel(/^Threshold/).fill('90');
  await editForm.getByRole('button', { name: 'Save rule' }).click();
  await expect(row).toContainText('90s');

  await row.getByRole('button', { name: /^Delete alert rule/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete rule' }).click();
  await expect(row).toBeHidden();
  await expect(page.getByText('Alert rule deleted')).toBeVisible();
  expect((await api.get('/api/alerts/rules')).json.rules.filter((r) => r.topic === topic)).toHaveLength(0);
});
