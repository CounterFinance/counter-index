/**
 * p2op utility tests.
 */

import { describe, it, expect } from 'vitest';
import { pubkeyHexToP2op, isP2opAddress, normaliseFromAddress } from '../src/chains/opnet/p2op.js';

// ---------------------------------------------------------------------------
// pubkeyHexToP2op
// ---------------------------------------------------------------------------

describe('pubkeyHexToP2op', () => {
  // A 32-byte all-zeros pubkey — known-deterministic input
  const ZERO_PUBKEY = '0'.repeat(64);
  // Same pubkey with 0x prefix
  const ZERO_PUBKEY_0X = '0x' + ZERO_PUBKEY;

  it('converts a 32-byte hex pubkey to a bech32m op1 address', () => {
    const result = pubkeyHexToP2op(ZERO_PUBKEY);
    expect(result).not.toBeNull();
    expect(result!.startsWith('op1')).toBe(true);
  });

  it('is deterministic — same pubkey always yields same address', () => {
    const a = pubkeyHexToP2op(ZERO_PUBKEY);
    const b = pubkeyHexToP2op(ZERO_PUBKEY);
    expect(a).toBe(b);
  });

  it('handles 0x prefix on input', () => {
    const withoutPrefix = pubkeyHexToP2op(ZERO_PUBKEY);
    const withPrefix    = pubkeyHexToP2op(ZERO_PUBKEY_0X);
    expect(withoutPrefix).toBe(withPrefix);
  });

  it('handles 0X (uppercase) prefix on input', () => {
    const result = pubkeyHexToP2op('0X' + ZERO_PUBKEY);
    expect(result).toBe(pubkeyHexToP2op(ZERO_PUBKEY));
  });

  it('returns different addresses for different pubkeys', () => {
    const alt = 'a'.repeat(64);
    expect(pubkeyHexToP2op(ZERO_PUBKEY)).not.toBe(pubkeyHexToP2op(alt));
  });

  it('returns null for a string shorter than 64 hex chars', () => {
    expect(pubkeyHexToP2op('abcd')).toBeNull();
  });

  it('returns null for an already-bech32m address', () => {
    expect(pubkeyHexToP2op('op1sqzjrvunc')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(pubkeyHexToP2op(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(pubkeyHexToP2op(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(pubkeyHexToP2op('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isP2opAddress
// ---------------------------------------------------------------------------

describe('isP2opAddress', () => {
  it('returns true for a string starting with op1', () => {
    expect(isP2opAddress('op1sqzjrvuncabc')).toBe(true);
  });

  it('returns false for a hex pubkey', () => {
    expect(isP2opAddress('0'.repeat(64))).toBe(false);
  });

  it('returns false for a 0x-prefixed hex pubkey', () => {
    expect(isP2opAddress('0x' + '0'.repeat(64))).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isP2opAddress(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isP2opAddress(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isP2opAddress('')).toBe(false);
  });

  it('returns false for short strings that start with op but not op1', () => {
    expect(isP2opAddress('op')).toBe(false);  // length <= 4
  });
});

// ---------------------------------------------------------------------------
// normaliseFromAddress
// ---------------------------------------------------------------------------

describe('normaliseFromAddress', () => {
  const HEX_PUBKEY = '0'.repeat(64);

  it('converts a hex pubkey to bech32m address and exposes pubkeyHex', () => {
    const { address, pubkeyHex } = normaliseFromAddress(HEX_PUBKEY);
    expect(address).not.toBeUndefined();
    expect(address!.startsWith('op1')).toBe(true);
    expect(pubkeyHex).toBe(HEX_PUBKEY);
  });

  it('passes through an already-bech32m address unchanged', () => {
    const bech32 = 'op1sqzjrvuncabc123456789';
    const { address, pubkeyHex } = normaliseFromAddress(bech32);
    expect(address).toBe(bech32);
    expect(pubkeyHex).toBeUndefined();
  });

  it('returns both undefined for null input', () => {
    const { address, pubkeyHex } = normaliseFromAddress(null);
    expect(address).toBeUndefined();
    expect(pubkeyHex).toBeUndefined();
  });

  it('returns both undefined for undefined input', () => {
    const { address, pubkeyHex } = normaliseFromAddress(undefined);
    expect(address).toBeUndefined();
    expect(pubkeyHex).toBeUndefined();
  });

  it('returns raw address unchanged when conversion is not possible (malformed)', () => {
    const malformed = 'not-hex-not-bech32m';
    const { address, pubkeyHex } = normaliseFromAddress(malformed);
    expect(address).toBe(malformed);
    expect(pubkeyHex).toBeUndefined();
  });

  it('is consistent with pubkeyHexToP2op for hex pubkey input', () => {
    const expected = pubkeyHexToP2op(HEX_PUBKEY);
    const { address } = normaliseFromAddress(HEX_PUBKEY);
    expect(address).toBe(expected);
  });
});
