#!/usr/bin/env node
// ─── traintrack L5 LIVE end-to-end verification ──────────────────────────────
// The proof (L5 = a REAL agent the lead never spawned JOINS a running team and
// participates). This is the discipline that distinguishes a real multi-agent
// coordination plugin from a demo: a session started out-of-band — via the
// `traintrack join` CLI, the way a human at another terminal would attach — registers
// itself, is seen by the lead AND by the already-running worker, receives a
// delegated task, and replies. All over the shared SQLite channel, with real
// codex agents.
//
//   ROUND A (a worker already running): spawn a real codex worker (role
//     'builder', seed task "reply READY"). Poll getUnread('lead') until its
//     reply lands; assert it contains READY. Capture builderHandle. The team is
//     now LIVE with one running worker.
//
//   ROUND B (a late LIVE joiner — the L5 proof): launch `traintrack join` as a
//     DETACHED child (handle 'reviewer', role 'reviewer', agent codex). This is a
//     session the lead did NOT spawn. Poll until channel.getMember('reviewer')
//     exists with kind==='live'. Assert channel.listMembers() now contains BOTH
//     builderHandle AND reviewer — print the roster.
//
//   ROUND C (the joiner receives + replies): the lead inserts a task to
//     'reviewer' ("reply APPROVED"). The join loop drains its inbox (~3s poll),
//     runs a real codex turn, and replies. Poll getUnread('lead') until a reply
//     from reviewer contains APPROVED.
//
//   ROUND D (roster-refresh — INFORMATIONAL, never gating): the lead asks the
//     already-running builder whether one of its teammates is a reviewer. The
//     worker rebuilds its briefing from the CURRENT roster every cycle, so after
//     the reviewer joined the briefing now lists it. Poll ~60s for any reply;
//     PRINT it + whether it says yes. Never exits non-zero for this round —
//     codex phrasing is non-deterministic; it is evidence, not a gate.
//
// This script ACTS as the lead, driving channel.insertMessage / spawnWorker /
// channel.getUnread directly. It shells out to the actual codex binary and the
// built dist/ CLI. Run: `node scripts/verify-l5.mjs`.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoDir = join(__dirname, '..')

