/**
 * Decoder edge cases that close mutation-testing gaps (M12): the no-eventName
 * path, non-event ABI items, and unnamed (positional) event args.
 */

import { describe, it, expect } from 'vitest';
import { toEventSelector, pad } from 'viem';
import type { Abi } from 'viem';
import { OpnetDecoder } from '../src/chains/opnet/opnetDecoder.js';
import { EvmAbiDecoder } from '../src/chains/evm/evmDecoder.js';

describe('OpnetDecoder edge cases', () => {
  it('returns null when no eventName is supplied (OPNET can’t name a log alone)', () => {
    expect(new OpnetDecoder().decode({ raw: new Uint8Array(96) })).toBeNull();
  });
});

describe('EvmAbiDecoder edge cases', () => {
  const abi = [
    { type: 'function', name: 'transfer', inputs: [], outputs: [], stateMutability: 'nonpayable' }, // non-event → skipped
    { type: 'event', name: 'Flag', inputs: [{ type: 'bool', indexed: false }] },                    // unnamed input → array args
  ] as const;
  const decoder = new EvmAbiDecoder(abi as unknown as Abi);
  const topic0 = toEventSelector(abi[1]);

  it('skips non-event ABI items in the selector map', () => {
    expect(decoder.decodableEvents()).toEqual(['Flag']);   // the function is not registered
    expect(decoder.canDecode('transfer')).toBe(false);
  });

  it('decodes unnamed event args by position (array path)', () => {
    const data = pad('0x01', { size: 32 });                // bool true, ABI-encoded
    const r = decoder.decode({ raw: new Uint8Array(Buffer.from(data.slice(2), 'hex')), topics: [topic0] });
    expect(r).not.toBeNull();
    expect(r!.eventName).toBe('Flag');
    expect(r!.decoded!['0']).toBe(true);                   // positional arg keyed by index
  });
});
