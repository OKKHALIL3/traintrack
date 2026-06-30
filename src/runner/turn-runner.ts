// Why: run ONE headless agent turn as a fresh child process and resolve its
// structured result. This is the reliable replacement for PTY injection — no
// idle-guessing: we spawn, stream stdout line-by-line through the event-parser,
// and the provider's own turn-end event (claude `result` / codex `turn.completed`)
// is the in-band ACK. Ported from the rust conductor's run_process/run_turn.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  createTurnParseState,
  reduceLine,
  finalizeTurn,
  type HeadlessProvider,
  type HeadlessTurnResult
} from './event-parser.js'

// Local passthrough: Windows packaging is out of scope for traintrack v1 (macOS/Linux only).
function getSpawnArgsForWindows(
  cmd: string,
  args: string[]
): { spawnCmd: string; spawnArgs: string[] } {
  return { spawnCmd: cmd, spawnArgs: args }
}

export type RunHeadlessTurnInput = {
  provider: HeadlessProvider
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Forward live assistant text as it streams (UI only; never journaled). */
  onDelta?: (delta: string) => void
  /** Test seam: inject a spawn implementation. */
  spawnImpl?: typeof spawn
}

export type HeadlessTurnOutcome = HeadlessTurnResult & {
  exitCode: number | null
  stderr: string
}

const MAX_STDERR_CHARS = 64_000

/** Spawn a headless turn, stream-parse its stdout, and resolve the turn result + exit code. */
export function runHeadlessTurn(input: RunHeadlessTurnInput): Promise<HeadlessTurnOutcome> {
  const { provider, command, args, cwd, env, onDelta } = input
  const spawnImpl = input.spawnImpl ?? spawn
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnImpl(spawnCmd, spawnArgs, {
        // Why: stdin MUST be ignored (= /dev/null). codex exec HANGS FOREVER on a
        // non-TTY stdin pipe waiting for input (openai/codex #20919); the rust
        // conductor used Stdio::null for exactly this.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd,
        env: env ?? process.env
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const state = createTurnParseState(provider)
    let stdoutBuf = ''
    let stderr = ''
    let settled = false

    const consumeLine = (line: string): void => {
      const { delta } = reduceLine(state, line)
      if (delta && onDelta) {
        onDelta(delta)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      let nl = stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        consumeLine(stdoutBuf.slice(0, nl))
        stdoutBuf = stdoutBuf.slice(nl + 1)
        nl = stdoutBuf.indexOf('\n')
      }
    })

    // Why: drain stderr concurrently so a chatty stderr can't fill the OS pipe
    // buffer and deadlock the child (the rust run_process deadlock fix).
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_STDERR_CHARS) {
        stderr = stderr.slice(-MAX_STDERR_CHARS)
      }
    })

    child.on('error', (err) => {
      if (settled) {
        return
      }
      settled = true
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      // Flush a trailing partial line that had no terminating newline.
      if (stdoutBuf.trim()) {
        consumeLine(stdoutBuf)
      }
      resolve({ ...finalizeTurn(state), exitCode: code, stderr })
    })
  })
}
