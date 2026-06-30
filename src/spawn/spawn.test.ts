import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Channel } from '../channel/channel.js'
import { buildWorkerCommand, spawnWorker } from './spawn.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `traintrack-test-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeFakeGitRepo(): string {
  const dir = makeTempDir()
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('buildWorkerCommand', () => {
  it('returns process.execPath as command', () => {
    const result = buildWorkerCommand({ agent: 'codex', role: 'api', handle: 'worker_abc', channel: '/tmp/ch.db' })
    expect(result.command).toBe(process.execPath)
  })

  it('argv contains worker subcommand and all flags', () => {
    const result = buildWorkerCommand({ agent: 'codex', role: 'api', handle: 'worker_abc12345', channel: '/tmp/channel.db' })
    const args = result.args
    expect(args).toContain('worker')
    expect(args).toContain('--agent')
    expect(args).toContain('codex')
    expect(args).toContain('--role')
    expect(args).toContain('api')
    expect(args).toContain('--handle')
    expect(args).toContain('worker_abc12345')
    expect(args).toContain('--channel')
    expect(args).toContain('/tmp/channel.db')
  })

  it('arg list starts with the cli path ending in dist/cli.js', () => {
    const result = buildWorkerCommand({ agent: 'codex', role: 'api', handle: 'worker_x', channel: '/tmp/ch.db' })
    expect(result.args[0]).toMatch(/dist\/cli\.js$/)
  })

  it('respects TRAINTRACK_CLI env override', () => {
    const origEnv = process.env.TRAINTRACK_CLI
    process.env.TRAINTRACK_CLI = '/custom/path/cli.js'
    try {
      const result = buildWorkerCommand({ agent: 'codex', role: 'api', handle: 'worker_x', channel: '/tmp/ch.db' })
      expect(result.args[0]).toBe('/custom/path/cli.js')
    } finally {
      if (origEnv === undefined) {
        delete process.env.TRAINTRACK_CLI
      } else {
        process.env.TRAINTRACK_CLI = origEnv
      }
    }
  })
})

