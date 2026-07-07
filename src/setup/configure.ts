// Apply/remove the MCP entry + awareness block + /team command for one harness.
// Pure orchestration over blocks.ts — honors ctx.dryRun and ctx.injectAwareness.
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Action, ConfigOutcome, HarnessSpec, SetupContext } from './types.js'
import { renderCommand } from './commands.js'
import {
  upsertBlock,
  removeBlock,
  upsertJson,
  removeJson,
  planBlock,
  planJson,
  planRemoveBlock,
  planRemoveJson,
} from './blocks.js'

// Marker conventions (per the plan). Re-runs replace, never duplicate; uninstall removes cleanly.
const MD_START = '<!-- >>> traintrack >>> -->'
const MD_END = '<!-- <<< traintrack <<< -->'
const TOML_START = '# >>> traintrack >>>'
const TOML_END = '# <<< traintrack <<<'

/** The awareness body — the auto-injected "coordinating-a-team" methodology,
 *  identical text on every harness, wrapped in the file's markers. */
export const AWARENESS_BODY = [
  'You are part of a traintrack agent team. Every coding-agent session opened in this project auto-joins the SAME team over a shared local channel, and you have these tools: list_team, check_messages, send_message, spawn_worker, delegate_task, await_results, join_team.',
  '',
  'Working with teammates (the mesh):',
  '- Run check_messages at the START of each turn, and whenever you see a "📨 N unread" nudge on a tool result — that is a teammate writing to you.',
  '- list_team shows who is online. send_message(to, body) messages a teammate by handle; they read it on their next turn (you cannot interrupt them mid-task).',
  '',
  'When the user asks you to build several things (you act as LEAD):',
  '1. Propose a short split — which part goes to which worker (claude or codex) — and confirm before spawning, unless told to just go.',
  '2. spawn_worker(agent, role, task, model?) for each part; workers run headless in their own git worktree and auto-reply. Pass model to pin the worker\'s model (e.g. "haiku" for a cheap claude worker); omit it for the provider default.',
  '3. await_results() to collect, delegate_task(handle, task) for follow-ups, then synthesize. Keep the team small; do simple work yourself.',
  '',
  'You can also drive the team from chat with the /team command (status · spawn · delegate · send · sync · check · help).',
  '',
  'If a human adds your session to a running team, you are already auto-joined — just check_messages and help.',
].join('\n')

/** Pick the marker pair for a comment style. */
function markers(style: HarnessSpec['awarenessStyle']): { start: string; end: string } {
  return style === 'toml' ? { start: TOML_START, end: TOML_END } : { start: MD_START, end: MD_END }
}

/** Encode a string as a TOML basic string (escape backslash + double-quote). */
function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Encode a string as a YAML double-quoted scalar (escape backslash + double-quote). */
function yamlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** The toml MCP block body (Codex `[mcp_servers.traintrack]`). */
function tomlMcpBody(ctx: SetupContext, agentId: string): string {
  return (
    `[mcp_servers.traintrack]\n` +
    `command = ${tomlStr(ctx.nodePath)}\n` +
    `args = [${tomlStr(ctx.serverPath)}]\n` +
    `env = { TRAINTRACK_AGENT = ${tomlStr(agentId)} }`
  )
}

/** The standalone YAML MCP file (Continue `.continue/mcpServers/traintrack.yaml`). */
function yamlMcpFile(ctx: SetupContext, agentId: string): string {
  return (
    `name: traintrack\n` +
    `version: 1.0.0\n` +
    `schema: v1\n` +
    `mcpServers:\n` +
    `  - name: traintrack\n` +
    `    type: stdio\n` +
    `    command: ${yamlStr(ctx.nodePath)}\n` +
    `    args:\n` +
    `      - ${yamlStr(ctx.serverPath)}\n` +
    `    env:\n` +
    `      TRAINTRACK_AGENT: ${yamlStr(agentId)}\n`
  )
}

/** The JSON MCP value for a host (the `mcpServers.<name>` / `mcp.<name>` object). */
function jsonMcpValue(spec: HarnessSpec, ctx: SetupContext): unknown {
  if (spec.mcp.kind === 'json-opencode') {
    return {
      type: 'local',
      command: [ctx.nodePath, ctx.serverPath],
      enabled: true,
      environment: { TRAINTRACK_AGENT: spec.id },
    }
  }
  if (spec.mcp.kind === 'json-copilot') {
    return {
      type: 'local',
      command: ctx.nodePath,
      args: [ctx.serverPath],
      env: { TRAINTRACK_AGENT: spec.id },
      tools: ['*'],
    }
  }
  return { command: ctx.nodePath, args: [ctx.serverPath], env: { TRAINTRACK_AGENT: spec.id } }
}

/** Did this action actually mutate a file? files[] should list only real writes. */
function wrote(action: Action, ctx: SetupContext): boolean {
  return !ctx.dryRun && (action === 'added' || action === 'updated')
}

// --- Authored-file primitives (a whole file traintrack owns: YAML MCP + command files) ---
function upsertFile(file: string, content: string): Action {
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') === content) return 'unchanged'
    writeFileSync(file, content, 'utf8')
    return 'updated'
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return 'added'
}
function removeFile(file: string): Action {
  if (!existsSync(file)) return 'unchanged'
  unlinkSync(file)
  return 'removed'
}
function planFile(file: string, content: string): Action {
  if (existsSync(file)) return readFileSync(file, 'utf8') === content ? 'unchanged' : 'updated'
  return 'added'
}
function planRemoveFile(file: string): Action {
  return existsSync(file) ? 'removed' : 'unchanged'
}

