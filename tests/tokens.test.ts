/**
 * Tests for native token constants and helpers.
 */

import { describe, it, expect } from 'vitest';
import { OPNET_NATIVE_TOKENS, getNativeToken, isNativeToken } from '../src/chains/opnet/tokens.js';

describe('OPNET_NATIVE_TOKENS', () => {
  it('contains BTC and MOTO', () => {
    const symbols = OPNET_NATIVE_TOKENS.map((t) => t.symbol);
    expect(symbols).toContain('BTC');
    expect(symbols).toContain('MOTO');
  });

  it('both tokens have 8 decimals', () => {
    for (const token of OPNET_NATIVE_TOKENS) {
      expect(token.decimals).toBe(8);
    }
  });

  it('all tokens have non-empty address, symbol, name', () => {
    for (const token of OPNET_NATIVE_TOKENS) {
      expect(token.address.length).toBeGreaterThan(0);
      expect(token.symbol.length).toBeGreaterThan(0);
      expect(token.name.length).toBeGreaterThan(0);
    }
  });
});

describe('getNativeToken', () => {
  it('returns BTC metadata by address', () => {
    const btc = OPNET_NATIVE_TOKENS.find((t) => t.symbol === 'BTC')!;
    const result = getNativeToken(btc.address);
    expect(result).toBeDefined();
    expect(result!.symbol).toBe('BTC');
  });

  it('is case-insensitive', () => {
    const btc = OPNET_NATIVE_TOKENS.find((t) => t.symbol === 'BTC')!;
    expect(getNativeToken(btc.address.toUpperCase())).toBeDefined();
    expect(getNativeToken(btc.address.toLowerCase())).toBeDefined();
  });

  it('returns undefined for unknown address', () => {
    expect(getNativeToken('0xdeadbeef')).toBeUndefined();
  });
});

describe('isNativeToken', () => {
  it('true for known native tokens', () => {
    for (const token of OPNET_NATIVE_TOKENS) {
      expect(isNativeToken(token.address)).toBe(true);
    }
  });

  it('false for unknown address', () => {
    expect(isNativeToken('0x1234567890abcdef')).toBe(false);
  });
});
