import { existsSync, statSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import type { HarnessSpec } from './types.js'
import { HARNESSES } from './harness.js'

export type Detected = {
  spec: HarnessSpec
  present: boolean
  reason: string
}

/** Detect which harnesses are available.
 *
 * @param args.home       - The user's home directory to probe configHints under.
 * @param args.onPath     - A function that returns true if a binary is executable on PATH.
 *                          Injected so tests can stub without touching the real filesystem or PATH.
 */
export function detectHarnesses(args: {
  home: string
  onPath: (bin: string) => boolean
}): Detected[] {
  const { home, onPath } = args

  return HARNESSES.map((spec): Detected => {
    // 1. Check bins on PATH
    for (const bin of spec.bins) {
      if (onPath(bin)) {
        return { spec, present: true, reason: `found '${bin}' on PATH` }
      }
    }

    // 2. Check configHints under home
    for (const hint of spec.configHints) {
      const abs = join(home, hint)
      if (existsSync(abs)) {
        return { spec, present: true, reason: `config hint found: ${abs}` }
      }
    }

    return { spec, present: false, reason: 'not found on PATH and no config hints present' }
  })
}

/** Real implementation: scan process.env.PATH directories for an executable named `bin`.
 *  No shelling out — pure Node.js fs checks. */
export function defaultOnPath(bin: string): boolean {
  const pathEnv = process.env['PATH'] ?? ''
  // Use the platform PATH separator (':' on POSIX, ';' on Windows). traintrack
  // targets macOS/Linux (see package.json "os"), but splitting on path.delimiter
  // keeps this correct rather than relying on a hardcoded ':'.
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0)

  for (const dir of dirs) {
    const candidate = join(dir, bin)
    try {
      const st = statSync(candidate)
      if (st.isFile()) {
        // Check executable bit: owner (0o100), group (0o010), or other (0o001)
        const mode = st.mode
        if (mode & 0o111) return true
      }
    } catch {
      // ENOENT or EACCES — not found in this dir, continue
    }
  }

  return false
}
