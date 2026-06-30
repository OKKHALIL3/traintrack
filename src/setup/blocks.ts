// The idempotency engine (pure, fs-only; no harness logic).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Action } from './types.js'

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

/** Build the canonical marker block: start, body, end on their own lines. */
function renderBlock(start: string, end: string, body: string): string {
  return `${start}\n${body}\n${end}`
}

/** Find the [start, end] span (inclusive of markers) in text at or after `at`, or null. */
function findSpanFrom(
  text: string,
  start: string,
  end: string,
  at: number,
): { from: number; to: number } | null {
  const from = text.indexOf(start, at)
  if (from === -1) return null
  const endStart = text.indexOf(end, from + start.length)
  if (endStart === -1) return null
  return { from, to: endStart + end.length }
}

/** Find the first [start, end] span (inclusive of markers) in text, or null. */
function findSpan(text: string, start: string, end: string): { from: number; to: number } | null {
  return findSpanFrom(text, start, end, 0)
}

/** Cut a span out of text, collapsing the seam so removal leaves no blank-line
 *  scar and never drops the file's POSIX trailing newline. */
function spliceSeam(text: string, span: { from: number; to: number }): string {
  let before = text.slice(0, span.from)
  let after = text.slice(span.to)
  // Drop a single leading newline on `after` (the newline that followed the end
  // marker), then drop a trailing newline on `before` ONLY when a real blank-line
  // scar is present (i.e. `after` still starts with a newline). When the block was
  // the last thing in the file, `after` becomes '' and we keep `before`'s trailing
  // newline so the file stays POSIX-clean.
  if (after.startsWith('\n')) after = after.slice(1)
  if (before.endsWith('\n') && after.startsWith('\n')) {
    before = before.slice(0, -1)
  }
  return before + after
}

/** Insert or replace a marker-delimited block in a text file. Creates the file
 *  (and parent dirs) if missing. Returns 'added' | 'updated' | 'unchanged'. */
export function upsertBlock(file: string, start: string, end: string, body: string): Action {
  const block = renderBlock(start, end, body)
  if (!existsSync(file)) {
    ensureDir(file)
    writeFileSync(file, block + '\n', 'utf8')
    return 'added'
  }
  const text = readFileSync(file, 'utf8')
  const span = findSpan(text, start, end)
  if (!span) {
    // No existing block — append, keeping a clean separation from prior content.
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
    writeFileSync(file, text + sep + block + '\n', 'utf8')
    return 'added'
  }
  // Replace the first span, then strip any further spans of the same markers so
  // the file converges to EXACTLY one block even if a prior buggy run, a merge,
  // or a copy/paste left duplicates behind.
  const existing = text.slice(span.from, span.to)
  let next = text.slice(0, span.from) + block + text.slice(span.to)
  const collapsed = collapseExtraSpans(next, start, end)
  next = collapsed.text
  if (existing === block && !collapsed.removedAny) return 'unchanged'
  writeFileSync(file, next, 'utf8')
  return 'updated'
}

/** Remove every span AFTER the first (the first is assumed already canonical),
 *  collapsing the seam each time. Returns the new text and whether any were removed. */
function collapseExtraSpans(
  text: string,
  start: string,
  end: string,
): { text: string; removedAny: boolean } {
  const first = findSpan(text, start, end)
  if (!first) return { text, removedAny: false }
  let removedAny = false
  // Search only the region after the first block's end for further spans.
  let cur = text
  let searchFrom = first.to
  for (;;) {
    const span = findSpanFrom(cur, start, end, searchFrom)
    if (!span) break
    cur = spliceSeam(cur, span)
    removedAny = true
    // Continue scanning from where the removed block began.
    searchFrom = span.from
  }
  return { text: cur, removedAny }
}

/** Remove a marker-delimited block if present; preserves the rest of the file.
 *  Returns 'removed' | 'unchanged'. */
