/**
 * Decoder — the chain-neutral strategy for turning a raw log into an event name
 * plus decoded fields. Each chain adapter ships its own implementation and keys
 * decoding in a chain-appropriate way: OPNET keys by the on-chain event name it
 * already carries; an EVM decoder keys by `topics[0]` (the event signature hash)
 * and an ABI. A source owns a Decoder; the core indexer never decodes.
 */

export interface DecodeInput {
  /** Raw event bytes, as the source supplies them. */
  raw: Uint8Array;
  /** Pre-known event name. OPNET sources supply this; EVM sources do not. */
  eventName?: string;
  /** Log topics. EVM uses `topics[0]` as the decode key. */
  topics?: string[];
}

export interface DecodeResult {
  /** Resolved event name. */
  eventName: string;
  /** Decoded fields, or null when the name is known but no decoder matched. */
  decoded: Record<string, unknown> | null;
}

export interface Decoder {
  /**
   * Resolve + decode one log. Returns null only when the log cannot even be
   * named (e.g. an EVM topic0 with no registered ABI). A known event with no
   * field decoder returns `{ eventName, decoded: null }`.
   */
  decode(input: DecodeInput): DecodeResult | null;

  /** Event names this decoder can resolve — for a boot-time decodability manifest. */
  decodableEvents(): string[];

  /** Whether this decoder can decode the given event name. */
  canDecode(eventName: string): boolean;
}
