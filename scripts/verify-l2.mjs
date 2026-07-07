#!/usr/bin/env node
// ─── traintrack L2 LIVE end-to-end verification ──────────────────────────────
// The proof (L2 = a multi-worker roster + lead→worker delegation): TWO real
// codex workers are spawned into fresh git worktrees off a shared SQLite
// channel. Both self-register in the roster (kind 'headless'). The lead then
// delegates a 'reply now' task to the PINGER worker; that worker drains its
// inbox (seed instruction + the delegate task), runs a headless codex turn, and
// posts its reply back to the lead. We poll the lead's inbox until the PONG
// reply from the pinger lands.
//
// This is intentionally NOT a unit test: it shells out to the actual codex
// binary and the built dist/ CLI. Run: `node scripts/verify-l2.mjs`.

import { execFileSync } from 'node:child_process'
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
  console.log('[verify-l2] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  // 2. Temp dir + git repo with an initial commit (so `git worktree add` works).
  const tmp = mkdtempSync(join(tmpdir(), 'traintrack-l2-'))
  console.log(`[verify-l2] temp repo: ${tmp}`)
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
  console.log(`[verify-l2] channel: ${channelDbPath}`)

  // 5. Spawn TWO real codex workers: a pinger (PONG) and an echoer (ECHO).
  console.log('[verify-l2] spawning real codex worker: pinger …')
  const { handle: pingerHandle } = await spawnWorker({
    channel,
    repoRoot: tmp,
    agent: 'codex',
    role: 'pinger',
    task: 'When asked, reply with the word PONG.',
    leadHandle: LEAD,
  })
  console.log(`[verify-l2] pinger handle: ${pingerHandle}`)

  console.log('[verify-l2] spawning real codex worker: echoer …')
  const { handle: echoerHandle } = await spawnWorker({
    channel,
    repoRoot: tmp,
    agent: 'codex',
    role: 'echoer',
    task: 'When asked, reply with the word ECHO.',
    leadHandle: LEAD,
  })
  console.log(`[verify-l2] echoer handle: ${echoerHandle}`)

  // 6. Assert BOTH workers are in the roster as headless members. spawnWorker
  //    pre-registers them; the worker loops also self-register on startup.
  const rosterOk = () => {
    const pinger = channel.getMember(pingerHandle)
    const echoer = channel.getMember(echoerHandle)
    return (
      Boolean(pinger) && pinger.kind === 'headless' &&
      Boolean(echoer) && echoer.kind === 'headless'
    )
  }
  if (!rosterOk()) {
    console.log('')
    console.log('L2 FAILED')
    console.log('(roster does not show both workers as headless members)')
    console.log(dumpChannel(channel, channelDbPath))
    channel.close()
    process.exit(1)
  }
  console.log('[verify-l2] roster OK — both pinger and echoer are headless members')

  // 7. Lead delegates a task to the PINGER worker. The pinger's inbox now holds
  //    its seed instruction ("When asked, reply with PONG") + this trigger.
  channel.insertMessage({
    to: pingerHandle,
    from: LEAD,
    body: 'reply now',
    type: 'task',
  })
  console.log(`[verify-l2] delegated 'reply now' task → ${pingerHandle}`)

  // 8. Poll the lead's inbox up to TIMEOUT_MS for the pinger's PONG reply.
  const deadline = Date.now() + TIMEOUT_MS
  let reply = null
  while (Date.now() < deadline) {
    const unread = channel.getUnread(LEAD)
    const fromPinger = unread.find(
      (m) => m.from === pingerHandle && m.body.toUpperCase().includes('PONG')
    )
    if (rosterOk() && fromPinger) {
      reply = fromPinger
      break
    }
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    console.log(
      `[verify-l2] waiting … roster=${rosterOk()} unread(lead)=${unread.length} (${remaining}s left)`
    )
    await sleep(POLL_MS)
  }

  // 9. Assert + report.
  if (reply && rosterOk()) {
    console.log('')
    console.log('--- roster (channel.listMembers()) ---')
    for (const m of channel.listMembers()) {
      console.log(JSON.stringify(m))
    }
    console.log('')
    console.log(`reply from ${reply.from} → ${reply.to}: ${JSON.stringify(reply.body)}`)
    console.log('L2 VERIFIED')
    channel.close()
    process.exit(0)
  }

  console.log('')
  console.log('L2 FAILED')
  console.log('(no PONG reply from the pinger arrived in the lead inbox before timeout)')
  console.log(dumpChannel(channel, channelDbPath))
  channel.close()
  process.exit(1)
}

// Make sure a stray hang surfaces as a failure rather than an indefinite wait.
const hardStop = setTimeout(() => {
  console.log('L2 FAILED (hard timeout reached before main() resolved)')
  process.exit(1)
}, TIMEOUT_MS + 60_000)
hardStop.unref()

main().catch((err) => {
  console.log('L2 FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
