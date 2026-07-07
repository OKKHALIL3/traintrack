// Why: build the exact non-interactive argv for one headless agent turn. claude
// runs `--print --output-format stream-json` (the structured stream the
// event-parser consumes); codex runs `exec [resume <id>] --json`. Centralizing
// argv here keeps the codex landmines in one audited place: ALWAYS pass
// --dangerously-bypass-approvals-and-sandbox (else unattended MCP tool calls
// auto-cancel, openai/codex #24135) and resume by the CAPTURED thread id, never
// --last (which is global and cross-wires parallel codex workers).

import type { HeadlessProvider } from './event-parser.js'

// Local helpers: resolve the CLI binary from env or fall back to PATH.
function resolveClaudeCommand(): string {
  return process.env.TRAINTRACK_CLAUDE_BIN ?? 'claude'
}

function resolveCodexCommand(): string {
  return process.env.TRAINTRACK_CODEX_BIN ?? 'codex'
}

function resolveCursorCommand(): string {
  return process.env.TRAINTRACK_CURSOR_BIN ?? 'cursor-agent'
}

function resolveOpencodeCommand(): string {
  return process.env.TRAINTRACK_OPENCODE_BIN ?? 'opencode'
}

export type HeadlessArgv = { command: string; args: string[] }

export type BuildHeadlessArgvInput = {
  agent: HeadlessProvider
  prompt: string
  model?: string
  /** Session id captured from a prior turn → resume that session instead of starting fresh. */
  resumeSessionId?: string
  /** codex only: keep the sandbox-bypass flag (default true — required for unattended turns). */
  codexBypassSandbox?: boolean
  /** Test seams: inject the resolved binary so tests don't depend on PATH resolution. */
  claudeCommand?: string
  codexCommand?: string
  cursorCommand?: string
  opencodeCommand?: string
}

// claude print mode + the JSON event stream (stream-json requires --verbose).
const CLAUDE_STREAM_FLAGS = ['--print', '--output-format', 'stream-json', '--verbose']

/** Build {command, args} for a single headless turn. The prompt is always the trailing positional. */
export function buildHeadlessArgv(input: BuildHeadlessArgvInput): HeadlessArgv {
  const { agent, prompt, model, resumeSessionId } = input

  if (agent === 'claude') {
    const command = input.claudeCommand ?? resolveClaudeCommand()
    const args = [...CLAUDE_STREAM_FLAGS]
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    }
    if (model) {
      args.push('--model', model)
    }
    args.push(prompt)
    return { command, args }
  }

  if (agent === 'cursor') {
    // cursor-agent headless (alpha): one-shot print, plain-text reply, unattended
    // (--force --trust so it never waits on an approval prompt).
    const command = input.cursorCommand ?? resolveCursorCommand()
    const args = ['-p', '--output-format', 'text', '--force', '--trust']
    if (model) {
      args.push('--model', model)
    }
    args.push(prompt)
    return { command, args }
  }

  if (agent === 'opencode') {
    // opencode headless (alpha): `opencode run <prompt>` prints the reply on stdout.
    const command = input.opencodeCommand ?? resolveOpencodeCommand()
    const args = ['run']
    if (model) {
      args.push('--model', model)
    }
    args.push(prompt)
    return { command, args }
  }

  // codex
  const command = input.codexCommand ?? resolveCodexCommand()
  const args = ['exec']
  if (resumeSessionId) {
    args.push('resume', resumeSessionId)
  }
  args.push('--json')
  if (input.codexBypassSandbox !== false) {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  }
  if (model) {
    args.push('-m', model)
  }
  args.push(prompt)
  return { command, args }
}
