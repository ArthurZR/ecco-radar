import { lookup as dnsLookup } from 'node:dns';
import ipaddr from 'ipaddr.js';

/**
 * SSRF protection for every outbound request whose URL could be influenced by a user or by
 * fetched content. Addresses are validated at connection time (see http-client.ts), so a DNS
 * answer that changes between check and connect (DNS rebinding) is still caught.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const ALLOWED_PORTS = new Set(['', '80', '443']);
const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata\.google\.internal$/i];

/** Synchronous checks on the URL itself. */
export function assertSafeUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http and https URLs are allowed');
  }
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  if (!ALLOWED_PORTS.has(url.port)) throw new BlockedUrlError('Only standard web ports (80, 443) are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.some((re) => re.test(host))) throw new BlockedUrlError('Local hostnames are not allowed');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new BlockedUrlError('Private, loopback and reserved addresses are not allowed');
  }
  if (!host.includes('.') && !ipaddr.isValid(host)) throw new BlockedUrlError('Single-label hostnames are not allowed');
  return url;
}

export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString());
  }
  return parsed.range() === 'unicast';
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
import type * as dns from 'node:dns';

/** A dns.lookup replacement that refuses to hand non-public addresses to the socket. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (list.length === 0 || bad) {
      const e = new BlockedUrlError(`Host ${hostname} resolves to a non-public address`) as unknown as NodeJS.ErrnoException;
      e.code = 'ESSRF';
      return callback(e, '');
    }
    if (options.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}
