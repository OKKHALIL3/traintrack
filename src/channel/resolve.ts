// Resolve WHICH channel db a traintrack process should attach to. The key design
// point: default to the GIT REPO ROOT (not cwd) so every session opened anywhere
// inside a project auto-lands in the SAME team — no flags, no path fiddling.
//
// Order of precedence:
//   1. explicit `channel` (a --channel path)
//   2. `room` → a shared cross-project room at ~/.traintrack/rooms/<room>.db
//   3. TRAINTRACK_CHANNEL env
//   4. git repo root → <root>/.traintrack/channel.db   (the common case)
//   5. cwd → <cwd>/.traintrack/channel.db              (non-git fallback)
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type ResolveOpts = {
  channel?: string
  room?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Test seam: override the git-root lookup. */
  gitRootImpl?: (cwd: string) => string | null
}

/** The git repo root for `cwd`, or null if not inside a work tree. */
export function gitRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toString().trim() || null
  } catch {
    return null
  }
}

/** Resolve the channel db path per the precedence above. */
export function resolveChannelPath(opts: ResolveOpts = {}): string {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  if (opts.channel) return opts.channel
  if (opts.room) return join(homedir(), '.traintrack', 'rooms', `${sanitizeRoom(opts.room)}.db`)
  if (env['TRAINTRACK_CHANNEL']) return env['TRAINTRACK_CHANNEL'] as string
  const root = (opts.gitRootImpl ?? gitRoot)(cwd)
  return join(root ?? cwd, '.traintrack', 'channel.db')
}

/** Room names become a file name; keep them filesystem-safe. */
function sanitizeRoom(room: string): string {
  return room.replace(/[^a-zA-Z0-9_-]/g, '_') || 'global'
}
