#!/usr/bin/env node
// ─── traintrack CAPSTONE live verification ──────────────────────────────────
// The whole Mode-2 (lead orchestration) flow through the REAL MCP server process:
// a lead session auto-resolves its project channel (git root), auto-registers,
// then via the tool path `spawn_worker`s a REAL codex worker and collects its
// reply with `await_results`. Proves the shipped server drives real cross-agent
// coordination end to end. Run: `node scripts/verify-capstone.mjs`.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
        /* ignore */
      }
    }
  })
  let id = 0
  return (method, params, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId)
          reject(new Error(`rpc ${method} timed out`))
        }
      }, timeoutMs)
    })
}

async function main() {
  console.log('[capstone] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  const repo = mkdtempSync(join(tmpdir(), 'traintrack-capstone-'))
  const git = (a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '--allow-empty', '-m', 'init'])
  const channelDb = join(repo, '.traintrack', 'channel.db')
  console.log(`[capstone] repo (lead cwd): ${repo}`)

  // A real lead MCP-server session (auto-resolves channel to git root, auto-joins).
  const lead = spawn(process.execPath, [join(repoDir, 'dist/mcp-server.js')], {
    cwd: repo,
    env: { ...process.env, TRAINTRACK_HANDLE: 'lead', TRAINTRACK_AGENT: 'claude', TRAINTRACK_ROLE: 'lead' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  lead.stderr.on('data', (d) => process.stderr.write(`[lead:err] ${d}`))
  const rpc = makeClient(lead)

  await rpc('initialize', {})
  await sleep(300)

  console.log('[capstone] lead → spawn_worker(codex, pinger, "reply PONG") …')
  const spawnRes = await rpc('tools/call', {
    name: 'spawn_worker',
    arguments: { agent: 'codex', role: 'pinger', task: 'Reply with the word PONG and nothing else.' },
  })
  const spawnText = spawnRes.result.content[0].text
  console.log('[capstone] spawn_worker →', JSON.stringify(spawnText))
  if (spawnRes.result.isError) {
    fail('spawn_worker returned an error', channelDb)
  }

  console.log('[capstone] lead → await_results (collecting the real codex reply) …')
  const awaitRes = await rpc('tools/call', { name: 'await_results', arguments: { timeoutMs: 180000 } }, 200000)
  const awaitText = awaitRes.result.content[0].text
  console.log('[capstone] await_results →', JSON.stringify(awaitText))

  cleanup(channelDb, lead)

  if (!/PONG/i.test(awaitText)) {
    console.log('\nCAPSTONE FAILED')
    console.log('(await_results did not contain PONG from the spawned codex worker)')
    process.exit(1)
  }

  console.log('\n--- capstone: lead session spawned a real codex worker and collected its reply ---')
  console.log(`  channel (git root): ${channelDb}`)
  console.log(`  spawn_worker: ${JSON.stringify(spawnText)}`)
  console.log(`  await_results: ${JSON.stringify(awaitText)}`)
  console.log('\nCAPSTONE VERIFIED')
  process.exit(0)
}

function cleanup(channelDb, lead) {
  try {
    lead.stdin.end()
  } catch {}
  try {
    execFileSync('pkill', ['-9', '-f', channelDb], { stdio: 'ignore' })
  } catch {}
}

const hardStop = setTimeout(() => {
  console.log('CAPSTONE FAILED (hard timeout)')
  process.exit(1)
}, 260000)
hardStop.unref()

function fail(msg, channelDb) {
  console.log('\nCAPSTONE FAILED')
  console.log(msg)
  try {
    execFileSync('pkill', ['-9', '-f', channelDb], { stdio: 'ignore' })
  } catch {}
  process.exit(1)
}

main().catch((err) => {
  console.log('CAPSTONE FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