const POLL_MS = 3000
const TIMEOUT_MS = 240_000
const LEAD = 'lead'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Tear down every process this run started so no codex/join lingers after exit.
 * 1. SIGKILL the detached join child's whole process group (it's a group leader
 *    because we spawned it detached:true).
 * 2. Belt-and-braces: `pkill -f <channelDbPath>` reaps anything still bound to
 *    THIS run's temp channel db — the join child AND the detached builder worker
 *    that spawnWorker launched (we never got that child's handle), plus any codex
 *    subprocess. The path is unique per run, so this can't touch other runs.
 * Called synchronously from `finally`, so it completes before process.exit.
 */
function cleanup(joinChild, channelDbPath) {
  if (joinChild && joinChild.pid) {
    try { process.kill(-joinChild.pid, 'SIGKILL') } catch {}
    try { joinChild.kill('SIGKILL') } catch {}
  }
  if (channelDbPath) {
    try {
      execFileSync('pkill', ['-9', '-f', channelDbPath], { stdio: 'ignore' })
    } catch {}
  }
}

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
 * `want` (case-insensitive) arrives, or the deadline passes. Returns the matching
 * Message or null. `wantKind` (optional) additionally requires the sender to be a
 * registered member of that kind — a headless worker vs. a live joiner.
 */
async function awaitReply({ channel, workerHandle, want, wantKind, deadline, label }) {
  const needle = want.toLowerCase()
  while (Date.now() < deadline) {
    const member = channel.getMember(workerHandle)
    const registered = Boolean(member) && (!wantKind || member.kind === wantKind)

    const unread = channel.getUnread(LEAD)
    const reply = unread.find(
      (m) => m.from === workerHandle && m.body.toLowerCase().includes(needle)
    )
    if (registered && reply) {
      // Mark it read so a later round's poll never re-matches a stale reply.
      channel.markRead([reply.id])
      return reply
    }
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    console.log(
      `[verify-l5] ${label}: waiting … registered=${registered} ` +
      `unread(lead)=${unread.length} want=${JSON.stringify(want)} (${remaining}s left)`
    )
    await sleep(POLL_MS)
  }
  return null
}

async function main() {
  // 1. Build so dist/ is current.
  console.log('[verify-l5] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  // 2. Temp dir + git repo with an initial commit (so `git worktree add` works).
  const tmp = mkdtempSync(join(tmpdir(), 'traintrack-l5-'))
  console.log(`[verify-l5] temp repo: ${tmp}`)
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
  console.log(`[verify-l5] channel: ${channelDbPath}`)

  // 4b. Register the lead in the roster BEFORE spawning the worker, so every
  //     member's onboarding briefing lists `lead` as a teammate.
  channel.addMember({
    handle: LEAD,
    agent: 'human',
    role: 'lead',
    kind: 'live',
    status: 'active',
    worktree: tmp,
  })

  const deadline = Date.now() + TIMEOUT_MS

  // The join child handle is declared out here so `finally` can always kill it.
  let joinChild = null

  try {
    // ── ROUND A — a worker is already running ────────────────────────────────
    console.log('[verify-l5] ROUND A — spawning real codex worker (role=builder) …')
    const { handle: builderHandle } = await spawnWorker({
      channel,
      repoRoot: tmp,
      agent: 'codex',
      role: 'builder',
      task: 'Reply with the word READY and nothing else.',
      leadHandle: LEAD,
    })
    console.log(`[verify-l5] builder handle: ${builderHandle}`)

    const roundA = await awaitReply({
      channel,
      workerHandle: builderHandle,
      want: 'READY',
      wantKind: 'headless',
      deadline,
      label: 'roundA',
    })
    if (!roundA) {
      console.log('')
      console.log('L5 FAILED')
      console.log('(round A: no reply containing "READY" from the builder before timeout)')
      console.log(dumpChannel(channel, channelDbPath))
      return 1
    }
    console.log(
      `[verify-l5] ROUND A reply from ${roundA.from} → ${roundA.to}: ${JSON.stringify(roundA.body)}`
    )

    // ── ROUND B — a late LIVE joiner (the L5 proof) ──────────────────────────
    // Launch `traintrack join` exactly as a human at another terminal would: a session
    // the lead did NOT spawn, attaching to the SAME channel db. Detached + unref'd
    // so it lives independently; the `finally` kills its process group.
    console.log('[verify-l5] ROUND B — launching `traintrack join` as a detached child (handle=reviewer) …')
    joinChild = spawn(
      process.execPath,
      [
        join(repoDir, 'dist/cli.js'),
        'join',
        '--handle', 'reviewer',
        '--role', 'reviewer',
        '--agent', 'codex',
        '--channel', channelDbPath,
      ],
      { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    )
    // Surface the join child's stderr/stdout (prefixed) so failures are debuggable.
    joinChild.stdout?.on('data', (d) =>
      process.stdout.write(`[join:out] ${d.toString().trimEnd()}\n`)
    )
    joinChild.stderr?.on('data', (d) =>
      process.stdout.write(`[join:err] ${d.toString().trimEnd()}\n`)
    )
    joinChild.unref()

    // Poll until the joiner self-registers as a live member.
    let reviewer = null
    while (Date.now() < deadline) {
      reviewer = channel.getMember('reviewer')
      if (reviewer && reviewer.kind === 'live') {
        break
      }
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
      console.log(
        `[verify-l5] roundB: waiting for reviewer to join … ` +
        `present=${Boolean(reviewer)} kind=${reviewer ? reviewer.kind : '-'} (${remaining}s left)`
      )
      await sleep(POLL_MS)
    }
    if (!reviewer || reviewer.kind !== 'live') {
      console.log('')
      console.log('L5 FAILED')
      console.log('(round B: `traintrack join` did not register reviewer as a live member before timeout)')
      console.log(dumpChannel(channel, channelDbPath))
      return 1
    }

    // Assert the lead now sees BOTH the original worker and the late joiner.
    const members = channel.listMembers()
    const handles = members.map((m) => m.handle)
    const hasBuilder = handles.includes(builderHandle)
    const hasReviewer = handles.includes('reviewer')
    console.log('[verify-l5] ROUND B roster (channel.listMembers()):')
    for (const m of members) {
      console.log(`  - ${m.handle} (agent=${m.agent}, role=${m.role}, kind=${m.kind}, status=${m.status})`)
    }
    if (!hasBuilder || !hasReviewer) {
      console.log('')
      console.log('L5 FAILED')
      console.log(
        `(round B: roster missing a member — hasBuilder=${hasBuilder} hasReviewer=${hasReviewer})`
      )
      console.log(dumpChannel(channel, channelDbPath))
      return 1
    }
    console.log(`[verify-l5] ROUND B verified — late joiner "reviewer" is on the team (kind=live).`)

    // ── ROUND C — the joiner receives + replies ──────────────────────────────
    console.log('[verify-l5] ROUND C — delegating a task to the late joiner (reviewer) …')
    channel.insertMessage({
      to: 'reviewer',
      from: LEAD,
      body: 'Reply with the word APPROVED and nothing else.',
      type: 'task',
    })

    const roundC = await awaitReply({
      channel,
      workerHandle: 'reviewer',
      want: 'APPROVED',
      wantKind: 'live',
      deadline,
      label: 'roundC',
    })
    if (!roundC) {
      console.log('')
      console.log('L5 FAILED')
      console.log('(round C: no reply containing "APPROVED" from the joiner before timeout)')
      console.log(dumpChannel(channel, channelDbPath))
      return 1
    }
    console.log(
      `[verify-l5] ROUND C reply from ${roundC.from} → ${roundC.to}: ${JSON.stringify(roundC.body)}`
    )

    // ── ROUND D — roster-refresh (INFORMATIONAL, never gating) ───────────────
    // The already-running builder rebuilds its briefing from the live roster each
    // cycle, so it should now know a reviewer is on the team. Poll up to ~60s for
    // any reply and PRINT it as evidence; this round NEVER fails the run.
    console.log('[verify-l5] ROUND D (informational) — asking the builder if a teammate is a reviewer …')
    channel.insertMessage({
      to: builderHandle,
      from: LEAD,
      body: 'Look at your teammates. Is one of them a reviewer? Answer with just YES or NO.',
      type: 'task',
    })
    const roundDDeadline = Math.min(deadline, Date.now() + 60_000)
    let roundD = null
    while (Date.now() < roundDDeadline) {
      const unread = channel.getUnread(LEAD)
      roundD = unread.find((m) => m.from === builderHandle)
      if (roundD) {
        channel.markRead([roundD.id])
        break
      }
      const remaining = Math.max(0, Math.round((roundDDeadline - Date.now()) / 1000))
      console.log(`[verify-l5] roundD: waiting for builder reply … (${remaining}s left, informational)`)
      await sleep(POLL_MS)
    }
    let roundDSummary
    if (roundD) {
      const saysYes = /\byes\b/i.test(roundD.body)
      console.log(
        `[verify-l5] ROUND D reply from ${roundD.from}: ${JSON.stringify(roundD.body)} ` +
        `(containsYes=${saysYes})`
      )
      roundDSummary = `${JSON.stringify(roundD.body)} (containsYes=${saysYes})`
    } else {
      console.log('[verify-l5] ROUND D — no reply within ~60s (inconclusive; not gating).')
      roundDSummary = '(no reply within ~60s — inconclusive, not gating)'
    }

    // ── REPORT ────────────────────────────────────────────────────────────────
    console.log('')
    console.log('--- L5: a real agent joined a running team ---')
    console.log('  final roster (channel.listMembers()):')
    for (const m of channel.listMembers()) {
      console.log(`    - ${m.handle} (agent=${m.agent}, role=${m.role}, kind=${m.kind})`)
    }
    console.log('')
    console.log(`  ROUND A (worker already running): ${builderHandle} → ${LEAD}: ${JSON.stringify(roundA.body)}  (asserted contains "READY")`)
    console.log(`  ROUND B (late LIVE joiner):        reviewer registered kind=live; roster has both ${builderHandle} and reviewer`)
    console.log(`  ROUND C (joiner receives+replies): reviewer → ${LEAD}: ${JSON.stringify(roundC.body)}  (asserted contains "APPROVED")`)
    console.log(`  ROUND D (roster-refresh, info):    builder → ${LEAD}: ${roundDSummary}`)
    console.log('')
    console.log('L5 VERIFIED')
    return 0
  } finally {
    // Tear down BEFORE the process exits — `main()` returns an exit code instead
    // of calling process.exit() inside the try, because process.exit() halts the
    // event loop immediately and would skip this async finally (leaking codex).
    cleanup(joinChild, channelDbPath)
    try { channel.close() } catch {}
  }
}

// Make sure a stray hang surfaces as a failure rather than an indefinite wait.
const hardStop = setTimeout(() => {
  console.log('L5 FAILED (hard timeout reached before main() resolved)')
  process.exit(1)
}, TIMEOUT_MS + 90_000)
hardStop.unref()

main()
  .then((code) => {
    // cleanup already ran in main()'s finally; exit now that the loop is idle.
    process.exit(code)
  })
  .catch((err) => {
    console.log('L5 FAILED')
    console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  })
