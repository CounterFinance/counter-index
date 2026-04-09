/**
 * Core types for the OpKit indexer framework.
 */

// ---------------------------------------------------------------------------
// Event — the universal input to the indexer
// ---------------------------------------------------------------------------

export interface DecodedEvent {
  blockNumber: number;
  txHash: string;
  contractAddress: string;
  eventName: string;
  /** Raw event bytes. */
  eventRaw: Uint8Array;
  /** Decoded fields (null if no decoder registered for this event). */
  decoded: Record<string, unknown> | null;
  dataLength: number;
}
