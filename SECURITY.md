# Security Policy

## Supported versions

traintrack is pre-1.0 in spirit (the published `2.x` line is the current and only supported release). Security fixes land on the latest published version.

| Version | Supported |
| --- | --- |
| latest `2.x` | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via either:

- **GitHub Security Advisories** — [open a draft advisory](https://github.com/OKKHALIL3/traintrack/security/advisories/new) (preferred), or
- **Email** — **security@traintrack.dev**

Include: a description, the impact, affected version(s), and a minimal reproduction. We aim to acknowledge within a few days and to ship a fix or mitigation as fast as the severity warrants. We'll credit you in the release notes unless you prefer to remain anonymous.

## What's in scope

traintrack touches a few sensitive surfaces — these are the areas we care most about:

- **The MCP server** (`src/mcp/`) — it exposes tools (`spawn_worker`, `send_message`, …) to whatever agent loads it. Tool input handling and the channel boundary matter.
- **Spawning workers** (`src/spawn/`, `src/runner/`) — traintrack launches real agent CLIs as child processes. Note that codex workers are launched with `--dangerously-bypass-approvals-and-sandbox` **by design**: an unattended headless turn cannot answer an approval prompt, so it would otherwise auto-cancel. This is an intentional, documented trade-off for the worker role, not a vulnerability — but reports about how it could be abused are welcome.
- **The setup installer** (`src/setup/`) — it writes MCP config + an awareness block into your agent tools' config files. It is idempotent and fully reversible (`traintrack setup --uninstall`); report anything that clobbers unrelated config or leaves residue.
- **The channel DB** (`src/channel/`) — a local SQLite file resolved at the git-repo root (or `~/.traintrack/rooms/<room>.db`). It is local-only; report any path-traversal or cross-project leakage.

## Out of scope

- The security posture of the underlying agent CLIs themselves (`claude`, `codex`, etc.) — report those upstream.
- Issues that require an attacker to already have local code-execution or write access to your config files.
