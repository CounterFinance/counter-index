/**
 * OPNET adapter constants.
 *
 * OPNET is a Bitcoin L2 with no EIP-155 chain id. We assign a synthetic,
 * clearly-non-EVM sentinel so OPNET events carry a stable `chainId` in the
 * multichain store (M5) without colliding with any real EIP-155 id. Core never
 * references this value — it lives entirely inside the OPNET adapter.
 */

/** Synthetic OPNET chain id (not an EIP-155 id; chosen to never collide with one). */
export const OPNET_CHAIN_ID = 2_147_000_000;

/** Default human-readable network label for OPNET sources. */
export const OPNET_NETWORK = 'opnet';
