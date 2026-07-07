import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Channel } from './channel.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function makeChannel(): Channel {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-'))
  return new Channel(join(dir, 'channel.db'))
}

describe('Channel', () => {
  it('inserts, reads-unread (marking read), and does not re-return read messages', () => {
    const c = makeChannel()
    const id = c.insertMessage({ from: 'lead', to: 'w1', body: 'do X' })
    expect(typeof id).toBe('number')
    const unread = c.getUnread('w1')
    expect(unread).toHaveLength(1)
    expect(unread[0].body).toBe('do X')
    c.markRead(unread.map((m) => m.id))
    expect(c.getUnread('w1')).toHaveLength(0)
    c.close()
  })
  it('adds + lists + gets members', () => {
    const c = makeChannel()
    c.addMember({ handle: 'w1', agent: 'codex', role: 'api', kind: 'headless', status: 'active', worktree: '/wt/w1' })
    expect(c.listMembers().map((m) => m.handle)).toEqual(['w1'])
    expect(c.getMember('w1')?.role).toBe('api')
    expect(c.getMember('nope')).toBeNull()
    c.close()
  })
})
