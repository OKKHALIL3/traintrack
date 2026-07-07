import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveChannelPath } from './resolve.js'

describe('resolveChannelPath', () => {
  it('honors an explicit --channel above all else', () => {
    expect(
      resolveChannelPath({ channel: '/x/y.db', room: 'r', env: { TRAINTRACK_CHANNEL: '/z.db' }, cwd: '/tmp' }),
    ).toBe('/x/y.db')
  })

  it('maps --room to a shared cross-project room under HOME', () => {
    expect(resolveChannelPath({ room: 'global', cwd: '/tmp' })).toBe(
      join(homedir(), '.traintrack', 'rooms', 'global.db'),
    )
  })

  it('sanitizes unsafe room names', () => {
    expect(resolveChannelPath({ room: '../evil' })).toBe(
      join(homedir(), '.traintrack', 'rooms', '___evil.db'),
    )
  })

  it('uses TRAINTRACK_CHANNEL env when no flag given', () => {
    expect(resolveChannelPath({ env: { TRAINTRACK_CHANNEL: '/env/c.db' }, cwd: '/tmp' })).toBe('/env/c.db')
  })

  it('defaults to the GIT REPO ROOT so a subdir session shares the team', () => {
    expect(
      resolveChannelPath({ cwd: '/repo/src/deep', env: {}, gitRootImpl: () => '/repo' }),
    ).toBe('/repo/.traintrack/channel.db')
  })

  it('falls back to cwd when not in a git repo', () => {
    expect(resolveChannelPath({ cwd: '/loose/dir', env: {}, gitRootImpl: () => null })).toBe(
      '/loose/dir/.traintrack/channel.db',
    )
  })
})
