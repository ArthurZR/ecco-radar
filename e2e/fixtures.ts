import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Cookie, type Page } from '@playwright/test';

export const EDITOR = { email: 'editor@example.com', password: 'e2e-password-1234' };

// Sign in through the form once, then reuse the session: the server allows only 10 sign-ins per
// 15 minutes from one address, and the suite has more tests than that.
let session: Cookie[] | null = null;

export async function signIn(page: Page): Promise<void> {
  if (session) {
    await page.context().addCookies(session);
    await page.goto('/');
    const signedIn = page.getByRole('heading', { name: 'RADAR', exact: true });
    const form = page.getByRole('button', { name: 'Sign in' });
    await expect(signedIn.or(form)).toBeVisible();
    if (await signedIn.isVisible()) return;
    session = null;
  }
  await page.goto('/');
  await page.getByLabel('Email').fill(EDITOR.email);
  await page.getByLabel('Password').fill(EDITOR.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'RADAR', exact: true })).toBeVisible();
  session = await page.context().cookies();
}

/** Automated WCAG 2.1 A/AA checks on the current page; all violations are reported, not just the first. */
export async function audit(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect.soft(summary, `accessibility violations on ${label}`).toEqual([]);
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
