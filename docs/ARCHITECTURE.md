# Architecture

traintrack is three things in one small package: a **library** (the channel + runner + worker loop), an **MCP server** (the tools your agent calls), and a **CLI** (`traintrack`). There is no daemon and no network service — coordination happens entirely through a local SQLite file.

```
        ┌─────────────── one git repo ───────────────┐
        │   <repo>/.traintrack/channel.db  (the bus)  │
        └──┬──────────────┬──────────────┬────────────┘
           │              │              │
   claude session   codex session   spawned worker
   (MCP server)     (MCP server)    (headless loop, own worktree)
   live member      live member     headless member
```

Every process opens the **same SQLite file**; the file *is* the message bus. No process talks to another directly.

## Modules (`src/`)

| Module | Responsibility |
| --- | --- |
| `channel/channel.ts` | The SQLite-WAL store: `messages` + `members` tables. `insertMessage`, `getUnread`, `markRead`, `addMember`, `listMembers`, `getMember`, `setStatus`. |
| `channel/resolve.ts` | `resolveChannelPath()` — picks which db to attach to. Order: `--channel` → `--room` (`~/.traintrack/rooms/<n>.db`) → `TRAINTRACK_CHANNEL` → **git repo root** → cwd. This is why sessions in a project auto-share a team. |
| `runner/{event-parser,argv,turn-runner}.ts` | Spawn a headless provider turn (`claude --print` / `codex exec`), parse the stream for the turn-end event + session id. |
| `worker/worker.ts` | The headless worker loop: drain inbox → run one headless turn → reply → mark read; rebuilds its team briefing from the live roster each cycle; resolves `@handle` peer addressing. |
| `spawn/spawn.ts` | `spawnWorker` = `git worktree add` + a detached child process running `traintrack worker`, registered as a `headless` member with its task seeded into the channel. |
| `mcp/tools.ts` | The 7 tools as injectable, unit-testable functions over a `Channel`. |
| `mcp/server.ts` | The stdio JSON-RPC MCP shell. On startup it **auto-registers the session** as a `live` member (`buildDepsFromEnv`) and flips it `offline` on exit; every tool result gets a `📨 N unread` nudge (`withUnreadNudge`). |
| `setup/*` | The `traintrack setup` installer: `detect` (which CLIs exist) → `configure` (write each harness's MCP config + awareness block) over an idempotent `blocks` engine; `prompt` is a raw-mode checkbox selector. |
| `onboarding/briefing.ts` | The team briefing prepended to each worker turn. |
| `ui/banner.ts` | The gradient CLI banner. |
| `cli.ts`, `mcp-server.ts` | Entry points (the `traintrack` bin and the MCP server bin). |

## Two membership kinds

- **`live`** — a hand-driven session (a real `claude`/`codex` TUI). It can't be interrupted mid-task, so it receives messages best-effort: at the start of each turn and via the unread nudge.
- **`headless`** — a worker spawned by a lead. It runs a loop, so it **truly auto-receives**: it drains its inbox every few seconds and replies on its own.

## Identity

A live session's handle is `TRAINTRACK_HANDLE` if set, else minted `<agent>-<rand>` by the MCP server on startup. `setup` writes `TRAINTRACK_AGENT=<harness>` into each MCP config so a session registers as the right agent type. Spawned workers get `worker_<uuid>` handles and an explicit `--channel`.

## The skill

`skills/coordinating-a-team/SKILL.md` is the methodology (mesh etiquette + lead orchestration). The same content is condensed into the awareness block `setup` injects into every harness's instructions file, so it's auto-applied identically across CLIs.

## Live verification

The discipline of this project: every layer is **run end-to-end with real agents**, not just unit-tested. The proofs live in `scripts/`:

| Script | Proves |
| --- | --- |
| `verify-l1.mjs` | spawn → real codex worker → reply (`PONG`) collected |
| `verify-l2.mjs` | roster + delegate + collect across 2 workers |
| `verify-l3.mjs` | worker ↔ worker `@handle` messaging |
| `verify-l4.mjs` | multi-round delegation with session continuity |
| `verify-l5.mjs` | a `traintrack join` member joins a running team |
| `verify-mesh.mjs` | 2 sessions in different subdirs auto-share a team, message + nudge, go offline |
| `verify-capstone.mjs` | a real lead MCP server spawns a real codex worker via the tool path |
| `verify-setup.mjs` | the installer writes/idempotently-updates/uninstalls all 4 harnesses' configs |
