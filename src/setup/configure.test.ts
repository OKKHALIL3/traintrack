import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureHarness, unconfigureHarness } from './configure.js'
import { HARNESSES } from './harness.js'
import type { HarnessSpec, SetupContext } from './types.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-configure-'))
  return dir
}

function spec(id: string): HarnessSpec {
  const s = HARNESSES.find((h) => h.id === id)
  if (!s) throw new Error(`no spec for ${id}`)
  return s
}

function ctx(home: string, over: Partial<SetupContext> = {}): SetupContext {
  return {
    home,
    serverPath: '/abs/repo/dist/mcp-server.js',
    nodePath: '/usr/bin/node',
    dryRun: false,
    injectAwareness: true,
    ...over,
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** Decode a single TOML basic string literal (incl. surrounding quotes) to its
 *  value — just enough to verify our escaping round-trips. Handles \\ and \". */
function decodeTomlBasic(literal: string): string {
  if (literal[0] !== '"' || literal[literal.length - 1] !== '"') {
    throw new Error(`not a quoted TOML basic string: ${literal}`)
  }
  const inner = literal.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      const next = inner[i + 1]
      if (next === '\\') out += '\\'
      else if (next === '"') out += '"'
      else throw new Error(`unexpected escape \\${next} in ${literal}`)
      i++
    } else {
      if (inner[i] === '"') throw new Error(`unescaped quote in ${literal}`)
      out += inner[i]
    }
  }
  return out
}

/** Pull the RHS literal after `key = ` on its own line (command/args item). */
function rhs(text: string, key: string): string {
  const line = text.split('\n').find((l) => l.trimStart().startsWith(`${key} = `))
  if (!line) throw new Error(`no line for key ${key}`)
  return line.slice(line.indexOf('= ') + 2).trim()
}

describe('configureHarness — codex (toml)', () => {
  it('writes the toml MCP block with the server path → mcp "added"', () => {
    const home = tempDir()
    const out = configureHarness(spec('codex'), ctx(home))
    expect(out.harness).toBe('codex')
    expect(out.mcp).toBe('added')
    const tomlPath = join(home, '.codex/config.toml')
    const text = readFileSync(tomlPath, 'utf8')
    expect(text).toContain('[mcp_servers.traintrack]')
    expect(text).toContain('command = "/usr/bin/node"')
    expect(text).toContain('args = ["/abs/repo/dist/mcp-server.js"]')
    expect(text).toContain('# >>> traintrack >>>')
    expect(text).toContain('# <<< traintrack <<<')
    expect(out.files).toContain(tomlPath)
  })

  it('writes the toml awareness block when injectAwareness:true', () => {
    const home = tempDir()
    const out = configureHarness(spec('codex'), ctx(home))
    expect(out.awareness).toBe('added')
    const awarenessPath = join(home, '.codex/AGENTS.md')
    const text = readFileSync(awarenessPath, 'utf8')
    expect(text).toContain('# >>> traintrack >>>')
    expect(text).toContain('# <<< traintrack <<<')
    expect(text).toContain('traintrack agent team')
    expect(out.files).toContain(awarenessPath)
  })

  it('re-run → mcp & awareness "unchanged"', () => {
    const home = tempDir()
    configureHarness(spec('codex'), ctx(home))
    const out = configureHarness(spec('codex'), ctx(home))
    expect(out.mcp).toBe('unchanged')
    expect(out.awareness).toBe('unchanged')
    const text = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    expect(countOccurrences(text, '[mcp_servers.traintrack]')).toBe(1)
  })

  it('TOML-escapes a serverPath/nodePath containing a quote and a backslash', () => {
    const home = tempDir()
    const nodePath = 'C:\\Program Files\\node\\node.exe'
    const serverPath = '/home/wei"rd/path\\dist/mcp-server.js'
    configureHarness(spec('codex'), ctx(home, { nodePath, serverPath }))
    const text = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    // command = "<escaped nodePath>" round-trips back to nodePath.
    expect(decodeTomlBasic(rhs(text, 'command'))).toBe(nodePath)
    // args = ["<escaped serverPath>"] — strip the brackets, then decode.
    const argsLiteral = rhs(text, 'args')
    expect(argsLiteral.startsWith('[') && argsLiteral.endsWith(']')).toBe(true)
    expect(decodeTomlBasic(argsLiteral.slice(1, -1).trim())).toBe(serverPath)
  })
})

