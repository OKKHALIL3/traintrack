// ─── Traintrack MCP tools ─────────────────────────────────────────────────────
// The four coordination tools the lead's TUI drives over a local Channel:
//   spawn_worker(agent, role, task) — hand out work to a fresh worker
//   await_results(timeoutMs?)       — block for the workers' replies
//   send_message(to, body)          — fire-and-forget message to one handle
//   check_messages()                — drain this lead's unread inbox
//
// Each tool takes its dependencies (the lead's own handle, the Channel, the
// spawnWorker impl, and a sleep) injected, so they are unit-testable against a
// real temp-file Channel with a faked spawnWorker and an instant sleep — no
// process, no readline, no protocol shell.

import type { Channel, Message } from '../channel/channel.js'
import { gitRoot } from '../channel/resolve.js'
import type { SpawnWorkerOptions, SpawnWorkerResult } from '../spawn/spawn.js'

/** A single tool-call result, MCP shape. Errors are returned as a normal result
 *  with isError:true so the calling model SEES the failure text rather than a
 *  transport-level JSON-RPC error. */
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

/** The spawnWorker function shape the tool needs — matches src/spawn/spawn.ts's
 *  signature but typed loosely here so a test can inject a fake. */
export type SpawnWorkerFn = (opts: SpawnWorkerOptions) => Promise<SpawnWorkerResult>

/** Dependencies injected into every tool: the lead's own handle (`self`), the
 *  Channel it owns, the spawnWorker impl, and a sleep used by the await poll. */
export type ToolDeps = {
  self: string
  channel: Channel
  spawnWorker: SpawnWorkerFn
  /** Async sleep; injectable so tests run the poll loop without real delay. */
  sleep?: (ms: number) => Promise<void>
}

/** The MCP tool definitions advertised by tools/list. */
export const TOOLS = [
  {
    name: 'spawn_worker',
    description:
      "Spawn a new worker agent of the given type and role in its own git worktree, and assign it a task. Returns the new worker's handle so you can reference it later. As lead, call spawn_worker to hand out work, then call await_results to block until the workers reply with their results.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'The agent type to spawn — "claude" or "codex" (beta), or "cursor"/"opencode" (alpha).',
        },
        role: {
          type: 'string',
          description: 'The role name for the new worker, e.g. "api", "ui", "tests".',
        },
        task: { type: 'string', description: 'The initial task to assign to the spawned worker.' },
      },
      required: ['agent', 'role', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'await_results',
    description:
      "Block until a worker replies with results (or the timeout expires). Use this AFTER calling spawn_worker to collect the workers' replies. Returns the formatted replies addressed to you, or a timeout message if none arrive in time.",
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description:
            'How long to wait for results in milliseconds. Defaults to 120000 (2 minutes).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to another agent in this workspace. It is posted to that agent in the BACKGROUND via the channel — they read it on their own cadence with check_messages — so it never interrupts them.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The recipient worker handle.' },
        body: { type: 'string', description: 'The message text to send.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_messages',
    description:
      'Read and consume the unread messages addressed to you — anything your workers have sent, including their results. This marks them read so you do not see them again. Use it to catch up without blocking.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_team',
    description:
      'List all teammates currently registered in this workspace — their handles, agent types, roles, and status. Use this to see who you can delegate to before calling delegate_task, or after spawn_worker to confirm a new worker is registered.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delegate_task',
    description:
      'Assign a task to an existing teammate by handle. This posts a task message to their inbox via the channel — they pick it up on their own cadence. Use list_team to see valid handles, spawn_worker to add a new teammate, then await_results to collect their reply.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The handle of the teammate to delegate to (must already exist in the team).' },
        task: { type: 'string', description: 'The task description to assign to the teammate.' },
      },
      required: ['to', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'join_team',
    description:
      'Join an EXISTING team as a live member. Use this when you are NOT the lead — e.g. a human added your session to a running team and you should start receiving its messages. Registers you in the shared roster under the given handle and role so teammates can reach you, and binds this session to that handle. After joining, call check_messages to pick up anything addressed to you.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The unique handle to register yourself under, e.g. "reviewer".' },
        role: { type: 'string', description: 'Your role on the team, e.g. "reviewer", "qa".' },
        agent: { type: 'string', description: 'Optional: your agent type (claude, codex, cursor, opencode; defaults to "claude").' },
      },
      required: ['handle', 'role'],
      additionalProperties: false,
    },
  },
] as const

const VALID_AGENTS = ['claude', 'codex', 'cursor', 'opencode'] as const

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatMessage(m: Message): string {
  return `- [${m.id}] from ${m.from}: ${m.body}`
}

