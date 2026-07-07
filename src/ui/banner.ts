// A dependency-free branded banner for the traintrack CLI: a block-letter
// wordmark with a horizontal truecolor gradient (blue → purple → pink), plus a
// dim tagline. Color is applied only when the caller says the terminal supports
// it; without color the same ASCII renders plain (pipes, NO_COLOR, non-TTY).

type RGB = [number, number, number]

/** 5-row block glyphs for the letters in "TRAINTRACK". Each glyph's rows share
 *  a fixed width so the composed rows line up. */
const GLYPHS: Record<string, string[]> = {
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
}
const BLANK = ['   ', '   ', '   ', '   ', '   ']

// Gradient stops, Gemini-ish: blue → purple → pink.
const STOPS: RGB[] = [
  [79, 140, 255],
  [160, 108, 255],
  [255, 95, 158],
]
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

/** Color at position t∈[0,1] across the two-segment gradient. */
function gradientAt(t: number): RGB {
  const seg = t < 0.5 ? 0 : 1
  const lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5
  const c0 = STOPS[seg]
  const c1 = STOPS[seg + 1]
  return [lerp(c0[0], c1[0], lt), lerp(c0[1], c1[1], lt), lerp(c0[2], c1[2], lt)]
}

function fg([r, g, b]: RGB): string {
  return `\x1b[38;2;${r};${g};${b}m`
}

/** Render a block-letter wordmark, optionally with the horizontal gradient. */
export function renderWordmark(word: string, color: boolean): string {
  const letters = word.toUpperCase().split('')
  const rows: string[] = []
  for (let r = 0; r < 5; r++) {
    rows.push(letters.map((ch) => (GLYPHS[ch] ?? BLANK)[r]).join(' '))
  }
  if (!color) return rows.join('\n')
  const width = rows[0].length
  return rows
    .map((row) => {
      let out = ''
      for (let i = 0; i < row.length; i++) {
        const ch = row[i]
        if (ch === ' ') {
          out += ' '
          continue
        }
        out += fg(gradientAt(width > 1 ? i / (width - 1) : 0)) + ch
      }
      return out + RESET
    })
    .join('\n')
}

/** The full banner: a blank line, the gradient wordmark, and a dim tagline with
 *  the version. Returns a ready-to-write string (trailing blank line included). */
export function renderBanner(opts: {
  version: string
  color: boolean
  word?: string
  subtitle?: string
}): string {
  const art = renderWordmark(opts.word ?? 'TRAINTRACK', opts.color)
  const sub = opts.subtitle ?? 'multi-agent coordination for your coding agents'
  const dim = opts.color ? DIM : ''
  const reset = opts.color ? RESET : ''
  return `\n${art}\n\n  ${dim}${sub} · v${opts.version}${reset}\n\n`
}

/** Whether to colorize: a real terminal and NO_COLOR not set. */
export function bannerColorEnabled(stream: { isTTY?: boolean }): boolean {
  return Boolean(stream.isTTY) && process.env['NO_COLOR'] == null
}
