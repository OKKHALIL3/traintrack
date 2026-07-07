import { describe, it, expect } from 'vitest'
import {
  createTurnParseState,
  parseJsonLine,
  isTurnEndEvent,
  extractSessionId,
  reduceLine,
  finalizeTurn
} from './event-parser.js'

// Fixture stdout lines mirroring the documented stream-json shapes.
const CLAUDE_LINES = [
  '{"type":"system","subtype":"init","session_id":"sess-claude-123","model":"claude-opus-4-8","cwd":"/x","tools":[]}',
  '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hello "}]},"session_id":"sess-claude-123"}',
  '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"world"}]},"session_id":"sess-claude-123"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"Hello world","session_id":"sess-claude-123","usage":{"input_tokens":42,"output_tokens":7},"total_cost_usd":0.0011,"duration_ms":1200,"num_turns":1}'
]

const CODEX_LINES = [
  '{"type":"thread.started","thread_id":"thread-codex-abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done with "}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"the task."}}',
  '{"type":"turn.completed","status":"completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20}}'
]

function reduceAll(provider: 'claude' | 'codex', lines: string[]): ReturnType<typeof finalizeTurn> {
  const state = createTurnParseState(provider)
  for (const line of lines) {
    reduceLine(state, line)
  }
  return finalizeTurn(state)
}

describe('headless event-parser', () => {
  it('parses a full claude turn: final text, session id, tokens, cost, no error', () => {
    const result = reduceAll('claude', CLAUDE_LINES)
    expect(result.ended).toBe(true)
    expect(result.finalText).toBe('Hello world')
    expect(result.sessionId).toBe('sess-claude-123')
    expect(result.tokensIn).toBe(42)
    expect(result.tokensOut).toBe(7)
    expect(result.costUsd).toBeCloseTo(0.0011)
    expect(result.isError).toBe(false)
  })

  it('parses a full codex turn: joined item text, thread id, tokens, no error', () => {
    const result = reduceAll('codex', CODEX_LINES)
    expect(result.ended).toBe(true)
    expect(result.finalText).toBe('Done with the task.')
    expect(result.sessionId).toBe('thread-codex-abc')
    expect(result.tokensIn).toBe(100)
    expect(result.tokensOut).toBe(20)
    expect(result.isError).toBe(false)
  })

  it('emits streaming text deltas in order (claude)', () => {
    const state = createTurnParseState('claude')
    const deltas: string[] = []
    for (const line of CLAUDE_LINES) {
      const { delta } = reduceLine(state, line)
      if (delta) {
        deltas.push(delta)
      }
    }
    expect(deltas).toEqual(['Hello ', 'world'])
  })

  it('emits streaming text deltas in order (codex)', () => {
    const state = createTurnParseState('codex')
    const deltas: string[] = []
    for (const line of CODEX_LINES) {
      const { delta } = reduceLine(state, line)
      if (delta) {
        deltas.push(delta)
      }
    }
    expect(deltas).toEqual(['Done with ', 'the task.'])
  })

  it('detects the authoritative turn-end event per provider', () => {
    expect(isTurnEndEvent('claude', { type: 'result' })).toBe(true)
    expect(isTurnEndEvent('claude', { type: 'assistant' })).toBe(false)
    expect(isTurnEndEvent('codex', { type: 'turn.completed' })).toBe(true)
    expect(isTurnEndEvent('codex', { type: 'turn.started' })).toBe(false)
  })

  it('extracts session/thread ids only from the right events', () => {
    expect(extractSessionId('claude', { type: 'system', subtype: 'init', session_id: 'a' })).toBe(
      'a'
    )
    expect(extractSessionId('claude', { type: 'assistant', session_id: 'a' })).toBeUndefined()
    expect(extractSessionId('codex', { type: 'thread.started', thread_id: 't' })).toBe('t')
    expect(extractSessionId('codex', { type: 'turn.started' })).toBeUndefined()
  })

  it('marks isError on a failed claude result and a failed codex turn', () => {
    const claude = createTurnParseState('claude')
    reduceLine(
      claude,
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'
    )
    expect(finalizeTurn(claude).isError).toBe(true)

    const codex = createTurnParseState('codex')
    reduceLine(
      codex,
      '{"type":"turn.completed","status":"failed","usage":{"input_tokens":1,"output_tokens":0}}'
    )
    expect(finalizeTurn(codex).isError).toBe(true)
  })

  it('ignores blank, banner, and malformed lines without throwing', () => {
    expect(parseJsonLine('')).toBeNull()
    expect(parseJsonLine('   ')).toBeNull()
    expect(parseJsonLine('Welcome to codex')).toBeNull()
    expect(parseJsonLine('{not valid json')).toBeNull()

    const state = createTurnParseState('claude')
    expect(() => reduceLine(state, 'garbage')).not.toThrow()
    expect(reduceLine(state, 'garbage')).toEqual({})
    expect(state.ended).toBe(false)
  })

  it('does not double-count: claude final prefers the result field over streamed deltas', () => {
    // result text differs from streamed deltas — authoritative wins.
    const state = createTurnParseState('claude')
    reduceLine(
      state,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}'
    )
    reduceLine(state, '{"type":"result","is_error":false,"result":"FINAL"}')
    expect(finalizeTurn(state).finalText).toBe('FINAL')
  })
})
