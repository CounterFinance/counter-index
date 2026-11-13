# Durability & exactly-once (M10)

## Per-block atomicity
A block is the unit of durability. For each block, counter-index runs **one**
transaction (`commitBlock` in `src/indexer.ts`) containing, in order:

1. every event handler's writes for that block,
2. the `onBlock` handlers,
3. the block-hash record (reorg mode),
4. the checkpoint advance (`opindex_meta.last_block`).

Either the whole block commits or none of it does. The checkpoint can **never**
advance past partially-applied entity state, because they commit together.

(Before M10 only steps 2–4 were transactional; entity writes auto-committed
per `store.set`, so a crash mid-block could leave partial state with the
checkpoint behind it. Fixed and proven — see below.)

## Exactly-once on restart
On startup an indexer resumes from `readCheckpoint().lastBlock + 1`. Combined with
per-block atomicity:

- **Crash mid-block** → the open transaction rolls back → no partial writes, and
  the checkpoint still points at the last fully-committed block → the block is
  re-fetched and re-applied cleanly. **No gap.**
- **A committed block is never re-applied**, because its checkpoint committed in
  the same transaction → **no double-count.**

Writes within a block are **read-your-writes**: a `store.get` inside a handler
sees earlier `store.set`s from the same block (same connection, same open
transaction), so running-balance accumulation is correct.

## Live mode note
In `subscribe`, the current (tip) block's events are buffered and committed when
the **next** block arrives — so the committed frontier is one block behind the
tip. That is deliberate: it keeps the unconfirmed tip out of durable state, which
is also safer for reorgs.

## Proof
`npm run dogfood:atomicity` runs a deterministic event stream into a file-backed
SQLite sink, then **kills the worker (`process.exit(137)`, simulating `kill -9`)
at random points mid-block**, restarting each time, with a final uninterrupted
pass. The crash-ridden result must equal a clean run **exactly** — same per-holder
counts, totals matching, no double counts, no gaps. Verified: 3 injected crashes,
`golden == final`, `sum(n) == total`.

## Scope
- Guarantee applies to the block-processing paths: `sync`, `processEvents`,
  `subscribe`. `processEvent` (single-event escape hatch) runs handlers without a
  block/checkpoint.
- SQLite proven today; the same transaction boundary applies to Postgres (the
  dockerized Postgres crash test lands in M12).
