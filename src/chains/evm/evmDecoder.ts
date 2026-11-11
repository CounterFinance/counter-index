/**
 * EvmAbiDecoder — the EVM implementation of the core `Decoder` strategy.
 *
 * EVM logs are not self-describing: the event is identified by `topics[0]` (the
 * keccak256 hash of the event signature). This decoder builds a topic0 -> ABI
 * event map from the ABIs it is given, then decodes indexed topics + data via
 * viem. Requires the optional peer dependency `viem`.
 */

import { decodeEventLog, toEventSelector, toHex } from 'viem';
import type { Abi, AbiEvent } from 'viem';
import type { Decoder, DecodeInput, DecodeResult } from '../../decoder.js';

export class EvmAbiDecoder implements Decoder {
  /** topic0 (lowercased) -> event ABI item. First registration wins on collision. */
  private readonly bySelector = new Map<string, AbiEvent>();

  constructor(abis: Abi | Abi[]) {
    const merged: Abi = Array.isArray(abis[0]) ? (abis as Abi[]).flat() : (abis as Abi);
    for (const item of merged) {
      if (item.type !== 'event') continue;
      const selector = toEventSelector(item).toLowerCase();
      if (!this.bySelector.has(selector)) this.bySelector.set(selector, item);
    }
  }

  decode(input: DecodeInput): DecodeResult | null {
    const topics = input.topics;
    if (!topics || topics.length === 0) return null;
    const event = this.bySelector.get(topics[0].toLowerCase());
    if (!event) return null;  // unknown signature — cannot even name it

    try {
      const decoded = decodeEventLog({
        abi: [event],
        data: toHex(input.raw),
        topics: topics as [`0x${string}`, ...`0x${string}`[]],
      });
      return { eventName: decoded.eventName, decoded: normaliseArgs(decoded.args) };
    } catch {
      // topic0 matched but the payload did not decode — name it, no fields.
      return { eventName: event.name, decoded: null };
    }
  }

  decodableEvents(): string[] {
    return [...this.bySelector.values()].map((e) => e.name);
  }

  canDecode(eventName: string): boolean {
    for (const e of this.bySelector.values()) if (e.name === eventName) return true;
    return false;
  }
}

/** Normalise viem's decoded args (named object or positional array) to a plain record. */
function normaliseArgs(args: unknown): Record<string, unknown> {
  if (Array.isArray(args)) {
    return Object.fromEntries(args.map((v, i) => [String(i), v]));
  }
  if (args && typeof args === 'object') {
    return { ...(args as Record<string, unknown>) };
  }
  return {};
}
