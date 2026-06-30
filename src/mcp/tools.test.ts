import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Channel } from '../channel/channel.js'
import { spawnWorkerTool, sendMessageTool, checkMessagesTool, awaitResultsTool, listTeamTool, delegateTaskTool, joinTeamTool } from './tools.js'
import type { ToolDeps, SpawnWorkerFn } from './tools.js'
import { handleMessage, withUnreadNudge, buildDepsFromEnv } from './server.js'

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function makeChannel(): Channel {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-mcp-'))
  return new Channel(join(dir, 'channel.db'))
}

/** A fake spawnWorker that records its call and returns a fixed handle. */
function fakeSpawn(handle = 'worker_fake01') {
  return vi.fn<SpawnWorkerFn>(async () => ({ handle }))
}

function deps(channel: Channel, over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    self: 'lead',
    channel,
    spawnWorker: fakeSpawn(),
    // Near-instant sleep so the poll loop does not actually wait in tests.
    sleep: async () => {},
    ...over,
  }
}

describe('spawnWorkerTool', () => {
  it('calls the injected spawnWorker and returns the new handle in the text', async () => {
    const c = makeChannel()
    const spawnWorker = fakeSpawn('worker_abc123')
    const res = await spawnWorkerTool({ agent: 'claude', role: 'api', task: 'do X' }, deps(c, { spawnWorker }))
    expect(spawnWorker).toHaveBeenCalledOnce()
    const callArg = spawnWorker.mock.calls[0][0]
    expect(callArg).toMatchObject({ agent: 'claude', role: 'api', task: 'do X', leadHandle: 'lead' })
    expect(callArg.channel).toBe(c)
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('worker_abc123')
    c.close()
  })

  it('rejects an invalid agent type', async () => {
    const c = makeChannel()
    const spawnWorker = fakeSpawn()
    const res = await spawnWorkerTool({ agent: 'gpt', role: 'api', task: 'do X' }, deps(c, { spawnWorker }))
    expect(res.isError).toBe(true)
    expect(spawnWorker).not.toHaveBeenCalled()
    c.close()
  })
})

describe('sendMessageTool', () => {
  it("inserts {to, from: self, body} into the channel", async () => {
    const c = makeChannel()
    const res = await sendMessageTool({ to: 'w1', body: 'hi' }, deps(c, { self: 'lead' }))
    expect(res.isError).toBeFalsy()
    const unread = c.getUnread('w1')
    expect(unread).toHaveLength(1)
    expect(unread[0]).toMatchObject({ to: 'w1', from: 'lead', body: 'hi' })
    c.close()
  })
})

describe('checkMessagesTool', () => {
  it("returns and marks-read this lead's unread messages", async () => {
    const c = makeChannel()
    c.insertMessage({ from: 'w1', to: 'lead', body: 'result A' })
    c.insertMessage({ from: 'w2', to: 'lead', body: 'result B' })
    const res = await checkMessagesTool({}, deps(c, { self: 'lead' }))
    expect(res.content[0].text).toContain('result A')
    expect(res.content[0].text).toContain('result B')
    // Consumed: a second check finds nothing.
    expect(c.getUnread('lead')).toHaveLength(0)
    c.close()
  })

  it('reports when there are no messages', async () => {
    const c = makeChannel()
    const res = await checkMessagesTool({}, deps(c))
    expect(res.content[0].text.toLowerCase()).toContain('no messages')
    c.close()
  })
})

describe('awaitResultsTool', () => {
  it('returns a pre-seeded message immediately and marks it read', async () => {
    const c = makeChannel()
    c.insertMessage({ from: 'w1', to: 'lead', body: 'done!' })
    const res = await awaitResultsTool({ timeoutMs: 100 }, deps(c, { self: 'lead' }))
    expect(res.content[0].text).toContain('done!')
    expect(c.getUnread('lead')).toHaveLength(0)
    c.close()
  })

  it('returns the no-results text after a tiny timeout when nothing arrives', async () => {
    const c = makeChannel()
    // Real sleep here so the poll loop genuinely elapses the timeout.
    const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const res = await awaitResultsTool({ timeoutMs: 100 }, deps(c, { self: 'lead', sleep: realSleep }))
    expect(res.content[0].text).toContain('No results within the timeout.')
    c.close()
  })
})