describe('configureHarness — claude (json)', () => {
  it('writes ~/.claude.json mcpServers.traintrack → mcp "added"', () => {
    const home = tempDir()
    const out = configureHarness(spec('claude'), ctx(home))
    expect(out.harness).toBe('claude')
    expect(out.mcp).toBe('added')
    const jsonPath = join(home, '.claude.json')
    const obj = JSON.parse(readFileSync(jsonPath, 'utf8'))
    expect(obj.mcpServers.traintrack).toEqual({
      command: '/usr/bin/node',
      args: ['/abs/repo/dist/mcp-server.js'],
      env: { TRAINTRACK_AGENT: 'claude' },
    })
    expect(out.files).toContain(jsonPath)
  })

  it('writes the md awareness block', () => {
    const home = tempDir()
    const out = configureHarness(spec('claude'), ctx(home))
    expect(out.awareness).toBe('added')
    const text = readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')
    expect(text).toContain('<!-- >>> traintrack >>> -->')
    expect(text).toContain('<!-- <<< traintrack <<< -->')
    expect(text).toContain('traintrack agent team')
  })

  it('re-run → unchanged', () => {
    const home = tempDir()
    configureHarness(spec('claude'), ctx(home))
    const out = configureHarness(spec('claude'), ctx(home))
    expect(out.mcp).toBe('unchanged')
    expect(out.awareness).toBe('unchanged')
  })
})

describe('configureHarness — cursor (md + MDC frontmatter)', () => {
  it('prepends `alwaysApply: true` frontmatter ABOVE the awareness block', () => {
    const home = tempDir()
    const out = configureHarness(spec('cursor'), ctx(home))
    expect(out.awareness).toBe('added')
    const rulePath = join(home, '.cursor/rules/traintrack.md')
    const text = readFileSync(rulePath, 'utf8')
    // Frontmatter must be the very first bytes or Cursor won't auto-apply the rule.
    expect(text.startsWith('---\nalwaysApply: true\n---')).toBe(true)
    // And the awareness markers/body sit below it.
    const fmEnd = text.indexOf('---', 3) + 3
    const body = text.slice(fmEnd)
    expect(body).toContain('<!-- >>> traintrack >>> -->')
    expect(body).toContain('traintrack agent team')
  })

  it('re-run is idempotent — exactly one frontmatter and unchanged', () => {
    const home = tempDir()
    configureHarness(spec('cursor'), ctx(home))
    const out = configureHarness(spec('cursor'), ctx(home))
    expect(out.awareness).toBe('unchanged')
    const text = readFileSync(join(home, '.cursor/rules/traintrack.md'), 'utf8')
    expect(countOccurrences(text, 'alwaysApply: true')).toBe(1)
    expect(countOccurrences(text, '<!-- >>> traintrack >>> -->')).toBe(1)
  })

  it('uninstall strips the frontmatter and the block, leaving the file clean', () => {
    const home = tempDir()
    configureHarness(spec('cursor'), ctx(home))
    const out = unconfigureHarness(spec('cursor'), ctx(home))
    expect(out.awareness).toBe('removed')
    const text = readFileSync(join(home, '.cursor/rules/traintrack.md'), 'utf8')
    expect(text).not.toContain('alwaysApply: true')
    expect(text).not.toContain('traintrack agent team')
  })
})

describe('configureHarness — injectAwareness:false', () => {
  it('skips awareness and writes only the MCP entry', () => {
    const home = tempDir()
    const out = configureHarness(spec('claude'), ctx(home, { injectAwareness: false }))
    expect(out.mcp).toBe('added')
    expect(out.awareness).toBe('skipped')
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false)
    expect(out.files).not.toContain(join(home, '.claude/CLAUDE.md'))
  })
})

