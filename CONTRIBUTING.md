# Contributing to traintrack

Thanks for your interest in traintrack — multi-agent coordination for coding agents. This guide gets you from a clone to a merged PR.

> **One principle above all: no hollow code.** traintrack's value is that the live path *actually works* — a lead really spawns workers, they really talk over a shared channel, results really come back. A change is not "done" because the unit tests are green; it's done when the **live path is proven** (see [Verifying live](#verifying-live)). Green tests that mask a broken live path are worse than no tests.

## Prerequisites

- **Node.js 18+**
- **npm** (the repo also carries a pnpm lockfile, but the scripts are npm-based — `npm install` works)
- For end-to-end verification: a real `claude` and/or `codex` CLI on your `PATH`

## Quick start

```bash
git clone https://github.com/OKKHALIL3/traintrack.git
cd traintrack
npm install
npm run build        # tsc → dist/
npm test             # vitest unit tests (147+)
npm run typecheck    # tsc --noEmit
```

`npm run build` must pass, `npm test` must be green, and `npm run typecheck` must be clean before you open a PR.

## Project layout

```
src/
  channel/     the SQLite-WAL channel (members + messages) — the shared substrate
  mcp/         the MCP server + the 7 tools agents call (spawn_worker, send_message, …)
  mcp-server.ts  MCP server entry (stdio)
  runner/      headless turn argv + the NDJSON event parser (claude/codex turn-end ACKs)
  spawn/       spawning a headless worker (git worktree + child_process)
  worker/      the worker loop: drain inbox → run a headless turn → reply
  setup/       the `traintrack setup` installer (detect harnesses, write MCP config + awareness)
  ui/          the CLI banner
  cli.ts       the `traintrack` binary
scripts/       live verification harnesses (verify-*.mjs) — see below
docs/          ARCHITECTURE.md and design notes
hooks/         per-agent hook payloads installed by setup
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit.

## Verifying live

Unit tests prove the pure logic. The `scripts/verify-*.mjs` harnesses prove the **real** thing by shelling out to the built `dist/` and spinning real agents/servers:

| Script | Proves |
| --- | --- |
| `node scripts/verify-setup.mjs` | `traintrack setup` wires every harness, is idempotent, uninstalls cleanly, and the configured MCP server boots (no agents needed) |
| `node scripts/verify-l1.mjs` … `verify-l5.mjs` | the spawn → work → collect path at increasing fidelity (need real `claude`/`codex`) |
| `node scripts/verify-mesh.mjs` | peers discover each other and exchange messages |
| `node scripts/verify-capstone.mjs` | the full lead-spawns-team flow end-to-end |

If you touch `setup/`, run `verify-setup.mjs`. If you touch `spawn/`, `worker/`, or `runner/`, run the relevant `verify-l*`/`verify-mesh`. **Include the verifier output in your PR.**

## The most common contribution: add support for a new agent CLI

traintrack "supports" a CLI at the **wire-in** tier (its sessions auto-join the mesh) and optionally the **headless-worker** tier (it can be spawned as a worker). Adding wire-in support is self-contained:

1. **`src/setup/types.ts`** — add the id to `HarnessId`.
2. **`src/setup/harness.ts`** — add a `HARNESSES` entry: `bins`, `configHints`, the `mcp` target (`file` + `jsonPath` + `kind`), and the `awarenessFile`/`awarenessStyle`.
   - If the tool's MCP config shape differs from the `mcpServers: { name: { command, args } }` convention, add a new `kind` (see `'json-opencode'`, which emits OpenCode's `mcp.<name> = { type, command[], enabled, environment }` shape) and handle it in `src/setup/configure.ts`.
3. **Tests** — extend `src/setup/detect.test.ts` and `src/setup/setup.test.ts` for the new harness.
4. **`scripts/verify-setup.mjs`** — add the harness to the seeded HOME + assertions, then run it (`SETUP VERIFIED`).
5. **`README.md`** — add it to the support table and the detect snippet.

Adding the **headless-worker** tier (so a lead can `spawn_worker` it) means teaching `src/runner/argv.ts` how to invoke it non-interactively and `src/runner/event-parser.ts` how to detect its turn-end + final text. **Only do this against a real, installed CLI** — never ship a parser you couldn't verify against actual output.

## Code style & conventions

- **TypeScript, ESM.** No `any` where a real type fits. Keep modules pure where they can be (the event parser does no I/O so it's table-testable — preserve that).
- **Comment the *why*, not the *what*.** Match the surrounding density — load-bearing decisions (e.g. codex's `--dangerously-bypass-approvals-and-sandbox`, per-thread resume) carry a short why.
- Run `npm run typecheck` and `npm test` before pushing.

## Commits & PRs

- **Conventional commits**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- **One logical change per commit** — commit each step as you finish it, not one giant blob at the end. Small, reviewable PRs merge faster.
- In the PR description: what changed, why, and the **verifier output** for anything touching the live path.
- Open an issue first for anything large or design-altering, so we can agree on the approach before you build.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/OKKHALIL3/traintrack/issues/new/choose). For bugs, include your OS, Node version, `traintrack --version`, which agent CLI(s), and exact repro steps.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind.
