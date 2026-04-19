/**
 * P2OP address encoding helpers.
 *
 * OPNET P2OP address format:
 *   bech32m('op', [0x10, ...toWords([0x00, HASH160(pubkey)])])
 *
 * where HASH160 = RIPEMD160(SHA256(pubkey)) and 0x10 is the witness version.
 *
 * OpStream's `from` field in transaction payloads is a 32-byte schnorr pubkey
 * in 0x-prefixed hex. All decoded event fields (buyer, sender, etc.) are already
 * bech32m. This module bridges the two by converting the pubkey-hex form to
 * bech32m at the event source boundary, so consumers always see bech32m in
 * `event.fromAddress` and raw hex in `event.fromAddressPubkey`.
 */

import { createHash } from 'node:crypto';
import { bech32m } from 'bech32';

/**
 * True when `v` already looks like an OP P2OP address (`op1...`).
 * Uses a structural prefix check — does not validate the checksum.
 */
export function isP2opAddress(v: string | undefined | null): boolean {
  return typeof v === 'string' && v.length > 4 && v.startsWith('op1');
}

/**
 * Convert a 32-byte schnorr pubkey (hex, with or without 0x prefix) to a
 * P2OP bech32m address.
 *
 * Returns `null` when the input is falsy or is not a valid 32-byte hex string
 * (e.g. already a bech32m address, or a malformed value). Callers should fall
 * back to the raw input when null is returned.
 */
export function pubkeyHexToP2op(hex: string | undefined | null): string | null {
  if (!hex) return null;
  const stripped = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (stripped.length !== 64) return null;

  const pubkey  = Buffer.from(stripped, 'hex');
  const sha     = createHash('sha256').update(pubkey).digest();
  const hash160 = createHash('ripemd160').update(sha).digest();

  // P2OP witness program: [deploymentVersion=0x00, ...HASH160 bytes]
  const program = Buffer.concat([Buffer.from([0x00]), hash160]);
  const words   = bech32m.toWords(program);
  // Witness version 0x10 is prepended as the first word
  words.unshift(0x10);
  return bech32m.encode('op', words, 200);
}

/**
 * Normalise an address-or-pubkey value to `{ address, pubkeyHex }`.
 *
 * - If `raw` is already a bech32m P2OP address: `{ address: raw, pubkeyHex: undefined }`
 * - If `raw` is a 32-byte pubkey hex: `{ address: <converted bech32m>, pubkeyHex: raw }`
 * - Otherwise (null / undefined / malformed): `{ address: raw ?? undefined, pubkeyHex: undefined }`
 */
export function normaliseFromAddress(
  raw: string | null | undefined,
): { address: string | undefined; pubkeyHex: string | undefined } {
  if (!raw) return { address: undefined, pubkeyHex: undefined };
  if (isP2opAddress(raw)) return { address: raw, pubkeyHex: undefined };
  const converted = pubkeyHexToP2op(raw);
  if (converted) return { address: converted, pubkeyHex: raw };
  return { address: raw, pubkeyHex: undefined };
}
