/// <reference types="node" />
/**
 * The two databases must describe the same shop.
 *
 * backends.test.ts proves both backends export the same FUNCTIONS. That
 * turned out not to be enough: desktop migration 0012_in_house.sql added
 * jobs.kind and clients.system, data.supabase.ts started writing both, and
 * the hosted twin was never written. Every function existed on both sides,
 * so that test passed, while the web build failed at the database the first
 * time anyone started in-house work. The gap was in the columns, and nothing
 * compared columns.
 *
 * This does. It builds the desktop schema for real (every migration, into
 * node:sqlite) and reads the hosted schema out of the Postgres migrations,
 * then requires every desktop column to exist on the hosted side. The hosted
 * side may have MORE -- server-only tables and columns are fine -- but a
 * column the desktop app writes and the web build lacks is exactly the bug
 * this exists to stop.
 *
 * The hosted side is parsed, not executed: there is no Postgres in the test
 * environment. The parser splits table bodies on top-level commas, so it
 * copes with several columns on one line and with commas inside check(...)
 * and numeric(10,2).
 *
 * It also checks one thing that has nothing to do with the desktop, because
 * it is the same blind spot one level further in. 0015_guide.sql enabled row
 * level security on guide_seen and stopped there. On Postgres, RLS with no
 * policy is DENY, not allow: the hosted guide read back nothing and wrote
 * nothing, silently, while every column matched and this file passed. So
 * every hosted table that enables RLS must also gain a policy. Fixed in
 * 0018_guide_policy.sql.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(ROOT, dir, f), 'utf8'))

/** Tables that exist on one side on purpose. Each needs a reason. */
const DESKTOP_ONLY_TABLES: Record<string, string> = {}

/** Columns that exist on the desktop only on purpose. Each needs a reason. */
const DESKTOP_ONLY_COLUMNS: Record<string, string> = {}

function desktopSchema(): Map<string, Set<string>> {
  const db = new DatabaseSync(':memory:')
  for (const sql of read('src-tauri/migrations')) db.exec(sql)
  const tables = (
    db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_sqlx%'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
  return new Map(
    tables.map((t) => [
      t,
      new Set((db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name)),
    ]),
  )
}

/** Split on commas that are not inside parentheses. */
function topLevelSplit(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

const NOT_A_COLUMN = /^(primary|unique|constraint|check|foreign|exclude|like)\b/i

function hostedSchema(): Map<string, Set<string>> {
  const sql = read('supabase/migrations')
    .join('\n')
    .replace(/--[^\n]*/g, '')
  const schema = new Map<string, Set<string>>()
  const cols = (t: string) => {
    if (!schema.has(t)) schema.set(t, new Set())
    return schema.get(t)!
  }

  // create table <name> ( ...body... ) -- body found by matching parens
  const createRe = /create table (?:if not exists )?(?:public\.)?(\w+)\s*\(/gi
  for (let m = createRe.exec(sql); m; m = createRe.exec(sql)) {
    let depth = 1
    let i = createRe.lastIndex
    const start = i
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++
      if (sql[i] === ')') depth--
    }
    for (const item of topLevelSplit(sql.slice(start, i - 1))) {
      const t = item.trim()
      if (!t || NOT_A_COLUMN.test(t)) continue
      cols(m[1]).add(t.split(/\s+/)[0].replace(/"/g, ''))
    }
  }

  const alterRe = /alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)([^;]*);/gi
  for (let m = alterRe.exec(sql); m; m = alterRe.exec(sql)) {
    for (const a of m[2].matchAll(/add column (?:if not exists )?"?(\w+)"?/gi)) cols(m[1]).add(a[1])
    for (const a of m[2].matchAll(/drop column (?:if exists )?"?(\w+)"?/gi)) cols(m[1]).delete(a[1])
  }
  return schema
}

/**
 * Tables the hosted migrations turn RLS on for, and tables they create a
 * policy on. Order does not matter -- a later migration may carry the policy
 * for a table an earlier one locked down -- so both are collected across the
 * whole migration set and compared once at the end.
 */
function hostedRls(): { enabled: Set<string>; policied: Set<string> } {
  const sql = read('supabase/migrations')
    .join('\n')
    .replace(/--[^\n]*/g, '')
  const enabled = new Set<string>()
  const policied = new Set<string>()

  for (const m of sql.matchAll(
    /alter table (?:if exists )?(?:only )?(?:public\.)?"?(\w+)"?\s+enable row level security/gi,
  ))
    enabled.add(m[1])
  for (const m of sql.matchAll(/create policy\s+"?[\w]+"?\s+on\s+(?:public\.)?"?(\w+)"?/gi))
    policied.add(m[1])

  // 0016_selling.sql does both inside a do $$ ... $$ loop over a text array,
  // so the statements above never appear literally. Read the array instead.
  for (const m of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]+)\]/gi))
    for (const q of m[1].matchAll(/'(\w+)'/g)) {
      enabled.add(q[1])
      policied.add(q[1])
    }
  return { enabled, policied }
}

describe('the desktop and hosted schemas describe the same shop', () => {
  const desktop = desktopSchema()
  const hosted = hostedSchema()

  it('the parser actually found the hosted schema', () => {
    // Guards the guard: a parser that finds nothing would pass everything.
    expect(hosted.size).toBeGreaterThan(15)
    expect(hosted.get('jobs')?.has('title')).toBe(true)
    // Several columns on one line in 0001 -- the case a naive parser misses.
    expect(hosted.get('materials')?.has('kind')).toBe(true)
  })

  it('every desktop table exists on the hosted backend', () => {
    const missing = [...desktop.keys()].filter((t) => !hosted.has(t) && !(t in DESKTOP_ONLY_TABLES))
    expect(missing, 'tables the desktop app writes that the web build does not have').toEqual([])
  })

  it('every desktop column exists on the hosted backend', () => {
    const missing: string[] = []
    for (const [t, cs] of desktop) {
      const h = hosted.get(t)
      if (!h) continue
      for (const c of cs) {
        if (!h.has(c) && !(`${t}.${c}` in DESKTOP_ONLY_COLUMNS)) missing.push(`${t}.${c}`)
      }
    }
    expect(
      missing.sort(),
      'columns the desktop app writes that the web build does not have -- write the hosted twin migration',
    ).toEqual([])
  })

  it('carries the in-house columns on both sides, which is where this started', () => {
    expect(hosted.get('jobs')?.has('kind')).toBe(true)
    expect(hosted.get('clients')?.has('system')).toBe(true)
  })

  describe('row level security on the hosted side', () => {
    const { enabled, policied } = hostedRls()

    it('the parser actually found the RLS statements', () => {
      // Guards the guard, same as above: finding nothing would pass everything.
      expect(enabled.size).toBeGreaterThan(10)
      expect(enabled.has('jobs')).toBe(true)
      // Enabled and policied inside 0016's do-block, not as literal statements.
      expect(enabled.has('sales')).toBe(true)
      expect(policied.has('sales')).toBe(true)
    })

    it('every table with RLS enabled has a policy', () => {
      // RLS with no policy is DENY on Postgres. A table locked down and left
      // unreachable reads exactly like a feature that does not work.
      const locked = [...enabled].filter((t) => !policied.has(t)).sort()
      expect(
        locked,
        'hosted tables with RLS enabled and no policy -- every read and write on these is denied',
      ).toEqual([])
    })

    it('guide_seen is reachable, which is the bug that prompted this', () => {
      expect(enabled.has('guide_seen')).toBe(true)
      expect(policied.has('guide_seen')).toBe(true)
    })
  })
})