describe('listTeamTool', () => {
  it('returns text containing both handles and roles when two members exist', () => {
    const c = makeChannel()
    c.addMember({ handle: 'w1', agent: 'claude', role: 'api', kind: 'headless', status: 'active', worktree: null })
    c.addMember({ handle: 'w2', agent: 'codex', role: 'ui', kind: 'headless', status: 'active', worktree: null })
    const res = listTeamTool(deps(c))
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('w1')
    expect(res.content[0].text).toContain('api')
    expect(res.content[0].text).toContain('w2')
    expect(res.content[0].text).toContain('ui')
    c.close()
  })

  it('returns a helpful message when there are no members', () => {
    const c = makeChannel()
    const res = listTeamTool(deps(c))
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text.toLowerCase()).toContain('no teammates')
    c.close()
  })
})

describe('delegateTaskTool', () => {
  it('inserts a task message when the recipient is a known member', () => {
    const c = makeChannel()
    c.addMember({ handle: 'w1', agent: 'claude', role: 'api', kind: 'headless', status: 'active', worktree: null })
    const res = delegateTaskTool(deps(c, { self: 'lead' }), 'w1', 'do Y')
    expect(res.isError).toBeFalsy()
    const unread = c.getUnread('w1')
    expect(unread).toHaveLength(1)
    expect(unread[0]).toMatchObject({ to: 'w1', from: 'lead', body: 'do Y' })
    c.close()
  })

  it('returns isError and names valid members when recipient is unknown, does NOT insert', () => {
    const c = makeChannel()
    c.addMember({ handle: 'w1', agent: 'claude', role: 'api', kind: 'headless', status: 'active', worktree: null })
    const res = delegateTaskTool(deps(c, { self: 'lead' }), 'nope', 'x')
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('nope')
    expect(res.content[0].text).toContain('w1')
    // Nothing should have been inserted for 'nope'
    expect(c.getUnread('nope')).toHaveLength(0)
    c.close()
  })
})

describe('joinTeamTool', () => {
  it('join_team registers a live member and rebinds self', () => {
    const ch = new Channel(join(mkdtempSync(join(tmpdir(), 'traintrack-jt-')), 'c.db'))
    const deps = { self: 'lead', channel: ch, spawnWorker: (async () => ({ handle: 'x' })) as any }
    const res = joinTeamTool(deps, 'reviewer', 'reviewer', 'codex')
    expect(res.isError).toBeFalsy()
    expect(deps.self).toBe('reviewer')                 // identity rebound for the session
    const m = ch.getMember('reviewer')
    expect(m?.kind).toBe('live')
    expect(m?.role).toBe('reviewer')
    expect(m?.agent).toBe('codex')
    expect(res.content[0].text).toContain('reviewer')
    ch.close()
  })

  it('join_team defaults agent to claude when omitted or invalid', () => {
    const ch = new Channel(join(mkdtempSync(join(tmpdir(), 'traintrack-jt2-')), 'c.db'))
    const deps = { self: 'lead', channel: ch, spawnWorker: (async () => ({ handle: 'x' })) as any }
    joinTeamTool(deps, 'qa', 'qa', 'bogus')
    expect(ch.getMember('qa')?.agent).toBe('claude')
    ch.close()
  })

  it('join_team rejects a taken handle and does not clobber the existing member', () => {
    const ch = new Channel(join(mkdtempSync(join(tmpdir(), 'traintrack-jt3-')), 'c.db'))
    ch.addMember({ handle: 'lead', agent: 'human', role: 'lead', kind: 'live', status: 'active', worktree: null })
    const deps = { self: 'someone', channel: ch, spawnWorker: (async () => ({ handle: 'x' })) as any }
    const res = joinTeamTool(deps, 'lead', 'reviewer', 'codex')
    expect(res.isError).toBe(true)
    expect(deps.self).toBe('someone')                 // identity NOT rebound on rejection
    expect(ch.getMember('lead')?.role).toBe('lead')   // existing member untouched
    expect(ch.getMember('lead')?.agent).toBe('human')
    ch.close()
  })
})

