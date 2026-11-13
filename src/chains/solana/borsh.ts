/**
 * Minimal Borsh (de)serialisation for the Solana adapter — just the field types
 * an Anchor event payload uses, so the adapter stays dependency-free. Little-
 * endian, as Borsh/Solana specify. A tiny base58 encoder renders pubkeys the way
 * Solana does.
 */

export type SolType = 'u8' | 'u16' | 'u32' | 'u64' | 'i64' | 'bool' | 'pubkey' | 'string' | 'bytes';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58-encode bytes (Bitcoin/Solana alphabet). */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let k = 0; bytes[k] === 0 && k < bytes.length - 1; k++) out += '1';   // leading zeros
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Sequential little-endian reader over a byte buffer. */
export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) throw new RangeError('borsh: unexpected end of buffer');
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  private uint(n: number): number {
    const b = this.take(n);
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + b[i];
    return v;
  }

  private bigUint(n: number): bigint {
    const b = this.take(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  read(type: SolType): unknown {
    switch (type) {
      case 'u8':     return this.uint(1);
      case 'u16':    return this.uint(2);
      case 'u32':    return this.uint(4);
      case 'u64':    return this.bigUint(8);
      case 'i64': {
        const u = this.bigUint(8);
        return u >= (1n << 63n) ? u - (1n << 64n) : u;   // two's complement
      }
      case 'bool':   return this.uint(1) !== 0;
      case 'pubkey': return base58Encode(this.take(32));
      case 'bytes':  return new Uint8Array(this.take(this.uint(4)));   // u32 len + bytes
      case 'string': return new TextDecoder().decode(this.take(this.uint(4)));
    }
  }

  get bytesRead(): number { return this.offset; }
}

/** Append-only little-endian writer — used by tests/dogfood to build fixtures. */
export class BorshWriter {
  private parts: number[] = [];
  private pushUint(v: number | bigint, n: number): this {
    let x = BigInt(v);
    for (let i = 0; i < n; i++) { this.parts.push(Number(x & 0xffn)); x >>= 8n; }
    return this;
  }
  write(type: SolType, value: unknown): this {
    switch (type) {
      case 'u8':  return this.pushUint(value as number, 1);
      case 'u16': return this.pushUint(value as number, 2);
      case 'u32': return this.pushUint(value as number, 4);
      case 'u64': return this.pushUint(value as bigint, 8);
      case 'i64': { const v = value as bigint; return this.pushUint(v < 0n ? v + (1n << 64n) : v, 8); }
      case 'bool': this.parts.push((value as boolean) ? 1 : 0); return this;
      case 'pubkey': { for (const b of value as Uint8Array) this.parts.push(b); return this; }
      case 'bytes': { const b = value as Uint8Array; this.pushUint(b.length, 4); for (const x of b) this.parts.push(x); return this; }
      case 'string': { const b = new TextEncoder().encode(value as string); this.pushUint(b.length, 4); for (const x of b) this.parts.push(x); return this; }
    }
  }
  concat(prefix: Uint8Array): Uint8Array {
    return new Uint8Array([...prefix, ...this.parts]);
  }
  toBytes(): Uint8Array { return new Uint8Array(this.parts); }
}
