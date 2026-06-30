import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Channel, type Member } from '../channel/channel.js'
import {
  buildWorkerPrompt,
  runWorkerCycle,
  runWorker,
  resolvePeerAddress,
  buildRosterBriefing,
  type TurnRunner
} from './worker.js'

function member(handle: string, role: string): Member {
  return { handle, agent: 'codex', role, kind: 'headless', status: 'active', worktree: null }
}

let dir: string
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})
function makeChannel(): Channel {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-worker-'))
  return new Channel(join(dir, 'channel.db'))
}

/** A fake runTurn that records the prompts/resume ids it was called with. */
const recordingRunner = (
  text: string,
  sessionId: string | undefined = 'thread-1'
): { runTurn: TurnRunner; calls: { prompt: string; resumeSessionId?: string }[] } => {
  const calls: { prompt: string; resumeSessionId?: string }[] = []
  const runTurn: TurnRunner = async (input) => {
    calls.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId })
    return { finalText: text, sessionId, isError: false }
  }
  return { runTurn, calls }
}

describe('buildWorkerPrompt', () => {
  it('splices every message body + sender into the prompt', () => {
    const prompt = buildWorkerPrompt('codex', [
      { id: 1, from: 'term_claude', to: 'me', body: 'are you there?', type: 'message', read: 0, createdAt: 't' },
      { id: 2, from: 'term_claude', to: 'me', body: 'second ping', type: 'message', read: 0, createdAt: 't' }
    ])
    expect(prompt).toContain('From term_claude: are you there?')
    expect(prompt).toContain('From term_claude: second ping')
    expect(prompt).toContain('"codex"')
  })

  it('prepends the briefing before the messages when one is given', () => {
    const prompt = buildWorkerPrompt(
      'claude',
      [{ id: 1, from: 'lead', to: 'me', body: 'hello', type: 'message', read: 0, createdAt: 't' }],
      'BRIEFING-TEXT'
    )
    const briefingIdx = prompt.indexOf('BRIEFING-TEXT')
    const messageIdx = prompt.indexOf('hello')
    expect(briefingIdx).toBeGreaterThanOrEqual(0)
    expect(briefingIdx).toBeLessThan(messageIdx)
  })
})

describe('runWorker startup', () => {
  const noopRunner: TurnRunner = async () => ({ finalText: '', isError: false })

  it('addMembers itself (kind=headless) on start', async () => {
    const channel = makeChannel()
    await runWorker({
      channel,
      handle: 'my-worker',
      agent: 'claude',
      role: 'lead',
      cwd: '/work',
      once: true,
      runTurn: noopRunner,
      print: () => undefined
    })
    const self = channel.getMember('my-worker')
    expect(self).not.toBeNull()
    expect(self?.kind).toBe('headless')
    expect(self?.agent).toBe('claude')
    expect(self?.role).toBe('lead')
    expect(self?.worktree).toBe('/work')
    channel.close()
  })

  it('builds a briefing (containing teammate handles + the plain-text reply contract) into the turn prompt', async () => {
    const channel = makeChannel()
    channel.addMember({
      handle: 'other-agent',
      agent: 'codex',
      role: 'worker',
      kind: 'headless',
      status: 'active',
      worktree: '/wt/other'
    })
    channel.insertMessage({ from: 'term_lead', to: 'my-worker', body: 'hello there' })
    const { runTurn, calls } = recordingRunner('ok')
    await runWorker({
      channel,
      handle: 'my-worker',
      agent: 'claude',
      role: 'worker',
      cwd: '/work',
      once: true,
      runTurn,
      print: () => undefined
    })
    expect(calls).toHaveLength(1)
    const prompt = calls[0]!.prompt
    expect(prompt).toContain('other-agent')
    // The worker briefing describes the real headless contract (plain-text reply),
    // NOT MCP tools the headless worker cannot call.
    expect(prompt).toContain('plain text')
    expect(prompt).not.toContain('check_messages')
    // briefing comes before the inbox messages
    const briefingIdx = prompt.indexOf('plain text')
    const messagesIdx = prompt.indexOf('hello there')
    expect(briefingIdx).toBeLessThan(messagesIdx)
    channel.close()
  })
})

