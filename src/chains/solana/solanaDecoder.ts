/**
 * SolanaDecoder — the chain-neutral Decoder for Anchor-style program events.
 *
 * Solana programs emit events as `emit!` → a base64 "Program data:" log line
 * whose bytes are an 8-byte discriminator followed by a Borsh-encoded payload.
 * The discriminator is `sha256("event:" + Name)[0..8]`. This decoder keys on that
 * discriminator (the Solana analogue of an EVM `topics[0]`) and Borsh-decodes the
 * fields from a declared event layout — no IDL runtime, no @solana/web3.js.
 */

import { createHash } from 'node:crypto';
import type { Decoder, DecodeInput, DecodeResult } from '../../decoder.js';
import { BorshReader, type SolType } from './borsh.js';

export interface SolanaEventField {
  name: string;
  type: SolType;
}

export interface SolanaEventDef {
  /** Event name as declared in the program (used to derive the discriminator). */
  name: string;
  fields: SolanaEventField[];
  /** Override the derived discriminator (8 bytes) if your program uses a custom one. */
  discriminator?: Uint8Array;
}

/** The 8-byte Anchor event discriminator for an event name. */
export function anchorEventDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`event:${name}`).digest().subarray(0, 8));
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export class SolanaDecoder implements Decoder {
  /** discriminator-hex → event definition. */
  private readonly byDisc = new Map<string, SolanaEventDef>();

  constructor(events: SolanaEventDef[]) {
    for (const ev of events) {
      const disc = ev.discriminator ?? anchorEventDiscriminator(ev.name);
      if (disc.length !== 8) throw new Error(`[counter-index] Solana discriminator for "${ev.name}" must be 8 bytes`);
      this.byDisc.set(hex(disc), ev);
    }
  }

  decode(input: DecodeInput): DecodeResult | null {
    const raw = input.raw;
    if (raw.length < 8) return null;                 // can't even carry a discriminator
    const def = this.byDisc.get(hex(raw.subarray(0, 8)));
    if (!def) return null;                           // unknown discriminator — not ours
    try {
      const reader = new BorshReader(raw.subarray(8));
      const decoded: Record<string, unknown> = {};
      for (const f of def.fields) decoded[f.name] = reader.read(f.type);
      return { eventName: def.name, decoded };
    } catch {
      // Known discriminator but a malformed payload — name it, decode nothing.
      return { eventName: def.name, decoded: null };
    }
  }

  decodableEvents(): string[] {
    return [...this.byDisc.values()].map((e) => e.name);
  }

  canDecode(eventName: string): boolean {
    for (const e of this.byDisc.values()) if (e.name === eventName) return true;
    return false;
  }

  /** The hex discriminator for an event name (handy for sources / tests). */
  discriminatorHex(eventName: string): string | undefined {
    for (const [disc, e] of this.byDisc) if (e.name === eventName) return disc;
    return undefined;
  }
}
