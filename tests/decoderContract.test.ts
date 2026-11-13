/**
 * The OPNET decoder must satisfy the shared Decoder contract.
 * When the EVM decoder lands (M4) it runs this same suite.
 */

import { OpnetDecoder } from '../src/chains/opnet/opnetDecoder.js';
import { runDecoderContract } from './support/decoderContract.js';

function transferRaw(): Uint8Array {
  // Transferred layout: from(32) + to(32) + value(32, big-endian).
  const raw = new Uint8Array(96);
  raw[31] = 0x01;
  raw[63] = 0x02;
  raw[95] = 100;
  return raw;
}

runDecoderContract('OpnetDecoder', () => new OpnetDecoder(), [
  {
    input: { raw: transferRaw(), eventName: 'Transferred' },
    expectEventName: 'Transferred',
    expectDecodedKeys: ['from', 'to', 'value'],
  },
]);
