import type { Page } from '@playwright/test';
import { test, expect, signIn, audit } from './fixtures';

// Automated WCAG 2.1 A/AA checks on every screen. Automated rules catch only part of what matters
// (contrast, names, labels, landmarks, ARIA); keyboard flows are covered in radar.spec.ts.

async function tab(page: Page, group: string, name: string) {
  await page.getByRole('group', { name: group }).getByRole('button', { name }).click();
  await page.waitForLoadState('networkidle');
}

test('sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await audit(page, 'sign-in');
});

test('every section of the app', async ({ page }) => {
  await signIn(page);
  await page.waitForLoadState('networkidle');
  await audit(page, 'RADAR dense');
  await tab(page, 'View', 'Research');
  await audit(page, 'RADAR research');
  await tab(page, 'View', 'Dense');

  await page.goto('/ref/1');
  await page.waitForLoadState('networkidle');
  await audit(page, 'reference detail');

  for (const [path, label] of [['/explore', 'Explore'], ['/studio/1', 'Caption Studio'], ['/sources', 'Sources'], ['/settings', 'Settings']] as const) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await audit(page, label);
  }

  await page.goto('/archive');
  await page.waitForLoadState('networkidle');
  await audit(page, 'Archive references');
  await tab(page, 'View', 'Groups');
  await audit(page, 'Archive groups');
  await tab(page, 'View', 'Decision history');
  await audit(page, 'Archive decisions');

  // Import a SYNTHETIC X file so the daily chart and its table are audited too.
  await page.goto('/insights');
  await tab(page, 'Section', 'Imports');
  const days = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 6, 1 + i));
    return `${d.toISOString().slice(0, 10)},${1000 + i * 37},${10 + (i % 7)}`;
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'SYNTHETIC-x-a11y.csv', mimeType: 'text/csv', buffer: Buffer.from(['Date,Impressions,Likes', ...days].join('\n')) });
  await page.getByPlaceholder('handle without @').fill('synthetic_a11y');
  await page.getByRole('button', { name: 'Preview import' }).click();
  await page.getByRole('button', { name: /Commit 21 row/ }).click();
  await expect(page.getByText('SYNTHETIC-x-a11y.csv').first()).toBeVisible();

  for (const name of ['Overview', 'Instagram posts', 'X daily', 'Editorial', 'Imports']) {
    await tab(page, 'Section', name);
    if (name === 'X daily') await expect(page.locator('svg[role="img"]').first()).toBeVisible();
    await audit(page, `Insights ${name}`);
  }

  // Leave the database as the other specs expect it.
  await tab(page, 'Section', 'Imports');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByRole('button', { name: 'Roll back' })).toHaveCount(0);
});
