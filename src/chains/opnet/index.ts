/**
 * OPNET adapter — the chain-specific implementation for OPNET (Bitcoin L2).
 *
 * Everything here is OPNET-specific: event sources that read from OpStream or an
 * OPNET RPC, the OPNET event decoders, OP20/OP721 standard detection, native
 * token metadata, and P2OP address utilities. The core engine imports none of it.
 */

export { DbEventSource } from './dbSource.js';
export {
  RpcEventSource,
  type BlockProvider,
  type BlockLike,
  type TransactionLike,
  type RpcEventSourceOptions,
} from './rpcSource.js';
export {
  WsEventSource,
  type WsEventSourceOptions,
} from './wsSource.js';
export {
  OpStreamRpcEventSource,
  type OpStreamRpcEventSourceOptions,
} from './opStreamRpcSource.js';
export {
  createEventSource,
  probeOpStreamSchema,
  type EventSourceInput,
  type CreateEventSourceOptions,
} from './eventSourceFactory.js';

export {
  decodeEvent, registerDecoder, DECODER_REGISTRY,
  type EventDecoder,
} from './decoders.js';

export { OpnetDecoder, opnetDecoder } from './opnetDecoder.js';

export {
  OP20_EVENT_NAMES, OP721_EVENT_NAMES,
  isOP20Contract, isOP721Contract, classifyContract,
  type OP20EventName, type OP721EventName,
} from './standards.js';

export {
  OPNET_NATIVE_TOKENS, getNativeToken, isNativeToken,
  type TokenMetadata,
} from './tokens.js';

export {
  pubkeyHexToP2op, isP2opAddress, normaliseFromAddress,
} from './p2op.js';

export { OPNET_CHAIN_ID, OPNET_NETWORK } from './constants.js';
export type { OpnetChainMeta } from './types.js';
