import { describe, expect, it } from 'vitest';
import { parseCount, parseDateTime, detectDateOrder, parseCsv } from '../src/modules/imports/normalize.js';
import { detectKind, suggestMapping } from '../src/modules/imports/schemas.js';

describe('parseCount', () => {
  it('treats missing markers as absent, never zero', () => {
    for (const v of ['', '-', 'N/A', '—', undefined]) expect(parseCount(v)).toEqual({ ok: true, value: null });
  });
  it('parses grouped thousands', () => {
    expect(parseCount('1,234')).toEqual({ ok: true, value: 1234 });
    expect(parseCount('1.234.567')).toEqual({ ok: true, value: 1234567 });
    expect(parseCount('12 345')).toEqual({ ok: true, value: 12345 });
    expect(parseCount('42')).toEqual({ ok: true, value: 42 });
  });
  it('rejects negatives, text and ambiguous decimals', () => {
    expect(parseCount('-3').ok).toBe(false);
    expect(parseCount('lots').ok).toBe(false);
    expect(parseCount('12,5').ok).toBe(false);
  });
});

describe('dates', () => {
  it('detects day/month order only when the data proves it', () => {
    expect(detectDateOrder(['10/05/2026 14:00', '10/25/2026 09:00'])).toBe('MDY');
    expect(detectDateOrder(['25/10/2026', '01/02/2026'])).toBe('DMY');
    expect(detectDateOrder(['01/02/2026', '03/04/2026'])).toBeNull();
    expect(detectDateOrder(['2026-10-05'])).toBe('ISO');
  });
  it('parses export formats', () => {
    expect(parseDateTime('10/25/2026 14:05', 'MDY')).toEqual({ ok: true, value: '2026-10-25T14:05:00.000Z' });
    expect(parseDateTime('Sun, Oct 5, 2025', 'ISO')).toEqual({ ok: true, value: '2025-10-05T00:00:00.000Z' });
    expect(parseDateTime('2025-10-06', 'ISO')).toEqual({ ok: true, value: '2025-10-06T00:00:00.000Z' });
    expect(parseDateTime('02/30/2026', 'MDY').ok).toBe(false);
    expect(parseDateTime('01/02/2026', 'ISO').ok).toBe(false);
  });
});

describe('CSV inspection', () => {
  it('parses BOM, quoted fields and detects export kinds', () => {
    const csv = parseCsv(Buffer.from('﻿Post ID,Account username,Description,Permalink,Publish time,Views\n1,ecco.archive,"A, b",https://www.instagram.com/p/A/,10/25/2026 14:05,10\n'));
    expect(csv.headers[0]).toBe('Post ID');
    expect(csv.rows[0]!.Description).toBe('A, b');
    expect(detectKind(csv.headers).kind).toBe('instagram_posts');
    expect(suggestMapping('instagram_posts', csv.headers)).toMatchObject({ post_id: 'Post ID', caption: 'Description', views: 'Views' });
    expect(detectKind(['Date', 'Impressions', 'Likes', 'New follows']).kind).toBe('x_account_daily');
  });
});
