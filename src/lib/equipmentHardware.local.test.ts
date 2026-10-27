/// <reference types="node" />
/**
 * importSlice against a real SQLite database.
 *
 * The parser has its own tests; this is the other half -- does the SQL run,
 * does the build sheet actually fill in, and above all does an imported
 * estimate stay out of job_actuals. That last one cannot be checked by
 * reading code and would not be caught by a mocked backend, which is the
 * lesson the rate-card bug left: it lived in a SELECT.
 *
 * Same node:sqlite stand-in for @tauri-apps/plugin-sql as data.local.test.ts.
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

/** The minimum rows importSlice's foreign keys need. */
function seed(db: ReturnType<typeof freshDb>) {
  db.sqlite.exec(`
    insert into shops (id, name, slug, currency, locale)
      values ('${SHOP}', 'Test', 'test', 'USD', 'en-US');
    insert into profiles (id, shop_id, full_name, role)
      values ('${ACTOR}', '${SHOP}', 'CG', 'owner');
    insert into clients (id, shop_id, name) values ('client-1', '${SHOP}', 'A client');
    insert into jobs (id, shop_id, ref, client_id, title)
      values ('${JOB}', '${SHOP}', 'J-001', 'client-1', 'Reef markers');
    insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly)
      values ('printer-1', '${SHOP}', 'Sakman', 'Prusa XL', 'fdm', 9, 3);
    insert into materials (id, shop_id, name, kind, unit, cost_per_unit)
      values ('material-1', '${SHOP}', 'PETG black', 'filament', 'g', 0.025);
  `)
}

beforeEach(() => {
  currentDb = freshDb()
  seed(currentDb)
  vi.resetModules()
})


/**
 * Equipment and hardware, end to end against the real schema (CG, 27 Oct).
 * Money a shop acts on, so the view's arithmetic is checked here, on real
 * SQLite, not in a mock.
 */
const actuals = () =>
  currentDb.sqlite.prepare('select equipment_hours, equipment_cost, hardware_cost from job_actuals where job_id = ?').get(JOB) as Record<string, number>

describe('equipment that is not a printer', () => {
  beforeEach(() => currentDb.sqlite.exec(`update shops set electricity_rate_kwh = 0.4 where id = '${SHOP}'`))

  it('logged hours cost power plus wear, and are on the project', async () => {
    const data = await import('./data.local')
    // Sunlu S4 Pro: 150 W average, $140 over 5,000 h.
    const dryer = await data.saveEquipment(SHOP, { name: 'Sunlu S4 Pro', kind: 'dryer', tracking: 'hours', watts: 150, price: 140, lifeHours: 5000, printerIds: [] })
    await data.logEquipmentUse(SHOP, JOB, ACTOR, { equipmentId: dryer, hours: 6, usedOn: '2026-10-27', note: 'PETG before Maui' })
    // 6 h x (0.15 kW x $0.40 + $140 / 5,000) = 6 x (0.06 + 0.028) = 0.528
    expect(actuals().equipment_hours).toBe(6)
    expect(actuals().equipment_cost).toBeCloseTo(0.528, 6)
    const ex = await data.listJobExtras(SHOP, JOB)
    expect(ex.equipment.map((e) => [e.equipmentName, e.hours])).toEqual([['Sunlu S4 Pro', 6]])
  })

  it('riding along costs for every print hour of the printers it serves, and nothing for others', async () => {
    const data = await import('./data.local')
    currentDb.sqlite.exec(`insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly) values ('printer-2', '${SHOP}', 'Other', 'MK4', 'fdm', 5, 1)`)
    await data.saveEquipment(SHOP, { name: 'Fume extractor', kind: 'fume', tracking: 'printers', watts: 50, price: 0, lifeHours: null, printerIds: ['printer-1'] })
    for (const [p, h] of [['printer-1', 2], ['printer-2', 5]] as const)
      await data.recordPrintRun(SHOP, JOB, ACTOR, { printerId: p, materialId: null, unitsUsed: 0, hours: h, outcome: 'success', failureReason: null, note: null, startedAt: '2026-10-27' })
    // Only printer-1's 2 h: 2 x 0.05 kW x $0.40 = 0.04
    expect(actuals().equipment_cost).toBeCloseTo(0.04, 6)
    expect(actuals().equipment_hours).toBe(0)
  })

  it('will not log hours on equipment tracked another way', async () => {
    const data = await import('./data.local')
    const room = await data.saveEquipment(SHOP, { name: 'Dehumidifier', kind: 'dehumidifier', tracking: 'overhead', watts: 400, price: 200, lifeHours: 10000, printerIds: [] })
    await expect(data.logEquipmentUse(SHOP, JOB, ACTOR, { equipmentId: room, hours: 1, usedOn: null, note: null })).rejects.toThrow(/not tracked by logged hours/)
  })
})