describe('configureHarness — dryRun', () => {
  it('writes NOTHING but reports the intended action (json)', () => {
    const home = tempDir()
    const out = configureHarness(spec('claude'), ctx(home, { dryRun: true }))
    expect(out.mcp).toBe('added')
    expect(out.awareness).toBe('added')
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false)
    expect(out.detail).toMatch(/dry/i)
  })

  it('writes NOTHING but reports the intended action (toml)', () => {
    const home = tempDir()
    const out = configureHarness(spec('codex'), ctx(home, { dryRun: true }))
    expect(out.mcp).toBe('added')
    expect(out.awareness).toBe('added')
    expect(existsSync(join(home, '.codex/config.toml'))).toBe(false)
    expect(existsSync(join(home, '.codex/AGENTS.md'))).toBe(false)
  })

  it('dryRun on an already-configured harness reports "unchanged" and writes nothing', () => {
    const home = tempDir()
    configureHarness(spec('claude'), ctx(home))
    const before = readFileSync(join(home, '.claude.json'), 'utf8')
    const out = configureHarness(spec('claude'), ctx(home, { dryRun: true }))
    expect(out.mcp).toBe('unchanged')
    expect(out.awareness).toBe('unchanged')
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(before)
  })

  it('dryRun does not throw when injectAwareness:false', () => {
    const home = tempDir()
    const out = configureHarness(spec('codex'), ctx(home, { dryRun: true, injectAwareness: false }))
    expect(out.mcp).toBe('added')
    expect(out.awareness).toBe('skipped')
  })

  it('dryRun JSON action matches the real action when the leaf has REORDERED keys', () => {
    const home = tempDir()
    // Pre-seed the leaf with the SAME value but keys in a different order than
    // configure writes ({command, args}). Key-order-insensitive comparison must
    // treat this as 'unchanged' in BOTH dry-run and real run.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          traintrack: {
            env: { TRAINTRACK_AGENT: 'claude' },
            args: ['/abs/repo/dist/mcp-server.js'],
            command: '/usr/bin/node',
          },
        },
      }),
    )
    const dry = configureHarness(spec('claude'), ctx(home, { dryRun: true }))
    const real = configureHarness(spec('claude'), ctx(home))
    expect(dry.mcp).toBe(real.mcp)
    expect(real.mcp).toBe('unchanged')
  })

  it('dryRun does not record any written files (json + awareness)', () => {
    const home = tempDir()
    const out = configureHarness(spec('claude'), ctx(home, { dryRun: true }))
    expect(out.mcp).toBe('added')
    expect(out.awareness).toBe('added')
    expect(out.files).toEqual([])
  })

  it('an "unchanged" re-run records NO written files', () => {
    const home = tempDir()
    configureHarness(spec('claude'), ctx(home))
    const out = configureHarness(spec('claude'), ctx(home))
    expect(out.mcp).toBe('unchanged')
    expect(out.awareness).toBe('unchanged')
    expect(out.files).toEqual([])
  })
})

describe('unconfigureHarness', () => {
  it('removes both MCP and awareness, preserving pre-seeded unrelated toml content', () => {
    const home = tempDir()
    // Pre-seed unrelated content into the codex config + agents files.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex/config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    )
    writeFileSync(join(home, '.codex/AGENTS.md'), '# House rules\nbe nice\n')

    configureHarness(spec('codex'), ctx(home))
    const out = unconfigureHarness(spec('codex'), ctx(home))
    expect(out.mcp).toBe('removed')
    expect(out.awareness).toBe('removed')

    const toml = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    expect(toml).not.toContain('[mcp_servers.traintrack]')
    expect(toml).not.toContain('# >>> traintrack >>>')
    expect(toml).toContain('model = "gpt-5"')
    expect(toml).toContain('[mcp_servers.other]')

    const agents = readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')
    expect(agents).not.toContain('traintrack agent team')
    expect(agents).toContain('# House rules')
    expect(agents).toContain('be nice')
  })

  it('removes the json MCP entry, preserving a pre-seeded sibling key', () => {
    const home = tempDir()
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { keep: { command: 'x' } } }),
    )
    configureHarness(spec('claude'), ctx(home))
    const out = unconfigureHarness(spec('claude'), ctx(home))
    expect(out.mcp).toBe('removed')
    const obj = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(obj.mcpServers.traintrack).toBeUndefined()
    expect(obj.mcpServers.keep).toEqual({ command: 'x' })
  })

  it('re-run uninstall → unchanged', () => {
    const home = tempDir()
    configureHarness(spec('claude'), ctx(home))
    unconfigureHarness(spec('claude'), ctx(home))
    const out = unconfigureHarness(spec('claude'), ctx(home))
    expect(out.mcp).toBe('unchanged')
    expect(out.awareness).toBe('unchanged')
  })

  it('dryRun uninstall writes nothing but reports the intended removal', () => {
    const home = tempDir()
    configureHarness(spec('codex'), ctx(home))
    const before = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    const out = unconfigureHarness(spec('codex'), ctx(home, { dryRun: true }))
    expect(out.mcp).toBe('removed')
    expect(out.awareness).toBe('removed')
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(before)
  })
})
