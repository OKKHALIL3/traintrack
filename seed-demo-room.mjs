import { Channel, resolveChannelPath } from './dist/index.js'
import { rmSync } from 'node:fs'
const path = resolveChannelPath({ room: 'traintrack' })
try { rmSync(path); rmSync(path + '-wal'); rmSync(path + '-shm') } catch {}
const ch = new Channel(path)
const members = [
  { handle: 'lead',        agent: 'claude', role: 'lead',     kind: 'live',     status: 'working', worktree: null },
  { handle: 'codex-api',   agent: 'codex',  role: 'backend',  kind: 'headless', status: 'done',    worktree: 'feat/auth-api' },
  { handle: 'codex-tests', agent: 'codex',  role: 'tests',    kind: 'headless', status: 'working', worktree: 'feat/auth-tests' },
  { handle: 'cursor-ui',   agent: 'cursor', role: 'frontend', kind: 'live',     status: 'done',    worktree: 'feat/login-form' },
]
for (const m of members) ch.addMember(m)
const msgs = [
  ['lead','codex-api','Build the POST /auth/login endpoint with JWT.'],
  ['lead','codex-tests','Write integration tests for the auth flow.'],
  ['lead','cursor-ui','Wire the login form to /auth/login.'],
  ['codex-api','lead','Endpoint done — returns { token, expiresIn }. ✓'],
  ['cursor-ui','codex-api',"What's the exact response shape?"],
  ['codex-api','cursor-ui','{ token: string, expiresIn: number }'],
  ['codex-tests','lead','12 tests passing, 1 flaky on token refresh — looking.'],
  ['cursor-ui','lead','Form wired, handling 401s. ✓'],
  ['codex-tests','lead','Flaky test fixed (clock mock). All green. ✓'],
]
for (const [from,to,body] of msgs) ch.insertMessage({ from, to, body })
console.log('seeded room ->', path)
console.log('members:', ch.listMembers().length, '| messages:', ch.getRecentMessages().length)
ch.close()
