/// <reference types="node" />
/**
 * A price set on purpose is not a guess (CG, 5 Nov 2026).
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
const ACTOR = 'actor-1'

beforeEach(() => {
  currentDb = freshDb()
  currentDb.sqlite.exec(`
    insert into shops (id, name, slug, currency, locale) values ('${SHOP}', 'Test', 'test', 'USD', 'en-US');
    insert into profiles (id, shop_id, full_name, role) values ('${ACTOR}', '${SHOP}', 'CG', 'owner');
    insert into materials (id, shop_id, name, kind, unit, cost_per_unit) values ('petg', '${SHOP}', 'PETG', 'filament', 'g', 0.03);
  `)
  vi.resetModules()
})

const basis = () => (currentDb.sqlite.prepare("select basis from material_costs where material_id = 'petg'").get() as { basis: string }).basis

describe('what a material costs, and how Guma knows', () => {
  it('starts as the setup estimate', () => {
    expect(basis()).toBe('estimate')
  })

  it('"this price is right" makes it a price you set', async () => {
    const { confirmMaterialCost } = await import('./data.local')
    await confirmMaterialCost(SHOP, 'petg')
    expect(basis()).toBe('confirmed')
  })

  it('changing the price in Settings confirms it; saving it unchanged does not', async () => {
    const { saveMaterial } = await import('./data.local')
    const row = { id: 'petg', name: 'PETG', kind: 'filament', swatch: '#000', unit: 'g' as const, costPerUnit: 0.03, sellOverride: null, onHand: null, reorderAt: null, archived: false }
    await saveMaterial(SHOP, row as never)
    expect(basis()).toBe('estimate')
    await saveMaterial(SHOP, { ...row, costPerUnit: 0.032 } as never)
    expect(basis()).toBe('confirmed')
  })

  it('a logged purchase is still measured, above a set price', async () => {
    const { confirmMaterialCost, recordMaterialPurchase } = await import('./data.local')
    await confirmMaterialCost(SHOP, 'petg')
    await recordMaterialPurchase(SHOP, 'petg', ACTOR, { purchasedOn: '2026-11-05', qty: 1000, totalCost: 28, supplier: null, note: null })
    expect(basis()).toBe('purchases')
  })

})
