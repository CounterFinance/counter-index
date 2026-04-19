/**
 * Core types for the op-index indexer framework.
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
  /** Address that submitted the transaction as a bech32m P2OP address. */
  fromAddress?: string;
  /**
   * Raw 32-byte schnorr pubkey (0x-prefixed hex) when the upstream source
   * supplies a pubkey rather than a bech32m address. Undefined when
   * `fromAddress` was already in bech32m form (no pubkey available).
   */
  fromAddressPubkey?: string;
  /** Gas consumed by the transaction (satoshi units). */
  gasUsed?: bigint;
  /** Bitcoin burned as fee (satoshi units). */
  burnedBitcoin?: bigint;
  /** True if the transaction reverted. */
  failed?: boolean;
  /** Revert reason string, if the transaction failed. */
  revertReason?: string | null;

  /**
   * All events that fired in the same transaction, keyed by contract address.
   * Populated by DbEventSource, RpcEventSource, and OpStreamRpcEventSource.
   * Undefined from WsEventSource (single-event push with no tx grouping).
   *
   * Use this to correlate sibling events — e.g. a router event that needs to
   * identify the underlying token via a Transferred event fired by the token
   * contract in the same tx. The Map is shared by reference across all events
   * from the same tx (not copied per event).
   */
  txEvents?: Map<string, Array<{ type: string; raw: Uint8Array }>>;
}
