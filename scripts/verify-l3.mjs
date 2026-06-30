#!/usr/bin/env node
// ─── traintrack L3 LIVE end-to-end verification ──────────────────────────────
// The proof (L3 = workers coordinating DIRECTLY with each other, no lead in the
// loop): TWO real codex workers are spawned into fresh git worktrees off a
// shared SQLite channel — an ORACLE (answers questions) and a RELAY (asks the
// oracle, then forwards the answer to the lead). The relay opens its message
// with `@oracle …`; the worker loop's resolvePeerAddress routes that straight to
// the oracle (worker→worker), the oracle answers back to the relay
// (worker→worker), and the relay then opens `@lead …` to hand the answer to the
// lead (worker→lead). We poll the channel and assert the full trail:
//   relay → oracle (the @oracle-routed question)
//   oracle → relay (the answer)
//   relay → lead   (body contains "4")
//
// This is intentionally NOT a unit test: it shells out to the actual codex
// binary and the built dist/ CLI. Run: `node scripts/verify-l3.mjs`.

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

/** Read every message row (oldest first) straight from the db for trail analysis. */
function allMessages(channelDbPath) {
  const db = new Database(channelDbPath, { readonly: true })
  const rows = db
    .prepare(
      `SELECT id, from_handle as "from", to_handle as "to", body, type, read, created_at as createdAt
       FROM messages ORDER BY id`
    )
    .all()
  db.close()
  return rows
}

async function main() {
  // 1. Build so dist/ is current.
  console.log('[verify-l3] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  // 2. Temp dir + git repo with an initial commit (so `git worktree add` works).
  const tmp = mkdtempSync(join(tmpdir(), 'traintrack-l3-'))
  console.log(`[verify-l3] temp repo: ${tmp}`)
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
  console.log(`[verify-l3] channel: ${channelDbPath}`)

  // 4b. Register the lead in the roster BEFORE spawning workers, so (a) every
  //     worker's onboarding briefing lists `lead` as a teammate and (b) the
  //     relay's `@lead …` reply resolves to a real member (resolvePeerAddress
  //     matches handle/role substrings — without this the @lead hop would fall
  //     back to the oracle).
  channel.addMember({
    handle: LEAD,
    agent: 'human',
    role: 'lead',
    kind: 'live',
    status: 'active',
    worktree: tmp,
  })

  // 5. Spawn the ORACLE first so it is registered before the relay's worker boots
  //    and snapshots the roster for its briefing (the briefing is built ONCE at
  //    worker startup — the relay must already know the oracle exists).
  console.log('[verify-l3] spawning real codex worker: oracle …')
  const { handle: oracleHandle } = await spawnWorker({
    channel,
    repoRoot: tmp,
    agent: 'codex',
    role: 'oracle',
    task:
      'You answer questions. When a teammate sends you a question, reply to them ' +
      'with a concise answer — just the answer, no preamble. For example, if a ' +
      'teammate asks "what is 2+2?", reply exactly "4".',
    leadHandle: LEAD,
  })
  console.log(`[verify-l3] oracle handle: ${oracleHandle} (role=oracle)`)

  // Give the oracle's worker a moment to self-register / settle before the relay
  // boots and snapshots the roster.
  await sleep(2000)

  console.log('[verify-l3] spawning real codex worker: relay …')
  const { handle: relayHandle } = await spawnWorker({
    channel,
    repoRoot: tmp,
    agent: 'codex',
    role: 'relay',
    task:
      'You are a relay between the lead and the "oracle" teammate. Do this in two ' +
      'steps.\n' +
      'STEP 1 — Right now, ask the oracle a question. Your reply for this turn must ' +
      'be EXACTLY this single line and nothing else:\n' +
      '@oracle what is 2+2?\n' +
      'STEP 2 — Later, the oracle will reply to you with the answer (a number). When ' +
      'that answer arrives, forward it to the lead: your reply for that turn must be ' +
      'EXACTLY one line of the form "@lead <answer>", e.g. "@lead 4". Do not add any ' +
      'other words.',
    leadHandle: LEAD,
  })
  console.log(`[verify-l3] relay handle: ${relayHandle} (role=relay)`)

  // 6. Assert BOTH workers are in the roster as headless members. spawnWorker
  //    pre-registers them; the worker loops also self-register on startup.
  const rosterOk = () => {
    const oracle = channel.getMember(oracleHandle)
    const relay = channel.getMember(relayHandle)
    return (
      Boolean(oracle) && oracle.kind === 'headless' &&
      Boolean(relay) && relay.kind === 'headless'
    )
  }

  // 7. Poll the channel up to TIMEOUT_MS and look for the full three-hop trail in
  //    the raw message rows:
  //      (a) relay → oracle   : the @oracle-routed question
  //      (b) oracle → relay   : the oracle's answer
  //      (c) relay → lead     : a reply whose body contains "4"
  //    We require them in causal order (id_a < id_b < id_c) so we are proving an
  //    actual conversation, not three unrelated rows.
  const deadline = Date.now() + TIMEOUT_MS
  let trail = null
  while (Date.now() < deadline) {
    const rows = allMessages(channelDbPath)

    const relayToOracle = rows.find(
      (m) => m.from === relayHandle && m.to === oracleHandle
    )
    const oracleToRelay = relayToOracle
      ? rows.find(
          (m) =>
            m.from === oracleHandle &&
            m.to === relayHandle &&
            m.id > relayToOracle.id
        )
      : null
    const relayToLead = oracleToRelay
      ? rows.find(
          (m) =>
            m.from === relayHandle &&
            m.to === LEAD &&
            m.body.includes('4') &&
            m.id > oracleToRelay.id
        )
      : null

    if (rosterOk() && relayToOracle && oracleToRelay && relayToLead) {
      trail = { relayToOracle, oracleToRelay, relayToLead }
      break
    }

    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    console.log(
      `[verify-l3] waiting … roster=${rosterOk()} rows=${rows.length} ` +
      `relay→oracle=${Boolean(relayToOracle)} oracle→relay=${Boolean(oracleToRelay)} ` +
      `relay→lead=${Boolean(relayToLead)} (${remaining}s left)`
    )
    await sleep(POLL_MS)
  }

  // 8. Assert + report.
  if (trail) {
    const fmt = (m) => `  [#${m.id}] ${m.from} → ${m.to}: ${JSON.stringify(m.body)}`
    console.log('')
    console.log('--- message trail (worker → worker → worker) ---')
    console.log(fmt(trail.relayToOracle))
    console.log(fmt(trail.oracleToRelay))
    console.log(fmt(trail.relayToLead))
    console.log('')
    console.log('L3 VERIFIED')
    channel.close()
    process.exit(0)
  }

  console.log('')
  console.log('L3 FAILED')
  console.log('(the relay→oracle→relay→lead trail did not complete before timeout)')
  console.log(dumpChannel(channel, channelDbPath))
  channel.close()
  process.exit(1)
}

// Make sure a stray hang surfaces as a failure rather than an indefinite wait.
const hardStop = setTimeout(() => {
  console.log('L3 FAILED (hard timeout reached before main() resolved)')
  process.exit(1)
}, TIMEOUT_MS + 90_000)
hardStop.unref()

main().catch((err) => {
  console.log('L3 FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
