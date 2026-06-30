import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Channel } from '../channel/channel.js'

// ── types ─────────────────────────────────────────────────────────────────────

export interface BuildWorkerCommandOptions {
  agent: string
  role: string
  handle: string
  channel: string
}

export interface BuildWorkerCommandResult {
  command: string
  args: string[]
}

export interface SpawnWorkerOptions {
  channel: Channel
  repoRoot: string
  agent: string
  role: string
  task: string
  leadHandle?: string
  /** Injected for tests — defaults to node:child_process execFile */
  execFileImpl?: (
    cmd: string,
    args: string[],
    opts: { cwd?: string },
    cb: (err: Error | null) => void
  ) => void
  /** Injected for tests — defaults to node:child_process spawn */
  spawnImpl?: (
    command: string,
    args: string[],
    opts: {
      cwd: string
      stdio: ['ignore', 'pipe', 'pipe']
      detached: boolean
    }
  ) => { unref: () => void }
}

export interface SpawnWorkerResult {
  handle: string
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the CLI path. Prefer the TRAINTRACK_CLI env var; otherwise resolve
 * relative to this module file so it works both in-repo and when installed.
 */
function resolveCliPath(): string {
  if (process.env.TRAINTRACK_CLI) {
    return process.env.TRAINTRACK_CLI
  }
  // __dirname equivalent for ESM: resolve from this file up two levels then into dist/cli.js
  const thisFile = fileURLToPath(import.meta.url)
  return resolve(thisFile, '../../..', 'dist/cli.js')
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Build the command + args needed to launch a worker process.
 * Uses `process.execPath` (node binary) so the worker runs under the same
 * Node version as the current process.
 */
export function buildWorkerCommand(opts: BuildWorkerCommandOptions): BuildWorkerCommandResult {
  const { agent, role, handle, channel } = opts
  const cliPath = resolveCliPath()
  return {
    command: process.execPath,
    args: [cliPath, 'worker', '--agent', agent, '--role', role, '--handle', handle, '--channel', channel],
  }
}

/**
 * Spawn a worker in a fresh git worktree.
 *
 * Steps:
 * 1. Validate that repoRoot is a git repo (has .git).
 * 2. Mint a unique handle.
 * 3. Create a git worktree at <repoRoot>/.traintrack/worktrees/<handle> on branch traintrack/<handle>.
 * 4. Register the worker as a channel member.
 * 5. Send the seed task message to the worker handle.
 * 6. Spawn the worker process in the worktree directory (detached, unreffed).
 * 7. Return { handle }.
 */
export async function spawnWorker(opts: SpawnWorkerOptions): Promise<SpawnWorkerResult> {
  const {
    channel,
    repoRoot,
    agent,
    role,
    task,
    leadHandle,
    execFileImpl = (cmd, args, optsCb, cb) => nodeExecFile(cmd, args, optsCb, (err) => cb(err)),
    spawnImpl = (command, args, spawnOpts) => nodeSpawn(command, args, spawnOpts),
  } = opts

  // Guard: ensure repoRoot is a git repository
  if (!existsSync(join(repoRoot, '.git'))) {
    throw new Error(`spawnWorker: ${repoRoot} is not a git repo (no .git found)`)
  }

  // Mint a unique worker handle
  const handle = `worker_${crypto.randomUUID().slice(0, 8)}`

  // Determine worktree path
  const worktreePath = join(repoRoot, '.traintrack', 'worktrees', handle)

  // Create the git worktree
  await new Promise<void>((resolveP, rejectP) => {
    execFileImpl(
      'git',
      ['worktree', 'add', worktreePath, '-b', `traintrack/${handle}`],
      { cwd: repoRoot },
      (err) => {
        if (err) { rejectP(err) } else { resolveP() }
      }
    )
  })

  // Register the member in the channel
  channel.addMember({
    handle,
    agent,
    role,
    kind: 'headless',
    status: 'active',
    worktree: worktreePath,
  })

  // Send the seed task message
  channel.insertMessage({
    from: leadHandle ?? 'lead',
    to: handle,
    body: task,
    type: 'task',
  })

  // Build and launch the worker command (detached, unreffed — runs in background)
  const { command, args } = buildWorkerCommand({ agent, role, handle, channel: channel.dbPath })
  const child = spawnImpl(command, args, {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.unref()

  return { handle }
}
