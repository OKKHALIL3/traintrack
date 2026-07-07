import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Message = { id: number; from: string; to: string; body: string; type: string; read: 0 | 1; createdAt: string }
export type Member = { handle: string; agent: string; role: string; kind: 'live' | 'headless'; status: string; worktree: string | null }

export class Channel {
  private db: Database.Database
  readonly dbPath: string
  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_handle TEXT NOT NULL, to_handle TEXT NOT NULL,
        body TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'message',
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS members (
        handle TEXT PRIMARY KEY, agent TEXT NOT NULL, role TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, worktree TEXT
      );`)
  }
  insertMessage(m: { from: string; to: string; body: string; type?: string }): number {
    const r = this.db.prepare(
      `INSERT INTO messages (from_handle,to_handle,body,type) VALUES (?,?,?,?)`
    ).run(m.from, m.to, m.body, m.type ?? 'message')
    return Number(r.lastInsertRowid)
  }
  getUnread(handle: string): Message[] {
    return this.db.prepare(
      `SELECT id, from_handle as "from", to_handle as "to", body, type, read, created_at as createdAt
       FROM messages WHERE to_handle = ? AND read = 0 ORDER BY id`
    ).all(handle) as Message[]
  }
  /** The last `limit` messages across the whole channel, oldest→newest (for a timeline view). */
  getRecentMessages(limit = 100): Message[] {
    return this.db.prepare(
      `SELECT id, "from", "to", body, type, read, createdAt FROM (
         SELECT id, from_handle as "from", to_handle as "to", body, type, read, created_at as createdAt
         FROM messages ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`
    ).all(limit) as Message[]
  }
  markRead(ids: number[]): void {
    if (ids.length === 0) { return }
    const stmt = this.db.prepare(`UPDATE messages SET read = 1 WHERE id = ?`)
    const tx = this.db.transaction((xs: number[]) => { for (const x of xs) { stmt.run(x) } })
    tx(ids)
  }
  addMember(m: Member): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO members (handle,agent,role,kind,status,worktree) VALUES (?,?,?,?,?,?)`
    ).run(m.handle, m.agent, m.role, m.kind, m.status, m.worktree)
  }
  listMembers(): Member[] {
    return this.db.prepare(`SELECT * FROM members ORDER BY rowid`).all() as Member[]
  }
  getMember(handle: string): Member | null {
    return (this.db.prepare(`SELECT * FROM members WHERE handle = ?`).get(handle) as Member) ?? null
  }
  setStatus(handle: string, status: string): void {
    this.db.prepare(`UPDATE members SET status = ? WHERE handle = ?`).run(status, handle)
  }
  close(): void { this.db.close() }
}