describe('hardware counted per piece', () => {
  it("a part's per-copy pieces count for every copy that came off, and go back when one fails", async () => {
    const data = await import('./data.local')
    const mag = await data.saveHardware(SHOP, { name: '6×2 mm magnet', unitCost: 0.08, markupPct: 25, onHand: 100, reorderAt: 20 })
    const part = await data.addPart(SHOP, JOB, ACTOR, { label: 'Maui', qty: 3, note: null })
    await data.setPartHardware(SHOP, part, mag, 6)
    await data.setCopyStates(SHOP, part, ACTOR, [0, 1], 'printed', null)
    // 2 copies x 6 x $0.08
    expect(actuals().hardware_cost).toBeCloseTo(0.96, 6)
    expect((await data.listHardware(SHOP))[0]).toMatchObject({ available: 88, used: 12 })
    // A copy fails: its magnets are back.
    await data.setCopyStates(SHOP, part, ACTOR, [1], 'reprint', 'Ghost printing')
    expect((await data.listHardware(SHOP))[0]).toMatchObject({ available: 94, used: 6 })
    // Counting stock later never shifts history.
    await data.saveHardware(SHOP, { id: mag, name: '6×2 mm magnet', unitCost: 0.08, markupPct: 25, onHand: 50, reorderAt: 20 })
    expect((await data.listHardware(SHOP))[0]).toMatchObject({ available: 50 })
  })

  it('logged pieces keep the cost they had when used', async () => {
    const data = await import('./data.local')
    const mag = await data.saveHardware(SHOP, { name: 'Magnet', unitCost: 0.1, markupPct: 0, onHand: 10, reorderAt: 0 })
    const use = await data.addHardwareUse(SHOP, JOB, ACTOR, { itemId: mag, qty: 4, note: 'Glued into a failed copy' })
    await data.saveHardware(SHOP, { id: mag, name: 'Magnet', unitCost: 0.5, markupPct: 0, onHand: 6, reorderAt: 0 })
    expect(actuals().hardware_cost).toBeCloseTo(0.4, 6)
    await data.deleteHardwareUse(SHOP, use)
    expect(actuals().hardware_cost).toBe(0)
    expect((await data.listHardware(SHOP))[0].available).toBe(10)
  })

  it("an assembly's pieces are used when it is finished, and are in the Shelf unit cost", async () => {
    const data = await import('./data.local')
    const mag = await data.saveHardware(SHOP, { name: 'Magnet', unitCost: 0.25, markupPct: 0, onHand: 30, reorderAt: 0 })
    const run = await data.recordPrintRun(SHOP, JOB, ACTOR, { printerId: 'printer-1', materialId: 'material-1', unitsUsed: 20, hours: 1, outcome: 'success', failureReason: null, note: null, startedAt: '2026-10-27' })
    await data.recordMadeItems(SHOP, JOB, run, [{ sectionId: null, label: 'Island', grams: 20, unitCost: 2, failed: false }])
    const asm = await data.saveAssembly(SHOP, JOB, { name: 'Maui 12in', needs: [] })
    await data.setAssemblyHardware(SHOP, asm, mag, 6)
    const [it0] = await data.listMadeItems(SHOP, JOB)
    await data.placeItems(SHOP, JOB, [it0.id], { kind: 'assembly', assemblyId: asm })
    const { batchId } = await data.finishAssembly(SHOP, asm, { kind: 'shelf', productId: null, madeOn: '2026-10-27' })
    // $2 of print + 6 x $0.25 of magnets
    expect(currentDb.sqlite.prepare('select unit_cost from batches where id = ?').get(batchId!)).toEqual({ unit_cost: 3.5 })
    expect(actuals().hardware_cost).toBeCloseTo(1.5, 6)
    expect((await data.listHardware(SHOP))[0].available).toBe(24)
    await expect(data.setAssemblyHardware(SHOP, asm, mag, 2)).rejects.toThrow(/finished/)
  })
})
