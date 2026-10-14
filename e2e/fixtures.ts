import { test as base, expect, type Page } from '@playwright/test';

export const EDITOR = { email: 'editor@example.com', password: 'e2e-password-1234' };

export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(EDITOR.email);
  await page.getByLabel('Password').fill(EDITOR.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'RADAR', exact: true })).toBeVisible();
}

/**
 * Every test also checks that the browser only ever talked to RADAR itself: no request to a social
 * platform or any other origin, whatever buttons were pressed.
 */
export const test = base.extend<{ foreignRequests: string[] }>({
  foreignRequests: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const foreign: string[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.protocol.startsWith('http') && u.origin !== origin) foreign.push(`${r.method()} ${r.url()}`);
      });
      await use(foreign);
      expect(foreign, 'requests to origins other than RADAR').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
