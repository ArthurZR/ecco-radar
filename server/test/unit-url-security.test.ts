import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from '../src/lib/canonical-url.js';
import { assertSafeUrlShape, isPublicAddress, guardedLookup } from '../src/lib/ssrf.js';

describe('canonicalizeUrl', () => {
  it('normalises scheme, host, tracking params, trailing slash and fragments', () => {
    expect(canonicalizeUrl('HTTP://WWW.Example.com/a/b/?utm_source=x&b=2&a=1#frag')).toBe('https://example.com/a/b?a=1&b=2');
  });
  it('maps known host aliases and short links', () => {
    expect(canonicalizeUrl('https://twitter.com/user/status/1?s=20')).toBe('https://x.com/user/status/1');
    expect(canonicalizeUrl('https://youtu.be/abc123?t=4')).toBe('https://youtube.com/watch?t=4&v=abc123');
    expect(canonicalizeUrl('https://www.instagram.com/p/XYZ/?igsh=abc')).toBe('https://instagram.com/p/XYZ');
    expect(canonicalizeUrl('https://commons.m.wikimedia.org/wiki/File:A.jpg')).toBe('https://commons.wikimedia.org/wiki/File:A.jpg');
  });
  it('keeps meaningful query parameters', () => {
    expect(canonicalizeUrl('https://example.com/view?id=5')).toBe('https://example.com/view?id=5');
  });
  it('rejects non-web schemes', () => {
    expect(() => canonicalizeUrl('javascript:alert(1)')).toThrow();
    expect(() => canonicalizeUrl('file:///etc/passwd')).toThrow();
  });
});

describe('SSRF guard', () => {
  it.each([
    'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/',
    'http://metadata.google.internal/', 'http://printer.local/', 'http://intranet/', 'ftp://example.com/',
    'http://user:pass@example.com/', 'http://example.com:8080/', 'gopher://example.com/',
  ])('blocks %s', (url) => {
    expect(() => assertSafeUrlShape(url)).toThrow();
  });
  it('allows ordinary public URLs', () => {
    expect(assertSafeUrlShape('https://example.com/page').hostname).toBe('example.com');
    expect(assertSafeUrlShape('http://93.184.216.34/').hostname).toBe('93.184.216.34');
  });
  it('classifies addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('100.64.0.1')).toBe(false); // carrier-grade NAT
    expect(isPublicAddress('fd00::1')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
  });
  it('refuses to connect when DNS resolves to a private address (rebinding defence)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      guardedLookup('localhost', {}, (e) => resolve(e)),
    );
    expect(err?.code).toBe('ESSRF');
  });
});
