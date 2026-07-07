# Multi-Agent Coordination Plugin — Design (working name: `traintrack`)

- **Date:** 2026-06-22
- **Type:** NEW standalone open-source repo (not the Orca fork). This spec will move into that repo when it's created.
- **Status:** Approved design → implementation plan next
- **Inspiration / packaging model:** the `superpowers` plugin (multi-platform, `/plugin`-installable, viral via open source).

## Goal

A standalone, open-source plugin — an **MCP server + a CLI** — installable in any `claude`/`codex`
session (no Electron, no daemon, no cloud). It gives a session tools to run a **team of AI agents**:
a lead spawns headless workers, delegates tasks, they do real work in their own git worktrees and
report back over a local shared channel, and the lead collects + synthesizes.

## Why this (vs the prior Orca-coupled attempt)

The prior version had 141 green unit tests but a broken live path — too many integration points
hidden behind a running Electron app + a human-driven TUI + RPC. This version removes all three:
the channel is a **file**, spawn is a **subprocess**, the lead is a normal TUI with the MCP loaded.
**Every layer is RUN and verified end-to-end with real agents** (like the headless-worker PONG test
that worked) before the next is built.

## Decisions (locked with the user)

1. **Standalone plugin**, zero Orca/Electron dependency. Installable like superpowers (`/plugin`).
2. **Channel = a shared SQLite file (WAL mode)** at `.traintrack/channel.db` in the project — every agent
   process opens it directly; no daemon.
3. **Spawn = `git worktree add` + Node `child_process`** — each worker gets its own worktree.
4. **The lead = the real `claude`/`codex` TUI** the user runs with the plugin's MCP; it pulls results
   via a blocking `await_results` tool.
5. **Full-vision target, built as live-verified LAYERS** (L1–L5 below) — same destination, no big-bang.

## Architecture (small, focused Node/TS modules)

| Module | Responsibility | Source |
|---|---|---|
| `src/channel/` | Open `.traintrack/channel.db` (SQLite WAL). Tables: `messages` (from, to, body, type, read, seq), `members` (handle, agent, role, kind, status, worktree). Pure db API. | NEW |
| `src/runner/` | Spawn `claude --print --output-format stream-json` / `codex exec --json`; stream-parse turn-end + session id (`event-parser`, `argv`, `turn-runner`). | PORTED |
| `src/worker/` | The worker loop: resolve `--handle`, `members` self-register, fetch briefing, drain unread → run a headless turn (briefing-prefixed) → reply; can message peers. Persistent, multi-round. | PORTED |
| `src/spawn/` | `git worktree add <path>` + `child_process` launch of `traintrack worker --agent X --role Y --handle H --channel <db>` (stdin ignored, codex `--dangerously-bypass-approvals-and-sandbox`); register the member + seed the task. | NEW |
| `src/mcp/` | The lead's MCP tools — `list_team` · `send_message` · `check_messages` · `reply` · `spawn_worker` · `delegate_task` · `await_results` — opening the channel file directly. | shapes PORTED |
| `src/cli/` | `traintrack worker …` (worker entry), `traintrack init` (create `.traintrack/`), `traintrack watch` (tail the channel). | NEW |
| `src/onboarding/` | The team-briefing generator (names team, roster, tools, "check messages"); seed prompt for workers; injected at join for live members. | PORTED |

The MCP server and the worker CLI are two entry points of the same package; both open the same
`.traintrack/channel.db` (WAL = safe concurrent access). Nothing talks over RPC — the file IS the bus.

## Packaging (installable like superpowers)

Multi-platform plugin repo:
- `.claude-plugin/plugin.json` — manifest (name, description, version, author, license, homepage).
- `.claude-plugin/marketplace.json` — `{ name, owner, plugins: [{ name:"traintrack", source:"./", version }] }`.
- `.mcp.json` at root — bundles the MCP server, auto-starts on enable:
  ```json
  { "mcpServers": { "traintrack": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"] } } }
  ```
- `.codex-plugin/plugin.json` — codex packaging (codex registers the MCP via its `mcp_servers` config).
- `package.json` — published to npm; `bin` exposes `traintrack`.
- **Install (Claude Code):** `/plugin marketplace add <github-repo>` → `/plugin install traintrack` → the MCP
  auto-loads and the session has the team tools. **Codex:** the `.codex-plugin` MCP entry.

## The lead + result flow

The lead is the user's real TUI (e.g. `claude --dangerously-skip-permissions`) with the plugin MCP.
It reasons: `list_team` → `spawn_worker(agent, role, task)` × N → `await_results()` (blocks on NEW
unread replies via the channel, marks them read) → synthesize → report. Workers reply to the lead's
handle; the lead pulls (no fragile passive auto-receive).

## Layered, live-verified build

Each layer ends with **me running real agents through it and showing it works**, not just tests:
- **L1** — spawn → real work in a worktree → report → collect. (lead spawns a codex worker that does a
  real small task and replies; lead `await_results` gets it.) *The PONG-grade proof, but real.*
- **L2** — `members` roster + `list_team` + auto-briefing on spawn (workers know the team + tools).
- **L3** — worker↔worker messaging (workers coordinate directly, not only via the lead).
- **L4** — roles + multi-round delegation (lead delegates, collects, delegates again).
- **L5** — live human-run members join the team (`traintrack join` registers a real TUI; best-effort receive
  via the briefing + `check_messages`, matching the TUI auto-wake limit).

## Reuse vs new

- **Ported (~70%, proven):** the runner core, the worker loop, the briefing generator, the four tool shapes.
- **New:** the SQLite channel module, the `git worktree` + `child_process` spawn, the MCP-server + CLI
  packaging, the plugin manifests.

## Testing

- **Unit:** channel db (insert/drain/mark-read/members), runner parser (fixtures), argv, briefing, the
  MCP tool handlers (fake channel), spawn arg-building.
- **LIVE (required, the whole point):** at each layer, a scripted end-to-end run with REAL `claude`/`codex`
  agents over a real `.traintrack/channel.db`, asserting the actual coordination happened (e.g. L1: a spawned
  codex worker's real reply lands in the lead's collected results). No layer ships on unit tests alone.

## Risks

- **SQLite concurrency:** multiple processes writing — WAL mode + short transactions + retry-on-busy.
  Verify under real parallel workers in L1/L3.
- **Spawn portability:** `git worktree add` requires a git repo + a clean base; handle the no-repo and
  dirty-tree cases with clear errors.
- **codex landmines:** stdin ignored (else `exec` hangs), `--dangerously-bypass-approvals-and-sandbox`,
  per-agent resume id — carried over from the ported runner.
- **Full-vision scope:** mitigated by the layered live-verified build — we never have a green-but-broken
  whole; each layer is demoed.
- **Cost:** every worker is real LLM spend; a `max-team-size` cap + the visible roster + `traintrack watch`.

## Out of scope (v1)

- The hosted/cloud + dashboard (the eventual commercial layer — see strategy; not in the OSS core v1).
- Non-claude/codex agents (gemini/others) — add after the claude+codex core is proven.
