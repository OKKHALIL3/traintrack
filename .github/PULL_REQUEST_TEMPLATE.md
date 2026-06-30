<!-- Thanks for contributing to traintrack! Keep PRs small and focused. -->

## What & why

<!-- What does this change, and why? Link any related issue (e.g. "Closes #12"). -->

## How it was verified

<!-- traintrack's bar is the LIVE path working, not just green unit tests. -->

- [ ] `npm run build` passes
- [ ] `npm test` is green
- [ ] `npm run typecheck` is clean
- [ ] If I touched `setup/`: ran `node scripts/verify-setup.mjs` → `SETUP VERIFIED`
- [ ] If I touched `spawn/` / `worker/` / `runner/`: ran the relevant `verify-l*` / `verify-mesh` against real agents

<!-- Paste verifier output for anything touching the live path: -->

```
(verifier output here)
```

## Notes for the reviewer

<!-- Anything non-obvious, trade-offs, follow-ups. -->
