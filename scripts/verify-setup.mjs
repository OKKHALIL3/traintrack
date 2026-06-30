#!/usr/bin/env node
// ─── traintrack `setup` auto-installer LIVE verification ──────────────────────
// The proof: a throwaway HOME is seeded so all four harnesses (Claude Code,
// Codex, Cursor, OpenCode) detect as present, alongside unrelated pre-existing
// config we must never clobber. We then run the BUILT CLI end-to-end:
//
//   node dist/cli.js setup --all --yes --home <HOME>
//
// and assert every harness got its MCP entry + awareness block, the unrelated
// content survived, a second run is idempotent (each block/key exactly once),
// `--uninstall` removes ONLY traintrack's entries, and the configured server
// actually boots (serverInfo.name === traintrack, exactly 7 tools).
//
// This is intentionally NOT a unit test: it shells out to the built dist/ CLI
// and spins the real dist/mcp-server.js over stdio. Run: `node scripts/verify-setup.mjs`.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoDir = join(__dirname, '..')
const TIMEOUT_MS = 120_000

// Files we seed; dumped verbatim on failure for diagnostics.
const SEEDED = [
  '.codex/config.toml',
  '.claude.json',
  '.cursor/', // dir only
  '.config/opencode/opencode.json',
]

const failures = []
/** Record an assertion. `ok` truthy ⇒ pass; otherwise log the message. */
function assert(ok, message) {
  if (ok) {
    console.log(`  ✓ ${message}`)
  } else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

/** mkdir -p the parent dir of a file path, then write it. */
function seedFile(home, rel, contents) {
  const abs = join(home, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
  return abs
}

function read(home, rel) {
  const abs = join(home, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

function parseJson(home, rel) {
  try {
    return JSON.parse(read(home, rel))
  } catch {
    return null
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack, needle) {
  if (!needle) return 0
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n += 1
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/** Dump every seeded file's current contents for failure diagnostics. */
function dumpSeeded(home) {
  const out = ['--- seeded HOME contents ---', `HOME=${home}`]
  const files = [
    '.codex/config.toml',
    '.codex/AGENTS.md',
    '.claude.json',
    '.claude/CLAUDE.md',
    '.cursor/mcp.json',
    '.cursor/rules/traintrack.md',
    '.config/opencode/opencode.json',
    '.config/opencode/AGENTS.md',
  ]
  for (const rel of files) {
    out.push(`\n### ${rel}`)
    out.push(existsSync(join(home, rel)) ? read(home, rel) : '(absent)')
  }
  return out.join('\n')
}

/** Run the built CLI with the given setup args; returns the captured stdout.
 *  TRAINTRACK_SETUP_NO_PATH=1 makes detection hermetic: it ignores the real
 *  machine's PATH and relies ONLY on the seeded config hints under the temp HOME,
 *  so this verification runs identically on any dev box or CI. */
function runCli(home, extraArgs) {
  const res = spawnSync(
    process.execPath,
    [join(repoDir, 'dist/cli.js'), 'setup', ...extraArgs, '--home', home],
    { cwd: repoDir, encoding: 'utf8', env: { ...process.env, TRAINTRACK_SETUP_NO_PATH: '1' } }
  )
  if (res.status !== 0) {
    console.log(res.stdout ?? '')
    console.log(res.stderr ?? '')
    throw new Error(`cli setup ${extraArgs.join(' ')} exited ${res.status}`)
  }
  return res.stdout ?? ''
}

function main() {
  // 1. Build so dist/ is current.
  console.log('[verify-setup] pnpm build …')
  execFileSync('pnpm', ['build'], { cwd: repoDir, stdio: 'inherit' })

  const serverPath = join(repoDir, 'dist/mcp-server.js')

  // 2. Throwaway HOME with all 4 harnesses detectable + unrelated content to preserve.
  const home = mkdtempSync(join(tmpdir(), 'traintrack-setup-'))
  console.log(`[verify-setup] temp HOME: ${home}`)

  // codex: a TOML config with an unrelated top-level key + an unrelated mcp block.
  seedFile(
    home,
    '.codex/config.toml',
    'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-bin"\nargs = ["--serve"]\n'
  )
  // claude: JSON with a pre-existing mcpServers entry we must keep.
  seedFile(home, '.claude.json', JSON.stringify({ mcpServers: { keep: { command: 'x' } } }, null, 2))
  // cursor: just the dir, so detection fires on the config hint.
  mkdirSync(join(home, '.cursor'), { recursive: true })
  // opencode: JSON with an unrelated top-level key (its config dir also makes it detect).
  seedFile(home, '.config/opencode/opencode.json', JSON.stringify({ theme: 'dark' }, null, 2))

  // Pre-seed the PRE-EXISTING awareness files (claude's CLAUDE.md, codex's
  // AGENTS.md) with unrelated content + a trailing newline. After uninstall we
  // assert that content survives AND the trailing newline is preserved — proving
  // the block is stripped, not the whole file, and the seam collapse is clean.
  const claudeAwarenessSeed = '# My house rules\n\nAlways write tests first.\n'
  const codexAwarenessSeed = '# Codex house rules\n\nKeep diffs small.\n'
  seedFile(home, '.claude/CLAUDE.md', claudeAwarenessSeed)
  seedFile(home, '.codex/AGENTS.md', codexAwarenessSeed)

  // 3. First install — wire all detected harnesses.
  console.log('[verify-setup] run 1: setup --all --yes …')
  runCli(home, ['--all', '--yes'])

  // 4. Assert MCP + awareness present, and unrelated content preserved.
  console.log('\n[verify-setup] assert: entries installed + unrelated content preserved')

  const codexToml = read(home, '.codex/config.toml')
  assert(codexToml.includes('[mcp_servers.traintrack]'), 'codex config has [mcp_servers.traintrack]')
  assert(codexToml.includes('model = "gpt-5"'), 'codex config still has model = "gpt-5"')
  assert(codexToml.includes('[mcp_servers.other]'), 'codex config still has [mcp_servers.other]')

  const claudeJson = parseJson(home, '.claude.json')
  assert(
    Boolean(claudeJson?.mcpServers?.traintrack),
    'claude .claude.json has mcpServers.traintrack'
  )
  assert(Boolean(claudeJson?.mcpServers?.keep), 'claude .claude.json still has mcpServers.keep')

  const cursorJson = parseJson(home, '.cursor/mcp.json')
  assert(Boolean(cursorJson?.mcpServers?.traintrack), 'cursor mcp.json has mcpServers.traintrack')

  const opencodeJson = parseJson(home, '.config/opencode/opencode.json')
  assert(Boolean(opencodeJson?.mcp?.traintrack), 'opencode opencode.json has mcp.traintrack')
  assert(opencodeJson?.mcp?.traintrack?.type === 'local', 'opencode traintrack is a local server')
  assert(opencodeJson?.theme === 'dark', 'opencode opencode.json still has theme:"dark"')

  // Awareness blocks present in each instructions file.
  assert(
    read(home, '.claude/CLAUDE.md').includes('part of a traintrack agent team'),
    'awareness block in .claude/CLAUDE.md'
  )
  assert(
    read(home, '.codex/AGENTS.md').includes('part of a traintrack agent team'),
    'awareness block in .codex/AGENTS.md'
  )
  assert(
    read(home, '.config/opencode/AGENTS.md').includes('part of a traintrack agent team'),
    'awareness block in .config/opencode/AGENTS.md'
  )
  assert(
    read(home, '.cursor/rules/traintrack.md').includes('part of a traintrack agent team'),
    'awareness block in .cursor/rules/traintrack.md'
  )

  // Each args path points at THIS repo's dist/mcp-server.js.
  assert(
    JSON.stringify(claudeJson?.mcpServers?.traintrack?.args) === JSON.stringify([serverPath]),
    'claude traintrack args → this repo dist/mcp-server.js'
  )
  assert(
    JSON.stringify(cursorJson?.mcpServers?.traintrack?.args) === JSON.stringify([serverPath]),
    'cursor traintrack args → this repo dist/mcp-server.js'
  )
  assert(
    Array.isArray(opencodeJson?.mcp?.traintrack?.command) &&
      opencodeJson.mcp.traintrack.command[1] === serverPath,
    'opencode traintrack command → this repo dist/mcp-server.js'
  )
  assert(
    codexToml.includes(`args = ["${serverPath}"]`),
    'codex traintrack args → this repo dist/mcp-server.js'
  )

  // 5. Idempotency: second run leaves each block/key exactly once.
  console.log('\n[verify-setup] run 2: setup --all --yes (idempotent) …')
  runCli(home, ['--all', '--yes'])

  const codexToml2 = read(home, '.codex/config.toml')
  assert(
    count(codexToml2, '[mcp_servers.traintrack]') === 1,
    'codex [mcp_servers.traintrack] appears exactly once'
  )
  assert(
    count(codexToml2, '# >>> traintrack >>>') === 1,
    'codex toml marker appears exactly once (single mcp block)'
  )

  // claude: a parsed JSON object can never have a duplicate key (last-write-wins),
  // so a key-count over the parsed object is vacuous. Check the RAW bytes instead:
  // exactly one "traintrack" key occurrence and exactly one serverPath occurrence
  // catches any structural doubling that JSON.parse would otherwise mask.
  const claudeJson2 = parseJson(home, '.claude.json')
  assert(Boolean(claudeJson2?.mcpServers?.traintrack), 'claude mcpServers.traintrack still present')
  const claudeRaw2 = read(home, '.claude.json')
  assert(
    count(claudeRaw2, '"traintrack"') === 1,
    'claude .claude.json has exactly one "traintrack" key occurrence (raw bytes)'
  )
  assert(
    count(claudeRaw2, serverPath) === 1,
    'claude .claude.json embeds serverPath exactly once (no double-write)'
  )

  // cursor + opencode: same idempotency proof — these had NO assertion before.
  // Re-parse to confirm the entry survived, and string-count the raw bytes to
  // catch structural doubling (which last-write-wins JSON parsing would hide).
  const cursorJson2 = parseJson(home, '.cursor/mcp.json')
  assert(Boolean(cursorJson2?.mcpServers?.traintrack), 'cursor mcp.json still has mcpServers.traintrack')
  const cursorRaw2 = read(home, '.cursor/mcp.json')
  assert(
    count(cursorRaw2, '"traintrack"') === 1,
    'cursor mcp.json has exactly one "traintrack" key occurrence (raw bytes)'
  )
  assert(
    count(cursorRaw2, serverPath) === 1,
    'cursor mcp.json embeds serverPath exactly once (no double-write)'
  )

  const opencodeJson2 = parseJson(home, '.config/opencode/opencode.json')
  assert(
    Boolean(opencodeJson2?.mcp?.traintrack),
    'opencode opencode.json still has mcp.traintrack'
  )
  assert(opencodeJson2?.theme === 'dark', 'opencode opencode.json idempotent run kept theme:"dark"')
  const opencodeRaw2 = read(home, '.config/opencode/opencode.json')
  assert(
    count(opencodeRaw2, '"traintrack"') === 1,
    'opencode opencode.json has exactly one "traintrack" key occurrence (raw bytes)'
  )
  assert(
    count(opencodeRaw2, serverPath) === 1,
    'opencode opencode.json embeds serverPath exactly once (no double-write)'
  )
  // Awareness files: exactly one traintrack block each.
  for (const { rel, marker } of [
    { rel: '.claude/CLAUDE.md', marker: '<!-- >>> traintrack >>> -->' },
    { rel: '.codex/AGENTS.md', marker: '# >>> traintrack >>>' },
    { rel: '.config/opencode/AGENTS.md', marker: '<!-- >>> traintrack >>> -->' },
    { rel: '.cursor/rules/traintrack.md', marker: '<!-- >>> traintrack >>> -->' },
  ]) {
    const text = read(home, rel)
    assert(count(text, marker) === 1, `${rel} has exactly one awareness block`)
  }

  // 6. Uninstall: removes ONLY traintrack's entries; seeded content survives.
  console.log('\n[verify-setup] run 3: setup --uninstall --all --yes …')
  runCli(home, ['--uninstall', '--all', '--yes'])

  const codexToml3 = read(home, '.codex/config.toml')
  assert(!codexToml3.includes('[mcp_servers.traintrack]'), 'uninstall removed codex traintrack mcp')
  assert(!codexToml3.includes('# >>> traintrack >>>'), 'uninstall removed codex toml marker')
  assert(codexToml3.includes('model = "gpt-5"'), 'uninstall kept codex model = "gpt-5"')
  assert(codexToml3.includes('[mcp_servers.other]'), 'uninstall kept codex [mcp_servers.other]')

  const claudeJson3 = parseJson(home, '.claude.json')
  assert(!claudeJson3?.mcpServers?.traintrack, 'uninstall removed claude traintrack')
  assert(Boolean(claudeJson3?.mcpServers?.keep), 'uninstall kept claude mcpServers.keep')

  const cursorJson3 = parseJson(home, '.cursor/mcp.json')
  assert(!cursorJson3?.mcpServers?.traintrack, 'uninstall removed cursor traintrack')

  const opencodeJson3 = parseJson(home, '.config/opencode/opencode.json')
  assert(!opencodeJson3?.mcp?.traintrack, 'uninstall removed opencode traintrack')
  assert(opencodeJson3?.theme === 'dark', 'uninstall kept opencode theme:"dark"')

  // Awareness blocks gone from every file.
  for (const rel of [
    '.claude/CLAUDE.md',
    '.codex/AGENTS.md',
    '.config/opencode/AGENTS.md',
    '.cursor/rules/traintrack.md',
  ]) {
    assert(
      !read(home, rel).includes('part of a traintrack agent team'),
      `uninstall removed awareness block from ${rel}`
    )
  }

  // PRE-EXISTING awareness files: positively assert the unrelated content
  // survived (the block was STRIPPED, not the whole file deleted) AND the
  // file's original trailing newline is intact (clean seam collapse).
  const claudeMd3 = read(home, '.claude/CLAUDE.md')
  assert(claudeMd3.includes('# My house rules'), 'uninstall kept claude CLAUDE.md house rules')
  assert(
    claudeMd3.includes('Always write tests first.'),
    'uninstall kept claude CLAUDE.md pre-existing body'
  )
  assert(claudeMd3.endsWith('\n'), 'uninstall preserved claude CLAUDE.md trailing newline')

  const codexMd3 = read(home, '.codex/AGENTS.md')
  assert(codexMd3.includes('# Codex house rules'), 'uninstall kept codex AGENTS.md house rules')
  assert(codexMd3.includes('Keep diffs small.'), 'uninstall kept codex AGENTS.md pre-existing body')
  assert(codexMd3.endsWith('\n'), 'uninstall preserved codex AGENTS.md trailing newline')

  // CREATED-FROM-SCRATCH awareness files (cursor, opencode): absence is acceptable —
  // traintrack authored the whole file, so removing the block may empty/remove it.
  // The "block gone" assertion above already covers correctness here; we document
  // the asymmetry explicitly rather than demanding surviving content.
  assert(
    !read(home, '.cursor/rules/traintrack.md').includes('part of a traintrack agent team'),
    'uninstall left no traintrack awareness in cursor rules (file authored by install; absence OK)'
  )
  assert(
    !read(home, '.config/opencode/AGENTS.md').includes('part of a traintrack agent team'),
    'uninstall left no traintrack awareness in opencode AGENTS.md (file authored by install; absence OK)'
  )

  // 7. Spin the configured server (path read straight out of a freshly-installed
  //    config) and assert it boots: serverInfo.name === traintrack, 7 tools.
  console.log('\n[verify-setup] spin the configured server (re-install to read args path) …')
  runCli(home, ['--all', '--yes', '--tools-only'])
  const reinstalled = parseJson(home, '.claude.json')
  const installedArgs = reinstalled?.mcpServers?.traintrack?.args ?? []
  assert(Array.isArray(installedArgs) && installedArgs.length === 1, 'claude traintrack args is a single-element array')
  const installedServer = installedArgs[0]
  assert(installedServer === serverPath, 'configured server path === this repo dist/mcp-server.js')

  const initReq = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } },
  })
  const listReq = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  // A LIVE tool call: check_messages reads the inbox with no side effects, which
  // forces the server to OPEN the real Channel SQLite DB at TRAINTRACK_CHANNEL.
  // tools/list alone is a static array served before any DB I/O, so it can pass
  // even if the Channel constructor / DB / tool wiring is broken. This proves the
  // live path actually works.
  const callReq = JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'check_messages', arguments: {} },
  })
  const serverRun = spawnSync(process.execPath, [installedServer], {
    input: `${initReq}\n${listReq}\n${callReq}\n`,
    cwd: home,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, TRAINTRACK_CHANNEL: join(home, '.traintrack', 'channel.db') },
  })
  const lines = (serverRun.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const initResp = lines.find((m) => m.id === 1)
  const listResp = lines.find((m) => m.id === 2)
  const callResp = lines.find((m) => m.id === 3)
  assert(
    initResp?.result?.serverInfo?.name === 'traintrack',
    'server initialize → serverInfo.name === "traintrack"'
  )
  assert(
    Array.isArray(listResp?.result?.tools) && listResp.result.tools.length === 7,
    `server tools/list → exactly 7 tools (got ${listResp?.result?.tools?.length})`
  )
  // LIVE-path proof: check_messages opened the real Channel DB and returned a
  // well-formed text result — not a transport error and not an isError tool result.
  assert(!callResp?.error, 'server tools/call check_messages → no JSON-RPC error')
  assert(
    callResp?.result?.content?.[0]?.type === 'text',
    'server tools/call check_messages → result.content[0].type === "text" (DB opened)'
  )
  assert(
    callResp?.result?.isError !== true,
    'server tools/call check_messages → not an isError result (Channel I/O succeeded)'
  )
  assert(
    existsSync(join(home, '.traintrack', 'channel.db')),
    'server tools/call check_messages → opened the real Channel DB at TRAINTRACK_CHANNEL'
  )

  // 8. Verdict.
  console.log('')
  if (failures.length === 0) {
    console.log('SETUP VERIFIED')
    process.exit(0)
  }
  console.log('SETUP FAILED')
  console.log(`(${failures.length} assertion(s) failed):`)
  for (const f of failures) console.log(`  - ${f}`)
  console.log('')
  console.log(dumpSeeded(home))
  process.exit(1)
}

// A stray hang surfaces as a failure rather than an indefinite wait.
const hardStop = setTimeout(() => {
  console.log('SETUP FAILED (hard timeout reached before main() resolved)')
  process.exit(1)
}, TIMEOUT_MS)
hardStop.unref()

try {
  main()
} catch (err) {
  console.log('SETUP FAILED')
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
}
