import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export type HarnessId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'windsurf'
  | 'cline'
  | 'kiro'
  | 'zed'
  | 'continue'
  | 'copilot'

/** How the MCP server entry is written for a host. All resolve to the same
 *  `node <serverPath>` + `TRAINTRACK_AGENT` env; only the wrapper key/shape differs.
 *  - 'json'          → `mcpServers.<name> = {command, args, env}` (Claude/Cursor/Windsurf/Cline/
 *                       Kiro; jsonPath is configurable — Zed uses `context_servers`).
 *  - 'json-copilot'  → `mcpServers.<name> = {type:'local', command, args, env, tools:['*']}` (Copilot CLI).
 *  - 'json-opencode' → `mcp.<name> = {type:'local', command:[...], enabled, environment}` (OpenCode).
 *  - 'toml'          → `[mcp_servers.<name>]` block (Codex).
 *  - 'yaml-file'     → a whole standalone authored YAML file (Continue's `.continue/mcpServers/*.yaml`). */
export type McpKind = 'json' | 'json-copilot' | 'json-opencode' | 'toml' | 'yaml-file'

/** How the `/team` command file is rendered for a host (the command body is shared;
 *  only frontmatter + the argument placeholder differ).
 *  - 'md-args'         → `--- description ---` + markdown body using `$ARGUMENTS` (Claude/Codex/OpenCode).
 *  - 'md-plain'        → plain markdown body, no frontmatter, no args (Cursor).
 *  - 'toml-args'       → TOML `description` + `prompt` using `{{args}}` (TOML-command hosts).
 *  - 'skill'           → `--- name + description ---` + body (Zed skill, Claude/Codex skills).
 *  - 'workflow'        → `--- description ---` + body, no args (Windsurf/Cline workflows).
 *  - 'steering-manual' → `--- inclusion: manual ---` + body (Kiro on-demand steering).
 *  - 'continue-prompt' → `--- name + description + invokable ---` + body (Continue). */
export type CommandFormat =
  | 'md-args'
  | 'md-plain'
  | 'toml-args'
  | 'skill'
  | 'workflow'
  | 'steering-manual'
  | 'continue-prompt'

/** What/where each harness reads. Pure data — see harness.ts for the table. */
export type HarnessSpec = {
  id: HarnessId
  displayName: string
  bins: string[]                       // binaries to probe on PATH, e.g. ['claude']
  configHints: string[]               // HOME-relative paths whose existence also signals presence
  mcp: { kind: McpKind; file: string; jsonPath?: string[] } // where/how the MCP entry goes
  awarenessFile: string               // HOME-relative instructions file for the awareness block
  awarenessStyle: 'md' | 'toml'       // comment style for the markers
  // Frontmatter that MUST sit at the very top of the awareness file for the host to
  // pick the rule up — e.g. Cursor `.mdc` needs `alwaysApply: true`; Kiro steering
  // needs `inclusion: always`. When set, configureHarness opens the file with it.
  awarenessFrontmatter?: string
  // Optional `/team` slash command. Hosts with no user-command surface (Copilot CLI)
  // leave this undefined → MCP + awareness only.
  command?: { file: string; format: CommandFormat }
  // true = live-verified end-to-end with a real agent (Claude/Codex). false/undefined =
  // configured per the host's official docs but not yet verified live. Drives the
  // README support tier + the setup output label. Honest, not hype.
  verified?: boolean
}

/** Resolved runtime context, injectable so tests/verify use a temp HOME. */
export type SetupContext = {
  home: string
  serverPath: string                  // abs path to dist/mcp-server.js
  nodePath: string                    // process.execPath
  dryRun: boolean
  injectAwareness: boolean            // full-auto = true; --tools-only = false
}

export type Action = 'added' | 'updated' | 'unchanged' | 'removed' | 'skipped' | 'error'

export type ConfigOutcome = {
  harness: HarnessId
  mcp: Action
  awareness: Action
  command: Action                     // 'skipped' when the host has no command surface
  files: string[]                     // absolute paths written
  detail?: string
}

/** Resolve the abs path to this package's dist/mcp-server.js from the module's
 *  own location (works for a global npm install). Exported for setup.ts.
 *  The module lives at dist/setup/types.js, so up two to package root, then
 *  dist/mcp-server.js. */
export function resolveServerPath(fromUrl: string): string {
  return resolve(join(dirname(fileURLToPath(fromUrl)), '..', '..', 'dist', 'mcp-server.js'))
}
