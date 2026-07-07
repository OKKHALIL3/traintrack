#!/usr/bin/env node
// ─── traintrack CLI ──────────────────────────────────────────────────────────
// The `traintrack` binary (package.json "bin"). Two subcommands:
//
//   traintrack init [--channel <path>]
//     Create .traintrack/ and an empty channel db so the workspace is ready for the
//     lead's MCP server and any workers to attach to.
//
//   traintrack worker --agent <claude|codex> --role <role> --handle <handle> [--model <model>] [--channel <path>]
//     Run a long-lived headless worker loop bound to the channel — it drains its
//     inbox, runs a headless agent turn per batch, and replies over the channel.
//
// Flag parsing mirrors traintrack-desktop's `headless-worker` block: a small
// `flag(name)` helper over argv, with the agent validated to the two providers.

import { Channel } from './channel/channel.js'
import { resolveChannelPath } from './channel/resolve.js'
import { runWorker } from './worker/worker.js'
import { runSetup } from './setup/setup.js'
import { renderBanner, bannerColorEnabled } from './ui/banner.js'
import { VERSION } from './index.js'
import type { HeadlessProvider } from './runner/event-parser.js'

const USAGE = `Usage:
  traintrack setup [--all] [--yes] [--dry-run] [--tools-only] [--uninstall] [--home <path>]
  traintrack team [--room <name>] [--channel <path>]
  traintrack inbox --handle <handle> [--room <name>] [--channel <path>]
  traintrack init [--room <name>] [--channel <path>]
  traintrack worker --agent <claude|codex|cursor|opencode> --role <role> --handle <handle> [--model <model>] [--channel <path>]
  traintrack join --handle <handle> --role <role> [--agent <claude|codex|cursor|opencode>] [--room <name>] [--channel <path>]`

/** Read the value following a `--name` flag in argv, or undefined if absent. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

/** True if a boolean `--name` flag is present in argv. */
function has(args: string[], name: string): boolean {
  return args.includes(name)
}

/** Resolve the channel db path from --channel / --room flags, else the git-root
 *  default (so sessions in a project auto-share a team). */
function channelFromArgs(args: string[]): string {
  return resolveChannelPath({ channel: flag(args, '--channel'), room: flag(args, '--room') })
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** Print the branded banner to stdout (colorized only on a real terminal). */
function showBanner(): void {
  process.stdout.write(
    renderBanner({ version: VERSION, color: bannerColorEnabled(process.stdout) }),
  )
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0]
  const args = argv.slice(1)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showBanner()
    process.stdout.write(`${USAGE}\n`)
    return
  }

  if (command === 'setup') {
    showBanner()
    // TRAINTRACK_SETUP_NO_PATH=1 forces config-hint-only detection (ignores the
    // real PATH) so the hermetic verify script exercises exactly the seeded HOME.
    const noPath = process.env['TRAINTRACK_SETUP_NO_PATH'] === '1'
    await runSetup({
      all: has(args, '--all'),
      yes: has(args, '--yes'),
      dryRun: has(args, '--dry-run'),
      toolsOnly: has(args, '--tools-only'),
      uninstall: has(args, '--uninstall'),
      home: flag(args, '--home'),
      ...(noPath ? { onPath: () => false } : {}),
    })
    return
  }

  if (command === 'init') {
    // Opening a Channel creates .traintrack/ (mkdir recursive) and the db file with
    // its schema; close it immediately — init just provisions the workspace.
    const channelPath = channelFromArgs(args)
    new Channel(channelPath).close()
    process.stdout.write(`Initialized traintrack channel at ${channelPath}\n`)
    return
  }

  if (command === 'team') {
    // Show everyone on this project's team and where the channel lives.
    const channelPath = channelFromArgs(args)
    const channel = new Channel(channelPath)
    const members = channel.listMembers()
    channel.close()
    process.stdout.write(`Team channel: ${channelPath}\n`)
    if (members.length === 0) {
      process.stdout.write('No members yet. Open a traintrack-aware session here, or spawn a worker.\n')
      return
    }
    for (const m of members) {
      process.stdout.write(`  - ${m.handle}  (${m.agent}, role: ${m.role}, ${m.kind}, ${m.status})\n`)
    }
    return
  }

  if (command === 'inbox') {
    // Print the unread messages addressed to a handle (does NOT mark them read).
    const handle = flag(args, '--handle') ?? process.env['TRAINTRACK_HANDLE']
    if (!handle) {
      fail('inbox: --handle is required (or set TRAINTRACK_HANDLE)')
    }
    const channel = new Channel(channelFromArgs(args))
    const msgs = channel.getUnread(handle)
    channel.close()
    if (msgs.length === 0) {
      process.stdout.write(`No unread messages for ${handle}.\n`)
      return
    }
    process.stdout.write(`${msgs.length} unread for ${handle}:\n`)
    for (const m of msgs) {
      process.stdout.write(`  [${m.id}] from ${m.from}: ${m.body}\n`)
    }
    return
  }

  if (command === 'worker') {
    const agentRaw = flag(args, '--agent')
    if (agentRaw !== 'claude' && agentRaw !== 'codex' && agentRaw !== 'cursor' && agentRaw !== 'opencode') {
      fail('worker: --agent must be one of: claude, codex, cursor, opencode')
    }
    const agent: HeadlessProvider = agentRaw
    const role = flag(args, '--role')
    if (!role) {
      fail('worker: --role is required')
    }
    const handle = flag(args, '--handle')
    if (!handle) {
      fail('worker: --handle is required')
    }
    const channel = new Channel(channelFromArgs(args))
    // Model is passed straight through to the agent CLI each turn; absent → provider default.
    const model = flag(args, '--model')
    await runWorker({ channel, handle, agent, role, cwd: process.cwd(), model })
    return
  }

  if (command === 'join') {
    const agentRaw = flag(args, '--agent') ?? 'codex'
    if (agentRaw !== 'claude' && agentRaw !== 'codex' && agentRaw !== 'cursor' && agentRaw !== 'opencode') {
      fail('join: --agent must be one of: claude, codex, cursor, opencode')
    }
    const agent: HeadlessProvider = agentRaw
    const role = flag(args, '--role')
    if (!role) {
      fail('join: --role is required')
    }
    const handle = flag(args, '--handle')
    if (!handle) {
      fail('join: --handle is required')
    }
    const channel = new Channel(channelFromArgs(args))
    // Reject a duplicate handle rather than clobber the existing member (addMember
    // is INSERT OR REPLACE). Handles must be unique on the team.
    if (channel.getMember(handle)) {
      fail(`join: handle "${handle}" is already on the team — pick a unique --handle`)
    }
    // A LIVE member the user launched and joined to an existing team. It auto-checks
    // its inbox on the same responsive loop as a worker, so it never misses a message.
    await runWorker({ channel, handle, agent, role, cwd: process.cwd(), kind: 'live' })
    return
  }

  fail(USAGE)
}

main(process.argv.slice(2)).catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
})
