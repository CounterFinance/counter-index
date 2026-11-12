/**
 * Solana adapter — proves the chain-neutral core on a non-EVM, non-OPNET chain.
 * Anchor-style event decoding (discriminator + Borsh) into ChainEvents.
 */

export { SolanaDecoder, anchorEventDiscriminator, type SolanaEventDef, type SolanaEventField } from './solanaDecoder.js';
export { SolanaLogSource, programDataPayloads, type SolanaLogSourceOptions, type SolanaTx } from './solanaLogSource.js';
export { type SolanaChainMeta } from './types.js';
export { BorshReader, BorshWriter, base58Encode, type SolType } from './borsh.js';
