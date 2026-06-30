import { describe, it, expect } from 'vitest'
import { renderCommand, COMMAND_DESCRIPTION } from './commands.js'
import type { CommandFormat } from './types.js'

const ALL_FORMATS: CommandFormat[] = [
  'md-args',
  'md-plain',
  'toml-args',
  'skill',
  'workflow',
  'steering-manual',
  'continue-prompt',
]

describe('renderCommand', () => {
  it('md-args: YAML frontmatter + $ARGUMENTS placeholder', () => {
    const c = renderCommand('md-args')
    expect(c.startsWith('---\n')).toBe(true)
    expect(c).toContain(`description: ${COMMAND_DESCRIPTION}`)
    expect(c).toContain('$ARGUMENTS')
    expect(c).not.toContain('{{args}}')
  })

  it('toml-args: TOML description + prompt with {{args}}', () => {
    const c = renderCommand('toml-args')
    expect(c).toContain('description = "')
    expect(c).toContain('prompt = """')
    expect(c).toContain('{{args}}')
    expect(c).not.toContain('$ARGUMENTS')
  })

  it('md-plain: no frontmatter, no placeholder token (Cursor)', () => {
    const c = renderCommand('md-plain')
    expect(c.startsWith('---')).toBe(false)
    expect(c).not.toContain('$ARGUMENTS')
    expect(c).not.toContain('{{args}}')
  })

  it('skill: name + description frontmatter (Zed)', () => {
    const c = renderCommand('skill')
    expect(c).toContain('name: team')
    expect(c).toContain(`description: ${COMMAND_DESCRIPTION}`)
  })

  it('steering-manual: inclusion:manual frontmatter (Kiro)', () => {
    expect(renderCommand('steering-manual')).toContain('inclusion: manual')
  })

  it('workflow: description frontmatter, no args (Windsurf/Cline)', () => {
    const c = renderCommand('workflow')
    expect(c).toContain('description:')
    expect(c).not.toContain('$ARGUMENTS')
  })

  it('continue-prompt: name + invokable frontmatter + $ARGUMENTS', () => {
    const c = renderCommand('continue-prompt')
    expect(c).toContain('name: team')
    expect(c).toContain('invokable: true')
    expect(c).toContain('$ARGUMENTS')
  })

  it('every format describes the team actions + tools', () => {
    for (const f of ALL_FORMATS) {
      const c = renderCommand(f)
      expect(c, f).toContain('spawn_worker')
      expect(c, f).toContain('list_team')
      expect(c, f).toContain('delegate')
      // No leftover internal token.
      expect(c, f).not.toContain('__ARGS__')
    }
  })
})
