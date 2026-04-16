# op-index — Claude Code Instructions

## Git workflow

MUST follow for all code changes:

1. **Always branch from `dev`** before making changes:
   - `feat/...` — new feature (small or large)
   - `fix/...` — bug fix
   - `chore/...` — tooling, deps, docs, config
   - `refactor/...` — internal restructure with no behaviour change
2. **Make focused commits** on the branch. Multiple commits per branch is fine and encouraged.
3. **Open a PR targeting `dev`** using the PR template. Always add one semver label:
   - `semver:major` — breaking API change or major milestone (bumps X.y.z)
   - `semver:minor` — meaningful new capability or consequent improvement (bumps x.Y.z)
   - `semver:patch` — small feature, fix, chore, refactor, docs (bumps x.y.Z)
4. **`dev → main` is the release PR** — merging to `main` triggers the version bump, CHANGELOG update, and git tag. npm publish is handled manually after.
5. **Never commit directly to `main` or `dev`** unless the user explicitly says so.

Semver guide for this project:
- **Z (patch)** — the default. Small features, small fixes, docs, chores, any general commit.
- **Y (minor)** — meaningful new capability or consequent improvement. Use judgment.
- **X (major)** — breaking change to the public API surface (exported types, event shapes, source interfaces).

## Tech stack

- **Node.js 24** — `engines` in package.json enforces `>=24.0.0`. CI enforces 24.
- **TypeScript strict** — `npx tsc --noEmit` must pass before any commit.
- **Vitest** — all new behaviour needs tests. Run `npm test` before declaring work done.
- **No ESLint** — not configured. Do not add ESLint lint steps to CI without first setting up the config.
- **ES modules** — `"type": "module"` in package.json. Use `.js` extensions in imports even for `.ts` source files.
- **better-sqlite3** — synchronous SQLite driver for `DbEventSource`.

## Package architecture

op-index is a **published npm library** (`@opnet-collective/op-index`). The public API is everything exported from `src/index.ts`. Breaking changes to exported types or interfaces require a major version bump.

Key concepts:
- **Event sources**: `DbEventSource`, `WsEventSource`, `RpcEventSource` — pluggable data providers
- **GraphQL layer**: schema defined in `src/graphql/`, resolvers query the event source
- **Subscriptions**: real-time via `graphql-ws` protocol
- `Connection.nodes` (not `.items`) — Relay spec, renamed in v0.1.4

## Releases

Releases go to npm — published manually after the `dev → main` PR merges and the version tag is created. The release workflow handles the version bump + CHANGELOG + tag automatically. Do not add an `npm publish` step to the workflow.

## Commit messages

Follow the existing style: `type(scope): short description`
- `feat`, `fix`, `chore`, `docs`, `refactor`, `test`
- Keep the subject line under 72 characters.
