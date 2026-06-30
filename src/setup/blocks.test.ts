import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertBlock, removeBlock, upsertJson, removeJson } from './blocks.js'

const START = '<!-- >>> traintrack >>> -->'
const END = '<!-- <<< traintrack <<< -->'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'traintrack-blocks-'))
  return dir
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

describe('upsertBlock', () => {
  it('creates the file (and parent dirs) with the block → "added"', () => {
    const file = join(tempDir(), 'nested', 'deep', 'NOTES.md')
    expect(existsSync(file)).toBe(false)
    const action = upsertBlock(file, START, END, 'hello body')
    expect(action).toBe('added')
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(START)
    expect(text).toContain(END)
    expect(text).toContain('hello body')
  })

  it('second identical call → "unchanged" and the file is byte-identical', () => {
    const file = join(tempDir(), 'NOTES.md')
    expect(upsertBlock(file, START, END, 'hello body')).toBe('added')
    const before = readFileSync(file, 'utf8')
    expect(upsertBlock(file, START, END, 'hello body')).toBe('unchanged')
    const after = readFileSync(file, 'utf8')
    expect(after).toBe(before)
  })

  it('changed body → "updated" and the block appears EXACTLY once', () => {
    const file = join(tempDir(), 'NOTES.md')
    upsertBlock(file, START, END, 'first body')
    const action = upsertBlock(file, START, END, 'second body')
    expect(action).toBe('updated')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('second body')
    expect(text).not.toContain('first body')
    expect(countOccurrences(text, START)).toBe(1)
    expect(countOccurrences(text, END)).toBe(1)
  })

  it('preserves unrelated surrounding content across an update', () => {
    const file = join(tempDir(), 'NOTES.md')
    writeFileSync(file, '# My Heading\n\nkeep this line\n')
    upsertBlock(file, START, END, 'first body')
    upsertBlock(file, START, END, 'second body')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# My Heading')
    expect(text).toContain('keep this line')
    expect(countOccurrences(text, START)).toBe(1)
  })

  it('re-run NEVER duplicates the block (idempotent over many runs)', () => {
    const file = join(tempDir(), 'NOTES.md')
    for (let i = 0; i < 5; i++) upsertBlock(file, START, END, 'stable body')
    const text = readFileSync(file, 'utf8')
    expect(countOccurrences(text, START)).toBe(1)
    expect(countOccurrences(text, END)).toBe(1)
    expect(countOccurrences(text, 'stable body')).toBe(1)
  })

  it('reconciles a DOUBLED block down to exactly one (converges)', () => {
    const file = join(tempDir(), 'NOTES.md')
    const block = `${START}\nold body\n${END}`
    // Two stale traintrack blocks (e.g. from a prior buggy run or a merge).
    writeFileSync(file, `lead\n${block}\nmiddle\n${block}\ntail\n`)
    const action = upsertBlock(file, START, END, 'new body')
    expect(action).toBe('updated')
    const text = readFileSync(file, 'utf8')
    expect(countOccurrences(text, START)).toBe(1)
    expect(countOccurrences(text, END)).toBe(1)
    expect(text).toContain('new body')
    expect(text).not.toContain('old body')
    expect(text).toContain('lead')
    expect(text).toContain('middle')
    expect(text).toContain('tail')
  })
})

