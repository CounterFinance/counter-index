/**
 * OpnetDecoder — the OPNET implementation of the core `Decoder` strategy.
 *
 * OPNET events arrive already named (OpStream stores the event name), so decode
 * keys on that name against the OPNET byte-layout registry. A known event with
 * no registered field decoder still resolves — it returns `decoded: null`,
 * preserving the current behaviour where the event flows with raw bytes only.
 */

import type { Decoder, DecodeInput, DecodeResult } from '../../decoder.js';
import { DECODER_REGISTRY, decodeEvent } from './decoders.js';

export class OpnetDecoder implements Decoder {
  decode(input: DecodeInput): DecodeResult | null {
    const { eventName, raw } = input;
    // OPNET cannot name a log on its own — the source always supplies the name.
    if (eventName === undefined) return null;
    return { eventName, decoded: decodeEvent(eventName, raw) };
  }

  decodableEvents(): string[] {
    return [...DECODER_REGISTRY.keys()];
  }

  canDecode(eventName: string): boolean {
    return DECODER_REGISTRY.has(eventName);
  }
}

/** Shared default OPNET decoder instance used by the OPNET sources. */
export const opnetDecoder = new OpnetDecoder();
