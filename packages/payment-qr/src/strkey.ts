/* Stellar StrKey checks (SEP-23) without a Stellar SDK: base32 (RFC 4648, no padding), a version
   byte, the payload and a CRC16-XModem checksum (little-endian). Only recognises; it never needs
   or keeps a key. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The kinds of StrKey a payments app meets. */
export type StrKeyKind = 'account' | 'muxed' | 'contract' | 'secret';

const VERSIONS: Record<StrKeyKind, { version: number; payload: number; prefix: string }> = {
  account: { version: 6 << 3, payload: 32, prefix: 'G' },
  muxed: { version: 12 << 3, payload: 40, prefix: 'M' },
  contract: { version: 2 << 3, payload: 32, prefix: 'C' },
  secret: { version: 18 << 3, payload: 32, prefix: 'S' },
};

function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  // Canonical encodings leave fewer than 5 bits over, all zero.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** CRC16-XModem: polynomial 0x1021, initial value 0. */
export function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The kind of a valid StrKey, or null when `text` is not one (wrong length, alphabet, version
    or checksum). */
export function strKeyKind(text: string): StrKeyKind | null {
  if (typeof text !== 'string' || text.length < 56 || text.length > 69) return null;
  const kind = (Object.keys(VERSIONS) as StrKeyKind[]).find((k) => VERSIONS[k].prefix === text[0]);
  if (!kind) return null;
  const spec = VERSIONS[kind];
  const bytes = base32Decode(text);
  if (!bytes || bytes.length !== 1 + spec.payload + 2 || bytes[0] !== spec.version) return null;
  const body = bytes.subarray(0, bytes.length - 2);
  const checksum = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
  return crc16Xmodem(body) === checksum ? kind : null;
}

/** Whether `text` is an address money can be sent to: an account (G), a muxed account (M) or a
    contract (C). A secret seed (S) is never an address. */
export function isStellarAddress(
  text: string,
  kinds: readonly Exclude<StrKeyKind, 'secret'>[] = ['account', 'muxed', 'contract'],
): boolean {
  const kind = strKeyKind(text);
  return kind !== null && kind !== 'secret' && kinds.includes(kind);
}
