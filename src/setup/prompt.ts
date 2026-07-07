// Dependency-free interactive prompts. A real terminal gets a proper keyboard
// navigable checkbox selector (↑/↓ move, space toggle, a all/none, enter
// confirm, esc cancel) via raw-mode keypress events. Non-TTY input (pipes,
// tests, CI) falls back to a simple line-based reader. Streams are injectable.
import { createInterface, emitKeypressEvents, type Interface } from 'node:readline'

/** Injectable IO. Defaults to process.stdin / process.stdout. */
export type PromptIO = {
  input?: NodeJS.ReadableStream
  output?: { write(s: string): void }
}

export type SelectItem = { id: string; label: string; hint: string }

type ResolvedIo = {
  input: NodeJS.ReadableStream
  output: { write(s: string): void }
}

/** A TTY-ish input: a readable stream that can enter raw mode. */
type RawInput = NodeJS.ReadableStream & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => void
  resume?: () => void
  pause?: () => void
}

function resolveIo(io: PromptIO | undefined): ResolvedIo {
  return {
    input: io?.input ?? process.stdin,
    output: io?.output ?? process.stdout,
  }
}

const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const RST = '\x1b[0m'

/** A single keypress reduced to the action our selector understands. Exported
 *  so the reducer can be unit-tested without a terminal. */
export type SelectAction = 'up' | 'down' | 'toggle' | 'all' | 'confirm' | 'cancel' | 'ignore'

export function keyToAction(key: { name?: string; ctrl?: boolean } | undefined): SelectAction {
  if (!key) return 'ignore'
  if (key.ctrl && key.name === 'c') return 'cancel'
  switch (key.name) {
    case 'up':
    case 'k':
      return 'up'
    case 'down':
    case 'j':
      return 'down'
    case 'space':
      return 'toggle'
    case 'a':
      return 'all'
    case 'return':
    case 'enter':
      return 'confirm'
    case 'escape':
      return 'cancel'
    default:
      return 'ignore'
  }
}

/** Pure state transition for the selector. `selected` is mutated in place and
 *  the new cursor is returned. Tested directly. */
export function applySelect(
  action: SelectAction,
  cursor: number,
  selected: boolean[],
): number {
  const n = selected.length
  switch (action) {
    case 'up':
      return (cursor - 1 + n) % n
    case 'down':
      return (cursor + 1) % n
    case 'toggle':
      selected[cursor] = !selected[cursor]
      return cursor
    case 'all': {
      const allOn = selected.every(Boolean)
      for (let i = 0; i < n; i++) selected[i] = !allOn
      return cursor
    }
    default:
      return cursor
  }
}

/** Raw-mode checkbox selector for real terminals. All items start selected. */
function rawModeSelect(title: string, items: SelectItem[], res: ResolvedIo): Promise<string[]> {
  const input = res.input as RawInput
  const out = res.output
  return new Promise<string[]>((resolve) => {
    let cursor = 0
    const selected = items.map(() => true)
    emitKeypressEvents(input)
    const wasRaw = Boolean(input.isRaw)
    input.setRawMode?.(true)
    input.resume?.()

    let prevLines = 0
    const draw = (final: boolean): void => {
      if (prevLines > 0) out.write(`\x1b[${prevLines}A\x1b[0J`)
      const rows: string[] = [title]
      items.forEach((it, i) => {
        const here = i === cursor && !final
        const pointer = here ? `${CYAN}›${RST}` : ' '
        const box = selected[i] ? `${CYAN}◉${RST}` : '◯'
        const label = here ? `${CYAN}${it.label}${RST}` : it.label
        rows.push(`  ${pointer} ${box} ${label} ${DIM}${it.hint}${RST}`)
      })
      if (!final) {
        rows.push(`${DIM}  ↑/↓ move · space toggle · a all/none · enter confirm · esc cancel${RST}`)
      }
      out.write(rows.join('\n') + '\n')
      prevLines = rows.length
    }

    const finish = (result: string[]): void => {
      draw(true)
      input.off('keypress', onKey)
      input.setRawMode?.(wasRaw)
      input.pause?.()
      resolve(result)
    }

    const chosen = (): string[] => items.filter((_, i) => selected[i]).map((it) => it.id)

    const onKey = (_s: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      const action = keyToAction(key)
      if (action === 'confirm') return finish(chosen())
      if (action === 'cancel') return finish([])
      if (action === 'ignore') return
      cursor = applySelect(action, cursor, selected)
      draw(false)
    }

    input.on('keypress', onKey)
    out.write('\n')
    draw(false)
  })
}

/** A line reader backed by ONE readline interface over the input stream. Used
 *  for the non-TTY fallback and for confirm(). Buffers early lines. */
class LineReader {
  private readonly rl: Interface
  private readonly buffered: string[] = []
  private readonly waiters: ((line: string) => void)[] = []
  private closed = false

  constructor(input: NodeJS.ReadableStream) {
    this.rl = createInterface({ input })
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter(line)
      else this.buffered.push(line)
    })
    this.rl.on('close', () => {
      this.closed = true
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!
        waiter('')
      }
    })
  }

  next(): Promise<string> {
    const queued = this.buffered.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve('')
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    this.rl.close()
  }
}

/** Non-TTY fallback: numbered list, type number(s) to toggle, blank to confirm. */
async function lineModeSelect(title: string, items: SelectItem[], res: ResolvedIo): Promise<string[]> {
  const reader = new LineReader(res.input)
  const selected = new Set<number>()
  const render = (): void => {
    res.output.write(`\n${title}\n`)
    items.forEach((it, i) => {
      res.output.write(`  ${selected.has(i) ? '[x]' : '[ ]'} ${i + 1}) ${it.label}  (${it.hint})\n`)
    })
    res.output.write('Type number(s) to toggle (e.g. "1 3"), or "all" / "none". Press Enter to confirm.\n> ')
  }
  try {
    for (;;) {
      render()
      const line = (await reader.next()).trim()
      if (line === '') break
      const lower = line.toLowerCase()
      if (lower === 'all') {
        items.forEach((_, i) => selected.add(i))
        continue
      }
      if (lower === 'none') {
        selected.clear()
        continue
      }
      for (const tok of line.split(/[\s,]+/).filter((t) => t.length > 0)) {
        const n = Number.parseInt(tok, 10)
        if (Number.isInteger(n) && n >= 1 && n <= items.length) {
          const idx = n - 1
          if (selected.has(idx)) selected.delete(idx)
          else selected.add(idx)
        }
      }
    }
  } finally {
    reader.close()
  }
  return items.filter((_, i) => selected.has(i)).map((it) => it.id)
}

/** Multi-select. Real terminals get an arrow-key checkbox UI; non-TTY input
 *  (pipes, tests) gets the line-based fallback. Returns the chosen ids. */
export async function multiSelect(
  title: string,
  items: SelectItem[],
  io?: PromptIO,
): Promise<string[]> {
  const res = resolveIo(io)
  if (items.length === 0) return []
  const input = res.input as RawInput
  if (input.isTTY && typeof input.setRawMode === 'function') {
    return rawModeSelect(title, items, res)
  }
  return lineModeSelect(title, items, res)
}

/** Yes/no confirm. Empty input → defaults to false. */
export async function confirm(question: string, io?: PromptIO): Promise<boolean> {
  const res = resolveIo(io)
  const reader = new LineReader(res.input)
  res.output.write(`${question} [y/N] `)
  try {
    const line = (await reader.next()).trim().toLowerCase()
    return line === 'y' || line === 'yes'
  } finally {
    reader.close()
  }
}
