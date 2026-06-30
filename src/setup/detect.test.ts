import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectHarnesses } from './detect.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-detect-'))
  return dir
}

describe('detectHarnesses', () => {
  it('codex detected via PATH, cursor via configHint, claude+opencode absent', () => {
    const home = tempDir()
    // Seed .cursor/ so cursor is detected via configHints
    mkdirSync(join(home, '.cursor'), { recursive: true })

    // onPath returns true only for 'codex'
    const onPath = (bin: string) => bin === 'codex'

    const results = detectHarnesses({ home, onPath })

    const byId = Object.fromEntries(results.map((r) => [r.spec.id, r]))

    // codex: present via PATH
    expect(byId['codex'].present).toBe(true)
    expect(byId['codex'].reason).toMatch(/path/i)

    // cursor: present via configHints
    expect(byId['cursor'].present).toBe(true)
    expect(byId['cursor'].reason).toMatch(/config/i)

    // claude: absent
    expect(byId['claude'].present).toBe(false)

    // opencode: absent
    expect(byId['opencode'].present).toBe(false)
  })

  it('all present when onPath returns true for all bins', () => {
    const home = tempDir()
    const onPath = (_bin: string) => true

    const results = detectHarnesses({ home, onPath })
    expect(results.every((r) => r.present)).toBe(true)
    expect(results.map((r) => r.spec.id).sort()).toEqual([
      'claude', 'cline', 'codex', 'continue', 'copilot', 'cursor',
      'kiro', 'opencode', 'windsurf', 'zed',
    ])
  })

  it('harness present via configHint when bin not on path', () => {
    const home = tempDir()
    // Seed .config/opencode dir to trigger opencode detection via configHints
    mkdirSync(join(home, '.config/opencode'), { recursive: true })

    const onPath = (_bin: string) => false

    const results = detectHarnesses({ home, onPath })
    const byId = Object.fromEntries(results.map((r) => [r.spec.id, r]))

    expect(byId['opencode'].present).toBe(true)
    expect(byId['opencode'].reason).toMatch(/config/i)
    expect(byId['claude'].present).toBe(false)
    expect(byId['codex'].present).toBe(false)
    expect(byId['cursor'].present).toBe(false)
  })

  it('returns all 10 harness specs regardless of detection result', () => {
    const home = tempDir()
    const onPath = (_bin: string) => false
    const results = detectHarnesses({ home, onPath })
    expect(results).toHaveLength(10)
    const ids = results.map((r) => r.spec.id).sort()
    expect(ids).toEqual([
      'claude', 'cline', 'codex', 'continue', 'copilot', 'cursor',
      'kiro', 'opencode', 'windsurf', 'zed',
    ])
  })

  it('reason string explains which signal fired for PATH detection', () => {
    const home = tempDir()
    const onPath = (bin: string) => bin === 'claude'
    const results = detectHarnesses({ home, onPath })
    const claude = results.find((r) => r.spec.id === 'claude')!
    expect(claude.present).toBe(true)
    expect(claude.reason).toContain('claude')
  })

  it('reason string explains which configHint file fired', () => {
    const home = tempDir()
    // .codex dir triggers codex
    mkdirSync(join(home, '.codex'), { recursive: true })
    const onPath = (_bin: string) => false
    const results = detectHarnesses({ home, onPath })
    const codex = results.find((r) => r.spec.id === 'codex')!
    expect(codex.present).toBe(true)
    // reason should mention a config hint
    expect(codex.reason).toMatch(/config|\.codex/i)
  })
})