describe('spawnWorker', () => {
  let channelDir: string
  let repoRoot: string
  let channelPath: string
  let channel: Channel

  beforeEach(() => {
    channelDir = makeTempDir()
    repoRoot = makeFakeGitRepo()
    channelPath = join(channelDir, 'channel.db')
    channel = new Channel(channelPath)
  })

  afterEach(() => {
    channel.close()
    rmSync(channelDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('calls git worktree add with path under .traintrack/worktrees/', async () => {
    const execFileCalls: Array<{ cmd: string; args: string[] }> = []

    const execFileImpl = (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      execFileCalls.push({ cmd, args })
      cb(null)
    }

    const mockProcess = { unref: vi.fn(), stdout: null, stderr: null }
    const spawnImpl = vi.fn().mockReturnValue(mockProcess)

    const result = await spawnWorker({
      channel,
      repoRoot,
      agent: 'codex',
      role: 'api',
      task: 'build the feature',
      execFileImpl,
      spawnImpl,
    })

    expect(execFileCalls).toHaveLength(1)
    const { cmd, args } = execFileCalls[0]
    expect(cmd).toBe('git')
    expect(args[0]).toBe('worktree')
    expect(args[1]).toBe('add')
    const worktreePath = args[2]
    expect(worktreePath).toContain('.traintrack/worktrees/')
    expect(worktreePath).toContain(result.handle)
    expect(args[3]).toBe('-b')
    expect(args[4]).toBe(`traintrack/${result.handle}`)
  })

  it('addMember is called with the minted handle, kind headless, and worktree set', async () => {
    const execFileImpl = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)
    const mockProcess = { unref: vi.fn(), stdout: null, stderr: null }
    const spawnImpl = vi.fn().mockReturnValue(mockProcess)

    const addMemberSpy = vi.spyOn(channel, 'addMember')

    const result = await spawnWorker({
      channel,
      repoRoot,
      agent: 'codex',
      role: 'api',
      task: 'do the thing',
      execFileImpl,
      spawnImpl,
    })

    expect(addMemberSpy).toHaveBeenCalledOnce()
    const memberArg = addMemberSpy.mock.calls[0][0]
    expect(memberArg.handle).toBe(result.handle)
    expect(memberArg.kind).toBe('headless')
    expect(memberArg.worktree).toContain(result.handle)
    expect(memberArg.agent).toBe('codex')
    expect(memberArg.role).toBe('api')
    expect(memberArg.status).toBe('active')
  })

  it('insertMessage is called with the task sent to the minted handle', async () => {
    const execFileImpl = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)
    const mockProcess = { unref: vi.fn(), stdout: null, stderr: null }
    const spawnImpl = vi.fn().mockReturnValue(mockProcess)

    const insertMessageSpy = vi.spyOn(channel, 'insertMessage')

    const result = await spawnWorker({
      channel,
      repoRoot,
      agent: 'codex',
      role: 'api',
      task: 'implement auth module',
      execFileImpl,
      spawnImpl,
    })

    expect(insertMessageSpy).toHaveBeenCalledOnce()
    const msgArg = insertMessageSpy.mock.calls[0][0]
    expect(msgArg.to).toBe(result.handle)
    expect(msgArg.from).toBe('lead')
    expect(msgArg.body).toBe('implement auth module')
    expect(msgArg.type).toBe('task')
  })

  it('uses leadHandle as from when provided', async () => {
    const execFileImpl = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)
    const mockProcess = { unref: vi.fn(), stdout: null, stderr: null }
    const spawnImpl = vi.fn().mockReturnValue(mockProcess)

    const insertMessageSpy = vi.spyOn(channel, 'insertMessage')

    await spawnWorker({
      channel,
      repoRoot,
      agent: 'codex',
      role: 'api',
      task: 'do work',
      leadHandle: 'coordinator_01',
      execFileImpl,
      spawnImpl,
    })

    const msgArg = insertMessageSpy.mock.calls[0][0]
    expect(msgArg.from).toBe('coordinator_01')
  })

  it('spawns the worker with stdio[0] === "ignore"', async () => {
    const execFileImpl = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)
    const mockProcess = { unref: vi.fn(), stdout: null, stderr: null }
    const spawnImpl = vi.fn().mockReturnValue(mockProcess)

    await spawnWorker({
      channel,
      repoRoot,
      agent: 'codex',
      role: 'api',
      task: 'do work',
      execFileImpl,
      spawnImpl,
    })

    expect(spawnImpl).toHaveBeenCalledOnce()
    const spawnOpts = spawnImpl.mock.calls[0][2]
    expect(spawnOpts.stdio[0]).toBe('ignore')
    expect(spawnOpts.detached).toBe(true)
    expect(mockProcess.unref).toHaveBeenCalled()
  })

  it('returns an object with handle starting with worker_', async () => {
    const execFileImpl = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)
    const mockProcess = { unref: vi.fn(), stdout: null, stderr: null }
    const spawnImpl = vi.fn().mockReturnValue(mockProcess)

    const result = await spawnWorker({
      channel,
      repoRoot,
      agent: 'codex',
      role: 'api',
      task: 'task description',
      execFileImpl,
      spawnImpl,
    })

    expect(result).toHaveProperty('handle')
    expect(result.handle).toMatch(/^worker_[a-f0-9-]{8}$/)
  })

  it('throws a clear error when repoRoot has no .git', async () => {
    const noGitDir = makeTempDir()
    const execFileImpl = vi.fn()
    const spawnImpl = vi.fn()

    try {
      await expect(
        spawnWorker({
          channel,
          repoRoot: noGitDir,
          agent: 'codex',
          role: 'api',
          task: 'task',
          execFileImpl,
          spawnImpl,
        })
      ).rejects.toThrow(/not a git repo/i)
    } finally {
      rmSync(noGitDir, { recursive: true, force: true })
    }
  })
})
