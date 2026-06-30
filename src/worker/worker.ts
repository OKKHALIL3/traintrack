// ─── traintrack headless worker ──────────────────────────────────────────────
// A long-lived loop that makes ONE agent a reliable, auto-responding teammate.
// Unlike PTY injection (best-effort, research-proven unreliable), this drains the
// agent's durable inbox (the local SQLite Channel) and runs each turn as a fresh
// HEADLESS process (claude --print / codex exec resume), using the structured
// turn-end event as the ACK. The receiving agent therefore "sees" messages with
// zero human input and on a guaranteed schedule.
//
// Ported from $TT/src/cli/headless-worker.ts and REPOINTED off Orca's
// RuntimeClient (RPC) onto the local Channel:
//   orchestration.check {unread} → channel.getUnread(handle) + channel.markRead(ids)
//   orchestration.send {to,from,body} → channel.insertMessage({to,from,body})
//   team.join {...} → channel.addMember({handle, agent, role, kind:'headless', ...})
//   team.list → channel.listMembers()
// No RPC, no engine — the worker takes a Channel directly.

import { Channel, type Member, type Message } from '../channel/channel.js'
import { buildHeadlessArgv } from '../runner/argv.js'
import { runHeadlessTurn } from '../runner/turn-runner.js'
import type { HeadlessProvider } from '../runner/event-parser.js'
import { buildBriefing, type TeamRosterEntry } from '../onboarding/briefing.js'

/** The headless-turn surface (injectable so tests don't spawn a real process). */
export type TurnRunner = (input: {
  provider: HeadlessProvider
  prompt: string
  cwd: string
  model?: string
  resumeSessionId?: string
}) => Promise<{ finalText: string; sessionId?: string; isError: boolean }>

/** Per-cycle inputs: one drain → turn → reply against the channel. */
export type WorkerCycleDeps = {
  channel: Channel
  handle: string
  agent: HeadlessProvider
  cwd: string
  model?: string
  runTurn: TurnRunner
  /** Session id carried across cycles for resume (claude uuid / codex thread id). */
  sessionId?: string
  print?: (msg: string) => void
  /** Team briefing prepended to every turn prompt. */
  briefing?: string
}

export type WorkerCycleResult = {
  processed: number
  reply?: string
  sessionId?: string
  repliedTo: string[]
}

/** Build the team briefing from the channel's CURRENT roster. Called every loop
 *  iteration so a worker's prompt reflects teammates who joined after it spawned. */
export function buildRosterBriefing(
  channel: Channel,
  selfHandle: string,
  selfRole: string,
  teamName = 'team'
): string {
  const roster: TeamRosterEntry[] = channel.listMembers().map((m) => ({
    handle: m.handle,
    role: m.role,
    agent: m.agent,
    kind: m.kind,
  }))
  return buildBriefing({ teamName, selfHandle, selfRole, roster })
}

/** Build the turn prompt from the drained inbox messages (port of the rust build_prompt). */
export function buildWorkerPrompt(
  agent: HeadlessProvider,
  messages: Message[],
  briefing?: string
): string {
  const lines = messages.map((m) => `From ${m.from}: ${m.body}`).join('\n')
  const body = [
    `You are the "${agent}" agent in a traintrack multi-agent workspace, coordinating with teammates over a shared message channel.`,
    `The following message(s) just arrived in your inbox. Read them and reply — your reply is delivered back to the sender(s).`,
    '',
    '--- Messages ---',
    lines,
    '--- End ---',
    '',
    'Respond now.'
  ].join('\n')
  if (briefing) {
    return `${briefing}\n\n${body}`
  }
  return body
}

/**
 * Resolve a direct peer address from a worker's reply text. If `text` starts with
 * `@`, the leading token (up to the first whitespace) is matched case-insensitively
 * as a substring against each member's `handle` or `role` (excluding `selfHandle`).
 * On a match, returns `{ to: matchedHandle, body: <rest of text> }`. If the text has
 * no leading `@`, or the token matches no member, returns `null` (caller falls back
 * to replying to the original sender — the message is never dropped). Ported from the
 * `@name` parse in traintrack-desktop's session.ts.
 */
export function resolvePeerAddress(
  text: string,
  members: Member[],
  selfHandle: string
): { to: string; body: string } | null {
  if (!text.startsWith('@')) {
    return null
  }
  const ws = text.search(/\s/)
  const token = (ws === -1 ? text.slice(1) : text.slice(1, ws)).trim()
  const body = ws === -1 ? '' : text.slice(ws + 1).trim()
  if (!token) {
    return null
  }
  const needle = token.toLowerCase()
  const match = members.find(
    (m) =>
      m.handle !== selfHandle &&
      (m.handle.toLowerCase().includes(needle) || m.role.toLowerCase().includes(needle))
  )
  return match ? { to: match.handle, body } : null
}