describe('join_team server dispatch', () => {
  it('valid join_team call resolves without error and registers a live member', async () => {
    const c = makeChannel()
    const d = deps(c, { self: 'lead' })
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'join_team', arguments: { handle: 'r', role: 'reviewer' } } },
      d
    )
    const result = res?.result as { isError?: boolean }
    expect(result.isError).toBeFalsy()
    expect(c.getMember('r')?.kind).toBe('live')
    c.close()
  })

  it('join_team call missing role resolves to isError and does NOT register', async () => {
    const c = makeChannel()
    const d = deps(c, { self: 'lead' })
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'join_team', arguments: { handle: 'r' } } },
      d
    )
    const result = res?.result as { isError?: boolean }
    expect(result.isError).toBe(true)
    expect(c.getMember('r')).toBeNull()
    c.close()
  })
})

describe('round isolation', () => {
  it('two sequential delegate_task→await_results cycles each return ONLY that round\'s reply', async () => {
    const c = makeChannel()
    c.addMember({ handle: 'w1', agent: 'claude', role: 'researcher', kind: 'headless', status: 'active', worktree: null })
    const d = deps(c, { self: 'lead', sleep: async () => {} })

    // ── Round 1 ──────────────────────────────────────────────────────────────
    // Lead delegates a task to w1.
    const del1 = delegateTaskTool(d, 'w1', 'task round 1')
    expect(del1.isError).toBeFalsy()

    // Simulate w1 replying: it inserts a message addressed to the lead.
    c.insertMessage({ to: 'lead', from: 'w1', body: 'r1' })

    // await_results must return r1 and mark it read.
    const res1 = await awaitResultsTool({ timeoutMs: 100 }, d)
    expect(res1.isError).toBeFalsy()
    expect(res1.content[0].text).toContain('r1')

    // After consuming, lead's inbox must be empty.
    expect(c.getUnread('lead')).toHaveLength(0)

    // ── Round 2 ──────────────────────────────────────────────────────────────
    // Lead delegates a follow-up task.
    const del2 = delegateTaskTool(d, 'w1', 'task round 2')
    expect(del2.isError).toBeFalsy()

    // Simulate w1 replying with round-2 result.
    c.insertMessage({ to: 'lead', from: 'w1', body: 'r2' })

    // await_results must return r2 ONLY — not r1 again.
    const res2 = await awaitResultsTool({ timeoutMs: 100 }, d)
    expect(res2.isError).toBeFalsy()
    expect(res2.content[0].text).toContain('r2')
    expect(res2.content[0].text).not.toContain('r1')

    // After consuming, inbox must be empty again.
    expect(c.getUnread('lead')).toHaveLength(0)

    c.close()
  })
})

describe('withUnreadNudge', () => {
  it('appends a mail nudge when the session has unread, on non-inbox tools', () => {
    const c = makeChannel()
    c.insertMessage({ to: 'lead', from: 'mate', body: 'hi' })
    const out = withUnreadNudge({ content: [{ type: 'text', text: 'Spawned worker.' }] }, 'spawn_worker', deps(c))
    expect(out.content[0].text).toContain('Spawned worker.')
    expect(out.content[0].text).toContain('1 unread')
    c.close()
  })

  it('does NOT nudge for check_messages/await_results or when inbox empty', () => {
    const c = makeChannel()
    c.insertMessage({ to: 'lead', from: 'mate', body: 'hi' })
    const skipped = withUnreadNudge({ content: [{ type: 'text', text: 'msgs' }] }, 'check_messages', deps(c))
    expect(skipped.content[0].text).toBe('msgs')
    const empty = withUnreadNudge({ content: [{ type: 'text', text: 'x' }] }, 'spawn_worker', deps(makeChannel()))
    expect(empty.content[0].text).toBe('x')
    c.close()
  })
})

describe('buildDepsFromEnv auto-presence', () => {
  it('registers the session as a live member on startup', () => {
    const d = mkdtempSync(join(tmpdir(), 'traintrack-pres-'))
    const dbPath = join(d, '.traintrack', 'channel.db')
    const saved = { ...process.env }
    process.env['TRAINTRACK_CHANNEL'] = dbPath
    process.env['TRAINTRACK_HANDLE'] = 'claude-pres1'
    process.env['TRAINTRACK_AGENT'] = 'claude'
    try {
      const deps2 = buildDepsFromEnv()
      const m = deps2.channel.getMember('claude-pres1')
      expect(m?.kind).toBe('live')
      expect(m?.status).toBe('active')
      expect(m?.agent).toBe('claude')
      expect(deps2.self).toBe('claude-pres1')
      deps2.channel.close()
    } finally {
      process.env = saved
    }
  })
})
