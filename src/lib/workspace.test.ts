/// <reference types="node" />
/**
 * The demo workspace, and the guard on it.
 *
 * resetWorkspace deletes a shop's entire history with no undo. The only
 * thing standing between a demo reset and someone's real records is one
 * condition, so it is tested from both sides: that it wipes the demo, and
 * that it refuses -- loudly, having changed nothing -- when the real
 * workspace is active.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION_SQL = readdirSync(join(here, '../../src-tauri/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '../../src-tauri/migrations', f), 'utf8'))
  .join('\n')

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION_SQL)
  return {
    sqlite,
    path: 'sqlite:guma.db',
    async execute(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...(params as never[]))
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...(params as never[]))
    },
  }
}

let currentDb: ReturnType<typeof freshDb>
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))

/** A minimal in-memory localStorage, since node has none. */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

beforeEach(() => {
  currentDb = freshDb()
  vi.stubGlobal('localStorage', fakeStorage())
  vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

/** A shop with something in it, so a wipe has something to remove. */
function seed() {
  currentDb.sqlite.exec(`
    insert into shops (id, name, slug, currency, locale)
      values ('s1', 'Kahului Fab', 'kahului-fab', 'USD', 'en-US');
    insert into clients (id, shop_id, name) values ('c1', 's1', 'Reef Watch');
    insert into jobs (id, shop_id, ref, client_id, title)
      values ('j1', 's1', 'J-001', 'c1', 'Markers');
    insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly)
      values ('p1', 's1', 'Sakman', 'Prusa XL', 'fdm', 9, 3);
  `)
}

const counts = () => ({
  shops: (currentDb.sqlite.prepare('select count(*) as n from shops').get() as { n: number }).n,
  jobs: (currentDb.sqlite.prepare('select count(*) as n from jobs').get() as { n: number }).n,
  printers: (currentDb.sqlite.prepare('select count(*) as n from printers').get() as { n: number })
    .n,
})

describe('which workspace is active', () => {
  it('is the real shop by default', async () => {
    const w = await import('./workspace')
    expect(w.activeWorkspace()).toBe('shop')
    expect(w.activeDbUrl()).toBe('sqlite:guma.db')
    expect(w.isDemo()).toBe(false)
  })

  it('points the demo at a SEPARATE file, never the real one', async () => {
    const w = await import('./workspace')
    w.switchWorkspace('demo', () => {})
    expect(w.activeDbUrl()).toBe('sqlite:guma-demo.db')
    // The whole design rests on this: a demo that shared the file would
    // wipe the shop's real history the first time it was reset.
    expect(w.activeDbUrl()).not.toBe('sqlite:guma.db')
  })

  it('falls back to the real shop when storage cannot be read', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const w = await import('./workspace')
    // Defaulting to the demo would hide a shop's data behind a blank
    // screen and look exactly like data loss.
    expect(w.activeWorkspace()).toBe('shop')
    expect(w.isDemo()).toBe(false)
  })

  it('reports a failed switch rather than reloading into the same place', async () => {
    const reload = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied')
      },
    })
    const w = await import('./workspace')
    expect(w.switchWorkspace('demo', reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads on a switch, because the connection is cached', async () => {
    const reload = vi.fn()
    const w = await import('./workspace')
    expect(w.switchWorkspace('demo', reload)).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe('resetting the demo workspace', () => {
  it('REFUSES while the real shop is active, and changes nothing', async () => {
    seed()
    const before = counts()
    const { resetWorkspace } = await import('./data.local')

    await expect(resetWorkspace()).rejects.toThrow(/Refusing to empty your shop/)
    // Not "threw" -- unchanged. A guard that throws after deleting half of
    // it would pass a test that only checked the message.
    expect(counts()).toEqual(before)
  })

  it('empties every table when the demo is active', async () => {
    seed()
    const w = await import('./workspace')
    w.switchWorkspace('demo', () => {})
    const { resetWorkspace } = await import('./data.local')

    await resetWorkspace()
    expect(counts()).toEqual({ shops: 0, jobs: 0, printers: 0 })
  })

  it('leaves no table behind, including ones added later', async () => {
    seed()
    const w = await import('./workspace')
    w.switchWorkspace('demo', () => {})
    const { resetWorkspace } = await import('./data.local')
    await resetWorkspace()

    // The wipe reads the table list from the schema rather than a list in
    // the source, so a migration added next month is covered without
    // anyone remembering. This asserts that property, not a fixed count.
    const tables = currentDb.sqlite
      .prepare(
        `select name from sqlite_master where type='table'
           and name not like 'sqlite_%' and name not like '_sqlx%'`,
      )
      .all() as { name: string }[]
    expect(tables.length).toBeGreaterThan(20)
    for (const t of tables) {
      const n = currentDb.sqlite.prepare(`select count(*) as n from "${t.name}"`).get() as {
        n: number
      }
      expect({ table: t.name, rows: n.n }).toEqual({ table: t.name, rows: 0 })
    }
  })

  it('leaves the database usable, so the next launch is a real first run', async () => {
    seed()
    const w = await import('./workspace')
    w.switchWorkspace('demo', () => {})
    const { resetWorkspace } = await import('./data.local')
    await resetWorkspace()

    // Foreign keys back on, tables intact, no shop -- which is what makes
    // loadShopContext throw NeedsSetup and the wizard open.
    currentDb.sqlite.exec(
      `insert into shops (id, name, slug, currency, locale)
         values ('s2', 'Fresh', 'fresh', 'USD', 'en-US')`,
    )
    expect(counts().shops).toBe(1)
  })
})
