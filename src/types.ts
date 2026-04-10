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

  // Block-level context (available when fed from OpStream)
  /** Unix timestamp of the block. Use for time-series handlers (candles, snapshots). */
  blockTimestamp?: number;

  // Transaction-level context (available when fed from OpStream transactions table)
  /** Position of this event within its transaction. Use for deterministic ordering. */
  logIndex?: number;
  /** Position of the transaction within its block. */
  txIndex?: number;
  /** Address that submitted the transaction (from_address in OpStream). */
  fromAddress?: string;
  /** Gas consumed by the transaction (satoshi units). */
  gasUsed?: bigint;
  /** Bitcoin burned as fee (satoshi units). */
  burnedBitcoin?: bigint;
  /** True if the transaction reverted. */
  failed?: boolean;
  /** Revert reason string, if the transaction failed. */
  revertReason?: string | null;
}
