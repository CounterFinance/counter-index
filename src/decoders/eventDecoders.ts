/**
 * ABI event decoder registry for OPNET on-chain events.
 *
 * Maps event_name strings to decoder functions that parse raw bytes into
 * structured JSON. When a new decoder is added, backfillDecoded() can
 * retroactively parse all historical raw data for that event type.
 *
 * OPNET uses big-endian encoding:
 *   - Addresses: 32 bytes
 *   - U256: 32 bytes big-endian
 *   - U128: 16 bytes big-endian
 *   - Strings: U32 length prefix (4 bytes BE) + raw UTF-8 bytes
 */

// --- Types ------------------------------------------------------------------

export type EventDecoder = (rawData: Buffer | Uint8Array) => Record<string, unknown> | null;

// --- Byte helpers -----------------------------------------------------------

function toHex(data: Buffer | Uint8Array, offset: number, length: number): string {
  return '0x' + Buffer.from(data.buffer, data.byteOffset + offset, length).toString('hex');
}

function readU256(data: Buffer | Uint8Array, offset: number): string {
  const hex = Buffer.from(data.buffer, data.byteOffset + offset, 32).toString('hex');
  return BigInt('0x' + hex).toString();
}

function readU128(data: Buffer | Uint8Array, offset: number): string {
  const hex = Buffer.from(data.buffer, data.byteOffset + offset, 16).toString('hex');
  return BigInt('0x' + hex).toString();
}

function readU32BE(data: Buffer | Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, false); // big-endian
}

// --- Known event decoders ---------------------------------------------------

/**
 * Transferred (OP-20 token transfer)
 * Layout: from (32 addr) + to (32 addr) + value (32 U256) = 96 bytes
 */
function decodeTransferred(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 96) return null;
  return {
    from: toHex(rawData, 0, 32),
    to: toHex(rawData, 32, 32),
    value: readU256(rawData, 64),
  };
}

/**
 * Synced (Motoswap pair reserve sync)
 * Layout: reserve0 (32 U256) + reserve1 (32 U256) = 64 bytes
 */
function decodeSynced(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 64) return null;
  return {
    reserve0: readU256(rawData, 0),
    reserve1: readU256(rawData, 32),
  };
}

/**
 * Swapped (Motoswap pair swap)
 * Layout: sender (32) + amount0In (32) + amount1In (32) + amount0Out (32) + amount1Out (32) + to (32) = 192 bytes
 */
function decodeSwapped(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 192) return null;
  return {
    sender: toHex(rawData, 0, 32),
    amount0In: readU256(rawData, 32),
    amount1In: readU256(rawData, 64),
    amount0Out: readU256(rawData, 96),
    amount1Out: readU256(rawData, 128),
    to: toHex(rawData, 160, 32),
  };
}

/**
 * LiquidityListed (NativeSwap LP deposit)
 * Layout: totalLiquidity U128 (16 bytes) + provider STRING (U32 len + UTF-8)
 */
function decodeLiquidityListed(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 20) return null; // 16 (U128) + 4 (string length prefix) minimum
  const totalLiquidity = readU128(rawData, 0);
  const strLen = readU32BE(rawData, 16);
  if (rawData.length < 20 + strLen) return null;
  const provider = new TextDecoder().decode(
    rawData.subarray(20, 20 + strLen),
  );
  return { totalLiquidity, provider };
}

/**
 * LiquidityAdded (Motoswap pair LP deposit)
 * Layout: sender (32 addr) + amount0 (32 U256) + amount1 (32 U256) = 96 bytes
 */
function decodeLiquidityAdded(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 96) return null;
  return {
    sender: toHex(rawData, 0, 32),
    amount0: readU256(rawData, 32),
    amount1: readU256(rawData, 64),
  };
}

/**
 * PoolCreated (Motoswap factory)
 * Layout: token0 (32 addr) + token1 (32 addr) = 64 bytes
 */
function decodePoolCreated(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 64) return null;
  return {
    token0: toHex(rawData, 0, 32),
    token1: toHex(rawData, 32, 32),
  };
}

/**
 * SwapExecuted (NativeSwap completed swap)
 * Layout: buyer (32 addr) + amountIn (32 U256) + amountOut (32 U256) = 96 bytes
 */
function decodeSwapExecuted(rawData: Buffer | Uint8Array): Record<string, unknown> | null {
  if (rawData.length < 96) return null;
  return {
    buyer: toHex(rawData, 0, 32),
    amountIn: readU256(rawData, 32),
    amountOut: readU256(rawData, 64),
  };
}

// --- Registry ---------------------------------------------------------------

export const DECODER_REGISTRY: Map<string, EventDecoder> = new Map([
  ['Transferred', decodeTransferred],
  ['Synced', decodeSynced],
  ['Swapped', decodeSwapped],
  ['LiquidityListed', decodeLiquidityListed],
  ['LiquidityAdded', decodeLiquidityAdded],
  ['PoolCreated', decodePoolCreated],
  ['SwapExecuted', decodeSwapExecuted],
]);

/**
 * Decode an event by name. Returns null if no decoder is registered
 * or if the decoder cannot parse the data.
 */
export function decodeEvent(
  eventName: string,
  rawData: Buffer | Uint8Array,
): Record<string, unknown> | null {
  const decoder = DECODER_REGISTRY.get(eventName);
  if (!decoder) return null;
  return decoder(rawData);
}

/**
 * Register a custom decoder at runtime.
 */
export function registerDecoder(eventName: string, decoder: EventDecoder): void {
  DECODER_REGISTRY.set(eventName, decoder);
}
