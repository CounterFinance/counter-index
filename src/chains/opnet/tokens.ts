/**
 * OPNET native token constants.
 *
 * OpStream no longer seeds the tokens table — that responsibility belongs to
 * counter-index. This module exports the canonical metadata for OPNET's built-in tokens
 * so callers can populate the tokens table on startup.
 *
 * counter-index stays zero-dependency: it exports the data, not the INSERT. The calling
 * application owns the database handle and does:
 *
 *   for (const token of OPNET_NATIVE_TOKENS) {
 *     db.prepare(
 *       `INSERT OR IGNORE INTO tokens (address, symbol, name, decimals)
 *        VALUES (?, ?, ?, ?)`
 *     ).run(token.address, token.symbol, token.name, token.decimals);
 *   }
 */

export interface TokenMetadata {
  /** Canonical 0x-prefixed contract address on OPNET mainnet. */
  address: string;
  symbol: string;
  name: string;
  /** Decimal precision. BTC and MOTO are both 8 (satoshi-based). */
  decimals: number;
}

/**
 * OPNET's two anchor tokens. Every other token pairs against one of these.
 *
 * BTC  — native wrapped Bitcoin, the settlement layer asset.
 * MOTO — hub token (analogous to WBNB on BSC); all Motoswap pairs route through it.
 */
export const OPNET_NATIVE_TOKENS: readonly TokenMetadata[] = [
  {
    address:  '0x0000000000000000000000000000000000000001',
    symbol:   'BTC',
    name:     'Bitcoin',
    decimals: 8,
  },
  {
    address:  '0x0000000000000000000000000000000000000002',
    symbol:   'MOTO',
    name:     'Motoswap',
    decimals: 8,
  },
] as const;

/** Look up a native token by address. Returns undefined if not found. */
export function getNativeToken(address: string): TokenMetadata | undefined {
  return OPNET_NATIVE_TOKENS.find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
}

/** Returns true if the address is one of the OPNET native tokens. */
export function isNativeToken(address: string): boolean {
  return getNativeToken(address) !== undefined;
}
