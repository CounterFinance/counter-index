/**
 * Tests for built-in OPNET event decoders.
 */

import { describe, it, expect } from 'vitest';
import { decodeEvent, DECODER_REGISTRY } from '../src/chains/opnet/decoders.js';

// Helpers to build raw event bytes in OPNET big-endian format

function addr(lastByte: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[31] = lastByte;
  return buf;
}

function u256(value: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

describe('DECODER_REGISTRY', () => {
  it('contains all expected event names', () => {
    const expected = [
      'Transferred', 'Synced', 'Swapped',
      'LiquidityListed', 'LiquidityAdded', 'PoolCreated', 'SwapExecuted',
      'Approval', 'ApprovalForAll',
    ];
    for (const name of expected) {
      expect(DECODER_REGISTRY.has(name)).toBe(true);
    }
  });
});

describe('Approval decoder', () => {
  it('decodes owner, spender, value', () => {
    const raw = concat(addr(0x01), addr(0x02), u256(999n));
    const result = decodeEvent('Approval', raw);
    expect(result).not.toBeNull();
    expect(result!['owner']).toMatch(/^0x/);
    expect(result!['spender']).toMatch(/^0x/);
    expect(result!['value']).toBe('999');
  });

  it('returns null for undersized input', () => {
    expect(decodeEvent('Approval', new Uint8Array(64))).toBeNull();
  });
});

describe('ApprovalForAll decoder', () => {
  it('decodes owner, operator, approved=true', () => {
    const raw = concat(addr(0x0a), addr(0x0b), new Uint8Array([1]));
    const result = decodeEvent('ApprovalForAll', raw);
    expect(result).not.toBeNull();
    expect(result!['owner']).toMatch(/^0x/);
    expect(result!['operator']).toMatch(/^0x/);
    expect(result!['approved']).toBe(true);
  });

  it('decodes approved=false when byte is 0', () => {
    const raw = concat(addr(0x0a), addr(0x0b), new Uint8Array([0]));
    const result = decodeEvent('ApprovalForAll', raw);
    expect(result!['approved']).toBe(false);
  });

  it('returns null for undersized input', () => {
    expect(decodeEvent('ApprovalForAll', new Uint8Array(64))).toBeNull();
  });
});

describe('Transferred decoder', () => {
  it('decodes from, to, value', () => {
    const raw = concat(addr(0x01), addr(0x02), u256(5000n));
    const result = decodeEvent('Transferred', raw);
    expect(result!['value']).toBe('5000');
  });

  it('returns null for undersized input', () => {
    expect(decodeEvent('Transferred', new Uint8Array(10))).toBeNull();
  });
});

describe('decodeEvent', () => {
  it('returns null for unknown event name', () => {
    expect(decodeEvent('UnknownEvent', new Uint8Array(96))).toBeNull();
  });
});
