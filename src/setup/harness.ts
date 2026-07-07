import type { HarnessSpec } from './types.js'

/** The canonical per-harness target table. Every path/format is sourced from each
 *  host's official MCP + custom-command docs (June 2026). `verified: true` means the
 *  spawn→work→collect path is live-verified with a real agent; the rest are configured
 *  per docs but not yet verified live (honest tier — see README). */
export const HARNESSES: HarnessSpec[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    bins: ['claude'],
    configHints: ['.claude.json', '.claude'],
    mcp: { kind: 'json', file: '.claude.json', jsonPath: ['mcpServers', 'traintrack'] },
    awarenessFile: '.claude/CLAUDE.md',
    awarenessStyle: 'md',
    command: { file: '.claude/commands/team.md', format: 'md-args' },
    verified: true,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    bins: ['codex'],
    configHints: ['.codex', '.codex/config.toml'],
    mcp: { kind: 'toml', file: '.codex/config.toml' },
    awarenessFile: '.codex/AGENTS.md',
    awarenessStyle: 'toml',
    // Codex has no project-level prompt dir; user-level ~/.codex/prompts/ → /prompts:team.
    command: { file: '.codex/prompts/team.md', format: 'md-args' },
    verified: true,
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    bins: ['cursor'],
    configHints: ['.cursor'],
    mcp: { kind: 'json', file: '.cursor/mcp.json', jsonPath: ['mcpServers', 'traintrack'] },
    awarenessFile: '.cursor/rules/traintrack.md',
    awarenessStyle: 'md',
    // Cursor rules only auto-apply with MDC frontmatter carrying alwaysApply.
    awarenessFrontmatter: '---\nalwaysApply: true\n---',
    // Cursor commands are plain markdown (no args placeholder) → /team.
    command: { file: '.cursor/commands/team.md', format: 'md-plain' },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    bins: ['opencode'],
    configHints: ['.config/opencode', '.opencode'],
    mcp: { kind: 'json-opencode', file: '.config/opencode/opencode.json', jsonPath: ['mcp', 'traintrack'] },
    awarenessFile: '.config/opencode/AGENTS.md',
    awarenessStyle: 'md',
    command: { file: '.config/opencode/commands/team.md', format: 'md-args' },
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    bins: ['windsurf'],
    configHints: ['.codeium/windsurf', '.codeium'],
    // Windsurf registers MCP servers globally only.
    mcp: { kind: 'json', file: '.codeium/windsurf/mcp_config.json', jsonPath: ['mcpServers', 'traintrack'] },
    awarenessFile: '.windsurf/rules/traintrack.md',
    awarenessStyle: 'md',
    command: { file: '.codeium/windsurf/global_workflows/team.md', format: 'workflow' },
  },
  {
    id: 'cline',
    displayName: 'Cline',
    bins: ['cline'],
    configHints: ['.cline', '.clinerules'],
    mcp: { kind: 'json', file: '.cline/mcp.json', jsonPath: ['mcpServers', 'traintrack'] },
    awarenessFile: '.clinerules/traintrack.md',
    awarenessStyle: 'md',
    command: { file: 'Documents/Cline/Workflows/team.md', format: 'workflow' },
  },
  {
    id: 'kiro',
    displayName: 'Kiro',
    bins: ['kiro'],
    configHints: ['.kiro'],
    mcp: { kind: 'json', file: '.kiro/settings/mcp.json', jsonPath: ['mcpServers', 'traintrack'] },
    awarenessFile: '.kiro/steering/traintrack.md',
    awarenessStyle: 'md',
    // Kiro steering must declare inclusion to be always-loaded.
    awarenessFrontmatter: '---\ninclusion: always\n---',
    // Kiro has no command-file format; a manual-inclusion steering file surfaces as /team.
    command: { file: '.kiro/steering/team.md', format: 'steering-manual' },
  },
  {
    id: 'zed',
    displayName: 'Zed',
    bins: ['zed'],
    configHints: ['.config/zed'],
    // Zed calls MCP servers "context_servers"; configured inside its settings.json.
    mcp: { kind: 'json', file: '.config/zed/settings.json', jsonPath: ['context_servers', 'traintrack'] },
    awarenessFile: '.config/zed/AGENTS.md',
    awarenessStyle: 'md',
    command: { file: '.agents/skills/team/SKILL.md', format: 'skill' },
  },
  {
    id: 'continue',
    displayName: 'Continue',
    bins: ['cn', 'continue'],
    configHints: ['.continue'],
    // Continue uses a standalone YAML mcpServers file.
    mcp: { kind: 'yaml-file', file: '.continue/mcpServers/traintrack.yaml' },
    awarenessFile: '.continue/rules/traintrack.md',
    awarenessStyle: 'md',
    awarenessFrontmatter: '---\nname: traintrack\nalwaysApply: true\n---',
    command: { file: '.continue/prompts/team.md', format: 'continue-prompt' },
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    bins: ['copilot'],
    configHints: ['.copilot'],
    // Copilot CLI uses a Claude-style mcpServers JSON with type:'local' + tools.
    mcp: { kind: 'json-copilot', file: '.copilot/mcp-config.json', jsonPath: ['mcpServers', 'traintrack'] },
    awarenessFile: '.copilot/copilot-instructions.md',
    awarenessStyle: 'md',
    // Copilot CLI has no user-defined /command surface → MCP + awareness only.
  },
]
