# Changelog

All notable changes to traintrack are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/).

> **About the version numbers:** this is the first release of the current
> project, but it ships as `2.x`. The `traintrack` npm name previously hosted an
> unrelated package (`1.0.0`–`1.0.3`, 2015) that was unpublished; npm forbids
> reusing or going below those numbers, so the modern traintrack starts at
> `2.0.0`. The README badge carries the real maturity.

## [2.2.0] — 2026-07-06

### Added
- **Per-worker model selection** — `spawn_worker` accepts an optional `model`,
  forwarded verbatim to the worker's agent CLI on every turn (`--model` for
  claude/cursor/opencode, `-m` for codex), e.g. spawn a cheap `"haiku"` claude
  worker next to a default one. Also exposed as `traintrack worker --model <model>`.
  Omit it for the provider default; model names are not validated by traintrack,
  so new provider models work without an update.

## [2.1.0] — 2026-06-28

### Added
- **Support for 10 coding agents** (up from 4): added **Windsurf, Cline, Kiro, Zed, Continue, and GitHub Copilot CLI** alongside Claude Code, Codex, Cursor, and OpenCode. `traintrack setup` wires each one's MCP server per its *official* config docs, in the host's own format (`mcpServers` JSON, Codex TOML, OpenCode `mcp` map, Zed `context_servers`, Copilot `type:local`, Continue YAML).
- **`/team` chat command** — drive the team from your agent's chat: `/team`, `/team spawn <task>`, `/team delegate <task>`, `/team sync`, `/team send <handle> <msg>`, `/team check`, `/team help`. Installed per-agent in the correct command format (Claude/Codex/OpenCode markdown+`$ARGUMENTS`, Cursor plain markdown, Windsurf/Cline workflows, Kiro manual steering, Zed skill, Continue prompt). Copilot CLI has no user-command surface → MCP + awareness only.
- **Headless workers for Cursor and OpenCode** (alpha) — `spawn_worker` / `traintrack worker --agent` now accept `cursor` and `opencode` in addition to `claude` and `codex`. Worker support for the remaining CLIs is in development.
- `scripts/verify-agents.mjs` — checks that all 10 agents install → are idempotent → uninstall cleanly.

## [2.0.1] — 2026-06-28

### Fixed
- CLI banner version now derives from `package.json` at runtime, so it can never
  drift from the published version again (it previously showed `v0.0.1`). Added a
  test that enforces the two stay in sync.

## [2.0.0] — 2026-06-28

First public release of the current project.

### Added
- One-command installer `traintrack setup` — detects your installed agent CLIs,
  registers the MCP server, and injects a team-awareness note. Idempotent and
  reversible (`--uninstall`).
- **OpenCode** support at the wire-in tier (writes its `mcp.<name>` local-server
  config shape).
- Public API: `Channel`, `resolveChannelPath`, and types are now exported so host
  apps can read the shared channel.
- The coordination engine: a lead spawns headless workers (git worktree +
  child process), delegates tasks, and collects results over a local SQLite-WAL
  channel; live members and a peer mesh; 7 MCP tools (`list_team`,
  `check_messages`, `send_message`, `spawn_worker`, `delegate_task`,
  `await_results`, `join_team`). Live-verified with real `claude`/`codex` agents.

### Changed
- Published as the unscoped name **`traintrack`** (was `@okkhalil/traintrack`).

### Removed
- **Gemini** support (Google ended standalone Gemini CLI consumer access).

[2.1.0]: https://github.com/OKKHALIL3/traintrack/releases/tag/v2.1.0
[2.0.1]: https://github.com/OKKHALIL3/traintrack/releases/tag/v2.0.1
[2.0.0]: https://github.com/OKKHALIL3/traintrack/releases/tag/v2.0.0
