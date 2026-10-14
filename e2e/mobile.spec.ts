import { test, expect, signIn } from './fixtures';

test('phone width: filters fold away and a reference opens', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('aside.filters')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByLabel('Search text or #ID')).toBeVisible();
  await page.getByRole('button', { name: 'Hide filters' }).click();
  await page.locator('article.card .refid').first().click();
  await expect(page).toHaveURL(/\/ref\/\d+/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