describe('removeBlock', () => {
  it('strips the block and leaves surrounding text intact → "removed"', () => {
    const file = join(tempDir(), 'NOTES.md')
    writeFileSync(file, 'before line\n')
    upsertBlock(file, START, END, 'the body')
    writeFileSync(file, readFileSync(file, 'utf8') + 'after line\n')
    const action = removeBlock(file, START, END)
    expect(action).toBe('removed')
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(START)
    expect(text).not.toContain(END)
    expect(text).not.toContain('the body')
    expect(text).toContain('before line')
    expect(text).toContain('after line')
  })

  it('second removal → "unchanged"', () => {
    const file = join(tempDir(), 'NOTES.md')
    upsertBlock(file, START, END, 'the body')
    expect(removeBlock(file, START, END)).toBe('removed')
    expect(removeBlock(file, START, END)).toBe('unchanged')
  })

  it('on a missing file → "unchanged"', () => {
    const file = join(tempDir(), 'does-not-exist.md')
    expect(removeBlock(file, START, END)).toBe('unchanged')
  })

  it('removing the trailing block preserves the preceding content trailing newline', () => {
    const file = join(tempDir(), 'CLAUDE.md')
    // Pre-existing content with its own trailing newline, then append a block.
    writeFileSync(file, 'existing content\n')
    upsertBlock(file, START, END, 'the body')
    // The block is now the last thing in the file.
    expect(removeBlock(file, START, END)).toBe('removed')
    const text = readFileSync(file, 'utf8')
    // POSIX: the original file ended in a newline; that must survive.
    expect(text).toBe('existing content\n')
  })

  it('collapses a DOUBLED block down to zero on remove', () => {
    const file = join(tempDir(), 'NOTES.md')
    const block = `${START}\nthe body\n${END}`
    // Two traintrack blocks (e.g. from a prior buggy run or a copy/paste).
    writeFileSync(file, `lead\n${block}\nmiddle\n${block}\ntail\n`)
    expect(removeBlock(file, START, END)).toBe('removed')
    const text = readFileSync(file, 'utf8')
    expect(countOccurrences(text, START)).toBe(0)
    expect(countOccurrences(text, END)).toBe(0)
    expect(text).toContain('lead')
    expect(text).toContain('middle')
    expect(text).toContain('tail')
  })
})

describe('upsertJson', () => {
  it('creates {traintrack:{...}} at the path in a missing file → "added"', () => {
    const file = join(tempDir(), 'nested', 'config.json')
    const action = upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['x.js'] })
    expect(action).toBe('added')
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    expect(obj.mcpServers.traintrack).toEqual({ command: 'node', args: ['x.js'] })
  })

  it('preserves existing unrelated keys', () => {
    const file = join(tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { keep: { command: 'x' } } }))
    const action = upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['x.js'] })
    expect(action).toBe('added')
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    expect(obj.theme).toBe('dark')
    expect(obj.mcpServers.keep).toEqual({ command: 'x' })
    expect(obj.mcpServers.traintrack).toEqual({ command: 'node', args: ['x.js'] })
  })

  it('same value again → "unchanged"', () => {
    const file = join(tempDir(), 'config.json')
    upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['x.js'] })
    const action = upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['x.js'] })
    expect(action).toBe('unchanged')
  })

  it('changed value → "updated" without duplicating', () => {
    const file = join(tempDir(), 'config.json')
    upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['old.js'] })
    const action = upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['new.js'] })
    expect(action).toBe('updated')
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    expect(obj.mcpServers.traintrack.args).toEqual(['new.js'])
  })

  it('re-run NEVER duplicates and preserves siblings (idempotent)', () => {
    const file = join(tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'x' } } }))
    for (let i = 0; i < 5; i++) {
      upsertJson(file, ['mcpServers', 'traintrack'], { command: 'node', args: ['x.js'] })
    }
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(obj.mcpServers).sort()).toEqual(['keep', 'traintrack'])
  })
})

describe('removeJson', () => {
  it('deletes only the target key and preserves siblings → "removed"', () => {
    const file = join(tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'x' }, traintrack: { command: 'node' } } }))
    const action = removeJson(file, ['mcpServers', 'traintrack'])
    expect(action).toBe('removed')
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    expect(obj.mcpServers.keep).toEqual({ command: 'x' })
    expect(obj.mcpServers.traintrack).toBeUndefined()
  })

  it('absent target → "unchanged"', () => {
    const file = join(tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'x' } } }))
    expect(removeJson(file, ['mcpServers', 'traintrack'])).toBe('unchanged')
  })

  it('on a missing file → "unchanged"', () => {
    const file = join(tempDir(), 'nope.json')
    expect(removeJson(file, ['mcpServers', 'traintrack'])).toBe('unchanged')
  })
})
