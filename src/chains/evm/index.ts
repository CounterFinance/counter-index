/**
 * EVM adapter — chain-specific implementation for EVM chains. Decodes logs via
 * an ABI (topic0 -> event) and sources them from `eth_getLogs`. Requires the
 * optional peer dependency `viem`. Core imports none of this.
 */

export { EvmAbiDecoder } from './evmDecoder.js';
export { EvmLogSource, type EvmLogSourceOptions } from './evmLogSource.js';
export type { EvmChainMeta } from './types.js';
