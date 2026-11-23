/// <reference types="node" />
/**
 * Who a Shelf piece went to -- sold, donated, reserved -- against a real
 * SQLite database (CG, 22 Nov 2026).
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
    insert into products (id, shop_id, name) values ('maui', '${SHOP}', 'Maui BathyTopo');
    insert into batches (id, shop_id, product_id, units_made, unit_cost, made_on) values ('b1', '${SHOP}', 'maui', 5, 10, '2026-11-01');
    insert into channels (id, shop_id, name, fee_pct, fee_flat) values ('etsy', '${SHOP}', 'Etsy', 10, 0);
  `)
  vi.resetModules()
})

const stock = () =>
  currentDb.sqlite.prepare("select units_sold, units_left, units_reserved, units_donated, revenue, cost_of_sold from batch_stock where batch_id = 'b1'").get()
const base = { batchId: 'b1', channelId: null, units: 1, unitPrice: 80, soldOn: '2026-11-02' }

describe('who a Shelf piece went to', () => {
  it('a sale with nobody named is just a sale, as before', async () => {
    const { recordSale } = await import('./data.local')
    await recordSale(SHOP, base)
    expect(stock()).toMatchObject({ units_sold: 1, units_left: 4, units_reserved: 0, revenue: 80 })
    expect(currentDb.sqlite.prepare('select count(*) as n from clients').get()).toEqual({ n: 0 })
  })

  it('naming someone adds them once, and finds them again by email', async () => {
    const { recordSale, listClients, listSales } = await import('./data.local')
    await recordSale(SHOP, { ...base, person: { name: 'Kai Akana', email: 'kai@example.com', marketingOk: true } })
    await recordSale(SHOP, { ...base, person: { name: 'Kai A.', email: 'KAI@example.com', phone: '808 555 0101' } })
    const people = await listClients(SHOP)
    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({ name: 'Kai Akana', phone: '808 555 0101', shelfPieces: 2, marketingOk: true })
    expect((await listSales(SHOP)).map((s) => s.client_name)).toEqual(['Kai Akana', 'Kai Akana'])
  })

  it('a reservation holds the piece -- it cannot be sold twice -- and needs a name', async () => {
    const { recordSale } = await import('./data.local')
    await expect(recordSale(SHOP, { ...base, kind: 'reserved' })).rejects.toThrow(/reserved for/)
    await recordSale(SHOP, { ...base, units: 4, kind: 'reserved', person: { name: 'Leilani' } })
    expect(stock()).toMatchObject({ units_sold: 0, units_left: 1, units_reserved: 4, revenue: 0 })
    await expect(recordSale(SHOP, { ...base, units: 2 })).rejects.toThrow(/Only 1/)
  })

  it('a reservation becomes a sale, fee and all, or is released', async () => {
    const { recordSale, settleReservation, deleteSale } = await import('./data.local')
    const id = await recordSale(SHOP, { ...base, kind: 'reserved', person: { name: 'Leilani' } })
    await settleReservation(SHOP, id, { as: 'sale', unitPrice: 90, channelId: 'etsy', soldOn: '2026-11-20' })
    expect(currentDb.sqlite.prepare('select kind, fee_total, sold_on from sales where id = ?').get(id)).toEqual({ kind: 'sale', fee_total: 9, sold_on: '2026-11-20' })
    await expect(settleReservation(SHOP, id, { as: 'sale', unitPrice: 90, channelId: null, soldOn: '2026-11-20' })).rejects.toThrow(/already left/)
    const hold = await recordSale(SHOP, { ...base, kind: 'reserved', person: { name: 'Leilani' } })
    await deleteSale(SHOP, hold)
    expect(stock()).toMatchObject({ units_sold: 1, units_left: 4, units_reserved: 0 })
  })

  it('a donation brings nothing in, takes no cut, and its cost still counts', async () => {
    const { recordSale } = await import('./data.local')
    await recordSale(SHOP, { ...base, unitPrice: 80, channelId: 'etsy', kind: 'donation', person: { name: 'Maui Ocean Center', kind: 'nonprofit' } })
    expect(stock()).toMatchObject({ units_sold: 1, units_donated: 1, revenue: 0, cost_of_sold: 10 })
    expect(currentDb.sqlite.prepare('select fee_total, unit_price from sales').get()).toEqual({ fee_total: 0, unit_price: 0 })
    expect(currentDb.sqlite.prepare('select kind, source from clients').get()).toEqual({ kind: 'nonprofit', source: 'Shelf' })
  })

  it('says who after the fact, and asks how it is going a week later', async () => {
    const { recordSale, setSalePerson, listClients, markCheckedIn } = await import('./data.local')
    const id = await recordSale(SHOP, { ...base, soldOn: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10) })
    await setSalePerson(SHOP, id, { name: 'Kai Akana', phone: '808-555-0101' })
    expect((await listClients(SHOP))[0]).toMatchObject({ checkIns: 1 })
    await markCheckedIn(SHOP, id, '2026-11-22')
    expect((await listClients(SHOP))[0]).toMatchObject({ checkIns: 0 })
  })

  it('a batch cannot shrink below what is sold, given or held', async () => {
    const { recordSale, saveBatch } = await import('./data.local')
    await recordSale(SHOP, { ...base, units: 2, kind: 'reserved', person: { name: 'Leilani' } })
    await recordSale(SHOP, { ...base, units: 1 })
    await expect(saveBatch(SHOP, { id: 'b1', productId: 'maui', unitsMade: 2, unitCost: 10, madeOn: '2026-11-01' })).rejects.toThrow(/3 of these/)
  })
})
