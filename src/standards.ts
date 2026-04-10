/**
 * OPNET contract standard detection.
 *
 * OpStream no longer tracks is_op20 in the database — that responsibility
 * belongs here. Callers feed a set of events observed from a contract address
 * and these functions determine which standard (if any) the contract implements.
 *
 * Detection rules:
 *   OP-20  — emits Transferred or Approval (fungible token)
 *   OP-721 — emits ApprovalForAll (NFT; sufficient signal, OP-20 never emits it)
 *
 * Both standards share Transferred and Approval event names, so OP-721 detection
 * relies on ApprovalForAll as the unambiguous discriminator.
 */

import type { DecodedEvent } from './types.js';

// ---------------------------------------------------------------------------
// Standard event name sets
// ---------------------------------------------------------------------------

export const OP20_EVENT_NAMES = ['Transferred', 'Approval'] as const;
export const OP721_EVENT_NAMES = ['Transferred', 'Approval', 'ApprovalForAll'] as const;

export type OP20EventName  = (typeof OP20_EVENT_NAMES)[number];
export type OP721EventName = (typeof OP721_EVENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if any event in the set was emitted by the given contract
 * and matches an OP-20 event name.
 *
 * Note: a contract that also emits ApprovalForAll is OP-721, not OP-20.
 * Use isOP721Contract() first when you need to distinguish them.
 */
export function isOP20Contract(
  contractAddress: string,
  events: DecodedEvent[],
): boolean {
  const op20Set = new Set<string>(OP20_EVENT_NAMES);
  return events.some(
    (e) => e.contractAddress === contractAddress && op20Set.has(e.eventName),
  );
}

/**
 * Returns true if any event in the set was emitted by the given contract
 * and is ApprovalForAll — the unambiguous OP-721 signal.
 */
export function isOP721Contract(
  contractAddress: string,
  events: DecodedEvent[],
): boolean {
  return events.some(
    (e) => e.contractAddress === contractAddress && e.eventName === 'ApprovalForAll',
  );
}

/**
 * Classify a contract by its observed events.
 * Returns 'op721' | 'op20' | 'unknown'.
 * OP-721 takes priority since it's the more specific match.
 */
export function classifyContract(
  contractAddress: string,
  events: DecodedEvent[],
): 'op721' | 'op20' | 'unknown' {
  if (isOP721Contract(contractAddress, events)) return 'op721';
  if (isOP20Contract(contractAddress, events))  return 'op20';
  return 'unknown';
}