/**
 * One drain → headless turn → reply cycle. Pulls this worker's unread inbox from
 * the channel, runs a single headless agent turn with those messages spliced in,
 * posts the agent's reply back to each distinct sender, and marks the drained
 * messages read. Returns what happened (for logging + tests) including the
 * (possibly new) session id to carry forward.
 */
export async function runWorkerCycle(deps: WorkerCycleDeps): Promise<WorkerCycleResult> {
  const { channel, handle, agent, cwd, model, runTurn, print, briefing } = deps

  const messages = channel.getUnread(handle)
  if (messages.length === 0) {
    return { processed: 0, sessionId: deps.sessionId, repliedTo: [] }
  }

  print?.(`[worker] ${agent} draining ${messages.length} message(s)`)
  const prompt = buildWorkerPrompt(agent, messages, briefing)
  const turn = await runTurn({
    provider: agent,
    prompt,
    cwd,
    model,
    resumeSessionId: deps.sessionId
  })

  const reply = turn.finalText.trim()
  const senders = [...new Set(messages.map((m) => m.from).filter(Boolean))]
  // If the reply opens with `@<handle-or-role>`, route the rest to that teammate
  // instead of the original sender(s). No `@` / no match → reply to senders as usual.
  const peer = reply ? resolvePeerAddress(reply, channel.listMembers(), handle) : null
  let repliedTo: string[] = []
  if (reply && peer) {
    channel.insertMessage({ to: peer.to, from: handle, body: peer.body, type: 'status' })
    repliedTo = [peer.to]
    print?.(`[worker] ${agent} addressed ${peer.to}`)
  } else if (reply) {
    for (const to of senders) {
      channel.insertMessage({ to, from: handle, body: reply, type: 'status' })
    }
    repliedTo = senders
    print?.(`[worker] ${agent} replied to ${senders.join(', ')}`)
  } else {
    print?.(`[worker] ${agent} produced no reply text (isError=${turn.isError})`)
  }

  // ACK the drained messages so they are not re-processed next cycle. Done after
  // the turn + reply so a crash mid-turn leaves them unread (re-tried) rather
  // than silently dropped.
  channel.markRead(messages.map((m) => m.id))

  return {
    processed: messages.length,
    reply: reply || undefined,
    sessionId: turn.sessionId ?? deps.sessionId,
    repliedTo
  }
}

export type WorkerOptions = {
  channel: Channel
  handle: string
  agent: HeadlessProvider
  role: string
  cwd: string
  model?: string
  /** Poll interval in ms between inbox drains. */
  pollMs?: number
  /** Run a single cycle then return (for smoke tests). */
  once?: boolean
  /** Test seam: override the turn runner. */
  runTurn?: TurnRunner
  /** Where status lines go (default: stderr). */
  print?: (s: string) => void
  /** Test seam: a sleeper so loops don't actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** Whether this member is a live (human/interactive) or headless worker (default: 'headless'). */
  kind?: 'live' | 'headless'
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Default turn runner: build the argv then spawn a real headless turn. */
const realTurnRunner: TurnRunner = async (input) => {
  const { command, args } = buildHeadlessArgv({
    agent: input.provider,
    prompt: input.prompt,
    model: input.model,
    resumeSessionId: input.resumeSessionId
  })
  const outcome = await runHeadlessTurn({
    provider: input.provider,
    command,
    args,
    cwd: input.cwd
  })
  return { finalText: outcome.finalText, sessionId: outcome.sessionId, isError: outcome.isError }
}

/**
 * Run the worker loop until the process is killed (or one cycle when once=true).
 * On start it registers itself in the channel's roster (addMember, kind=headless),
 * reads the roster (listMembers), and builds the team briefing ONCE — the briefing
 * is then prepended to every per-turn prompt.
 */
export async function runWorker(opts: WorkerOptions): Promise<void> {
  const print = opts.print ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const sleep = opts.sleep ?? defaultSleep
  const pollMs = opts.pollMs ?? 3000
  const runTurn = opts.runTurn ?? realTurnRunner

  // Self-register in the channel roster so teammates discover this worker.
  const self: Member = {
    handle: opts.handle,
    agent: opts.agent,
    role: opts.role,
    kind: opts.kind ?? 'headless',
    status: 'active',
    worktree: opts.cwd
  }
  opts.channel.addMember(self)

  print(
    `[worker] online as ${opts.handle} (agent=${opts.agent}, role=${opts.role}, cwd=${opts.cwd}, poll=${pollMs}ms)`
  )

  let sessionId: string | undefined
  for (;;) {
    try {
      const briefing = buildRosterBriefing(opts.channel, opts.handle, opts.role)
      const cycle = await runWorkerCycle({
        channel: opts.channel,
        handle: opts.handle,
        agent: opts.agent,
        cwd: opts.cwd,
        model: opts.model,
        runTurn,
        sessionId,
        print,
        briefing
      })
      sessionId = cycle.sessionId
    } catch (err) {
      print(`[worker] cycle error: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (opts.once) {
      return
    }
    await sleep(pollMs)
  }
}
