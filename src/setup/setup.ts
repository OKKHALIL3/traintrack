// runSetup / runUninstall orchestrators: detect harnesses, let the user choose
// (or --all), configure (or --uninstall) each, and print a summary. Never throws
// on a single harness failing — that harness becomes an 'error' outcome.
import { homedir } from 'node:os'
import type { ConfigOutcome, HarnessId, HarnessSpec, SetupContext } from './types.js'
import { resolveServerPath } from './types.js'
import { detectHarnesses, defaultOnPath } from './detect.js'
import { configureHarness, unconfigureHarness } from './configure.js'
import { multiSelect, confirm } from './prompt.js'
import type { PromptIO } from './prompt.js'

export type SetupOptions = {
  home?: string
  all?: boolean
  yes?: boolean
  dryRun?: boolean
  toolsOnly?: boolean
  uninstall?: boolean
  /** Override binary-on-PATH probing. Injected so callers (tests, the hermetic
   *  verify script) can force config-hint-only detection. Defaults to defaultOnPath. */
  onPath?: (bin: string) => boolean
  io?: { input?: NodeJS.ReadableStream; output?: { write(s: string): void } }
}

/** Resolve the output sink — defaults to process.stdout. */
function out(opts: SetupOptions): { write(s: string): void } {
  return opts.io?.output ?? process.stdout
}

/** Run one harness through configure/unconfigure, capturing any throw as an
 *  'error' outcome so a single bad harness never aborts the whole run. */
function applyOne(
  spec: HarnessSpec,
  ctx: SetupContext,
  uninstall: boolean,
): ConfigOutcome {
  try {
    return uninstall ? unconfigureHarness(spec, ctx) : configureHarness(spec, ctx)
  } catch (err) {
    return {
      harness: spec.id,
      mcp: 'error',
      awareness: 'error',
      command: 'error',
      files: [],
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Print a per-harness summary table plus a closing note. */
function printSummary(
  io: { write(s: string): void },
  outcomes: ConfigOutcome[],
  ctx: SetupContext,
  uninstall: boolean,
): void {
  io.write('\n')
  for (const o of outcomes) {
    io.write(
      `  ${o.harness.padEnd(9)} mcp:${o.mcp.padEnd(10)} awareness:${o.awareness.padEnd(10)} command:${o.command}\n`,
    )
    if (o.detail) io.write(`    ${o.detail}\n`)
    for (const f of o.files) io.write(`    → ${f}\n`)
  }
  io.write('\n')
  if (ctx.dryRun) {
    io.write('Dry run — no files were written.\n')
    return
  }
  if (uninstall) {
    io.write('Removed traintrack from the selected tools.\n')
    return
  }
  const names = outcomes.map((o) => o.harness).join(', ')
  io.write(
    `Done. Open ${names} and ask it to spawn a worker — e.g. "spawn a codex worker to write tests".\n`,
  )
}

/**
 * Detect installed harnesses, choose targets (interactively unless --all),
 * and configure (or uninstall) traintrack for each. Returns the outcomes.
 */
export async function runSetup(opts: SetupOptions): Promise<ConfigOutcome[]> {
  const io = out(opts)
  const ctx: SetupContext = {
    home: opts.home ?? homedir(),
    serverPath: resolveServerPath(import.meta.url),
    nodePath: process.execPath,
    dryRun: opts.dryRun ?? false,
    injectAwareness: !opts.toolsOnly,
  }

  const detected = detectHarnesses({ home: ctx.home, onPath: opts.onPath ?? defaultOnPath })
  const present = detected.filter((d) => d.present)

  if (present.length === 0) {
    io.write(
      'No supported agent CLIs detected.\n' +
        'Install one (Claude Code, Codex, Cursor, OpenCode, Windsurf, Cline, Kiro, Zed, Continue, or Copilot) and re-run `traintrack setup`.\n',
    )
    return []
  }

  // Choose targets.
  let chosen: HarnessId[]
  if (opts.all) {
    chosen = present.map((d) => d.spec.id)
  } else {
    const promptIo: PromptIO = { input: opts.io?.input, output: io }
    const verb = opts.uninstall ? 'remove traintrack from' : 'wire traintrack into'
    const ids = await multiSelect(
      `Which tools should we ${verb}?`,
      present.map((d) => ({ id: d.spec.id, label: d.spec.displayName, hint: d.reason })),
      promptIo,
    )
    chosen = ids as HarnessId[]
    if (chosen.length === 0) {
      io.write('Nothing selected — exiting.\n')
      return []
    }
    if (!opts.yes) {
      const ok = await confirm(`${opts.uninstall ? 'Remove from' : 'Configure'} ${chosen.join(', ')}?`, promptIo)
      if (!ok) {
        io.write('Cancelled.\n')
        return []
      }
    }
  }

  const chosenSpecs = present
    .filter((d) => chosen.includes(d.spec.id))
    .map((d) => d.spec)

  const outcomes: ConfigOutcome[] = []
  for (const spec of chosenSpecs) {
    outcomes.push(applyOne(spec, ctx, opts.uninstall ?? false))
  }

  printSummary(io, outcomes, ctx, opts.uninstall ?? false)
  return outcomes
}

/** Convenience wrapper for the uninstall path. */
export async function runUninstall(opts: SetupOptions): Promise<ConfigOutcome[]> {
  return runSetup({ ...opts, uninstall: true })
}
