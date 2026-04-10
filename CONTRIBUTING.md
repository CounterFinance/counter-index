# Contributing to OpKit

Thanks for your interest. OpKit is an MIT-licensed indexer framework for OPNET — contributions
that improve correctness, performance, documentation, or developer experience are welcome.

## Before you start

- For bug fixes and small improvements, open a PR directly.
- For larger features or breaking changes, open an issue first to align on scope before writing code.
- Check the [roadmap in the README](./README.md#roadmap) for items already in flight.

## Setup

Node.js 22+ required.

```bash
git clone https://github.com/opnet-devs/opkit
cd opkit
npm install
```

## Development workflow

```bash
npm test              # run all 165+ tests (vitest)
npm run test:watch    # watch mode
npx tsc --noEmit      # type check — must be clean
```

Or with `just` if you have it installed:

```bash
just check            # test + typecheck in one shot
just test-watch       # watch mode
just doctor           # verify your environment
```

Tests use an in-memory SQLite adapter — no database setup needed.

## Code style

- TypeScript strict mode throughout — no `any`, no `// @ts-ignore`
- No runtime dependencies beyond `graphql` (already a dep) and `better-sqlite3` (optional peer)
- Keep new source files under `src/`, tests under `tests/`
- Match the existing file structure: one concern per file, named by what it does

## Adding a built-in decoder

New OPNET protocol events belong in `src/decoders/eventDecoders.ts`. Add the decoder function,
register it in `DECODER_REGISTRY`, and add a test in `tests/decoders.test.ts`.

## Tests

Every new behaviour needs a test. OpKit targets 100% branch coverage on public API paths.

- Unit tests go in `tests/<subject>.test.ts`
- Use the `createTestAdapter()` helper from `src/adapter.ts` for an in-memory SQLite sink
- For `WsEventSource` tests, use a real in-process `WebSocketServer` (see `tests/wsSource.test.ts`)

## Pull request checklist

- `npm test` passes
- `npx tsc --noEmit` passes with no errors
- New behaviour is covered by tests
- Docs updated if the public API changed

## What we are not looking for

- Runtime dependency additions — OpKit is intentionally lean
- Breaking changes to `defineSchema`, `createIndexer`, or store CRUD without a compelling reason
- Features specific to a single contract or protocol (use `registerDecoder()` in your own indexer instead)
