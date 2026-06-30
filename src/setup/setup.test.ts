import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, PassThrough } from 'node:stream'
import { runSetup } from './setup.js'
import { multiSelect, confirm, applySelect, keyToAction } from './prompt.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/** A temp HOME seeded so all 4 harnesses detect as present via configHints. */
function seededHome(): string {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-setup-'))
  mkdirSync(join(dir, '.codex'), { recursive: true })
  writeFileSync(join(dir, '.codex/config.toml'), 'model = "gpt-5"\n')
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { keep: { command: 'x' } } }))
  mkdirSync(join(dir, '.cursor'), { recursive: true })
  mkdirSync(join(dir, '.config/opencode'), { recursive: true })
  writeFileSync(join(dir, '.config/opencode/opencode.json'), JSON.stringify({ theme: 'dark' }))
  return dir
}

/** A silent output sink so runSetup's printing never hits the console in tests. */
function sink(): { write(s: string): void } {
  return { write() {} }
}

describe('runSetup — --all --yes', () => {
  it('returns 4 outcomes all mcp "added" and writes the entries', async () => {
    const home = seededHome()
    const out = await runSetup({ home, all: true, yes: true, onPath: () => false, io: { output: sink() } })
    expect(out).toHaveLength(4)
    expect(out.every((o) => o.mcp === 'added')).toBe(true)

    const codex = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    expect(codex).toContain('[mcp_servers.traintrack]')
    expect(codex).toContain('model = "gpt-5"')

    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.traintrack).toBeDefined()
    expect(claude.mcpServers.keep).toEqual({ command: 'x' })

    const cursor = JSON.parse(readFileSync(join(home, '.cursor/mcp.json'), 'utf8'))
    expect(cursor.mcpServers.traintrack).toBeDefined()

    const opencode = JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8'))
    expect(opencode.mcp.traintrack).toBeDefined()
    expect(opencode.mcp.traintrack.type).toBe('local')
    expect(opencode.theme).toBe('dark')
  })

  it('re-run → all mcp "unchanged"', async () => {
    const home = seededHome()
    await runSetup({ home, all: true, yes: true, io: { output: sink() } })
    const out = await runSetup({ home, all: true, yes: true, io: { output: sink() } })
    expect(out.every((o) => o.mcp === 'unchanged')).toBe(true)
  })

  it('injects awareness by default (full-auto)', async () => {
    const home = seededHome()
    const out = await runSetup({ home, all: true, yes: true, io: { output: sink() } })
    expect(out.every((o) => o.awareness === 'added')).toBe(true)
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(true)
  })

  it('--tools-only skips awareness', async () => {
    const home = seededHome()
    const out = await runSetup({ home, all: true, yes: true, toolsOnly: true, io: { output: sink() } })
    expect(out.every((o) => o.awareness === 'skipped')).toBe(true)
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false)
  })
})

describe('runSetup — uninstall', () => {
  it('removes the entries', async () => {
    const home = seededHome()
    await runSetup({ home, all: true, yes: true, io: { output: sink() } })
    const out = await runSetup({ home, all: true, yes: true, uninstall: true, io: { output: sink() } })
    expect(out.every((o) => o.mcp === 'removed')).toBe(true)

    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.traintrack).toBeUndefined()
    expect(claude.mcpServers.keep).toEqual({ command: 'x' })

    const codex = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    expect(codex).not.toContain('[mcp_servers.traintrack]')
    expect(codex).toContain('model = "gpt-5"')
  })
})

describe('runSetup — dryRun', () => {
  it('writes nothing', async () => {
    const home = seededHome()
    const before = readFileSync(join(home, '.claude.json'), 'utf8')
    const out = await runSetup({ home, all: true, yes: true, dryRun: true, onPath: () => false, io: { output: sink() } })
    expect(out).toHaveLength(4)
    expect(out.every((o) => o.mcp === 'added')).toBe(true)
    // No new files, existing files untouched.
    expect(existsSync(join(home, '.cursor/mcp.json'))).toBe(false)
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(before)
  })
})

describe('runSetup — onPath injection (hermetic detection)', () => {
  it('honors an injected onPath:() => false so detection uses ONLY config hints', async () => {
    const home = seededHome()
    // Even if the real machine has claude/codex on PATH, forcing onPath:false
    // means the four seeded config hints alone decide detection — fully hermetic.
    const out = await runSetup({
      home,
      all: true,
      yes: true,
      onPath: () => false,
      io: { output: sink() },
    })
    // All four are seeded via config hints, so all four still get configured.
    expect(out.map((o) => o.harness).sort()).toEqual(['claude', 'codex', 'cursor', 'opencode'])
  })

  it('injected onPath:() => false on an EMPTY home detects nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'traintrack-setup-hermetic-'))
    const out = await runSetup({
      home: dir,
      all: true,
      yes: true,
      onPath: () => false,
      io: { output: sink() },
    })
    // No config hints, no PATH binaries → nothing detected, regardless of the
    // real machine's PATH. No need to mutate process.env.PATH.
    expect(out).toEqual([])
  })
})

