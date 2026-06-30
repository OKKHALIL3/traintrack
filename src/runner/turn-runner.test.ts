import { describe, it, expect } from 'vitest'
import { runHeadlessTurn } from './turn-runner.js'

// Use the real node binary as a deterministic fake CLI: `node -e <script>` prints
// canned NDJSON to stdout. This exercises the real spawn + stream + parse + close
// path (including stdin-ignore), not a mock.
const NODE = process.execPath

function printerArgs(lines: string[]): string[] {
  const script = `const out=${JSON.stringify(lines)};for(const l of out){process.stdout.write(l+"\\n")}`
  return ['-e', script]
}

describe('runHeadlessTurn', () => {
  it('spawns a fake claude CLI, streams deltas, parses turn-end', async () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"sess-1"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
      '{"type":"result","is_error":false,"result":"Hi","session_id":"sess-1","usage":{"input_tokens":3,"output_tokens":1},"total_cost_usd":0.0002}'
    ]
    const deltas: string[] = []
    const out = await runHeadlessTurn({
      provider: 'claude',
      command: NODE,
      args: printerArgs(lines),
      cwd: process.cwd(),
      onDelta: (d) => deltas.push(d)
    })
    expect(out.exitCode).toBe(0)
    expect(out.ended).toBe(true)
    expect(out.finalText).toBe('Hi')
    expect(out.sessionId).toBe('sess-1')
    expect(out.tokensIn).toBe(3)
    expect(deltas).toEqual(['Hi'])
  })

  it('captures codex thread id + joined text from a fake codex CLI', async () => {
    const lines = [
      '{"type":"thread.started","thread_id":"th-9"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","status":"completed","usage":{"input_tokens":5,"output_tokens":2}}'
    ]
    const out = await runHeadlessTurn({
      provider: 'codex',
      command: NODE,
      args: printerArgs(lines),
      cwd: process.cwd()
    })
    expect(out.exitCode).toBe(0)
    expect(out.sessionId).toBe('th-9')
    expect(out.finalText).toBe('ok')
    expect(out.tokensOut).toBe(2)
  })

  it('propagates a non-zero exit + stderr without hanging', async () => {
    const out = await runHeadlessTurn({
      provider: 'claude',
      command: NODE,
      args: ['-e', 'process.stderr.write("boom\\n");process.exit(3)'],
      cwd: process.cwd()
    })
    expect(out.exitCode).toBe(3)
    expect(out.stderr).toContain('boom')
    expect(out.ended).toBe(false)
  })

  it('does not hang when the child reads stdin (stdin is ignored → immediate EOF)', async () => {
    const script =
      'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{process.stdout.write(\'{"type":"result","is_error":false,"result":"done"}\\n\')})'
    const out = await runHeadlessTurn({
      provider: 'claude',
      command: NODE,
      args: ['-e', script],
      cwd: process.cwd()
    })
    expect(out.finalText).toBe('done')
  })
})
