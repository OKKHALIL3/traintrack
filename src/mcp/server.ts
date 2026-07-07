// ─── Traintrack stdio MCP server ─────────────────────────────────────────────
// A tiny stdio MCP (Model Context Protocol) server that the lead's TUI talks to.
// It exposes four tools — spawn_worker, await_results, send_message,
// check_messages — each operating directly on a local SQLite Channel. There is
// no RuntimeClient and no Orca runtime here: this process OWNS its Channel.
//
// The lead's own handle (used as `from` on outgoing messages and `to` for the
// inbox it drains) is TRAINTRACK_HANDLE, defaulting to 'lead'. The Channel db path is
// TRAINTRACK_CHANNEL, defaulting to <cwd>/.traintrack/channel.db.
//
// MCP transport is newline-delimited JSON-RPC 2.0 over stdio. The protocol
// surface we need is small (initialize, tools/list, tools/call, ping, the
// initialized notification), so this is hand-rolled rather than pulling in the
// SDK. The protocol logic is split from the stdin/stdout wiring so it is
// unit-testable without a process.

import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { Channel } from '../channel/channel.js'
import { resolveChannelPath } from '../channel/resolve.js'
import { spawnWorker } from '../spawn/spawn.js'
import {
  TOOLS,
  type ToolDeps,
  type ToolResult,
  spawnWorkerTool,
  awaitResultsTool,
  sendMessageTool,
  checkMessagesTool,
  listTeamTool,
  delegateTaskTool,
  joinTeamTool,
} from './tools.js'

const SERVER_NAME = 'traintrack'
const SERVER_VERSION = '0.1.0'
// The MCP protocol version we implement. We echo the client's requested version
// when present (forward-compat with newer clients) and fall back to this.
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

type JsonRpcId = string | number | null
type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
}
export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'spawn_worker':
        return await spawnWorkerTool(args, deps)
      case 'await_results':
        return await awaitResultsTool(args, deps)
      case 'send_message':
        return await sendMessageTool(args, deps)
      case 'check_messages':
        return await checkMessagesTool(args, deps)
      case 'list_team':
        return listTeamTool(deps)
      case 'delegate_task': {
        const to = typeof args.to === 'string' ? args.to.trim() : ''
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        if (!to || !task) {
          return errorResult('"to" (a teammate handle) and "task" are both required.')
        }
        return delegateTaskTool(deps, to, task)
      }
      case 'join_team': {
        const handle = typeof args.handle === 'string' ? args.handle.trim() : ''
        const role = typeof args.role === 'string' ? args.role.trim() : ''
        const agent = typeof args.agent === 'string' ? args.agent.trim() : undefined
        if (!handle || !role) {
          return errorResult('"handle" and "role" are both required to join a team.')
        }
        return joinTeamTool(deps, handle, role, agent)
      }
      default:
        return errorResult(`Unknown tool: ${name}`)
    }
  } catch (error) {
    // Why: a tool (e.g. spawnWorker's git worktree add) can throw. Surface it as
    // an isError result so the model sees the failure text rather than the
    // transport dropping the call.
    const detail = error instanceof Error ? error.message : String(error)
    return errorResult(`Tool "${name}" failed: ${detail}`)
  }
}

/** Handle one parsed JSON-RPC message. Returns the response to write, or null
 *  for notifications (no id) — which get no reply. Pure except for the injected
 *  deps (Channel + spawnWorker), so it is fully unit-testable. */