describe('runSetup — none present', () => {
  it('returns [] when no harness is detected', async () => {
    // Empty home AND an empty PATH so defaultOnPath finds no real binaries
    // (this test box may actually have claude/codex installed).
    dir = mkdtempSync(join(tmpdir(), 'traintrack-setup-empty-'))
    const savedPath = process.env['PATH']
    process.env['PATH'] = ''
    try {
      const out = await runSetup({ home: dir, all: true, yes: true, io: { output: sink() } })
      expect(out).toEqual([])
    } finally {
      process.env['PATH'] = savedPath
    }
  })
})

describe('runSetup — never throws on one harness failing', () => {
  it('captures a harness error as an "error" outcome and continues', async () => {
    const home = seededHome()
    // Make ~/.claude.json a directory so writing the json MCP entry throws,
    // but the other three still succeed.
    rmSync(join(home, '.claude.json'))
    mkdirSync(join(home, '.claude.json'), { recursive: true })

    const out = await runSetup({ home, all: true, yes: true, onPath: () => false, io: { output: sink() } })
    expect(out).toHaveLength(4)
    const claude = out.find((o) => o.harness === 'claude')!
    expect(claude.mcp).toBe('error')
    // The others still got configured.
    const others = out.filter((o) => o.harness !== 'claude')
    expect(others.every((o) => o.mcp === 'added')).toBe(true)
  })
})

describe('multiSelect', () => {
  it('selecting one item returns just that id', async () => {
    const items = [
      { id: 'claude', label: 'Claude Code', hint: 'found on PATH' },
      { id: 'codex', label: 'Codex', hint: 'config hint' },
    ]
    // Input: toggle item 1 (space on the first row is default cursor), then Enter.
    // Our prompt accepts a number to toggle then a blank line to confirm.
    const input = Readable.from(['1\n\n'])
    const lines: string[] = []
    const output = { write(s: string) { lines.push(s) } }
    const picked = await multiSelect('Pick', items, { input, output })
    expect(picked).toEqual(['claude'])
  })

  it('reducer: keyToAction maps keys and applySelect toggles/wraps', () => {
    expect(keyToAction({ name: 'space' })).toBe('toggle')
    expect(keyToAction({ name: 'down' })).toBe('down')
    expect(keyToAction({ name: 'j' })).toBe('down')
    expect(keyToAction({ name: 'a' })).toBe('all')
    expect(keyToAction({ name: 'return' })).toBe('confirm')
    expect(keyToAction({ name: 'c', ctrl: true })).toBe('cancel')
    expect(keyToAction(undefined)).toBe('ignore')
    const sel = [true, true, true]
    expect(applySelect('up', 0, sel)).toBe(2) // wraps to last
    expect(applySelect('down', 2, sel)).toBe(0) // wraps to first
    applySelect('all', 0, sel) // all on → all off
    expect(sel).toEqual([false, false, false])
    applySelect('all', 0, sel) // all off → all on
    expect(sel).toEqual([true, true, true])
    applySelect('toggle', 1, sel)
    expect(sel).toEqual([true, false, true])
  })

  it('raw-mode TTY: a/↓/space/enter selects exactly the toggled item', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void }
    input.isTTY = true
    input.setRawMode = () => {}
    const items = [
      { id: 'a', label: 'A', hint: 'x' },
      { id: 'b', label: 'B', hint: 'y' },
      { id: 'c', label: 'C', hint: 'z' },
    ]
    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
    const p = multiSelect('Pick', items, { input, output: sink() })
    await tick()
    input.write('a') // all start selected → toggle all OFF
    await tick()
    input.write('\x1b[B') // down → cursor on B
    await tick()
    input.write(' ') // toggle B on
    await tick()
    input.write('\r') // confirm
    expect(await p).toEqual(['b'])
  })
})

describe('confirm', () => {
  it('returns true for "y"', async () => {
    const input = Readable.from(['y\n'])
    const ok = await confirm('Proceed?', { input, output: sink() })
    expect(ok).toBe(true)
  })

  it('returns false for "n"', async () => {
    const input = Readable.from(['n\n'])
    const ok = await confirm('Proceed?', { input, output: sink() })
    expect(ok).toBe(false)
  })
})