export function removeBlock(file: string, start: string, end: string): Action {
  if (!existsSync(file)) return 'unchanged'
  let text = readFileSync(file, 'utf8')
  let removedAny = false
  // Loop until no span remains so ALL traintrack blocks are removed — a doubled
  // block (from a prior buggy run, a copy/paste, or a merge) is fully collapsed,
  // not left orphaned. uninstall then truly removes everything it claims to.
  for (;;) {
    const span = findSpan(text, start, end)
    if (!span) break
    text = spliceSeam(text, span)
    removedAny = true
  }
  if (!removedAny) return 'unchanged'
  writeFileSync(file, text, 'utf8')
  return 'removed'
}

/** Structural (key-order-INSENSITIVE) deep equality. Exported so dry-run planning
 *  in configure.ts compares JSON values exactly the way the real upsertJson does. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
  }
  return false
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function writeJson(file: string, obj: Record<string, unknown>): void {
  ensureDir(file)
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

/** Read a JSON file (or {} if missing), set obj[...path] = value (deep), write
 *  back pretty-printed. Returns 'added' | 'updated' | 'unchanged'. Creates dirs. */
export function upsertJson(file: string, path: string[], value: unknown): Action {
  const obj = readJson(file)
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const child = cursor[key]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) {
      cursor[key] = {}
    }
    cursor = cursor[key] as Record<string, unknown>
  }
  const leaf = path[path.length - 1]
  const had = Object.prototype.hasOwnProperty.call(cursor, leaf)
  if (had && deepEqual(cursor[leaf], value)) return 'unchanged'
  cursor[leaf] = value
  writeJson(file, obj)
  return had ? 'updated' : 'added'
}

/** Delete obj[...path] if present; write back. Returns 'removed' | 'unchanged'. */
export function removeJson(file: string, path: string[]): Action {
  if (!existsSync(file)) return 'unchanged'
  const obj = readJson(file)
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const child = cursor[path[i]]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return 'unchanged'
    cursor = child as Record<string, unknown>
  }
  const leaf = path[path.length - 1]
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return 'unchanged'
  delete cursor[leaf]
  writeJson(file, obj)
  return 'removed'
}

// ─── Dry-run planners ────────────────────────────────────────────────────────
// Single source of truth for `--dry-run`: each planX answers exactly the Action
// the matching mutator WOULD return, using the SAME comparison logic, so dry-run
// can never disagree with a real run (structural parity, not coincidental).

/** What upsertBlock WOULD return for these inputs, without writing. */
export function planBlock(file: string, start: string, end: string, body: string): Action {
  const block = renderBlock(start, end, body)
  if (!existsSync(file)) return 'added'
  const text = readFileSync(file, 'utf8')
  const span = findSpan(text, start, end)
  if (!span) return 'added'
  const existing = text.slice(span.from, span.to)
  // A doubled block would be reconciled to one → 'updated' even if the first matches.
  const next = text.slice(0, span.from) + block + text.slice(span.to)
  const { removedAny } = collapseExtraSpans(next, start, end)
  return existing === block && !removedAny ? 'unchanged' : 'updated'
}

/** What upsertJson WOULD return for these inputs, without writing. */
export function planJson(file: string, path: string[], value: unknown): Action {
  if (!existsSync(file)) return 'added'
  const obj = readJson(file)
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const child = cursor[path[i]]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return 'added'
    cursor = child as Record<string, unknown>
  }
  const leaf = path[path.length - 1]
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return 'added'
  return deepEqual(cursor[leaf], value) ? 'unchanged' : 'updated'
}

/** What removeBlock WOULD return for these inputs, without writing. */
export function planRemoveBlock(file: string, start: string, end: string): Action {
  if (!existsSync(file)) return 'unchanged'
  const text = readFileSync(file, 'utf8')
  return findSpan(text, start, end) ? 'removed' : 'unchanged'
}

/** What removeJson WOULD return for these inputs, without writing. */
export function planRemoveJson(file: string, path: string[]): Action {
  if (!existsSync(file)) return 'unchanged'
  const obj = readJson(file)
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const child = cursor[path[i]]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return 'unchanged'
    cursor = child as Record<string, unknown>
  }
  const leaf = path[path.length - 1]
  return Object.prototype.hasOwnProperty.call(cursor, leaf) ? 'removed' : 'unchanged'
}
