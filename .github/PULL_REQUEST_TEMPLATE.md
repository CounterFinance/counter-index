## Summary

<!-- What does this PR change and why? 1–3 sentences. -->

## Type

- [ ] `feat`: new feature (small or large)
- [ ] `fix`: bug fix
- [ ] `chore`: tooling, deps, docs, config
- [ ] `refactor`: internal restructure, no behaviour change

## Semver label

Add **one** of the following labels to this PR before merging:

| Label | Bumps | When to use |
|---|---|---|
| `semver:patch` | x.y.**Z** | Small feature, fix, chore, docs, the default |
| `semver:minor` | x.**Y**.z | Meaningful new capability or consequent improvement |
| `semver:major` | **X**.y.z | Breaking change to exported API, types, or event shapes |

## Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test`: all tests green, new behaviour has tests
- [ ] `CHANGELOG.md` entry not needed, release workflow appends it automatically on `dev → main` merge
- [ ] Docs / README updated if public API changed
