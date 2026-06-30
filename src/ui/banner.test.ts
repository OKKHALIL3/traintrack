import { describe, it, expect } from 'vitest'
import { renderWordmark, renderBanner, bannerColorEnabled } from './banner.js'

describe('renderWordmark', () => {
  it('renders 5 block rows with no escapes when color is off', () => {
    const art = renderWordmark('TT', false)
    const lines = art.split('\n')
    expect(lines).toHaveLength(5)
    expect(art).toContain('█')
    expect(art).not.toContain('\x1b')
  })

  it('applies a truecolor gradient when color is on', () => {
    const art = renderWordmark('TT', true)
    expect(art).toContain('\x1b[38;2;') // truecolor fg escape
    expect(art).toContain('\x1b[0m') // reset
  })
})

describe('renderBanner', () => {
  it('includes the version and tagline', () => {
    const out = renderBanner({ version: '1.2.3', color: false })
    expect(out).toContain('v1.2.3')
    expect(out).toContain('multi-agent coordination')
    expect(out.split('\n').length).toBeGreaterThanOrEqual(7) // blank + 5 rows + tagline
  })
})

describe('bannerColorEnabled', () => {
  it('is false for a non-TTY stream', () => {
    expect(bannerColorEnabled({ isTTY: false })).toBe(false)
    expect(bannerColorEnabled({})).toBe(false)
  })
})
