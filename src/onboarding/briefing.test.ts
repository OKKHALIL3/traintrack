import { describe, it, expect } from 'vitest'
import { buildBriefing } from './briefing.js'

describe('buildBriefing', () => {
  it('names the team + role, lists OTHER members, the plain-text reply contract, and @-addressing', () => {
    const b = buildBriefing({
      teamName: 'auth-build',
      selfHandle: 'term_self',
      selfRole: 'api',
      roster: [
        { handle: 'term_self', role: 'api', agent: 'codex', kind: 'headless' },
        { handle: 'term_lead', role: 'lead', agent: 'claude', kind: 'live' }
      ]
    })
    expect(b).toContain('auth-build')
    expect(b).toContain('api')
    expect(b).toContain('term_lead')
    expect(b).not.toContain('term_self') // self excluded from the teammate list
    // Worker runs headless with NO MCP tools — the briefing must describe the
    // real contract (plain-text reply + @-addressing), not non-existent tools.
    expect(b.toLowerCase()).toContain('plain text')
    expect(b).toContain('@<their-handle-or-role>')
    expect(b).not.toContain('check_messages')
    expect(b).not.toContain('send_message')
    expect(b).not.toContain('reply(')
    expect(b.toLowerCase()).toContain('any time')
  })
})
