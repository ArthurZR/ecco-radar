import type { Page } from '@playwright/test';
import sharp from 'sharp';
import yazl from 'yazl';
import { test, expect, signIn, audit } from './fixtures';

// SYNTHETIC Instagram analytics and a SYNTHETIC "Download your information" archive. Nothing real.
const IG_CSV = [
  'Post ID,Account username,Description,Publish time,Permalink,Post type,Reach,Likes,Shares,Comments,Saves',
  '7001,synthetic.ecco,"SYNTHETIC Aqua button study, 2003",10/13/2026 14:00,https://www.instagram.com/p/SYNE2E1/,IG image,1000,80,5,4,11',
  '7002,synthetic.ecco,"SYNTHETIC chrome logo sheet",10/14/2026 14:00,https://www.instagram.com/p/SYNE2E2/,IG image,500,20,1,1,3',
  '7003,synthetic.ecco,"SYNTHETIC post the export does not have",10/15/2026 14:00,https://www.instagram.com/p/SYNE2E3/,IG image,400,10,0,0,1',
].join('\n');

const jpeg = (r: number, g: number, b: number) => sharp({ create: { width: 80, height: 60, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

async function exportZip(): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const posts = [
    { media: [{ uri: 'media/posts/202610/aqua.jpg', creation_timestamp: Date.UTC(2026, 9, 13, 14, 0) / 1000, title: 'SYNTHETIC Aqua button study, 2003' }] },
    { media: [{ uri: 'media/posts/202610/chrome.jpg', creation_timestamp: Date.UTC(2026, 9, 14, 14, 0) / 1000, title: 'SYNTHETIC chrome logo sheet' }] },
  ];
  zip.addBuffer(Buffer.from(JSON.stringify(posts)), 'your_instagram_activity/content/posts_1.json');
  zip.addBuffer(await jpeg(30, 90, 220), 'media/posts/202610/aqua.jpg');
  zip.addBuffer(await jpeg(200, 200, 205), 'media/posts/202610/chrome.jpg');
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const tab = (page: Page, name: string) => page.getByRole('group', { name: 'Section' }).getByRole('button', { name, exact: true }).click();

test('post images: an Instagram download attaches images to imported posts, and each step can be undone', async ({ page }) => {
  await signIn(page);
  await page.goto('/insights');

  await tab(page, 'Imports');
  await page.locator('input[type="file"]').setInputFiles({ name: 'SYNTHETIC-ig-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(IG_CSV) });
  await page.getByLabel('4 · Account to import').selectOption('synthetic.ecco');
  await page.getByRole('button', { name: 'Preview import' }).click();
  await page.getByRole('button', { name: /Commit 3 row/ }).click();
  await expect(page.getByText('SYNTHETIC-ig-e2e.csv').first()).toBeVisible();

  await tab(page, 'Post images');
  await expect(page.getByText('0 of 3')).toBeVisible();
  await page.getByLabel('Instagram ZIP').setInputFiles({ name: 'instagram-synthetic.zip', mimeType: 'application/zip', buffer: await exportZip() });
  await page.getByRole('button', { name: 'Import images' }).click();
  await expect(page.getByText('2 image(s) added')).toBeVisible();
  await expect(page.getByText('2 of 3')).toBeVisible();

  // The post the export lacks is offered for a hand upload.
  const list = page.locator('.post-images-list');
  await expect(list.getByText('SYNTHETIC post the export does not have')).toBeVisible();
  await audit(page, 'Insights post images');
  await list.getByLabel(/Add an image to the/).setInputFiles({ name: 'cover.jpg', mimeType: 'image/jpeg', buffer: await jpeg(10, 10, 10) });
  await expect(page.getByText('Every imported Instagram post has an image.')).toBeVisible();

  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'With images' }).click();
  const thumbs = list.locator('img.post-thumb');
  await expect(thumbs).toHaveCount(3);
  // The stored copies are served from RADAR itself and actually load.
  await expect.poll(() => thumbs.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // Undo the export import, then roll the CSV back so other specs see an empty Instagram history.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('1 of 3')).toBeVisible();
  await tab(page, 'Imports');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByRole('button', { name: 'Roll back' })).toHaveCount(0);
  await tab(page, 'Post images');
  await expect(page.getByText('0 of 0')).toBeVisible();
});
