#!/usr/bin/env node
// Generate assets/banner.svg — the gradient TRAINTRACK wordmark, matching the CLI
// banner (same block glyphs, same blue→purple→pink gradient) but as an SVG so it
// renders in the GitHub README (where ANSI color is stripped).
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GLYPHS = {
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
}
const WORD = 'TRAINTRACK'.split('')
const CELL = 16
const GAP = 1
const PAD = 30
const ROWS = 5
const TAGLINE_H = 34

let totalCols = 0
WORD.forEach((ch, i) => {
  totalCols += GLYPHS[ch][0].length
  if (i < WORD.length - 1) totalCols += GAP
})
const wmW = totalCols * CELL
const wmH = ROWS * CELL
const W = wmW + PAD * 2
const H = wmH + PAD * 2 + TAGLINE_H

let rects = ''
let colX = 0
for (const ch of WORD) {
  const g = GLYPHS[ch]
  const w = g[0].length
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < w; c++) {
      if (g[r][c] === '█') {
        const x = PAD + (colX + c) * CELL
        const y = PAD + r * CELL
        rects += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="url(#g)"/>`
      }
    }
  }
  colX += w + GAP
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="traintrack">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${PAD}" y1="0" x2="${PAD + wmW}" y2="0">
      <stop offset="0" stop-color="#4F8CFF"/>
      <stop offset="0.5" stop-color="#A06CFF"/>
      <stop offset="1" stop-color="#FF5F9E"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="14" fill="#0B0E14"/>
  ${rects}
  <text x="${W / 2}" y="${PAD + wmH + 24}" text-anchor="middle" fill="#8b95a7" font-size="14" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">your coding agents, working as a team · no daemon, no wrapper</text>
</svg>
`

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
mkdirSync(join(root, 'assets'), { recursive: true })
const out = join(root, 'assets', 'banner.svg')
writeFileSync(out, svg)
console.log(`wrote ${out} (${W}x${H})`)
