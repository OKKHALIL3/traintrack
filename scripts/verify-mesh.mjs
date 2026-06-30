#!/usr/bin/env node
// ─── traintrack MESH live verification (M1) ─────────────────────────────────
// Proves the "they auto-see each other" core: two REAL MCP-server sessions
// started in DIFFERENT SUBDIRECTORIES of one git repo both resolve the same
// repo-root channel, auto-register as live members, can message each other (with
// the unread nudge surfacing it), and flip to offline when their session ends.
// No path fiddling, no explicit join. Run: `node scripts/verify-mesh.mjs`.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const repoDir = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Minimal JSON-RPC-over-stdio client for one MCP child. */
function makeClient(child) {
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  })
  let id = 0
  return (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId)
          reject(new Error(`rpc ${method} timed out`))
        }
      }, 15000)
    })
}

function startSession(cwd, handle, agent) {
  const child = spawn(process.execPath, [join(repoDir, 'dist/mcp-server.js')], {
    cwd,
    env: { ...process.env, TRAINTRACK_HANDLE: handle, TRAINTRACK_AGENT: agent, TRAINTRACK_ROLE: 'lead' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stderr.write(`[${handle}:err] ${d}`))
  return { child, rpc: makeClient(child) }
}

function members(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare('SELECT handle,agent,kind,status FROM members ORDER BY rowid').all()
  db.close()
  return rows
}

function fail(msg, dbPath) {
  console.log('\nMESH FAILED')
  console.log(msg)
  try {
    console.log('members:', JSON.stringify(members(dbPath)))
  } catch {}
  process.exit(1)
}

async function main() {
  console.log('[verify-mesh] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  const repo = mkdtempSync(join(tmpdir(), 'traintrack-mesh-'))
  const git = (a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '--allow-empty', '-m', 'init'])
  const subA = join(repo, 'frontend')
  const subB = join(repo, 'backend', 'api')
  mkdirSync(subA, { recursive: true })
  mkdirSync(subB, { recursive: true })
  const channelDb = join(repo, '.traintrack', 'channel.db')
  console.log(`[verify-mesh] repo ${repo}\n  session A cwd: ${subA}\n  session B cwd: ${subB}`)

  // Two sessions in DIFFERENT subdirs — no --channel, no join.
  const A = startSession(subA, 'claude-A', 'claude')
  const B = startSession(subB, 'codex-B', 'codex')
  await A.rpc('initialize', {})
  await B.rpc('initialize', {})
  await sleep(500)

  // 1. Both auto-registered into the SAME repo-root channel.
  const m1 = members(channelDb)
  console.log('[verify-mesh] roster after both started:', JSON.stringify(m1))
  const hasA = m1.find((m) => m.handle === 'claude-A' && m.status === 'active' && m.kind === 'live')
  const hasB = m1.find((m) => m.handle === 'codex-B' && m.status === 'active' && m.kind === 'live')
  if (!hasA || !hasB) fail('both sessions should be active live members in the shared repo-root channel', channelDb)

  // 2. A sees B via list_team.
  const teamA = await A.rpc('tools/call', { name: 'list_team', arguments: {} })
  const teamText = teamA.result.content[0].text
  console.log('[verify-mesh] A list_team →', JSON.stringify(teamText))
  if (!teamText.includes('codex-B')) fail('session A list_team should include codex-B', channelDb)

  // 3. A messages B; B's inbox has it; the unread NUDGE surfaces on B's next tool call.
  await A.rpc('tools/call', { name: 'send_message', arguments: { to: 'codex-B', body: 'ping from A' } })
  await sleep(200)
  const bTool = await B.rpc('tools/call', { name: 'list_team', arguments: {} })
  const bText = bTool.result.content[0].text
  console.log('[verify-mesh] B list_team (with nudge) →', JSON.stringify(bText))
  if (!/unread/.test(bText)) fail('session B should see an unread nudge after A messaged it', channelDb)
  const bInbox = await B.rpc('tools/call', { name: 'check_messages', arguments: {} })
  const bInboxText = bInbox.result.content[0].text
  console.log('[verify-mesh] B check_messages →', JSON.stringify(bInboxText))
  if (!bInboxText.includes('ping from A')) fail('session B check_messages should contain A\'s message', channelDb)

  // 4. Ending a session flips it offline.
  A.child.stdin.end()
  await sleep(600)
  const m2 = members(channelDb)
  const aOffline = m2.find((m) => m.handle === 'claude-A' && m.status === 'offline')
  console.log('[verify-mesh] roster after A exits:', JSON.stringify(m2))
  if (!aOffline) fail('claude-A should be offline after its session ends', channelDb)

  B.child.stdin.end()
  await sleep(300)

  console.log('\n--- mesh: two sessions in different subdirs auto-shared one team ---')
  console.log(`  channel (git root): ${channelDb}`)
  console.log('  A and B auto-registered (live), A saw B, A→B message delivered + nudged, A went offline on exit')
  console.log('\nMESH VERIFIED')
  process.exit(0)
}

const hardStop = setTimeout(() => {
  console.log('MESH FAILED (hard timeout)')
  process.exit(1)
}, 90000)
hardStop.unref()

main().catch((err) => {
  console.log('MESH FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