/** Ensure `file` opens with exactly `frontmatter` (e.g. Cursor MDC, Kiro inclusion).
 *  Idempotent; honors dryRun; the frontmatter must be the first bytes of the file. */
function ensureFrontmatter(file: string, frontmatter: string, dryRun: boolean): void {
  if (dryRun) return
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (text.startsWith(frontmatter)) return
  const sep = text.length === 0 || text.startsWith('\n') ? '' : '\n'
  writeFileSync(file, frontmatter + '\n' + sep + text, 'utf8')
}

/** Strip a leading `frontmatter` block from `file` (inverse of ensureFrontmatter). */
function removeFrontmatter(file: string, frontmatter: string, dryRun: boolean): void {
  if (dryRun || !existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (!text.startsWith(frontmatter)) return
  let rest = text.slice(frontmatter.length)
  if (rest.startsWith('\n')) rest = rest.slice(1)
  if (rest.startsWith('\n')) rest = rest.slice(1)
  writeFileSync(file, rest, 'utf8')
}

/** Apply the MCP entry + (optionally) awareness + the /team command for one harness. */
export function configureHarness(spec: HarnessSpec, ctx: SetupContext): ConfigOutcome {
  const mcpFile = join(ctx.home, spec.mcp.file)
  const awarenessFile = join(ctx.home, spec.awarenessFile)
  const files: string[] = []

  // --- MCP ---
  let mcp: Action
  if (spec.mcp.kind === 'toml') {
    mcp = ctx.dryRun
      ? planBlock(mcpFile, TOML_START, TOML_END, tomlMcpBody(ctx, spec.id))
      : upsertBlock(mcpFile, TOML_START, TOML_END, tomlMcpBody(ctx, spec.id))
  } else if (spec.mcp.kind === 'yaml-file') {
    const content = yamlMcpFile(ctx, spec.id)
    mcp = ctx.dryRun ? planFile(mcpFile, content) : upsertFile(mcpFile, content)
  } else {
    const path = spec.mcp.jsonPath ?? ['mcpServers', 'traintrack']
    const value = jsonMcpValue(spec, ctx)
    mcp = ctx.dryRun ? planJson(mcpFile, path, value) : upsertJson(mcpFile, path, value)
  }
  if (wrote(mcp, ctx)) files.push(mcpFile)

  // --- Awareness ---
  let awareness: Action
  if (!ctx.injectAwareness) {
    awareness = 'skipped'
  } else {
    const m = markers(spec.awarenessStyle)
    awareness = ctx.dryRun
      ? planBlock(awarenessFile, m.start, m.end, AWARENESS_BODY)
      : upsertBlock(awarenessFile, m.start, m.end, AWARENESS_BODY)
    if (spec.awarenessFrontmatter && !ctx.dryRun) {
      ensureFrontmatter(awarenessFile, spec.awarenessFrontmatter, ctx.dryRun)
    }
    if (wrote(awareness, ctx)) files.push(awarenessFile)
  }

  // --- /team command (authored file; hosts without a command surface are skipped) ---
  let command: Action = 'skipped'
  if (spec.command) {
    const commandFile = join(ctx.home, spec.command.file)
    const content = renderCommand(spec.command.format)
    command = ctx.dryRun ? planFile(commandFile, content) : upsertFile(commandFile, content)
    if (wrote(command, ctx)) files.push(commandFile)
  }

  return {
    harness: spec.id,
    mcp,
    awareness,
    command,
    files,
    detail: ctx.dryRun ? 'dry-run: no files written' : undefined,
  }
}

/** Remove the MCP entry + awareness + command for one harness (inverse of configureHarness). */
export function unconfigureHarness(spec: HarnessSpec, ctx: SetupContext): ConfigOutcome {
  const mcpFile = join(ctx.home, spec.mcp.file)
  const awarenessFile = join(ctx.home, spec.awarenessFile)
  const files: string[] = []

  // --- MCP ---
  let mcp: Action
  if (spec.mcp.kind === 'toml') {
    mcp = ctx.dryRun
      ? planRemoveBlock(mcpFile, TOML_START, TOML_END)
      : removeBlock(mcpFile, TOML_START, TOML_END)
  } else if (spec.mcp.kind === 'yaml-file') {
    mcp = ctx.dryRun ? planRemoveFile(mcpFile) : removeFile(mcpFile)
  } else {
    const path = spec.mcp.jsonPath ?? ['mcpServers', 'traintrack']
    mcp = ctx.dryRun ? planRemoveJson(mcpFile, path) : removeJson(mcpFile, path)
  }
  if (!ctx.dryRun && mcp === 'removed') files.push(mcpFile)

  // --- Awareness ---
  const m = markers(spec.awarenessStyle)
  const awareness = ctx.dryRun
    ? planRemoveBlock(awarenessFile, m.start, m.end)
    : removeBlock(awarenessFile, m.start, m.end)
  if (spec.awarenessFrontmatter && !ctx.dryRun && awareness === 'removed') {
    removeFrontmatter(awarenessFile, spec.awarenessFrontmatter, ctx.dryRun)
  }
  if (!ctx.dryRun && awareness === 'removed') files.push(awarenessFile)

  // --- /team command ---
  let command: Action = 'skipped'
  if (spec.command) {
    const commandFile = join(ctx.home, spec.command.file)
    command = ctx.dryRun ? planRemoveFile(commandFile) : removeFile(commandFile)
    if (!ctx.dryRun && command === 'removed') files.push(commandFile)
  }

  return {
    harness: spec.id,
    mcp,
    awareness,
    command,
    files,
    detail: ctx.dryRun ? 'dry-run: no files written' : undefined,
  }
}
