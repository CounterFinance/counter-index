/**
 * OPNET-specific event metadata. Lives in the adapter, not in core — the engine
 * only knows `ChainMeta` has a `kind`. Handlers that need OPNET transaction
 * context narrow `event.chainMeta?.kind === 'opnet'` and cast to this type.
 */

import type { ChainMeta } from '../../types.js';

export interface OpnetChainMeta extends ChainMeta {
  kind: 'opnet';
  /** Submitter as a bech32m P2OP address, when resolvable. */
  fromAddress?: string;
  /** Raw 32-byte schnorr pubkey (0x-hex) when only a pubkey is available. */
  fromAddressPubkey?: string;
  /** Gas consumed (satoshi units). */
  gasUsed?: bigint;
  /** Bitcoin burned as fee (satoshi units). */
  burnedBitcoin?: bigint;
  /** True if the transaction reverted. */
  failed?: boolean;
  /** Revert reason string, if the transaction failed. */
  revertReason?: string | null;
}
