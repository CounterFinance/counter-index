# counter-index — Claude Code Instructions

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
   - `semver:minor` — meaningful stable milestone (bumps x.Y.z)
   - `semver:patch` — default for everything else (bumps x.y.Z)
4. **`dev → main` is the release PR** — merging to `main` triggers the version bump, CHANGELOG update, and git tag. npm publish is handled manually after.
5. **Never commit directly to `main` or `dev`** unless the user explicitly says so.

Semver guide for this project:
- **Default publishing flow** — use prerelease alpha tags for all iterative work:
  ```
  npm version 0.1.12-alpha.1 && npm publish --tag alpha
  npm version 0.1.12-alpha.2 && npm publish --tag alpha
  # stable milestone:
  npm version 0.1.12 && npm publish
  ```
- **Z-alpha (0.0.Z-alpha.N)** — the default. Any fix, feature, breaking change, refactor. Publish with `--tag alpha`.
- **Z stable (0.0.Z)** — only when explicitly blessed as stable. Publish with `npm publish` (→ `latest`).
- **Y (minor)** — meaningful stable milestone. Requires explicit user approval.
- **X (major)** — stays at 0 for the foreseeable future. Do not bump.

## Tech stack

- **Node.js 24** — `engines` in package.json enforces `>=24.0.0`. CI enforces 24.
- **TypeScript strict** — `npx tsc --noEmit` must pass before any commit.
- **Vitest** — all new behaviour needs tests. Run `npm test` before declaring work done.
- **ESLint** — configured in `eslint.config.mjs` (flat config, type-aware). Run `npm run lint` or `just lint`. Zero errors required; `no-console` and `no-explicit-any` are warnings only. Auto-fix: `just lint-fix`.
- **ES modules** — `"type": "module"` in package.json. Use `.js` extensions in imports even for `.ts` source files.
- **better-sqlite3** — synchronous SQLite driver for `DbEventSource`.

## Package architecture

counter-index is a **published npm library** (`@counterfinance/counter-index`). The public API is everything exported from `src/index.ts`. Breaking changes to exported types or interfaces require a major version bump.

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
