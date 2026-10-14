import type { Page } from '@playwright/test';
import { test, expect, signIn, audit, EDITOR } from './fixtures';

/** The masonry lays cards out by column, so rank position comes from data-idx, not DOM order. */
const card = (page: Page, idx: number) => page.locator(`article.card[data-idx="${idx}"]`);
const byRef = (page: Page, label: string) => page.locator('article.card', { has: page.locator('.refid', { hasText: label }) });
/** Badges show a short label; the full status name is in the title. */
const badge = (status: string) => `.badge[title="${status}"]`;

// The seeded references are SYNTHETIC (server/scripts/e2e-server.ts); no real source is contacted.

test('private by default: the archive needs a sign-in and rejects a wrong password', async ({ page }) => {
  const api = await page.request.get('/api/references');
  expect(api.status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('Email').fill(EDITOR.email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect');
  await expect(page.getByRole('heading', { name: 'RADAR', exact: true })).toHaveCount(0);
});

test('feed: permanent IDs, keyboard approval with undo, and the research view', async ({ page }) => {
  await signIn(page);
  await page.goto('/?sort=ref_number');
  const cards = page.locator('article.card');
  await expect(cards).toHaveCount(8);
  // ID order is newest first; the IDs never change whatever the ranking does.
  await expect(card(page, 0).locator('.refid')).toHaveText('#00008');
  await expect(card(page, 7).locator('.refid')).toHaveText('#00001');

  // a approves the selected (first) reference for editorial consideration; Undo reverts it.
  await page.locator('body').press('a');
  await expect(card(page, 0).locator(badge('Approved for consideration'))).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, 0).locator(badge('Discovered'))).toBeVisible();

  // j moves the selection, s saves the second reference.
  await page.locator('body').press('j');
  await page.locator('body').press('s');
  await expect(card(page, 1).locator(badge('Saved for research'))).toBeVisible();

  // Research view shows every reason and the attribution basis, and is remembered after a reload.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Research' }).click();
  await expect(page.locator('.research-list article.card')).toHaveCount(8);
  await expect(page.getByText('Creator not stated by the source')).toBeVisible();
  await page.reload();
  await expect(page.locator('.research-list')).toBeVisible();
  await page.locator('body').press('v');
  await expect(page.locator('.masonry')).toBeVisible();
});

test('reject asks for a reason and keeps the item in the archive', async ({ page }) => {
  await signIn(page);
  await page.goto('/?sort=ref_number');
  const third = card(page, 2);
  await third.getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Reject/ }).click();
  await expect(page.locator('article.card')).toHaveCount(7);

  await page.goto('/archive');
  await expect(page.getByText('SYNTHETIC Arcade cabinet marquee')).toBeVisible();
});

test('detail: the original source link, a research note and honest performance context', async ({ page }) => {
  await signIn(page);
  await page.goto('/ref/1');
  await expect(page.getByText('#00001').first()).toBeVisible();
  await expect(page.locator('a[href="https://example.com/synthetic/1"]').first()).toBeVisible();
  await page.getByLabel('New note').fill('SYNTHETIC note: checked the source page.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('SYNTHETIC note: checked the source page.')).toBeVisible();
  // Performance context is honest about missing analytics.
  await expect(page.getByText(/No post-level analytics imported yet/)).toBeVisible();
});

test('archive groups: references are grouped by wording, and colour grouping waits for analysed images', async ({ page }) => {
  await signIn(page);
  await page.goto('/archive');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Groups' }).click();
  await expect(page.getByRole('heading', { name: 'Group 1' })).toBeVisible();
  await expect(page.getByText(/rejected references left out/)).toBeVisible();
  await page.locator('.cluster-members a').first().click();
  await expect(page).toHaveURL(/\/ref\/\d+/);

  await page.goto('/archive');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Groups' }).click();
  await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Colour & tone' }).click();
  await expect(page.getByText('Not enough to group yet')).toBeVisible();
});

test('caption studio to manual publication never contacts a platform', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/1');
  // A discovered reference cannot jump into the publication pipeline; the button says why.
  await expect(page.getByRole('button', { name: 'Mark caption draft' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mark caption draft' })).toHaveAttribute('title', /Save or approve/);
  await page.goto('/?sort=ref_number');
  await byRef(page, '#00001').getByRole('button', { name: 'Save' }).click();
  await expect(byRef(page, '#00001').locator(badge('Saved for research'))).toBeVisible();

  await page.goto('/studio/1');
  await page.getByRole('button', { name: 'Assemble from facts (no AI)' }).click();
  await expect(page.getByText('SYNTHETIC Aqua button study, Test Designer A, 2003.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Use as final text' }).first().click();
  await page.getByLabel('Final caption').fill('SYNTHETIC Aqua button study, Test Designer A, 2003. Final words.');
  await page.getByRole('button', { name: 'Save final caption' }).click();
  await expect(page.getByText(/^saved /)).toBeVisible();

  // The publication pack credits only what the source states and lists what is still open.
  const pack = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Publication pack' }) });
  await expect(pack.locator('.credit-line')).toHaveText('“SYNTHETIC Aqua button study”, Test Designer A, 2003. Via Manual URL import.');
  await expect(pack.getByText('Not yet approved for manual publication.')).toBeVisible();
  await audit(page, 'Caption Studio with publication pack');

  await page.getByRole('button', { name: 'Mark caption draft' }).click();
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await page.getByRole('button', { name: 'Approve for manual publication' }).click();
  await page.getByRole('button', { name: 'I published it manually…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/does not post, schedule or contact any platform/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(page.locator(badge('Manually published')).first()).toBeVisible();
  // The fixture checks after each test that no request left RADAR's own origin.
});

test('import: X daily totals stay account-level, and the batch can be rolled back', async ({ page }) => {
  await signIn(page);
  await page.goto('/insights');
  await page.getByRole('group', { name: 'Section' }).getByRole('button', { name: 'Imports' }).click();
  const csv = [
    'Date,Impressions,Likes,Engagements,Bookmarks,Shares,New follows,Unfollows,Replies,Reposts,Profile visits',
    '"Sun, Oct 5, 2025",1500,30,80,2,1,3,0,4,5,9',
    '"Mon, Oct 6, 2025",900,12,40,0,0,1,1,2,1,4',
  ].join('\n');
  await page.locator('input[type="file"]').setInputFiles({ name: 'SYNTHETIC-x-overview.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByPlaceholder('handle without @').fill('synthetic_account');
  await page.getByRole('button', { name: 'Preview import' }).click();
  await page.getByRole('button', { name: /Commit 2 row/ }).click();
  await expect(page.getByText('SYNTHETIC-x-overview.csv').first()).toBeVisible();

  await page.getByRole('group', { name: 'Section' }).getByRole('button', { name: 'X daily' }).click();
  await expect(page.getByText(/account-level|account totals/i).first()).toBeVisible();

  await page.getByRole('group', { name: 'Section' }).getByRole('button', { name: 'Imports' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByRole('button', { name: 'Roll back' })).toHaveCount(0);
});

test('settings: the daily AI limit can be changed and removed', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  const field = page.getByLabel(/Daily AI limit/);
  await expect(field).toHaveValue('200000');
  await field.fill('50000');
  await field.press('Enter');
  await expect(page.getByText(/of 50,000 tokens used/)).toBeVisible();
  await field.fill('');
  await field.press('Enter');
  await expect(page.getByText(/no limit set/)).toBeVisible();
});
