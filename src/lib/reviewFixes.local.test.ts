/// <reference types="node" />
/**
 * Regression tests for four data-layer bugs found in review (8 Oct 2026),
 * run against a real SQLite database with every desktop migration applied.
 * Same node:sqlite stand-in for @tauri-apps/plugin-sql as data.local.test.ts.
 *
 *  1. markPlatePrinted moved one section at a time from a single read, so a
 *     plate with two sections on the same part ("Leg" and "leg" -- the
 *     slicer groups names case-sensitively, importSlice matches them
 *     ignoring case) marked the first and then threw, half-applied.
 *  2. An unsent DRAFT revision of an accepted quote became the project's
 *     quote status and total, so an agreed in-build project read as "not
 *     agreed", lost its client value and dropped out of margin history,
 *     while job_money still billed the accepted price.
 *  3. job_actuals' power_cost covered only runs on metered printers and
 *     then replaced machine_cost wholesale, so on a mixed fleet every run
 *     on a printer without wattage cost $0 (0033_actuals_per_run_power.sql).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flagsFor } from './gates'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n')

const SHOP = 'shop-1'
const JOB = 'job-1'
const ACTOR = 'actor-1'

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION_SQL)
  sqlite.exec(`
    insert into shops (id, name, slug, currency, locale) values ('${SHOP}', 'Test', 'test', 'USD', 'en-US');
    insert into profiles (id, shop_id, full_name, role) values ('${ACTOR}', '${SHOP}', 'CG', 'owner');
    insert into clients (id, shop_id, name) values ('client-1', '${SHOP}', 'A client');
    insert into jobs (id, shop_id, ref, client_id, title, taken_in_at, phase)
      values ('${JOB}', '${SHOP}', 'J-001', 'client-1', 'Reef markers', '2026-10-01', 'building');
    insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly)
      values ('printer-1', '${SHOP}', 'Sakman', 'Prusa XL', 'fdm', 9, 3);
    insert into materials (id, shop_id, name, kind, unit, cost_per_unit, on_hand)
      values ('material-1', '${SHOP}', 'PETG black', 'filament', 'g', 0.025, 1000);
  `)
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
beforeEach(() => {
  currentDb = freshDb()
  vi.resetModules()
})

describe('marking a plate printed', () => {
  const plate = (sections: { label: string; qty: number }[]) => ({
    fileName: 'legs.3mf',
    kind: '3mf' as const,
    printerModel: 'Prusa XL',
    printerId: 'printer-1',
    materialText: 'PETG',
    materialId: 'material-1',
    estMinutes: 60,
    estGrams: 40,
    notes: [],
    sections: sections.map((s) => ({ ...s, estMinutes: 30, estGrams: 20, material: 'PETG' })),
  })

  it('sums two sections on the same part instead of throwing half-way', async () => {
    const L = await import('./data.local')
    const res = await L.importSlice(SHOP, JOB, ACTOR, plate([{ label: 'Leg', qty: 1 }, { label: 'leg', qty: 1 }]))
    expect(res).toMatchObject({ partsAdded: 1, partsMatched: 1 })
    await expect(L.markPlatePrinted(SHOP, JOB, ACTOR, res.importId)).resolves.toBe(1)
    const [p] = currentDb.sqlite.prepare('select qty, status, printed_n from job_parts').all() as any[]
    expect(p).toMatchObject({ qty: 1, status: 'printed', printed_n: 1 })
    // One move, one history line -- not one per section.
    expect(currentDb.sqlite.prepare("select count(*) as n from part_events where kind = 'status' and n is not null").get()).toEqual({ n: 1 })
  })

  it('moves the plate total, capped by what is left to print', async () => {
    const L = await import('./data.local')
    await L.addPart(SHOP, JOB, ACTOR, { label: 'Leg', qty: 3, note: null })
    const res = await L.importSlice(SHOP, JOB, ACTOR, plate([{ label: 'Leg', qty: 1 }, { label: 'LEG', qty: 1 }]))
    await L.markPlatePrinted(SHOP, JOB, ACTOR, res.importId)
    expect(currentDb.sqlite.prepare('select printed_n from job_parts').get()).toEqual({ printed_n: 2 })
    // Second plate: two more on it, one copy left -- one moves, no throw.
    await expect(L.markPlatePrinted(SHOP, JOB, ACTOR, res.importId)).resolves.toBe(1)
    expect(currentDb.sqlite.prepare('select printed_n, status from job_parts').get()).toEqual({ printed_n: 3, status: 'printed' })
  })
})

describe('a failed copy given a replacement file (CG, 9 Oct)', () => {
  const file = (fileName: string, sections: { label: string; qty: number }[]) => ({
    fileName,
    kind: 'gcode' as const,
    printerModel: 'Prusa XL',
    printerId: 'printer-1',
    materialText: 'PETG',
    materialId: 'material-1',
    estMinutes: 20,
    estGrams: 9,
    notes: [],
    sections: sections.map((x) => ({ ...x, estMinutes: 20, estGrams: 9, material: 'PETG' })),
  })
  const states = () =>
    JSON.parse((currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Hull'").get() as any).copy_states)

  it('keeps the failure, links the file to that copy, and recording the file prints that copy', async () => {
    const L = await import('./data.local')
    const partId = await L.addPart(SHOP, JOB, ACTOR, { label: 'Hull', qty: 3, note: null })
    await L.setCopyStates(SHOP, partId, ACTOR, [1], 'reprint', 'Warped corner')
    const fix = await L.importSlice(SHOP, JOB, ACTOR, { ...file('hull v2.gcode', [{ label: 'Hull fixed', qty: 1 }]), forPartId: partId })
    expect(fix).toMatchObject({ partsAdded: 0, partsMatched: 1 })
    await L.requeueCopyFromFile(SHOP, partId, ACTOR, 1, fix.importId, 'hull v2.gcode')
    expect(states()).toEqual(['pending', 'pending', 'pending'])

    // The failure is still on record, and the requeue names the file.
    const evs = currentDb.sqlite
      .prepare("select to_status, copies, note, slice_import_id from part_events where part_id = ? and kind = 'status' order by id")
      .all(partId) as any[]
    expect(evs.find((e) => e.to_status === 'reprint')).toMatchObject({ copies: '2', note: 'Warped corner' })
    expect(evs.at(-1)).toMatchObject({ to_status: 'pending', copies: '2', slice_import_id: fix.importId })
    const detail = await L.loadProjectDetail(SHOP, JOB)
    const hull = detail.parts.find((x) => x.id === partId)!
    expect(hull.history.find((h) => h.sliceImportId === fix.importId)?.copies).toEqual([2])
    // The part prints from the fix now.
    expect(hull.chosenSectionId).toBe(hull.variants.find((v) => v.fileName === 'hull v2.gcode')?.sectionId)

    // The fix plate came off: copy 2 is printed -- not copy 1, the next in line.
    await L.markPlatePrinted(SHOP, JOB, ACTOR, fix.importId)
    expect(states()).toEqual(['pending', 'printed', 'pending'])
  })

  it('only a failed copy can be given a replacement', async () => {
    const L = await import('./data.local')
    const partId = await L.addPart(SHOP, JOB, ACTOR, { label: 'Hull', qty: 2, note: null })
    const fix = await L.importSlice(SHOP, JOB, ACTOR, { ...file('hull v2.gcode', [{ label: 'Hull', qty: 1 }]), forPartId: partId })
    await expect(L.requeueCopyFromFile(SHOP, partId, ACTOR, 0, fix.importId, 'hull v2.gcode')).rejects.toThrow(/has not failed/)
  })

  it('a re-sliced plate with the part among others points the part at it without adding parts', async () => {
    const L = await import('./data.local')
    const partId = await L.addPart(SHOP, JOB, ACTOR, { label: 'Hull', qty: 1, note: null })
    await L.addPart(SHOP, JOB, ACTOR, { label: 'Lid', qty: 1, note: null })
    const fix = await L.importSlice(SHOP, JOB, ACTOR, {
      ...file('plate 3 v2.gcode', [{ label: 'Hull', qty: 1 }, { label: 'Lid', qty: 1 }]),
      forPartId: partId,
    })
    expect(fix).toMatchObject({ partsAdded: 0, partsMatched: 2 })
    const detail = await L.loadProjectDetail(SHOP, JOB)
    const hull = detail.parts.find((x) => x.id === partId)!
    expect(hull.chosenSectionId).toBe(hull.variants.find((v) => v.fileName === 'plate 3 v2.gcode')?.sectionId)
  })
})

describe('the quote that counts, beside the newest version', () => {
  beforeEach(() => {
    currentDb.sqlite.exec(`
      insert into quotes (id, shop_id, job_id, version, status, total, deposit_due, sent_at, design_billing, quantity)
        values ('q1', '${SHOP}', '${JOB}', 1, 'accepted', 1000, 500, '2026-10-01', 'hourly', 1);
      insert into quotes (id, shop_id, job_id, version, status, design_billing, quantity)
        values ('q2', '${SHOP}', '${JOB}', 2, 'draft', 'hourly', 1);
    `)
  })

  it('an unsent draft revision does not un-agree an accepted, in-build project', async () => {
    const L = await import('./data.local')
    const rows = await L.listJobs(SHOP)
    expect(rows).toHaveLength(1)
    const [row] = rows
    // The printable is still the newest version ...
    expect(row.quoteId).toBe('q2')
    // ... but the facts read the version job_money bills from.
    expect(row.facts.balanceOwed).toBe(1000)
    expect(row.facts.quoteStatus).toBe('accepted')
    expect(row.facts.quoteTotal).toBe(1000)
    expect(flagsFor(row.facts).some((f) => f.key === 'unagreed')).toBe(false)

    const d = await L.loadProjectDetail(SHOP, JOB)
    expect(d.quote?.id).toBe('q2')
    expect(d.facts.quoteStatus).toBe('accepted')

    const [client] = await L.listClients(SHOP)
    expect(client.value).toBe(1000)
  })

  it('a newer SENT revision still counts after the accepted one until it is accepted', async () => {
    currentDb.sqlite.exec(`update quotes set status = 'sent', total = 1200, sent_at = '2026-10-05' where id = 'q2'`)
    const L = await import('./data.local')
    const [row] = await L.listJobs(SHOP)
    expect(row.facts.quoteTotal).toBe(1000)
    currentDb.sqlite.exec(`update quotes set status = 'accepted' where id = 'q2'`)
    const [after] = await L.listJobs(SHOP)
    expect(after.facts.quoteTotal).toBe(1200)
    expect(after.facts.balanceOwed).toBe(1200)
  })

  it('a project with only a draft still reads that draft', async () => {
    currentDb.sqlite.exec(`delete from quotes where id = 'q1'`)
    const L = await import('./data.local')
    const [row] = await L.listJobs(SHOP)
    expect(row.facts.quoteStatus).toBe('draft')
  })
})

describe('machine cost on a mixed fleet', () => {
  function runs(...rows: [printer: string, hours: number][]) {
    rows.forEach(([printer, hours], i) =>
      currentDb.sqlite
        .prepare(
          `insert into print_runs (id, shop_id, job_id, printer_id, hours, outcome)
           values (?, '${SHOP}', '${JOB}', ?, ?, 'success')`,
        )
        .run(`run-${i}`, printer, hours),
    )
  }
  beforeEach(() => {
    currentDb.sqlite.exec(`
      update shops set electricity_rate_kwh = 0.30;
      update printers set wear_hourly = 0;
      insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly, watts)
        values ('printer-metered', '${SHOP}', 'Bay 2', 'P1S', 'fdm', 7, 0, 200);
    `)
  })

  it('charges unmetered runs at the machine rate, metered runs at their power', async () => {
    // 2 h metered at 200 W x $0.30 = $0.12; 3 h unmetered at $9/h = $27.
    runs(['printer-metered', 2], ['printer-1', 3])
    const L = await import('./data.local')
    const d = await L.loadProjectDetail(SHOP, JOB)
    expect(d.actuals.powerCost).toBeCloseTo(27.12, 6)
    expect(d.actuals.machineCost).toBeCloseTo(41, 6)
    expect(d.facts.actualCost).toBeCloseTo(27.12, 6)
  })

  it('is unchanged when no run is metered: power 0, the machine rate is the cost', async () => {
    runs(['printer-1', 3])
    const L = await import('./data.local')
    const d = await L.loadProjectDetail(SHOP, JOB)
    expect(d.actuals.powerCost).toBe(0)
    expect(d.facts.actualCost).toBeCloseTo(27, 6)
  })

  it('is unchanged when every run is metered: power only', async () => {
    runs(['printer-metered', 2])
    const L = await import('./data.local')
    const d = await L.loadProjectDetail(SHOP, JOB)
    expect(d.facts.actualCost).toBeCloseTo(0.12, 6)
  })
})
