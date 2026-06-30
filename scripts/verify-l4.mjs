#!/usr/bin/env node
// ─── traintrack L4 LIVE end-to-end verification ──────────────────────────────
// The proof (L4 = MULTI-ROUND delegation with session continuity): the lead
// drives TWO sequential rounds against the SAME real codex worker over the
// shared SQLite channel, collecting each round's reply separately.
//
//   Round 1: spawn a codex worker (role 'counter', seed task "reply with 1").
//            Poll getUnread('lead') until the worker's reply lands; assert "1".
//   Round 2: the lead inserts a NEW task to that SAME worker handle:
//            "reply with the previous number plus one". The worker loop is still
//            running (runWorker loops forever, draining its inbox each poll), so
//            it picks the task off its inbox, RESUMES its codex session (the
//            captured thread id is held in memory across cycles → "previous
//            number" = 1), and replies "2". Poll getUnread('lead') until it
//            lands; assert "2".
//
// This script ACTS as the lead, driving channel.insertMessage / spawnWorker /
// channel.getUnread directly — the exact tool calls a real claude lead would
// drive. It proves the multi-round mechanics end to end.
//
// This is intentionally NOT a unit test: it shells out to the actual codex
// binary and the built dist/ CLI. Run: `node scripts/verify-l4.mjs`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoDir = join(__dirname, '..')

const POLL_MS = 3000
const TIMEOUT_MS = 180_000
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

/**
 * Poll the lead's inbox until a reply from `workerHandle` whose body contains
 * `want` (a string) arrives, or the deadline passes. Returns the matching
 * Message or null. We also require the worker to still be a headless member.
 */
async function awaitReply({ channel, workerHandle, want, deadline, label }) {
  while (Date.now() < deadline) {
    const member = channel.getMember(workerHandle)
    const registered = Boolean(member) && member.kind === 'headless'

    const unread = channel.getUnread(LEAD)
    const reply = unread.find(
      (m) => m.from === workerHandle && m.body.includes(want)
    )
    if (registered && reply) {
      // Mark it read so a later round's poll never re-matches a stale reply.
      channel.markRead([reply.id])
      return reply
    }
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    console.log(
      `[verify-l4] ${label}: waiting … registered=${registered} ` +
      `unread(lead)=${unread.length} want=${JSON.stringify(want)} (${remaining}s left)`
    )
    await sleep(POLL_MS)
  }
  return null
}

async function main() {
  // 1. Build so dist/ is current.
  console.log('[verify-l4] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  // 2. Temp dir + git repo with an initial commit (so `git worktree add` works).
  const tmp = mkdtempSync(join(tmpdir(), 'traintrack-l4-'))
  console.log(`[verify-l4] temp repo: ${tmp}`)
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
  console.log(`[verify-l4] channel: ${channelDbPath}`)

  // 4b. Register the lead in the roster BEFORE spawning the worker, so the
  //     worker's onboarding briefing lists `lead` as a teammate (matches the
  //     L3 pattern; keeps the worker's notion of who it talks to consistent).
  channel.addMember({
    handle: LEAD,
    agent: 'human',
    role: 'lead',
    kind: 'live',
    status: 'active',
    worktree: tmp,
  })

  const deadline = Date.now() + TIMEOUT_MS

  // ── ROUND 1 ───────────────────────────────────────────────────────────────
  // Spawn a real codex worker. The seed task IS round 1's instruction; the lead
  // is the seed message's sender, so the worker's reply comes back to `lead`.
  console.log('[verify-l4] ROUND 1 — spawning real codex worker (role=counter) …')
  const { handle } = await spawnWorker({
    channel,
    repoRoot: tmp,
    agent: 'codex',
    role: 'counter',
    task: 'Reply with the number 1 and nothing else.',
    leadHandle: LEAD,
  })
  console.log(`[verify-l4] worker handle: ${handle}`)

  const round1 = await awaitReply({
    channel,
    workerHandle: handle,
    want: '1',
    deadline,
    label: 'round1',
  })
  if (!round1) {
    console.log('')
    console.log('L4 FAILED')
    console.log('(round 1: no reply containing "1" from the worker before timeout)')
    console.log(dumpChannel(channel, channelDbPath))
    channel.close()
    process.exit(1)
  }
  console.log(
    `[verify-l4] ROUND 1 reply from ${round1.from} → ${round1.to}: ${JSON.stringify(round1.body)}`
  )

  // ── ROUND 2 ───────────────────────────────────────────────────────────────
  // The lead delegates a SECOND task to the SAME worker handle. The worker loop
  // is still alive (runWorker loops), so it drains this task on its next poll,
  // resumes its codex session (previous number = 1), and replies "2".
  console.log('[verify-l4] ROUND 2 — delegating follow-up task to the SAME worker …')
  channel.insertMessage({
    to: handle,
    from: LEAD,
    body: 'Now reply with the previous number plus one — just the number.',
    type: 'task',
  })

  const round2 = await awaitReply({
    channel,
    workerHandle: handle,
    want: '2',
    deadline,
    label: 'round2',
  })
  if (!round2) {
    console.log('')
    console.log('L4 FAILED')
    console.log('(round 2: no reply containing "2" from the worker before timeout)')
    console.log(dumpChannel(channel, channelDbPath))
    channel.close()
    process.exit(1)
  }
  console.log(
    `[verify-l4] ROUND 2 reply from ${round2.from} → ${round2.to}: ${JSON.stringify(round2.body)}`
  )

  // ── REPORT ──────────────────────────────────────────────────────────────────
  console.log('')
  console.log('--- multi-round delegation (lead ↔ one worker, two rounds) ---')
  console.log(`  ROUND 1: ${handle} → ${LEAD}: ${JSON.stringify(round1.body)}  (asserted contains "1")`)
  console.log(`  ROUND 2: ${handle} → ${LEAD}: ${JSON.stringify(round2.body)}  (asserted contains "2")`)
  console.log('')
  console.log('L4 VERIFIED')
  channel.close()
  process.exit(0)
}

// Make sure a stray hang surfaces as a failure rather than an indefinite wait.
const hardStop = setTimeout(() => {
  console.log('L4 FAILED (hard timeout reached before main() resolved)')
  process.exit(1)
}, TIMEOUT_MS + 90_000)
hardStop.unref()

main().catch((err) => {
  console.log('L4 FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
