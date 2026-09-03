/**
 * A stand-in for `@tauri-apps/plugin-sql`, backed by node:sqlite.
 *
 * The MCP server is aliased onto this at build time (see vite.mcp.config.ts)
 * so that `src/lib/data.local.ts` — every query the desktop app runs, with
 * its validation, its append-only rules and its derived views — runs
 * unmodified in a Node process against the same file. That is the whole
 * design: there is no second data layer for the AI to be wrong in, and no
 * way for the MCP server and the app to disagree about what a project is.
 *
 * node:sqlite is built into Node 22+, so the server has no dependencies at
 * all — which also means adding it never touched package-lock.json.
 */
import { DatabaseSync } from 'node:sqlite'

export interface QueryResult {
  rowsAffected: number
  lastInsertId: number
}

export interface Connection {
  path: string
  execute(sql: string, params?: unknown[]): Promise<QueryResult>
  select<T>(sql: string, params?: unknown[]): Promise<T>
  close(): void
}

let resolvedPath = ''
let readOnly = false

/** Called by the server before any data call. */
export function configure(path: string, opts: { readOnly?: boolean } = {}): void {
  resolvedPath = path
  readOnly = opts.readOnly ?? false
}

const WRITES = /^\s*(insert|update|delete|replace|drop|alter|create)\b/i

let conn: Connection | null = null

function open(): Connection {
  if (conn) return conn
  if (!resolvedPath) throw new Error('configure() was not called before the first query.')
  const db = new DatabaseSync(resolvedPath)
  // The desktop app may have this file open right now. A short wait beats
  // failing a whole tool call on a lock that clears in milliseconds.
  db.exec('pragma busy_timeout = 5000')
  // Per-connection, not per-schema: without it every `on delete cascade` in
  // the schema is inert on THIS connection, which is how a delete leaves
  // orphaned payments behind. data.local.ts sets it too; belt and braces.
  db.exec('pragma foreign_keys = ON')

  conn = {
    path: resolvedPath,
    async execute(sql, params = []) {
      if (readOnly && WRITES.test(sql)) {
        throw new Error('guma-mcp is running with --read-only; this would have written to the database.')
      }
      const info = db.prepare(sql).run(...(params as never[]))
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T
    },
    close() {
      db.close()
      conn = null
    },
  }
  return conn
}

/** The shape data.local.ts imports: `Database.load(...)`. */
const Database = {
  async load(_url: string): Promise<Connection> {
    return open()
  },
}

export default Database
