# Reorg handling, design (M6)

## Problem
Handlers persist **absolute** derived state (`balance = prev + delta`, counters,
running totals). When a chain reorgs, the blocks after the fork point are replaced
by a different canonical history. Their entity writes must be **undone** and the
canonical blocks re-indexed. We cannot recompute by replaying deltas backwards -
a handler could do anything.

## Approach, per-block inverse journal (prior-row snapshots)
Before each entity write inside a block's transaction, record the entity's
**prior full row** (or a tombstone meaning "did not exist") in a journal. To roll
back to fork block `F`, replay the journal for blocks `> F` in **reverse** order,
restoring each prior row (or deleting when the prior was a tombstone). Then prune
the journal `> F`, drop the stale block-hash records, and rewind the checkpoint to
`F`. Re-sync continues from `F+1` on the canonical chain.

Because we restore exact prior **snapshots**, absolute writes roll back correctly
with **zero handler changes**: the subtlety the roadmap flagged (store deltas,
not absolutes) is sidestepped by snapshotting prior state instead of deltas.

## Journal
`counterindex_journal(seq PK autoincrement, chain_id, block_number, entity, id, prior_json)`
- `prior_json` is the JSON of the row before the write, or `NULL` if it did not
exist. One append per write (set/update/delete). Pruned below the finality depth.

## Write path
When reorg tracking is on (`reorg.finalityDepth > 0`), `set`/`update`/`delete`
first read the current row and append `(chainId, block, entity, id, prior_json)`
to the journal, then perform the write, all inside the existing per-block
`dispatchBlock` transaction, so journal + entity writes commit atomically.

## Fork detection (live)
Every `ChainEvent` carries `blockHash` + `parentHash`. We keep a small per-chain
block-hash log (`counterindex_blockhash(chain_id, block_number, block_hash)`) for the
last `finalityDepth` blocks. On a new block `N` whose `parentHash` ≠ the stored
hash of `N-1`, walk back comparing hashes until the fork block `F` (hashes agree);
`rollbackToBlock(F)`, rewind checkpoint, and re-sync from `F+1`.

## Finality / pruning
Journal + block-hash rows are kept for the last `finalityDepth` blocks
(configurable per chain, e.g. 12 on Ethereum mainnet, higher on fast L2s) and
pruned below it. Reorgs deeper than `finalityDepth` are unrecoverable by design -
the same assumption as Envio's `max_reorg_depth` and Ponder's retention window.
An optional finality lag (index at `tip - finalityDepth`) trades latency for never
seeing a reorg at all.

## Scope / non-goals (M6)
- **In:** journal + `rollbackToBlock` in the store (opt-in); block-hash tracking +
  fork detection in `subscribe`; a deterministic rollback test (rollback + re-index
  == fresh index) and a live anvil reorg test; finality-depth config + pruning.
- **Out (later):** reorgs during historical backfill (backfill runs below finality);
  cross-chain reorg coordination (chains are independent); reorgs deeper than
  `finalityDepth`.

## Verification
1. **Deterministic:** index blocks 1–5, `rollbackToBlock(3)`, re-index a *different*
   4–5, assert final state equals a from-scratch index of the canonical 1–5.
2. **Live:** on anvil, snapshot, index, mine a divergent branch (revert +
   re-mine), drive fork detection, assert state equals a fresh re-index.

## Hardening (M11)

The M6 core was correct for shallow live reorgs; M11 makes the failure modes safe.

- **Atomic rollback.** `rollbackToBlock` now runs the journal replay, the
  journal/block-hash cleanup **and the checkpoint rewind** in ONE transaction. A
  crash mid-rollback rolls the whole thing back; on restart the journal is intact
  and the rollback simply re-runs. State can never half-rewind, and the checkpoint
  can never diverge from the data (it's rewound in the same txn, not by the caller).
  Proven by a fault-injection test (`tests/reorg-hardening.test.ts`): a failure
  mid-rollback leaves the pre-rollback state fully intact, and a retry succeeds.

- **Deep-reorg detection, stop, don't diverge.** Two guards:
  1. *Store level:* `rollbackToBlock` throws **`DeepReorgError`** if the target is
     below the retained finality floor (its journal was pruned), a correct
     rollback is impossible, so it refuses rather than silently producing wrong data.
  2. *Live level:* after clamping the rollback to `tip - finalityDepth`, the indexer
     checks that the canonical chain's first re-indexed block builds on the
     **retained hash** of that boundary. If it doesn't, the true fork is older than
     `finalityDepth`; the indexer logs, **halts the subscription**, flips to an
     error state, and calls the optional `onDeepReorg` hook. It never re-indexes
     over a fork it can't prove it resolved. (To make the boundary hash available,
     pruning retains `finalityDepth + 1` blocks.)
  Both paths are tested, including an indexer-level deep-reorg that halts instead
  of diverging (`tests/reorgIndexer.test.ts`).

- **Property test (already in M12):** `tests/property.reorg.test.ts`: apply-then-
  undo over 150 random journals equals the pre-fork state (rollback == inverse).

### Still honest about scope
- **Backfill reorgs:** historical `sync()` runs below finality where blocks are
  final; a reorg near the tip is caught by the live `subscribe` fork detection at
  the backfill→live handoff, not during the backfill scan itself.
- **Empty-block residual:** the live boundary check needs the canonical boundary
  block to carry events (for its `parentHash`). A deep fork whose boundary block is
  empty is still caught by the store-level floor guard on the next rollback that
  needs pruned journal, but not at the boundary itself, choose `finalityDepth`
  ≥ the chain's realistic max reorg depth.
