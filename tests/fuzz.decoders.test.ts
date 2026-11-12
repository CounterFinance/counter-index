/**
 * Property/fuzz tests (fast-check): decoders must NEVER throw on adversarial
 * input — a panic on a malformed on-chain log would crash the indexer (a DoS).
 */

import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { Abi } from 'viem';
import { OpnetDecoder } from '../src/chains/opnet/opnetDecoder.js';
import { EvmAbiDecoder } from '../src/chains/evm/evmDecoder.js';

describe('decoder fuzzing (never panics)', () => {
  it('OpnetDecoder.decode never throws on random bytes for any event', () => {
    const d = new OpnetDecoder();
    const names = d.decodableEvents();
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.nat(names.length - 1), (bytes, idx) => {
        d.decode({ raw: bytes, eventName: names[idx]! });   // must not throw
      }),
      { numRuns: 3000 },
    );
  });

  it('EvmAbiDecoder.decode never throws on random bytes + topics', () => {
    const abi = [{
      type: 'event', name: 'Transfer',
      inputs: [
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    }] as const;
    const d = new EvmAbiDecoder(abi as unknown as Abi);
    const hex = fc.hexaString({ maxLength: 80 }).map((s) => (`0x${s}`) as `0x${string}`);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), fc.array(hex, { maxLength: 5 }), (bytes, topics) => {
        d.decode({ raw: bytes, topics });   // must not throw
      }),
      { numRuns: 3000 },
    );
  });
});
