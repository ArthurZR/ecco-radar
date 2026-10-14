import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { db } from '../../db/pool.js';
import { mediaDir } from '../post-media/service.js';

/**
 * A local copy of a reference's preview, kept only where reuse is permitted: the source allows
 * media caching, or the item itself carries an open licence that permits redistribution with
 * attribution (public domain, CC0, CC BY, CC BY-SA). Non-commercial and no-derivatives licences,
 * unknown rights and "all rights reserved" are never cached; those previews stay links to the
 * source. The copy is a 640px WebP used when the original link stops working.
 */
export const PREVIEW_DIR = 'previews';

const OPEN = /(public domain|^pd\b|\bpd-|\bcc0\b|cc[\s-]*by(?:[\s-]*sa)?(?:[\s-]*\d(?:\.\d)?)?\s*$|^attribution\b)/i;
const RESTRICTED = /\b(nc|nd|non[\s-]*commercial|no[\s-]*deriv|all rights reserved|copyright(ed)?|fair use)\b/i;

export function licencePermitsCaching(licence: string | null): boolean {
  if (!licence) return false;
  const l = licence.trim();
  return OPEN.test(l) && !RESTRICTED.test(l);
}

export async function previewCachingEnabled(): Promise<boolean> {
  const r = await db().query<{ value: boolean }>(`SELECT value FROM app_settings WHERE key = 'preview_caching_enabled'`);
  return r.rows[0]?.value ?? true;
}

/** Why a reference may (or may not) keep a local preview. */
export async function cachingPermission(referenceId: string): Promise<{ allowed: boolean; basis: string }> {
  const r = await db().query<{ allows: boolean; license: string | null; name: string }>(
    `SELECT s.allows_media_caching AS allows, r.license, s.name FROM reference_items r JOIN sources s ON s.id = r.source_id WHERE r.id = $1`,
    [referenceId],
  );
  const row = r.rows[0];
  if (!row) return { allowed: false, basis: 'Reference not found' };
  if (row.allows) return { allowed: true, basis: `${row.name} permits caching previews` };
  if (licencePermitsCaching(row.license)) return { allowed: true, basis: `Open licence: ${row.license}` };
  return { allowed: false, basis: row.license ? `Licence does not clearly permit reuse (${row.license})` : 'No licence stated; linked from the source only' };
}

/** Stores the local copy when permitted. Returns the stored relative path, or null. */
export async function cachePreviewIfPermitted(referenceId: string, image: Buffer): Promise<string | null> {
  if (!(await previewCachingEnabled())) return null;
  if (!(await cachingPermission(referenceId)).allowed) return null;
  const rel = `${PREVIEW_DIR}/${referenceId}.webp`;
  await mkdir(join(mediaDir(), PREVIEW_DIR), { recursive: true });
  const webp = await sharp(image, { limitInputPixels: 50_000_000 }).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  await writeFile(join(mediaDir(), rel), webp);
  await db().query('UPDATE reference_items SET cached_preview_path = $2 WHERE id = $1', [referenceId, rel]);
  return rel;
}