export async function handleMessage(
  req: JsonRpcRequest,
  deps: ToolDeps
): Promise<JsonRpcResponse | null> {
  // A JSON-RPC notification omits `id` — process side effects, send nothing
  // back. This covers notifications/initialized and any other notification.
  if (req.id === undefined) {
    return null
  }
  const id = req.id
  const method = req.method
  if (method === 'initialize') {
    const requested = req.params?.protocolVersion
    const protocolVersion = typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION
    return ok(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    })
  }
  if (method === 'ping') {
    return ok(id, {})
  }
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS })
  }
  if (method === 'tools/call') {
    const name = typeof req.params?.name === 'string' ? req.params.name : ''
    const args =
      req.params?.arguments && typeof req.params.arguments === 'object'
        ? (req.params.arguments as Record<string, unknown>)
        : {}
    return ok(id, withUnreadNudge(await callTool(name, args, deps), name, deps))
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method ?? ''}` },
  }
}

/** Build the tool deps from the environment AND auto-join this live session to
 *  its project team. The channel is resolved to the GIT REPO ROOT (so every
 *  session in a project shares one team — see resolveChannelPath). The session's
 *  handle is TRAINTRACK_HANDLE or a freshly-minted `<agent>-<rand>`, its agent is
 *  TRAINTRACK_AGENT (default 'claude'), and it registers itself as a live member
 *  on startup so teammates see it immediately. */
export function buildDepsFromEnv(): ToolDeps {
  const dbPath = resolveChannelPath()
  const channel = new Channel(dbPath)
  const agent = process.env['TRAINTRACK_AGENT'] ?? 'claude'
  const role = process.env['TRAINTRACK_ROLE'] ?? 'lead'
  const handle = process.env['TRAINTRACK_HANDLE'] ?? `${agent}-${randomBytes(3).toString('hex')}`
  // Auto-presence: this hand-driven session joins its project team on startup so
  // teammates discover it with zero fiddling (no explicit join / channel path).
  channel.addMember({ handle, agent, role, kind: 'live', status: 'active', worktree: process.cwd() })
  return { self: handle, channel, spawnWorker }
}

/** Append a one-line "you have mail" nudge to a tool result when the session has
 *  unread messages — so a live agent learns of teammate messages the moment it
 *  uses any tool, without a fragile per-turn OS hook. check_messages/await_results
 *  already surface messages, so they are skipped. */
export function withUnreadNudge(result: ToolResult, name: string, deps: ToolDeps): ToolResult {
  if (name === 'check_messages' || name === 'await_results') return result
  let unread = 0
  try {
    unread = deps.channel.getUnread(deps.self).length
  } catch {
    return result
  }
  if (unread === 0) return result
  const note = `\n\n📨 ${unread} unread message${unread === 1 ? '' : 's'} from teammates — call check_messages to read ${unread === 1 ? 'it' : 'them'}.`
  const content = result.content.length ? result.content : [{ type: 'text' as const, text: '' }]
  const last = content[content.length - 1]
  return {
    ...result,
    content: [...content.slice(0, -1), { type: 'text' as const, text: (last.text || '') + note }],
  }
}

/** Run the stdio MCP loop until the input stream closes. Reads newline-delimited
 *  JSON-RPC requests and writes newline-delimited responses. Streams + deps are
 *  injectable so the full loop (readline framing → handler) is testable
 *  end-to-end; the defaults wire the real process stdio + env. */
export function runTraintrackMcpServer(
  io: {
    input?: NodeJS.ReadableStream
    output?: Pick<NodeJS.WritableStream, 'write'>
    deps?: ToolDeps
  } = {}
): void {
  const deps = io.deps ?? buildDepsFromEnv()
  const usingRealStdin = !io.input
  const input = io.input ?? process.stdin
  const output = io.output ?? process.stdout
  const rl = createInterface({ input })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    let req: JsonRpcRequest
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`
      )
      return
    }
    void handleMessage(req, deps).then((res) => {
      if (res) {
        output.write(`${JSON.stringify(res)}\n`)
      }
    })
  })
  rl.on('close', () => {
    // Mark this session offline so teammates' rosters reflect it leaving.
    try {
      deps.channel.setStatus(deps.self, 'offline')
    } catch {
      // best-effort; never block shutdown
    }
    // Only tear the process down when we own the real stdin; an injected stream
    // closing (a test) must not kill the host process.
    if (usingRealStdin) {
      process.exit(0)
    }
  })
}
