#!/usr/bin/env node
// ─── traintrack L1 LIVE end-to-end verification ──────────────────────────────
// The proof: a REAL codex worker is spawned in a fresh git worktree, drains its
// seed task off the shared SQLite channel, runs a headless codex turn, and posts
// its reply back to the lead — all with zero human input. We poll the lead's
// inbox until the PONG reply lands.
//
// This is intentionally NOT a unit test: it shells out to the actual codex
// binary and the built dist/ CLI. Run: `node scripts/verify-l1.mjs`.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoDir = join(__dirname, '..')

const POLL_MS = 2000
const TIMEOUT_MS = 150_000
const LEAD = 'lead'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Dump the channel's members + raw messages table for failure diagnostics. */
function dumpChannel(channel, channelDbPath) {
  const out = []
  out.push('--- members (channel.listMembers()) ---')
  try {
    for (const m of channel.listMembers()) {
      out.push(JSON.stringify(m))
    }
  } catch (err) {
    out.push(`(listMembers failed: ${err instanceof Error ? err.message : String(err)})`)
  }
  out.push('--- messages (raw rows) ---')
  try {
    const db = new Database(channelDbPath, { readonly: true })
    const rows = db.prepare('SELECT * FROM messages ORDER BY id').all()
    for (const r of rows) {
      out.push(JSON.stringify(r))
    }
    db.close()
  } catch (err) {
    out.push(`(messages dump failed: ${err instanceof Error ? err.message : String(err)})`)
  }
  return out.join('\n')
}

async function main() {
  // 1. Build so dist/ is current.
  console.log('[verify-l1] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  // 2. Temp dir + git repo with an initial commit (so `git worktree add` works).
  const tmp = mkdtempSync(join(tmpdir(), 'traintrack-l1-'))
  console.log(`[verify-l1] temp repo: ${tmp}`)
  const git = (args) =>
    execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git([
    '-c', 'user.email=a@b.c',
    '-c', 'user.name=x',
    'commit', '--allow-empty', '-m', 'init',
  ])

  // 3. Import the BUILT modules from dist/.
  const { Channel } = await import(join(repoDir, 'dist/channel/channel.js'))
  const { spawnWorker } = await import(join(repoDir, 'dist/spawn/spawn.js'))

  // 4. Open the channel.
  const channelDbPath = join(tmp, '.traintrack', 'channel.db')
  const channel = new Channel(channelDbPath)
  console.log(`[verify-l1] channel: ${channelDbPath}`)

  // 5. Spawn a REAL codex worker.
  console.log('[verify-l1] spawning real codex worker …')
  const { handle } = await spawnWorker({
    channel,
    repoRoot: tmp,
    agent: 'codex',
    role: 'pinger',
    task: 'Reply with exactly the word PONG and nothing else.',
    leadHandle: LEAD,
  })
  console.log(`[verify-l1] worker handle: ${handle}`)

  // 6. Poll the lead's inbox up to TIMEOUT_MS.
  const deadline = Date.now() + TIMEOUT_MS
  let reply = null
  let registered = false
  while (Date.now() < deadline) {
    // Worker self-registers (kind 'headless') on startup. spawnWorker also pre-
    // registers it; we require the member to exist and be headless.
    const member = channel.getMember(handle)
    registered = Boolean(member) && member.kind === 'headless'

    const unread = channel.getUnread(LEAD)
    const fromWorker = unread.find((m) => m.from === handle && m.body.includes('PONG'))
    if (registered && fromWorker) {
      reply = fromWorker
      break
    }
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    console.log(
      `[verify-l1] waiting … registered=${registered} unread(lead)=${unread.length} (${remaining}s left)`
    )
    await sleep(POLL_MS)
  }

  // 7. Assert + report.
  if (reply && registered) {
    console.log('')
    console.log(`reply from ${reply.from} → ${reply.to}: ${JSON.stringify(reply.body)}`)
    console.log('L1 VERIFIED')
    channel.close()
    process.exit(0)
  }

  console.log('')
  console.log('L1 FAILED')
  if (!registered) {
    console.log(`(worker ${handle} never registered as a headless member)`)
  }
  console.log(dumpChannel(channel, channelDbPath))
  channel.close()
  process.exit(1)
}

// Make sure a stray hang surfaces as a failure rather than an indefinite wait.
const hardStop = setTimeout(() => {
  console.log('L1 FAILED (hard timeout reached before main() resolved)')
  process.exit(1)
}, TIMEOUT_MS + 60_000)
hardStop.unref()

main().catch((err) => {
  console.log('L1 FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
