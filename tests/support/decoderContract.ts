/**
 * Shared Decoder contract test suite.
 *
 * Every `Decoder` implementation (OPNET today, EVM in M4) must satisfy this same
 * behavioural contract. Reuse it by calling `runDecoderContract(...)` at the top
 * level of a *.test.ts file.
 */

import { describe, it, expect } from 'vitest';
import type { Decoder, DecodeInput } from '../../src/decoder.js';

export interface DecoderContractCase {
  /** A decodable input for this decoder. */
  input: DecodeInput;
  /** Event name the decoder must resolve it to. */
  expectEventName: string;
  /** Keys that must be present in the decoded fields. */
  expectDecodedKeys: string[];
}

export function runDecoderContract(
  label: string,
  makeDecoder: () => Decoder,
  cases: DecoderContractCase[],
): void {
  describe(`Decoder contract: ${label}`, () => {
    it('decodableEvents() is non-empty and every entry is canDecode=true', () => {
      const d = makeDecoder();
      const events = d.decodableEvents();
      expect(events.length).toBeGreaterThan(0);
      for (const name of events) expect(d.canDecode(name)).toBe(true);
    });

    it('canDecode() is false for an unregistered event name', () => {
      expect(makeDecoder().canDecode('__definitely_not_a_real_event__')).toBe(false);
    });

    it('never throws on empty or garbage raw bytes', () => {
      const d = makeDecoder();
      const known = d.decodableEvents()[0]!;
      expect(() => d.decode({ raw: new Uint8Array(0), eventName: known })).not.toThrow();
      expect(() => d.decode({ raw: new Uint8Array([1, 2, 3, 4, 5]), eventName: known })).not.toThrow();
      expect(() => d.decode({ raw: new Uint8Array(0) })).not.toThrow();
    });

    for (const c of cases) {
      it(`decodes ${c.expectEventName} with all expected keys`, () => {
        const result = makeDecoder().decode(c.input);
        expect(result).not.toBeNull();
        expect(result!.eventName).toBe(c.expectEventName);
        expect(result!.decoded).not.toBeNull();
        for (const k of c.expectDecodedKeys) expect(result!.decoded).toHaveProperty(k);
      });
    }
  });
}
