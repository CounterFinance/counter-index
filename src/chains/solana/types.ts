/**
 * Solana-specific event metadata. Core only knows `ChainMeta` has a `kind`;
 * handlers narrow `chainMeta?.kind === 'solana'` and cast.
 */

import type { ChainMeta } from '../../types.js';

export interface SolanaChainMeta extends ChainMeta {
  kind: 'solana';
  /** The program that emitted the event (base58). */
  programId: string;
  /** Slot (Solana's block height). */
  slot?: number;
  /** The 8-byte Anchor discriminator, hex-encoded. */
  discriminator?: string;
}
