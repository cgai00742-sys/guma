/// <reference types="node" />
/**
 * Removing a print whose pieces were already placed (CG, 28 Oct 2026):
 * they come back first, instead of the removal silently doing nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
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
// The quote-build tests below go through the DISPATCHER (./data) rather than
// data.local directly, because saveQuote is what a screen calls. Without
// this the dispatcher decides it is not in Tauri, loads data.supabase and
// tries to reach the network -- which fails as "fetch failed", naming
// nothing useful.
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

const SHOP = 'shop-1'
const JOB = 'job-1'
const ACTOR = 'actor-1'

function seed(db: ReturnType<typeof freshDb>) {
  db.sqlite.exec(`
    insert into shops (id, name, slug, currency, locale) values ('${SHOP}', 'Test', 'test', 'USD', 'en-US');
    insert into profiles (id, shop_id, full_name, role) values ('${ACTOR}', '${SHOP}', 'CG', 'owner');
    insert into clients (id, shop_id, name) values ('client-1', '${SHOP}', 'Guma');
    insert into jobs (id, shop_id, ref, client_id, title, kind) values ('${JOB}', '${SHOP}', 'J-001', 'client-1', 'Maui magnets', 'inhouse');
    insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly) values ('p1', '${SHOP}', 'Hatsa', 'XL', 'fdm', 1, 1);
    insert into print_runs (id, shop_id, job_id, printer_id, started_at, units_used, outcome)
      values ('r1', '${SHOP}', '${JOB}', 'p1', '2026-10-26', 27, 'success'),
             ('r2', '${SHOP}', '${JOB}', 'p1', '2026-10-27', 27, 'success');
    insert into products (id, shop_id, name) values ('prod', '${SHOP}', 'Maui hang magnet');
  `)
}

beforeEach(() => {
  currentDb = freshDb()
  seed(currentDb)
  vi.resetModules()
})

function shelve(batch: string, units: number, items: [string, string][]) {
  currentDb.sqlite.exec(`insert into batches (id, shop_id, product_id, job_id, units_made, unit_cost, made_on)
    values ('${batch}', '${SHOP}', 'prod', '${JOB}', ${units}, 2, '2026-10-27')`)
  for (const [id, run] of items)
    currentDb.sqlite.exec(`insert into made_items (id, shop_id, job_id, run_id, label, unit_cost, status, batch_id)
      values ('${id}', '${SHOP}', '${JOB}', '${run}', 'Maui HANG-MAGNET', 2, 'shelved', '${batch}')`)
}

describe('removing a print whose pieces were placed', () => {
  it('a batch made only of its pieces goes, and the print can then be removed', async () => {
    shelve('b1', 1, [['m2', 'r2']])
    const { takeBackPlaced, deletePrintRun } = await import('./data.local')
    expect(await takeBackPlaced(SHOP, ['r2'])).toBe(1)
    await deletePrintRun(SHOP, 'r2', true)
    expect(currentDb.sqlite.prepare("select count(*) as n from batches where id = 'b1'").get()).toEqual({ n: 0 })
    expect(currentDb.sqlite.prepare("select count(*) as n from print_runs where id = 'r2'").get()).toEqual({ n: 0 })
  })

  it('a shared batch shrinks by its pieces and keeps the rest', async () => {
    shelve('b1', 2, [['m1', 'r1'], ['m2', 'r2']])
    const { takeBackPlaced } = await import('./data.local')
    await takeBackPlaced(SHOP, ['r2'])
    expect(currentDb.sqlite.prepare("select units_made from batches where id = 'b1'").get()).toEqual({ units_made: 1 })
    expect(currentDb.sqlite.prepare("select status from made_items where id = 'm1'").get()).toEqual({ status: 'shelved' })
  })

  it('refuses when the batch has sold more than would be left', async () => {
    shelve('b1', 1, [['m2', 'r2']])
    currentDb.sqlite.exec(`insert into sales (id, shop_id, batch_id, units, unit_price, sold_on) values ('s1', '${SHOP}', 'b1', 1, 20, '2026-10-28')`)
    const { takeBackPlaced } = await import('./data.local')
    await expect(takeBackPlaced(SHOP, ['r2'])).rejects.toThrow(/has sold/)
    expect(currentDb.sqlite.prepare("select status from made_items where id = 'm2'").get()).toEqual({ status: 'shelved' })
  })
})