/** Drain a non-empty batch of unread messages: mark them read and format. */
function drain(messages: Message[], channel: Channel, header: string): ToolResult {
  channel.markRead(messages.map((m) => m.id))
  return textResult(`${header}:\n${messages.map(formatMessage).join('\n')}`)
}

export async function spawnWorkerTool(
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  const agent = typeof args.agent === 'string' ? args.agent.trim() : ''
  const role = typeof args.role === 'string' ? args.role.trim() : ''
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (!agent || !role || !task) {
    return errorResult('"agent", "role", and "task" are all required.')
  }
  if (!(VALID_AGENTS as readonly string[]).includes(agent)) {
    return errorResult(`Unknown agent "${agent}". Valid agents: ${VALID_AGENTS.join(', ')}.`)
  }
  const { handle } = await deps.spawnWorker({
    channel: deps.channel,
    // Worktrees must be created from the git root, even if the lead session is in
    // a subdirectory of the project.
    repoRoot: gitRoot(process.cwd()) ?? process.cwd(),
    agent,
    role,
    task,
    leadHandle: deps.self,
  })
  return textResult(
    `Spawned ${agent} worker (${role}) as ${handle}. Call await_results to collect their reply.`
  )
}

export async function sendMessageTool(
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  const to = typeof args.to === 'string' ? args.to.trim() : ''
  const body = typeof args.body === 'string' ? args.body : ''
  if (!to || !body.trim()) {
    return errorResult('Both "to" (a worker handle) and "body" are required.')
  }
  deps.channel.insertMessage({ to, from: deps.self, body })
  return textResult(`Sent to ${to}. They'll pick it up with check_messages — it does not interrupt them.`)
}

export async function checkMessagesTool(
  _args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  const msgs = deps.channel.getUnread(deps.self)
  if (msgs.length === 0) {
    return textResult('No messages.')
  }
  return drain(msgs, deps.channel, 'Messages')
}

export function listTeamTool(deps: ToolDeps): ToolResult {
  const members = deps.channel.listMembers()
  if (members.length === 0) {
    return { content: [{ type: 'text', text: 'No teammates yet. Use spawn_worker to recruit one.' }] }
  }
  const lines = members.map((m) => `- ${m.handle} (${m.agent}, role: ${m.role}, ${m.status})`).join('\n')
  return { content: [{ type: 'text', text: `Team:\n${lines}` }] }
}

export function delegateTaskTool(deps: ToolDeps, to: string, task: string): ToolResult {
  if (!deps.channel.getMember(to)) {
    const valid = deps.channel.listMembers().map((m) => m.handle).join(', ') || '(none)'
    return { content: [{ type: 'text', text: `No teammate "${to}". Valid: ${valid}. Use list_team / spawn_worker.` }], isError: true }
  }
  deps.channel.insertMessage({ to, from: deps.self, body: task, type: 'task' })
  return { content: [{ type: 'text', text: `Delegated to ${to}. Call await_results to collect the reply.` }] }
}

export function joinTeamTool(
  deps: ToolDeps,
  handle: string,
  role: string,
  agent?: string
): ToolResult {
  // Guard against clobbering an existing member — addMember is INSERT OR REPLACE,
  // so joining under a taken handle (e.g. "lead" or a running worker) would
  // silently overwrite that member's roster row and scramble addressing. Reject
  // instead; handles must be unique on the team.
  const existing = deps.channel.getMember(handle)
  if (existing) {
    return errorResult(
      `Handle "${handle}" is already taken (a ${existing.kind} member, role: ${existing.role}). Pick a different handle — handles must be unique on the team.`
    )
  }
  const a = agent && (VALID_AGENTS as readonly string[]).includes(agent) ? agent : 'claude'
  deps.channel.addMember({ handle, agent: a, role, kind: 'live', status: 'active', worktree: null })
  deps.self = handle
  const lines = deps.channel
    .listMembers()
    .map((m) => `- ${m.handle} (${m.agent}, role: ${m.role}, ${m.status})`)
    .join('\n')
  return textResult(
    `Joined the team as ${handle} (role: ${role}). You are now a LIVE member — messages addressed to ${handle} land in your inbox; call check_messages whenever you finish a unit of work so you never miss one. Team:\n${lines}`
  )
}

export async function awaitResultsTool(
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 120000
  const sleep = deps.sleep ?? realSleep
  const deadline = Date.now() + timeoutMs
  // Poll every ~250ms for new replies; return the first non-empty batch (marking
  // it read) or fall out to the timeout message once the deadline passes. We
  // always poll at least once, so a pre-seeded message returns immediately.
  for (;;) {
    const msgs = deps.channel.getUnread(deps.self)
    if (msgs.length > 0) {
      return drain(msgs, deps.channel, 'Worker results')
    }
    if (Date.now() >= deadline) {
      return textResult('No results within the timeout.')
    }
    await sleep(250)
  }
}
