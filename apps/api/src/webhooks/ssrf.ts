import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Webhook destinations are chosen by API clients, so the sender must never be
 * turned against the network it runs in (SSRF). A destination is refused when
 * ANY address its host resolves to is private, loopback, link-local, unique
 * local, multicast, reserved or otherwise not public, and the check runs at
 * CONNECT time (`safeLookup` as the socket's resolver), so a DNS answer that
 * changes between a check and the request (rebinding) is caught too.
 */

function ipv4Parts(ip: string): number[] {
  return ip.split('.').map(Number);
}

function isPublicIpv4(ip: string): boolean {
  const [a, b, c] = ipv4Parts(ip);
  if (a === 0 || a === 10 || a === 127) return false; // this net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** The 8 groups of an IPv6 address, or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = ipv4Parts(dotted[2]);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) =>
    s ? s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : [];
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

function isPublicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return false; // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // IETF protocol assignments (incl. Teredo)
  return true;
}

/** Whether an IP literal is a public unicast address. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

export interface DestinationPolicy {
  /** Development only: http:// and private destinations are allowed. */
  allowInsecure: boolean;
}

/** Static checks of a destination URL; answers the problem, or null when it may be used. */
export function destinationProblem(raw: string, policy: DestinationPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be an absolute URL';
  }
  if (url.protocol !== 'https:' && !(policy.allowInsecure && url.protocol === 'http:')) {
    return 'url must use https';
  }
  if (url.username || url.password) return 'url must not carry credentials';
  if (raw.length > 2000) return 'url is too long';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowInsecure) {
    if (isIP(host) && !isPublicAddress(host)) return 'url must point to a public address';
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
      return 'url must point to a public host';
    }
  }
  return null;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for `http(s).request` that resolves every address of the host
 * and refuses the connection when any of them is not public.
 */
export function safeLookup(policy: DestinationPolicy) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (!policy.allowInsecure && list.some((a) => !isPublicAddress(a.address))) {
        const refused = new Error(
          `webhook destination ${hostname} resolves to a non-public address`,
        ) as NodeJS.ErrnoException;
        refused.code = 'EDESTINATION';
        return callback(refused, []);
      }
      if (options.all) return callback(null, list);
      const first = list[0];
      if (!first)
        return callback(new Error(`no address for ${hostname}`) as NodeJS.ErrnoException, []);
      callback(null, first.address, first.family);
    });
  };
}
