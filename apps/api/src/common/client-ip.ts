import { isIP } from 'node:net';

/**
 * Who a keyless caller is, for budgets: an IPv4 address as is, an IPv6
 * address by its /48 (one site's whole allocation), so rotating addresses
 * inside one allocation is still one client.
 */
export function clientSubject(ip: string): string {
  const bare = ip.replace(/^::ffff:/i, '');
  if (isIP(bare) === 4) return `v4:${bare}`;
  if (isIP(bare) === 6) {
    const [head, tail] = bare.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = tail !== undefined && tail ? tail.split(':') : [];
    const groups =
      tail === undefined
        ? left
        : [...left, ...new Array<string>(8 - left.length - right.length).fill('0'), ...right];
    return `v6:${groups
      .slice(0, 3)
      .map((g) => parseInt(g || '0', 16).toString(16))
      .join(':')}::/48`;
  }
  return `other:${ip}`;
}
