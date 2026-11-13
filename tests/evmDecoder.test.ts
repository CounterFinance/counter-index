/**
 * The EVM ABI decoder must satisfy the same shared Decoder contract as OPNET,
 * plus EVM-specific decoding of a real ERC-20 Transfer log.
 */

import { describe, it, expect } from 'vitest';
import { toEventSelector, pad, numberToHex } from 'viem';
import type { Abi } from 'viem';
import { EvmAbiDecoder } from '../src/chains/evm/evmDecoder.js';
import { runDecoderContract } from './support/decoderContract.js';

const erc20Abi = [
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

const transferTopic0 = toEventSelector(erc20Abi[0]);
const FROM = '0x1111111111111111111111111111111111111111';
const TO   = '0x2222222222222222222222222222222222222222';
const addrTopic = (a: string): `0x${string}` => pad(a as `0x${string}`, { size: 32 });
const valueData = pad(numberToHex(1000n), { size: 32 });
const hexToBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex.slice(2), 'hex'));

runDecoderContract('EvmAbiDecoder', () => new EvmAbiDecoder(erc20Abi as unknown as Abi), [
  {
    input: { raw: hexToBytes(valueData), topics: [transferTopic0, addrTopic(FROM), addrTopic(TO)] },
    expectEventName: 'Transfer',
    expectDecodedKeys: ['from', 'to', 'value'],
  },
]);

describe('EvmAbiDecoder specifics', () => {
  const decoder = new EvmAbiDecoder(erc20Abi as unknown as Abi);

  it('decodes indexed addresses and the data value correctly', () => {
    const r = decoder.decode({
      raw: hexToBytes(valueData),
      topics: [transferTopic0, addrTopic(FROM), addrTopic(TO)],
    });
    expect(r).not.toBeNull();
    expect(r!.eventName).toBe('Transfer');
    expect((r!.decoded!['from'] as string).toLowerCase()).toBe(FROM);
    expect((r!.decoded!['to'] as string).toLowerCase()).toBe(TO);
    expect(r!.decoded!['value']).toBe(1000n);
  });

  it('returns null for an unknown topic0 (no matching ABI)', () => {
    const r = decoder.decode({ raw: new Uint8Array(32), topics: ['0x' + 'ab'.repeat(32)] });
    expect(r).toBeNull();
  });

  it('returns null when there are no topics', () => {
    expect(decoder.decode({ raw: new Uint8Array(32) })).toBeNull();
  });
});
