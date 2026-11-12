# Reorg handling — design (M6)

## Problem
Handlers persist **absolute** derived state (`balance = prev + delta`, counters,
running totals). When a chain reorgs, the blocks after the fork point are replaced
by a different canonical history. Their entity writes must be **undone** and the
canonical blocks re-indexed. We cannot recompute by replaying deltas backwards —
a handler could do anything.

## Approach — per-block inverse journal (prior-row snapshots)
Before each entity write inside a block's transaction, record the entity's
**prior full row** (or a tombstone meaning "did not exist") in a journal. To roll
back to fork block `F`, replay the journal for blocks `> F` in **reverse** order,
restoring each prior row (or deleting when the prior was a tombstone). Then prune
the journal `> F`, drop the stale block-hash records, and rewind the checkpoint to
`F`. Re-sync continues from `F+1` on the canonical chain.

Because we restore exact prior **snapshots**, absolute writes roll back correctly
with **zero handler changes** — the subtlety the roadmap flagged (store deltas,
not absolutes) is sidestepped by snapshotting prior state instead of deltas.

## Journal
`opindex_journal(seq PK autoincrement, chain_id, block_number, entity, id, prior_json)`
— `prior_json` is the JSON of the row before the write, or `NULL` if it did not
exist. One append per write (set/update/delete). Pruned below the finality depth.

## Write path
When reorg tracking is on (`reorg.finalityDepth > 0`), `set`/`update`/`delete`
first read the current row and append `(chainId, block, entity, id, prior_json)`
to the journal, then perform the write — all inside the existing per-block
`dispatchBlock` transaction, so journal + entity writes commit atomically.

## Fork detection (live)
Every `ChainEvent` carries `blockHash` + `parentHash`. We keep a small per-chain
block-hash log (`opindex_blockhash(chain_id, block_number, block_hash)`) for the
last `finalityDepth` blocks. On a new block `N` whose `parentHash` ≠ the stored
hash of `N-1`, walk back comparing hashes until the fork block `F` (hashes agree);
`rollbackToBlock(F)`, rewind checkpoint, and re-sync from `F+1`.

## Finality / pruning
Journal + block-hash rows are kept for the last `finalityDepth` blocks
(configurable per chain — e.g. 12 on Ethereum mainnet, higher on fast L2s) and
pruned below it. Reorgs deeper than `finalityDepth` are unrecoverable by design —
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
