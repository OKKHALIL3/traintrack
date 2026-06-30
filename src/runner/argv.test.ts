import { describe, it, expect } from 'vitest'
import { buildHeadlessArgv } from './argv.js'

const CLAUDE = { claudeCommand: '/bin/claude' }
const CODEX = { codexCommand: '/bin/codex' }

describe('buildHeadlessArgv', () => {
  it('builds a claude turn-1 argv: stream-json flags + prompt last', () => {
    const { command, args } = buildHeadlessArgv({ agent: 'claude', prompt: 'hello', ...CLAUDE })
    expect(command).toBe('/bin/claude')
    expect(args).toEqual(['--print', '--output-format', 'stream-json', '--verbose', 'hello'])
    expect(args.at(-1)).toBe('hello')
  })

  it('builds a claude resume argv with --resume <captured id>', () => {
    const { args } = buildHeadlessArgv({
      agent: 'claude',
      prompt: 'follow up',
      resumeSessionId: 'sess-uuid',
      model: 'claude-opus-4-8',
      ...CLAUDE
    })
    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      'sess-uuid',
      '--model',
      'claude-opus-4-8',
      'follow up'
    ])
  })

  it('builds a codex turn-1 argv: exec --json + ALWAYS bypass, prompt last', () => {
    const { command, args } = buildHeadlessArgv({ agent: 'codex', prompt: 'do it', ...CODEX })
    expect(command).toBe('/bin/codex')
    expect(args).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', 'do it'])
    expect(args.at(-1)).toBe('do it')
  })

  it('builds a codex resume argv with the captured thread id (never --last)', () => {
    const { args } = buildHeadlessArgv({
      agent: 'codex',
      prompt: 'next',
      resumeSessionId: 'thread-xyz',
      model: 'gpt-5.5',
      ...CODEX
    })
    expect(args).toEqual([
      'exec',
      'resume',
      'thread-xyz',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'gpt-5.5',
      'next'
    ])
    expect(args).not.toContain('--last')
  })

  it('codex argv ALWAYS includes the sandbox-bypass flag unless explicitly disabled', () => {
    const on = buildHeadlessArgv({ agent: 'codex', prompt: 'x', ...CODEX })
    expect(on.args).toContain('--dangerously-bypass-approvals-and-sandbox')

    const off = buildHeadlessArgv({
      agent: 'codex',
      prompt: 'x',
      codexBypassSandbox: false,
      ...CODEX
    })
    expect(off.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})
