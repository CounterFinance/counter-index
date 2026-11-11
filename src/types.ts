/**
 * Core types for the op-index indexer framework.
 *
 * `ChainEvent` is the single, chain-neutral input to the indexer. Every source
 * adapter produces exactly this shape. The core engine (indexer, store, graphql,
 * schema, handlers) never reads a chain-specific field: anything chain-specific
 * lives under `chainMeta`, whose concrete shape is defined by each adapter (see
 * e.g. `src/chains/opnet/types.ts`). A handler narrows `chainMeta` by its `kind`
 * discriminant and casts to the adapter's meta type only when it needs it.
 */

// ---------------------------------------------------------------------------
// Chain-specific metadata — open base; adapters define concrete variants
// ---------------------------------------------------------------------------

/**
 * Base for all chain-specific event metadata. Each chain adapter extends this
 * with its own fields under a unique `kind` discriminant (e.g. the OPNET adapter
 * defines `OpnetChainMeta`, an EVM adapter defines `EvmChainMeta`). Core never
 * enumerates these — it only knows there is a `kind`.
 */
export interface ChainMeta {
  kind: string;
}

// ---------------------------------------------------------------------------
// ChainEvent — the universal, chain-neutral input to the indexer
// ---------------------------------------------------------------------------

export interface ChainEvent {
  /**
   * Chain identity. EVM uses the real EIP-155 chain id (1, 8453, …). Other
   * ecosystems use an adapter-defined constant (never a reserved value, never
   * hardcoded in core). Pairs with `network` for human-readable context.
   */
  chainId: number;
  /** Human-readable network label, e.g. "eth-mainnet", "base-mainnet", "opnet". */
  network: string;

  /** Block number (slot number on slot-based chains). */
  blockNumber: number;
  /**
   * Hash of this event's block. Required for reorg detection (M6). Empty string
   * when the source cannot supply it (e.g. a chain/source with no reorgs).
   */
  blockHash: string;
  /** Parent block hash, when the source supplies it. Enables fork-point detection. */
  parentHash?: string;
  /** Unix timestamp of the block. Use for time-series handlers (candles, snapshots). */
  blockTimestamp?: number;

  txHash: string;
  /** Position of the transaction within its block. */
  txIndex?: number;
  /** Position of this event within its transaction. Use for deterministic ordering. */
  logIndex?: number;

  /** Emitting contract/program address. */
  contractAddress: string;
  /** Decoder key: the event name the adapter's decoder resolves this log to. */
  eventName: string;
  /** Raw event bytes, as the adapter supplies them. */
  eventRaw: Uint8Array;
  /** Decoded fields (null if no decoder matched this event). */
  decoded: Record<string, unknown> | null;
  /** Length of the raw event payload. */
  dataLength: number;

  /**
   * All events that fired in the same transaction, keyed by contract address.
   * Used to correlate sibling events (the router pattern). Shared by reference
   * across all events from the same tx. Undefined for single-event push sources.
   */
  txEvents?: Map<string, Array<{ type: string; raw: Uint8Array }>>;

  /**
   * Chain-specific context. Narrow by `kind` and cast to the owning adapter's
   * meta type (e.g. `OpnetChainMeta`). Undefined if the source adds none.
   */
  chainMeta?: ChainMeta;
}
