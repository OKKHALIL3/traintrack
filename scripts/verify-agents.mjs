#!/usr/bin/env node
// ─── traintrack multi-agent breadth verification ─────────────────────────────
// Proof that `traintrack setup` wires the MCP server + /team command into ALL 11
// supported agents, in each host's own config/command format, and removes them
// cleanly on --uninstall. Hermetic: TRAINTRACK_SETUP_NO_PATH=1 makes detection
// rely only on the seeded config-hint dirs under a throwaway HOME, so it runs
// identically on any box. Complements verify-setup.mjs (which deep-tests the
// 4 core agents) with breadth across every host.
//
// Run: node scripts/verify-agents.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// Each agent: the config-hint dir(s) to seed, its MCP file + a content needle,
// and (where supported) its /team command file + a content needle.
const AGENTS = [
  { id: 'claude', seed: ['.claude'], seedFiles: ['.claude.json'], mcp: '.claude.json', mcpNeedle: '"traintrack"', cmd: '.claude/commands/team.md', cmdNeedle: '$ARGUMENTS' },
  { id: 'codex', seed: ['.codex'], mcp: '.codex/config.toml', mcpNeedle: 'mcp_servers.traintrack', cmd: '.codex/prompts/team.md', cmdNeedle: '$ARGUMENTS' },
  { id: 'cursor', seed: ['.cursor'], mcp: '.cursor/mcp.json', mcpNeedle: '"traintrack"', cmd: '.cursor/commands/team.md', cmdNeedle: 'list_team' },
  { id: 'opencode', seed: ['.config/opencode'], mcp: '.config/opencode/opencode.json', mcpNeedle: '"type": "local"', cmd: '.config/opencode/commands/team.md', cmdNeedle: '$ARGUMENTS' },
  { id: 'windsurf', seed: ['.codeium/windsurf'], mcp: '.codeium/windsurf/mcp_config.json', mcpNeedle: '"traintrack"', cmd: '.codeium/windsurf/global_workflows/team.md', cmdNeedle: 'list_team' },
  { id: 'cline', seed: ['.cline'], mcp: '.cline/mcp.json', mcpNeedle: '"traintrack"', cmd: 'Documents/Cline/Workflows/team.md', cmdNeedle: 'list_team' },
  { id: 'kiro', seed: ['.kiro'], mcp: '.kiro/settings/mcp.json', mcpNeedle: '"traintrack"', cmd: '.kiro/steering/team.md', cmdNeedle: 'inclusion: manual' },
  { id: 'zed', seed: ['.config/zed'], mcp: '.config/zed/settings.json', mcpNeedle: '"traintrack"', cmd: '.agents/skills/team/SKILL.md', cmdNeedle: 'name: team' },
  { id: 'continue', seed: ['.continue'], mcp: '.continue/mcpServers/traintrack.yaml', mcpNeedle: 'TRAINTRACK_AGENT', cmd: '.continue/prompts/team.md', cmdNeedle: 'invokable' },
  { id: 'copilot', seed: ['.copilot'], mcp: '.copilot/mcp-config.json', mcpNeedle: '"type": "local"', cmd: null },
]

const failures = []
function assert(ok, msg) {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures.push(msg)
}
function has(home, rel, needle) {
  const p = join(home, rel)
  return existsSync(p) && readFileSync(p, 'utf8').includes(needle)
}

function runCli(home, extra) {
  const res = spawnSync(process.execPath, [join(repoDir, 'dist/cli.js'), 'setup', ...extra, '--home', home], {
    cwd: repoDir, encoding: 'utf8', env: { ...process.env, TRAINTRACK_SETUP_NO_PATH: '1' },
  })
  if (res.status !== 0) { console.log(res.stdout, res.stderr); throw new Error(`setup ${extra.join(' ')} exited ${res.status}`) }
  return res.stdout ?? ''
}

function main() {
  console.log('[verify-agents] build …')
  execFileSync('npm', ['run', 'build'], { cwd: repoDir, stdio: 'inherit' })

  const home = mkdtempSync(join(tmpdir(), 'traintrack-agents-'))
  console.log(`[verify-agents] temp HOME: ${home}`)
  for (const a of AGENTS) {
    for (const d of a.seed) mkdirSync(join(home, d), { recursive: true })
    for (const f of a.seedFiles ?? []) { mkdirSync(dirname(join(home, f)), { recursive: true }); writeFileSync(join(home, f), '') }
  }

  console.log('\n[verify-agents] install: setup --all --yes')
  runCli(home, ['--all', '--yes'])
  console.log('\n[verify-agents] assert each agent got MCP + /team:')
  for (const a of AGENTS) {
    assert(has(home, a.mcp, a.mcpNeedle), `${a.id}: MCP entry written (${a.mcp})`)
    if (a.cmd) assert(has(home, a.cmd, a.cmdNeedle), `${a.id}: /team command written (${a.cmd})`)
    else assert(!existsSync(join(home, '.copilot/agents/team.md')), `${a.id}: no /team (no command surface) — correct`)
  }

  console.log('\n[verify-agents] idempotency: second run is all "unchanged"')
  const out2 = runCli(home, ['--all', '--yes'])
  assert(!out2.includes('mcp:added') && !out2.includes('command:added'), 'second run added nothing (idempotent)')

  console.log('\n[verify-agents] uninstall: setup --uninstall --all --yes')
  runCli(home, ['--uninstall', '--all', '--yes'])
  console.log('\n[verify-agents] assert MCP + /team removed:')
  for (const a of AGENTS) {
    assert(!has(home, a.mcp, a.mcpNeedle), `${a.id}: MCP entry removed`)
    if (a.cmd) assert(!existsSync(join(home, a.cmd)), `${a.id}: /team command removed`)
  }

  console.log('')
  if (failures.length === 0) { console.log('AGENTS VERIFIED'); process.exit(0) }
  console.log(`AGENTS FAILED (${failures.length}):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}

try { main() } catch (e) { console.log('AGENTS FAILED'); console.log(e?.stack ?? String(e)); process.exit(1) }
