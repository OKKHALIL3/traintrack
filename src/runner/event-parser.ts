// Why: a headless agent turn (claude `--print --output-format stream-json` or
// codex `exec --json`) emits one JSON object per stdout line. This module is the
// PURE classifier for that stream — no spawning, no I/O — so it can be table-
// tested against fixture lines. It is the structured, in-band turn-end signal
// that replaces PTY idle-guessing (see project_headless_worker_pivot): claude's
// {type:'result'} and codex's {type:'turn.completed'} are authoritative ACKs.
//
// Ported from the abandoned Rust conductor's runtime/event_parser.rs.

export type HeadlessProvider = 'claude' | 'codex' | 'cursor' | 'opencode'

/** Text providers (cursor-agent, opencode) emit a plain-text reply, not an NDJSON
 *  event stream: every stdout line is part of the answer and the turn ends when
 *  the process exits (the turn runner supplies that signal from the exit code).
 *  The JSON providers (claude, codex) emit a structured stream with an
 *  authoritative in-band turn-end event. */
export function isTextProvider(provider: HeadlessProvider): boolean {
  return provider === 'cursor' || provider === 'opencode'
}

/** Accumulated result of a single headless agent turn. */
export type HeadlessTurnResult = {
  /** The agent's final assistant text for the turn. */
  finalText: string
  /** Provider session id to pin for the next turn's --resume (claude uuid / codex thread id). */
  sessionId?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  /** True if the turn ended in an error state (claude is_error / codex failed status). */
  isError: boolean
  /** True once the authoritative turn-end event has been seen. */
  ended: boolean
}

/** Mutable accumulator threaded through the streamed lines of one turn. */
export type TurnParseState = HeadlessTurnResult & {
  provider: HeadlessProvider
  /** Streaming assistant text accumulated from deltas/items (for onDelta + codex final). */
  streamedText: string
  /** Authoritative final text when the provider gives one (claude `result`). */
  authoritativeText?: string
}

export function createTurnParseState(provider: HeadlessProvider): TurnParseState {
  return {
    provider,
    finalText: '',
    streamedText: '',
    isError: false,
    ended: false
  }
}

/**
 * Parse one NDJSON line to a plain object. Returns null for blank or malformed
 * lines — NEVER throws (a CLI can interleave non-JSON banner lines on stdout).
 */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** True when this event is the authoritative turn-end (the ACK). */
export function isTurnEndEvent(provider: HeadlessProvider, evt: Record<string, unknown>): boolean {
  const type = str(evt.type)
  return provider === 'claude' ? type === 'result' : type === 'turn.completed'
}

/**
 * The provider session id to pin for resume, if this event carries one.
 * claude: the {type:'system',subtype:'init'} event (also present on `result`).
 * codex: the {type:'thread.started'} event (turn 1 only) — load-bearing for
 * per-agent resume; using --last with >1 codex worker cross-wires threads.
 */
export function extractSessionId(
  provider: HeadlessProvider,
  evt: Record<string, unknown>
): string | undefined {
  if (provider === 'claude') {
    const type = str(evt.type)
    if (type === 'system' && str(evt.subtype) === 'init') {
      return str(evt.session_id)
    }
    if (type === 'result') {
      return str(evt.session_id)
    }
    return undefined
  }
  // codex
  if (str(evt.type) === 'thread.started') {
    return str(evt.thread_id) ?? str(evt.session_id)
  }
  return undefined
}

/** Incremental assistant text from a streaming event, else undefined. */
export function extractTextDelta(
  provider: HeadlessProvider,
  evt: Record<string, unknown>
): string | undefined {
  if (provider === 'claude') {
    // {type:'assistant', message:{content:[{type:'text', text:'...'}]}}
    if (str(evt.type) !== 'assistant') {
      return undefined
    }
    const message = asRecord(evt.message)
    const content = message?.content
    if (!Array.isArray(content)) {
      return undefined
    }
    const parts: string[] = []
    for (const block of content) {
      const rec = asRecord(block)
      if (rec && str(rec.type) === 'text') {
        const t = str(rec.text)
        if (t) {
          parts.push(t)
        }
      }
    }
    return parts.length ? parts.join('') : undefined
  }
  // codex: {type:'item.completed', item:{type:'agent_message', text:'...'}}
  if (str(evt.type) !== 'item.completed') {
    return undefined
  }
  const item = asRecord(evt.item)
  const itemType = item ? (str(item.type) ?? str(item.item_type)) : undefined
  if (item && (itemType === 'agent_message' || itemType === 'assistant_message')) {
    return str(item.text)
  }
  return undefined
}

function applyTurnEnd(state: TurnParseState, evt: Record<string, unknown>): void {
  state.ended = true
  if (state.provider === 'claude') {
    state.authoritativeText = str(evt.result) ?? state.authoritativeText
    state.isError = evt.is_error === true || str(evt.subtype)?.startsWith('error') === true
    const usage = asRecord(evt.usage)
    state.tokensIn = num(usage?.input_tokens) ?? state.tokensIn
    state.tokensOut = num(usage?.output_tokens) ?? state.tokensOut
    state.costUsd = num(evt.total_cost_usd) ?? state.costUsd
  } else {
    // codex turn.completed
    const status = str(evt.status)
    state.isError = status === 'failed' || status === 'interrupted'
    const usage = asRecord(evt.usage)
    state.tokensIn = num(usage?.input_tokens) ?? state.tokensIn
    state.tokensOut = num(usage?.output_tokens) ?? state.tokensOut
  }
}

/**
 * Reduce one stdout line into the accumulator state, mutating it in place.
 * Returns the streaming text delta produced by this line (if any) so the caller
 * can forward live tokens to the UI without re-parsing.
 */
export function reduceLine(state: TurnParseState, line: string): { delta?: string } {
  // Text providers (cursor, opencode): no NDJSON to classify — every line is part
  // of the plain-text reply. Accumulate raw stdout; the turn end comes from exit.
  if (isTextProvider(state.provider)) {
    state.streamedText += state.streamedText ? `\n${line}` : line
    return { delta: line }
  }

  const evt = parseJsonLine(line)
  if (!evt) {
    return {}
  }

  const sessionId = extractSessionId(state.provider, evt)
  if (sessionId && !state.sessionId) {
    state.sessionId = sessionId
  }

  let delta: string | undefined
  if (!isTurnEndEvent(state.provider, evt)) {
    delta = extractTextDelta(state.provider, evt)
    if (delta) {
      state.streamedText += delta
    }
  } else {
    applyTurnEnd(state, evt)
  }

  return delta ? { delta } : {}
}

/** Snapshot the accumulator into a turn result (call after the stream closes). */
export function finalizeTurn(state: TurnParseState): HeadlessTurnResult {
  return {
    finalText: state.authoritativeText ?? state.streamedText,
    sessionId: state.sessionId,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    costUsd: state.costUsd,
    isError: state.isError,
    ended: state.ended
  }
}