describe('runWorkerCycle', () => {
  it('does nothing when the inbox is empty (no turn, no reply)', async () => {
    const channel = makeChannel()
    let called = false
    const runTurn: TurnRunner = async () => {
      called = true
      return { finalText: 'x', isError: false }
    }
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/x',
      runTurn
    })
    expect(res.processed).toBe(0)
    expect(called).toBe(false)
    expect(channel.listMembers()).toHaveLength(0)
    channel.close()
  })

  it('drains an inserted message, runs one turn, and replies to the sender', async () => {
    const channel = makeChannel()
    channel.insertMessage({ from: 'term_claude', to: 'term_codex', body: 'hello codex' })
    const { runTurn, calls } = recordingRunner('yes, I am here')
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(res.processed).toBe(1)
    expect(res.reply).toBe('yes, I am here')
    expect(res.sessionId).toBe('thread-1')
    expect(res.repliedTo).toEqual(['term_claude'])
    expect(calls[0]?.prompt).toContain('hello codex')
    // reply was inserted back to the sender
    const replies = channel.getUnread('term_claude')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.body).toBe('yes, I am here')
    expect(replies[0]!.from).toBe('term_codex')
    // original message is now marked read (drained)
    expect(channel.getUnread('term_codex')).toHaveLength(0)
    channel.close()
  })

  it('replies to each distinct sender exactly once', async () => {
    const channel = makeChannel()
    channel.insertMessage({ from: 'term_claude', to: 'term_codex', body: 'a' })
    channel.insertMessage({ from: 'term_cursor', to: 'term_codex', body: 'b' })
    channel.insertMessage({ from: 'term_claude', to: 'term_codex', body: 'c' })
    const { runTurn } = recordingRunner('ok')
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(res.repliedTo.sort()).toEqual(['term_claude', 'term_cursor'])
    expect(channel.getUnread('term_claude')).toHaveLength(1)
    expect(channel.getUnread('term_cursor')).toHaveLength(1)
    channel.close()
  })

  it('carries the previous session id into the turn for resume', async () => {
    const channel = makeChannel()
    channel.insertMessage({ from: 'term_claude', to: 'term_codex', body: 'hi' })
    const { runTurn, calls } = recordingRunner('ok', 'thread-2')
    await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn,
      sessionId: 'thread-1'
    })
    expect(calls[0]?.resumeSessionId).toBe('thread-1')
    channel.close()
  })

  it('sends nothing when the turn produced no reply text', async () => {
    const channel = makeChannel()
    channel.insertMessage({ from: 'term_claude', to: 'term_codex', body: 'hi' })
    const runTurn: TurnRunner = async () => ({ finalText: '   ', sessionId: 's', isError: false })
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(res.reply).toBeUndefined()
    expect(channel.getUnread('term_claude')).toHaveLength(0)
    // message still drained (marked read) even though no reply produced
    expect(channel.getUnread('term_codex')).toHaveLength(0)
    channel.close()
  })
})

describe('resolvePeerAddress', () => {
  const members = [member('lead', 'lead'), member('w_db', 'db'), member('self', 'worker')]

  it('returns null when the text has no leading @', () => {
    expect(resolvePeerAddress('hello there', members, 'self')).toBeNull()
  })

  it('matches a peer by role (case-insensitive) and strips the @token', () => {
    expect(resolvePeerAddress('@db what is the schema?', members, 'self')).toEqual({
      to: 'w_db',
      body: 'what is the schema?'
    })
  })

  it('matches a peer by handle', () => {
    expect(resolvePeerAddress('@lead status please', members, 'self')).toEqual({
      to: 'lead',
      body: 'status please'
    })
  })

  it('matches case-insensitively as a substring', () => {
    expect(resolvePeerAddress('@LEA hi', members, 'self')).toEqual({ to: 'lead', body: 'hi' })
  })

  it('returns null when the @token matches no member', () => {
    expect(resolvePeerAddress('@unknown hello', members, 'self')).toBeNull()
  })

  it('never resolves to itself', () => {
    expect(resolvePeerAddress('@self note', members, 'self')).toBeNull()
  })

  it('handles an @token with no trailing body (empty body)', () => {
    expect(resolvePeerAddress('@db', members, 'self')).toEqual({ to: 'w_db', body: '' })
  })
})

