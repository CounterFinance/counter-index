/**
 * EVM-specific event metadata. Lives in the EVM adapter; core only knows
 * `ChainMeta` has a `kind`. Handlers narrow `chainMeta?.kind === 'evm'` and cast.
 */

import type { ChainMeta } from '../../types.js';

export interface EvmChainMeta extends ChainMeta {
  kind: 'evm';
  /** `tx.from` (0x-hex). */
  from?: string;
  /** Raw log topics; topics[0] is the event signature hash. */
  topics: string[];
  /** Gas used by the transaction. */
  gasUsed?: bigint;
  /** Effective gas price (wei). */
  effectiveGasPrice?: bigint;
  /** True when the log was removed by a reorg (eth_getLogs `removed`). */
  removed?: boolean;
}
