/**
 * Hex <-> bytes helpers, shared across chain adapters so the conversion lives in
 * one place. Chain-neutral: no adapter owns these.
 */

/**
 * Decode a hex string (with or without a `0x` prefix) to bytes. An odd-length
 * string is left-padded with a zero nibble (Buffer.from would otherwise silently
 * drop the trailing nibble). Empty -> empty.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const even = clean.length % 2 === 0 ? clean : '0' + clean;
  return new Uint8Array(Buffer.from(even, 'hex'));
}

/** Encode bytes to a `0x`-prefixed hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}