describe('runWorkerCycle peer-addressing', () => {
  it('routes a reply starting with @role to the matched peer, not the sender', async () => {
    const channel = makeChannel()
    channel.addMember(member('lead', 'lead'))
    channel.addMember(member('w_db', 'db'))
    channel.insertMessage({ from: 'lead', to: 'term_codex', body: 'figure out the schema' })
    const { runTurn } = recordingRunner('@db what is the schema?')
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(res.repliedTo).toEqual(['w_db'])
    const toPeer = channel.getUnread('w_db')
    expect(toPeer).toHaveLength(1)
    expect(toPeer[0]!.body).toBe('what is the schema?')
    expect(toPeer[0]!.from).toBe('term_codex')
    // the original sender did NOT receive the reply
    expect(channel.getUnread('lead')).toHaveLength(0)
    channel.close()
  })

  it('replies to the sender when the reply is plain text (no @)', async () => {
    const channel = makeChannel()
    channel.addMember(member('lead', 'lead'))
    channel.addMember(member('w_db', 'db'))
    channel.insertMessage({ from: 'lead', to: 'term_codex', body: 'status?' })
    const { runTurn } = recordingRunner('all good, schema is ready')
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(res.repliedTo).toEqual(['lead'])
    expect(channel.getUnread('lead')[0]!.body).toBe('all good, schema is ready')
    expect(channel.getUnread('w_db')).toHaveLength(0)
    channel.close()
  })

  it('falls back to the sender when @token matches no member (does not drop)', async () => {
    const channel = makeChannel()
    channel.addMember(member('lead', 'lead'))
    channel.addMember(member('w_db', 'db'))
    channel.insertMessage({ from: 'lead', to: 'term_codex', body: 'who is on the team?' })
    const { runTurn } = recordingRunner('@unknown anyone there?')
    const res = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(res.repliedTo).toEqual(['lead'])
    expect(channel.getUnread('lead')[0]!.body).toBe('@unknown anyone there?')
    channel.close()
  })
})

describe('buildRosterBriefing', () => {
  it('buildRosterBriefing reflects a member added after the first build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traintrack-rb-'))
    const ch = new Channel(join(dir, 'c.db'))
    ch.addMember({ handle: 'self', agent: 'codex', role: 'worker', kind: 'headless', status: 'active', worktree: null })
    ch.addMember({ handle: 'oracle', agent: 'codex', role: 'oracle', kind: 'headless', status: 'active', worktree: null })
    const first = buildRosterBriefing(ch, 'self', 'worker')
    expect(first).toContain('oracle')
    expect(first).not.toContain('reviewer')
    ch.addMember({ handle: 'reviewer', agent: 'codex', role: 'reviewer', kind: 'live', status: 'active', worktree: null })
    const second = buildRosterBriefing(ch, 'self', 'worker')
    expect(second).toContain('reviewer')   // late joiner now in the briefing
    expect(second).toContain('oracle')
    ch.close()
  })

  it('runWorker registers self under the given kind (live)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'traintrack-rk-'))
    const ch = new Channel(join(dir, 'c.db'))
    await runWorker({
      channel: ch, handle: 'live1', agent: 'codex', role: 'reviewer', cwd: dir,
      kind: 'live', once: true,
      runTurn: async () => ({ finalText: '', sessionId: undefined, isError: false }),
      sleep: async () => {}, print: () => {},
    })
    expect(ch.getMember('live1')?.kind).toBe('live')
    ch.close()
  })
})

describe('session id carries across cycles', () => {
  it('feeds the first cycle session id into the next cycle as resume id', async () => {
    const channel = makeChannel()
    channel.addMember({
      handle: 'term_codex',
      agent: 'codex',
      role: 'worker',
      kind: 'headless',
      status: 'active',
      worktree: '/work'
    })
    const resumeIds: (string | undefined)[] = []
    const runTurn: TurnRunner = async (input) => {
      resumeIds.push(input.resumeSessionId)
      return { finalText: 'reply', sessionId: `s-${resumeIds.length}`, isError: false }
    }
    // cycle 1: a message arrives, no prior session
    channel.insertMessage({ from: 'lead', to: 'term_codex', body: 'first' })
    const c1 = await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn
    })
    expect(c1.sessionId).toBe('s-1')
    // cycle 2: another message, prior session id carried in
    channel.insertMessage({ from: 'lead', to: 'term_codex', body: 'second' })
    await runWorkerCycle({
      channel,
      handle: 'term_codex',
      agent: 'codex',
      cwd: '/work',
      runTurn,
      sessionId: c1.sessionId
    })
    expect(resumeIds).toEqual([undefined, 's-1'])
    channel.close()
  })
})
