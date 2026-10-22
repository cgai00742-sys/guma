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
import type { SliceImportInput } from './data.types'

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

const BUOY: SliceImportInput = {
  fileName: 'H2S_Reef buoy_sliced.gcode.3mf',
  kind: '3mf',
  printerModel: 'Bambu Lab H2S',
  printerId: 'printer-1',
  materialText: 'PETG',
  materialId: 'material-1',
  estMinutes: 123,
  estGrams: 86.5,
  notes: ['Time and filament are slicer estimates, split across sections by quantity.'],
  sections: [
    { label: 'Buoy shell', qty: 2, estMinutes: 82, estGrams: 57.7, material: 'PETG' },
    { label: 'Cap', qty: 1, estMinutes: 41, estGrams: 28.8, material: 'PETG' },
  ],
}

describe('importing a sliced file', () => {
  it('fills in the build sheet, one part per object, with copy counts', async () => {
    const { importSlice } = await import('./data.local')
    const res = await importSlice(SHOP, JOB, ACTOR, BUOY)
    expect(res).toMatchObject({ partsAdded: 2, partsMatched: 0 })

    const parts = currentDb.sqlite
      .prepare('select label, qty, status from job_parts where job_id = ? order by sort')
      .all(JOB)
    expect(parts).toEqual([
      { label: 'Buoy shell', qty: 2, status: 'pending' },
      { label: 'Cap', qty: 1, status: 'pending' },
    ])
  })

  it('says where each part came from, in its history', async () => {
    const { importSlice } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    const ev = currentDb.sqlite
      .prepare('select note, to_status from part_events where job_id = ? order by id')
      .all(JOB) as { note: string; to_status: string }[]
    expect(ev).toHaveLength(2)
    expect(ev[0].note).toBe('Imported from H2S_Reef buoy_sliced.gcode.3mf')
    expect(ev[0].to_status).toBe('pending')
  })

  it('reads back everything it stored, notes and sections included', async () => {
    const { importSlice, listSliceImports } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    const [imp] = await listSliceImports(SHOP, JOB)

    expect(imp.fileName).toBe('H2S_Reef buoy_sliced.gcode.3mf')
    expect(imp.estGrams).toBe(86.5)
    expect(imp.estMinutes).toBe(123)
    // Joined, not just the stored id -- the screen shows names.
    expect(imp.printerName).toBe('Sakman')
    expect(imp.materialName).toBe('PETG black')
    // The file's own word for the machine survives alongside the match.
    expect(imp.printerModel).toBe('Bambu Lab H2S')
    expect(imp.notes).toHaveLength(1)
    expect(imp.sections.map((s) => [s.label, s.qty, s.estGrams])).toEqual([
      ['Buoy shell', 2, 57.7],
      ['Cap', 1, 28.8],
    ])
    // Every section points at the build-sheet row it made.
    expect(imp.sections.every((s) => s.partId)).toBe(true)
  })

  it('survives a notes column that is not valid JSON', async () => {
    const { importSlice, listSliceImports } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    currentDb.sqlite.exec("update slice_imports set notes = 'not json at all'")
    const [imp] = await listSliceImports(SHOP, JOB)
    // An advisory note must never be able to take the project screen down.
    expect(imp.notes).toEqual([])
    expect(imp.fileName).toBe('H2S_Reef buoy_sliced.gcode.3mf')
  })
})

describe('an estimate is not an actual', () => {
  it('writes no print_run at all', async () => {
    const { importSlice } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    const runs = currentDb.sqlite.prepare('select count(*) as n from print_runs').get() as {
      n: number
    }
    expect(runs.n).toBe(0)
  })

  it('leaves job_actuals reading zero, which is the whole reason for the table', async () => {
    const { importSlice } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    const a = currentDb.sqlite
      .prepare('select material_units, material_cost, machine_hours, runs from job_actuals where job_id = ?')
      .get(JOB) as Record<string, number>
    // 86.5 g at $0.025 is $2.16 of material and 2 hours of machine time that
    // the shop has not spent. If any of these moves, an imported estimate
    // has reached the cost the project reports.
    expect(a.material_units).toBe(0)
    expect(a.material_cost).toBe(0)
    expect(a.machine_hours).toBe(0)
    expect(a.runs).toBe(0)
  })
})

describe('confirming the print that the file described', () => {
  /** The other half of the rule above. An estimate must not reach the
   *  actuals by itself -- and the moment the plate comes off the bed, the
   *  file's own numbers must be able to get there in one step, or the shop
   *  retypes them and the material count drifts. */
  it('deducts the filament and lands the hours, and says which file it came from', async () => {
    const { importSlice, recordPrintRun, loadProjectDetail } = await import('./data.local')
    currentDb.sqlite.exec("update materials set on_hand = 1000 where id = 'material-1'")
    const { importId } = await importSlice(SHOP, JOB, ACTOR, BUOY)

    await recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1',
      materialId: 'material-1',
      unitsUsed: 87,
      hours: 2.05,
      outcome: 'success',
      failureReason: null,
      note: `From ${BUOY.fileName}`,
      startedAt: '2026-09-27',
      sliceImportId: importId,
    })

    const a = currentDb.sqlite
      .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
      .get(JOB) as Record<string, number>
    expect(a.material_units).toBe(87)
    expect(a.machine_hours).toBe(2.05)
    expect(a.runs).toBe(1)

    const m = currentDb.sqlite
      .prepare("select on_hand from materials where id = 'material-1'")
      .get() as { on_hand: number }
    expect(m.on_hand).toBe(913)

    // And the screen can tell that this file has been recorded, so the same
    // plate does not get logged twice.
    const detail = await loadProjectDetail(SHOP, JOB)
    expect(detail.slices.map((x) => x.id)).toEqual([importId])
    expect(detail.runs[0].sliceImportId).toBe(importId)
  })

  it('keeps the run when the import is deleted -- the print still happened', async () => {
    const { importSlice, recordPrintRun, deleteSliceImport } = await import('./data.local')
    const { importId } = await importSlice(SHOP, JOB, ACTOR, BUOY)
    await recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1',
      materialId: 'material-1',
      unitsUsed: 87,
      hours: 2,
      outcome: 'failed',
      failureReason: 'Warped off the plate',
      note: null,
      startedAt: null,
      sliceImportId: importId,
    })
    await deleteSliceImport(SHOP, importId)
    const run = currentDb.sqlite
      .prepare('select slice_import_id, hours from print_runs')
      .all() as { slice_import_id: string | null; hours: number }[]
    expect(run).toHaveLength(1)
    expect(run[0].slice_import_id).toBeNull()
    expect(Number(run[0].hours)).toBe(2)
  })
})

describe('re-importing a fixed file for a reprint', () => {
  it('attaches the new estimate to the part that already exists', async () => {
    const { importSlice, listSliceImports } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)

    const fixed: SliceImportInput = {
      ...BUOY,
      fileName: 'H2S_Reef buoy_sliced_v2.gcode.3mf',
      estGrams: 91,
      sections: [{ label: 'buoy shell', qty: 2, estMinutes: 88, estGrams: 62, material: 'PETG' }],
    }
    const res = await importSlice(SHOP, JOB, ACTOR, fixed)

    // Matched by label, case-insensitively: "buoy shell" is "Buoy shell".
    expect(res).toMatchObject({ partsAdded: 0, partsMatched: 1 })
    const parts = currentDb.sqlite
      .prepare('select count(*) as n from job_parts where job_id = ?')
      .get(JOB) as { n: number }
    expect(parts.n).toBe(2) // still Buoy shell and Cap, not four rows

    // Both predictions survive, newest first -- "sliced twice and the
    // estimate went up" is the thing a shop wants to be able to see.
    const imports = await listSliceImports(SHOP, JOB)
    expect(imports.map((i) => i.fileName)).toEqual([
      'H2S_Reef buoy_sliced_v2.gcode.3mf',
      'H2S_Reef buoy_sliced.gcode.3mf',
    ])
    const shellEstimates = imports
      .flatMap((i) => i.sections)
      .filter((s) => s.label.toLowerCase() === 'buoy shell')
      .map((s) => s.estGrams)
    expect(shellEstimates).toEqual([62, 57.7])
  })

  it('does not overwrite a quantity the shop set', async () => {
    const { importSlice } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    currentDb.sqlite.exec("update job_parts set qty = 8 where label = 'Buoy shell'")
    await importSlice(SHOP, JOB, ACTOR, {
      ...BUOY,
      fileName: 'one-off.gcode',
      sections: [{ label: 'Buoy shell', qty: 1, estMinutes: 40, estGrams: 28, material: 'PETG' }],
    })
    const part = currentDb.sqlite
      .prepare("select qty from job_parts where label = 'Buoy shell'")
      .get() as { qty: number }
    // Re-slicing one copy must not quietly cut a build of eight down to one.
    expect(part.qty).toBe(8)
  })
})

describe('deleting an import', () => {
  it('takes its sections with it and leaves the build sheet alone', async () => {
    const { importSlice, listSliceImports, deleteSliceImport } = await import('./data.local')
    const { importId } = await importSlice(SHOP, JOB, ACTOR, BUOY)
    await deleteSliceImport(SHOP, importId)

    expect(await listSliceImports(SHOP, JOB)).toEqual([])
    const secs = currentDb.sqlite.prepare('select count(*) as n from slice_sections').get() as {
      n: number
    }
    expect(secs.n).toBe(0)
    // The parts are the shop's now, not the file's.
    const parts = currentDb.sqlite
      .prepare('select count(*) as n from job_parts where job_id = ?')
      .get(JOB) as { n: number }
    expect(parts.n).toBe(2)
  })

  it('will not delete another shop\'s import', async () => {
    const { importSlice, listSliceImports, deleteSliceImport } = await import('./data.local')
    const { importId } = await importSlice(SHOP, JOB, ACTOR, BUOY)
    await deleteSliceImport('some-other-shop', importId)
    expect(await listSliceImports(SHOP, JOB)).toHaveLength(1)
  })
})

describe('refusals', () => {
  it('refuses a file with nothing on the plate', async () => {
    const { importSlice } = await import('./data.local')
    await expect(importSlice(SHOP, JOB, ACTOR, { ...BUOY, sections: [] })).rejects.toThrow(
      /nothing on the plate/,
    )
  })
})

/* ---- quote build lines -------------------------------------------------- */

/**
 * A quote that spans two machines, saved and read back against real SQLite.
 *
 * The arithmetic is pricing.test.ts's job. This is the other half: does the
 * SQL run, does the order survive, and -- the one that matters -- does a
 * quote with build lines leave the old single-machine columns alone rather
 * than mirroring them. Two copies of one fact are free to disagree, and the
 * one that disagrees silently is the one that bills a client.
 */
describe('a quote saved across two machines', () => {
  async function saveTwoMachineQuote() {
    const data = await import('./data')
    currentDb.sqlite.exec(`
      insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly)
        values ('printer-2', '${SHOP}', 'Big Blue', 'Bambu Lab H2D', 'fdm', 12, 4);
      insert into materials (id, shop_id, name, kind, unit, cost_per_unit)
        values ('material-2', '${SHOP}', 'PLA white', 'filament', 'g', 0.02);
    `)
    return data.saveQuote({
      shopId: SHOP,
      ref: 'J-002',
      client: { name: 'Reef Watch', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Markers', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly',
        design_qty: 0,
        revisions_incl: 0,
        quantity: 1,
        material_id: null,
        printer_id: null,
        units_per_part: 0,
        print_hrs_part: 0,
        finishing_hrs: 0,
        rush: false,
        flat_each: 0,
        discount_pct: 0,
      },
      builds: [
        {
          label: 'Hull',
          printerId: 'printer-2',
          materialId: 'material-1',
          qty: 2,
          unitsPerPart: 100,
          printHrsPerPart: 3,
        },
        {
          label: 'Cap',
          printerId: 'printer-1',
          materialId: 'material-2',
          qty: 1,
          unitsPerPart: 50,
          printHrsPerPart: 1,
        },
      ],
    })
  }

  it('reads back every line, in the order it was given', async () => {
    const { listQuoteBuilds } = await import('./data')
    const saved = await saveTwoMachineQuote()
    const builds = await listQuoteBuilds(saved.quoteId)

    expect(builds.map((b) => [b.label, b.qty, b.printerId, b.materialId])).toEqual([
      ['Hull', 2, 'printer-2', 'material-1'],
      ['Cap', 1, 'printer-1', 'material-2'],
    ])
    expect(builds.map((b) => b.unitsPerPart)).toEqual([100, 50])
    expect(builds.map((b) => b.printHrsPerPart)).toEqual([3, 1])
    expect(builds.every((b) => b.kind === 'print')).toBe(true)
  })

  it('leaves the old single-machine columns exactly as passed, not mirrored', async () => {
    const saved = await saveTwoMachineQuote()
    const q = currentDb.sqlite
      .prepare('select quantity, printer_id, material_id, units_per_part, print_hrs_part from quotes where id = ?')
      .get(saved.quoteId) as Record<string, unknown>
    // If a future change starts writing the first build into these, the
    // quote would have two descriptions of itself and pricing would have a
    // choice to make. It must not.
    expect(q).toEqual({
      quantity: 1,
      printer_id: null,
      material_id: null,
      units_per_part: 0,
      print_hrs_part: 0,
    })
  })

  it('prices from the build lines, at each machine its own rate', async () => {
    const { priceQuote } = await import('./pricing')
    const { listQuoteBuilds } = await import('./data')
    const saved = await saveTwoMachineQuote()
    const builds = await listQuoteBuilds(saved.quoteId)

    // The fleet as seeded above, rather than loadShopContext -- this test is
    // about whether persisted build lines price correctly, and dragging a
    // rate card into the fixture would only add a way for it to fail for an
    // unrelated reason.
    const fleet = {
      materials: [
        { id: 'material-1', name: 'PETG black', unit: 'g' as const, costPerUnit: 0.025, sellOverride: null, swatch: '#000' },
        { id: 'material-2', name: 'PLA white', unit: 'g' as const, costPerUnit: 0.02, sellOverride: null, swatch: '#fff' },
      ],
      printers: [
        { id: 'printer-1', name: 'Sakman', model: 'Prusa XL', ratePerHour: 9, wearPerHour: 3, watts: null },
        { id: 'printer-2', name: 'Big Blue', model: 'Bambu Lab H2D', ratePerHour: 12, wearPerHour: 4, watts: null },
      ],
    }
    const rates = {
      currency: 'USD',
      locale: 'en-US',
      taxLabel: 'GET',
      taxPct: 0,
      designHourly: 0,
      finishingHourly: 0,
      rushPct: 0,
      minimumOrder: 0,
      depositPct: 0,
      depositWhen: 'design' as const,
      depositWaiveBelow: 0,
      materialMarkup: 1,
      revisionsIncl: 0,
      revisionHourly: null,
      electricityRateKwh: null,
      // The true-cost trio. Null means "not supplied", which is what a shop
      // that has not filled them in has -- and it must not change the
      // machine and wear arithmetic this test is about.
      overheadMonthly: null,
      productiveHoursMonth: null,
      failurePct: null,
    }

    const q = priceQuote(
      {
        assetOrigin: 'ready',
        designBilling: 'hourly',
        designQty: 0,
        revisions: 0,
        quantity: 1,
        unitsPerPart: 0,
        printHrsPerPart: 0,
        finishingHrs: 0,
        rush: false,
        flatEach: 0,
        discountPct: 0,
        builds: builds.map((b) => ({ ...b, key: b.id })),
      },
      rates,
      null,
      null,
      fleet,
    )
    // Hull: 2 x 3 h = 6 h on Big Blue at $12 = $72
    // Cap:  1 x 1 h = 1 h on Sakman   at $9  = $9
    expect(Math.round(q.machineAmt * 100) / 100).toBe(81)
    expect(q.machineHours).toBe(7)
    // Wear splits the same way: 6 x $4 + 1 x $3.
    expect(Math.round(q.wearAmt * 100) / 100).toBe(27)
  })

  it('writes no build rows for a plain single-machine quote', async () => {
    const data = await import('./data')
    await data.saveQuote({
      shopId: SHOP,
      ref: 'J-003',
      client: { name: 'Reef Watch', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Plain', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly',
        design_qty: 0,
        revisions_incl: 0,
        quantity: 3,
        material_id: 'material-1',
        printer_id: 'printer-1',
        units_per_part: 40,
        print_hrs_part: 2,
        finishing_hrs: 0,
        rush: false,
        flat_each: 0,
        discount_pct: 0,
      },
    })
    const n = currentDb.sqlite.prepare('select count(*) as n from quote_builds').get() as {
      n: number
    }
    // Absent builds must mean "the old shape", not "an empty build list",
    // or every existing quote would price to zero.
    expect(n).toEqual({ n: 0 })
  })
})

describe('sorting the objects of a plate onto parts (CG, 16 Oct)', () => {
  const BATHY = (fileName: string, grams: number): SliceImportInput => ({
    ...BUOY,
    fileName,
    estGrams: grams,
    estMinutes: grams * 2.8,
    sections: [{ label: 'Maui BATHY 3x', qty: 1, estMinutes: grams * 2.8, estGrams: grams, material: 'PLA' }],
  })
  const partsNow = () =>
    currentDb.sqlite.prepare('select id, label, copy_states, printed_n, reprint_n from job_parts where job_id = ? order by sort').all(JOB) as {
      id: string
      label: string
      copy_states: string | null
      printed_n: number
      reprint_n: number
    }[]

  it('puts a same-named object on a new part when the person says so, and never reuses a name', async () => {
    const { importSlice } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BATHY('Sliced_Maui_BATHY_16h26m.bgcode', 355))
    const res = await importSlice(SHOP, JOB, ACTOR, {
      ...BATHY('Sliced_Maui_BATHY_7h14m.bgcode', 117),
      sections: [{ label: 'Maui BATHY 3x', qty: 1, estMinutes: 434, estGrams: 117, material: 'PLA', assign: { newLabel: 'Maui BATHY 3x' } }],
    })
    expect(res).toMatchObject({ partsAdded: 1, partsMatched: 0 })
    expect(partsNow().map((p) => p.label)).toEqual(['Maui BATHY 3x', 'Maui BATHY 3x (2)'])
    // The object keeps the name the file gave it.
    expect(currentDb.sqlite.prepare("select label from slice_sections where import_id = (select id from slice_imports where file_name like '%7h14m%')").get()).toEqual({
      label: 'Maui BATHY 3x',
    })
  })

  it('puts an object on the existing part the person picked, whatever it is called', async () => {
    const { importSlice } = await import('./data.local')
    await importSlice(SHOP, JOB, ACTOR, BUOY)
    const cap = partsNow().find((p) => p.label === 'Cap')!
    await importSlice(SHOP, JOB, ACTOR, {
      ...BUOY,
      fileName: 'lid v2.gcode',
      sections: [{ label: 'Lid', qty: 1, estMinutes: 40, estGrams: 28, material: 'PETG', assign: { partId: cap.id } }],
    })
    expect(partsNow().map((p) => p.label)).toEqual(['Buoy shell', 'Cap'])
    await expect(
      importSlice(SHOP, JOB, ACTOR, { ...BUOY, fileName: 'x.gcode', sections: [{ ...BUOY.sections[0], assign: { partId: 'nope' } }] }),
    ).rejects.toThrow(/not on this project/)
  })

  it('moves an object to a new part and takes the copies its prints marked with it', async () => {
    const data = await import('./data.local')
    // Two files, both calling their object "Maui BATHY 3x" -- matched by name, as before.
    const a = await data.importSlice(SHOP, JOB, ACTOR, BATHY('Sliced_Maui_BATHY_16h26m.bgcode', 355))
    // It stopped part way...
    const r1 = await data.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 335, hours: 15.07, outcome: 'cancelled',
      failureReason: 'Ghost printing', note: null, startedAt: '2026-10-14', sliceImportId: a.importId,
    })
    await data.markPlateFailed(SHOP, JOB, ACTOR, a.importId, r1, 'Ghost printing')
    // ...and a different, smaller file under the same object name printed.
    const b = await data.importSlice(SHOP, JOB, ACTOR, BATHY('Sliced_Maui_BATHY_7h14m.bgcode', 117))
    const r2 = await data.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 117, hours: 7.23, outcome: 'success',
      failureReason: null, note: null, startedAt: '2026-10-15', sliceImportId: b.importId,
    })
    await data.markPlatePrinted(SHOP, JOB, ACTOR, b.importId, r2)
    expect(partsNow()).toHaveLength(1)
    expect(JSON.parse(partsNow()[0].copy_states!)).toEqual(['printed'])

    // Sorted: the 7h 14m object is its own part.
    const sec = currentDb.sqlite.prepare('select id from slice_sections where import_id = ?').get(b.importId) as { id: string }
    const res = await data.moveSliceSection(SHOP, JOB, ACTOR, sec.id, { newLabel: 'Maui BATHY small' })
    expect(res).toMatchObject({ moved: 1, unplaced: 0 })
    const [big, small] = partsNow()
    expect(small.label).toBe('Maui BATHY small')
    expect(JSON.parse(small.copy_states!)).toEqual(['printed'])
    // The big part is back where its own plate left it: failed, waiting for a reprint.
    expect(JSON.parse(big.copy_states!)).toEqual(['reprint'])
    // Both histories say what happened.
    const notes = currentDb.sqlite.prepare("select part_id, note from part_events where kind = 'note' order by id").all() as { part_id: string; note: string }[]
    expect(notes.find((n) => n.part_id === big.id && /moved to/.test(n.note))?.note).toMatch(/Maui BATHY 3x on Sliced_Maui_BATHY_7h14m\.bgcode moved to Maui BATHY small — 1 copy it marked put back as before/)
    expect(notes.find((n) => n.part_id === small.id && /sorted here/.test(n.note))?.note).toMatch(/sorted here from Maui BATHY 3x/)
    // Removing the print now undoes the copy on the part it moved to.
    await data.deletePrintRun(SHOP, r2, true)
    expect(JSON.parse(partsNow()[1].copy_states!)).toEqual(['pending'])
  })

  it('moves a failed object, failure and all, onto an existing part', async () => {
    const data = await import('./data.local')
    await data.importSlice(SHOP, JOB, ACTOR, BUOY)
    const a = await data.importSlice(SHOP, JOB, ACTOR, BATHY('Outer Islands.bgcode', 2))
    const r1 = await data.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 2, hours: 0.48, outcome: 'failed',
      failureReason: 'Warped', note: null, startedAt: '2026-10-13', sliceImportId: a.importId,
    })
    await data.markPlateFailed(SHOP, JOB, ACTOR, a.importId, r1, 'Warped')
    const cap = partsNow().find((p) => p.label === 'Cap')!
    const sec = currentDb.sqlite.prepare('select id from slice_sections where import_id = ?').get(a.importId) as { id: string }
    const res = await data.moveSliceSection(SHOP, JOB, ACTOR, sec.id, { partId: cap.id })
    expect(res).toMatchObject({ partId: cap.id, moved: 1, unplaced: 0 })
    const after = partsNow()
    expect(JSON.parse(after.find((p) => p.label === 'Cap')!.copy_states!)).toEqual(['reprint'])
    expect(JSON.parse(after.find((p) => p.label === 'Maui BATHY 3x')!.copy_states ?? '["pending"]')).toEqual(['pending'])
    // The failure no longer counts against the part it left.
    const left = after.find((p) => p.label === 'Maui BATHY 3x')!
    expect(currentDb.sqlite.prepare("select count(*) as n from part_events where part_id = ? and to_status = 'reprint'").get(left.id)).toEqual({ n: 0 })
  })
})

describe('what each print made, and where it went (CG, 21 Oct)', () => {
  const run = async (data: any, importId: string | null, outcome = 'success') =>
    data.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 86.5, hours: 2.05, outcome,
      failureReason: outcome === 'success' ? null : 'x', note: null, startedAt: '2026-10-20', sliceImportId: importId,
    })
  const items = () => currentDb.sqlite.prepare('select label, status, unit_cost, batch_id, assembly_id from made_items order by rowid').all() as any[]

  it('records the objects off a print, shelves some, assembles others, and keeps the books straight', async () => {
    const data = await import('./data.local')
    const imp = await data.importSlice(SHOP, JOB, ACTOR, BUOY)
    const r = await run(data, imp.importId)
    await data.recordMadeItems(SHOP, JOB, r, [
      { sectionId: null, label: 'Buoy shell', grams: 28.85, unitCost: 1, failed: false },
      { sectionId: null, label: 'Buoy shell', grams: 28.85, unitCost: 1, failed: false },
      { sectionId: null, label: 'Cap', grams: 20, unitCost: 0.5, failed: true },
    ])
    const list = await data.listMadeItems(SHOP, JOB)
    expect(list.map((x) => [x.label, x.status, x.printedOn, x.fileName])).toEqual([
      ['Buoy shell', 'made', '2026-10-20', null],
      ['Buoy shell', 'made', '2026-10-20', null],
      ['Cap', 'failed', '2026-10-20', null],
    ])
    const [a, b, c] = list
    // A failed object cannot be shelved.
    await expect(data.placeItems(SHOP, JOB, [c.id], { kind: 'kept' })).rejects.toThrow(/failed print/)
    // One onto the shelf as a new product, at its share.
    const { batchId } = await data.placeItems(SHOP, JOB, [a.id], { kind: 'shelf', productId: null, name: 'Reef buoy', madeOn: '2026-10-21' })
    expect(currentDb.sqlite.prepare('select units_made, unit_cost, note from batches where id = ?').get(batchId!)).toEqual({ units_made: 1, unit_cost: 1, note: '1 × Buoy shell' })
    // One into an assembly that needs two.
    const asm = await data.saveAssembly(SHOP, JOB, { name: 'Buoy pair', needs: [{ label: 'Buoy shell', qty: 2 }] })
    await data.placeItems(SHOP, JOB, [b.id], { kind: 'assembly', assemblyId: asm })
    expect(items().map((x) => x.status)).toEqual(['shelved', 'assembled', 'failed'])
    // The print cannot be removed while what it made is placed.
    await expect(data.deletePrintRun(SHOP, r, true)).rejects.toThrow(/take it back first/)
    // Out of the assembly and back; the shelf does not give back.
    await data.placeItems(SHOP, JOB, [b.id], { kind: 'back' })
    await expect(data.placeItems(SHOP, JOB, [a.id], { kind: 'back' })).rejects.toThrow(/on the shelf/)
    // Finish the assembly onto the shelf: one unit at the sum.
    await data.placeItems(SHOP, JOB, [b.id], { kind: 'assembly', assemblyId: asm })
    const done = await data.finishAssembly(SHOP, asm, { kind: 'shelf', productId: null, madeOn: '2026-10-21' })
    expect(currentDb.sqlite.prepare('select b.units_made, b.unit_cost, p.name from batches b join products p on p.id = b.product_id where b.id = ?').get(done.batchId!)).toEqual({ units_made: 1, unit_cost: 1, name: 'Buoy pair' })
    await expect(data.placeItems(SHOP, JOB, [b.id], { kind: 'back' })).rejects.toThrow(/finished assembly/)
    expect((await data.listAssemblies(SHOP, JOB))[0]).toMatchObject({ name: 'Buoy pair', status: 'done', needs: [{ label: 'Buoy shell', qty: 2 }] })
  })

  it('a new product from printed pieces starts with the plate picture', async () => {
    const data = await import('./data.local')
    const imp = await data.importSlice(SHOP, JOB, ACTOR, BUOY)
    await data.setSliceExtras(SHOP, imp.importId, 'data:image/png;base64,PLATE', null)
    const sec = currentDb.sqlite.prepare('select id from slice_sections where import_id = ?').get(imp.importId) as { id: string }
    const r = await run(data, imp.importId)
    await data.recordMadeItems(SHOP, JOB, r, [{ sectionId: sec.id, label: 'Buoy shell', grams: 1, unitCost: 1, failed: false }])
    const [it0] = await data.listMadeItems(SHOP, JOB)
    await data.placeItems(SHOP, JOB, [it0.id], { kind: 'shelf', productId: null, name: 'Reef buoy', madeOn: '2026-10-22' })
    const [p] = await data.listShelf(SHOP)
    expect(p.photo).toBe('data:image/png;base64,PLATE')
  })

  it('recording a print again replaces what it made, and removing an unplaced print removes it', async () => {
    const data = await import('./data.local')
    const imp = await data.importSlice(SHOP, JOB, ACTOR, BUOY)
    const r = await run(data, imp.importId)
    await data.recordMadeItems(SHOP, JOB, r, [{ sectionId: null, label: 'Cap', grams: 1, unitCost: 1, failed: false }])
    await data.recordMadeItems(SHOP, JOB, r, [{ sectionId: null, label: 'Cap', grams: 1, unitCost: 2, failed: false }])
    expect(items().map((x) => x.unit_cost)).toEqual([2])
    await data.deletePrintRun(SHOP, r, true)
    expect(items()).toEqual([])
  })

  it('an open assembly can go, and what was in it is made again', async () => {
    const data = await import('./data.local')
    const r = await run(data, null)
    await data.recordMadeItems(SHOP, JOB, r, [{ sectionId: null, label: 'Cap', grams: 1, unitCost: 1, failed: false }])
    const [it] = await data.listMadeItems(SHOP, JOB)
    const asm = await data.saveAssembly(SHOP, JOB, { name: 'Set', needs: [] })
    await data.placeItems(SHOP, JOB, [it.id], { kind: 'assembly', assemblyId: asm })
    await data.deleteAssembly(SHOP, asm)
    expect(items().map((x) => [x.status, x.assembly_id])).toEqual([['made', null]])
  })
})

describe('taking a batch back off the shelf (CG, 22 Oct)', () => {
  it('returns its pieces to the project, refuses once sold, and lets an empty product go', async () => {
    const data = await import('./data.local')
    const r = await data.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 10, hours: 1, outcome: 'success',
      failureReason: null, note: null, startedAt: '2026-10-22', sliceImportId: null,
    })
    await data.recordMadeItems(SHOP, JOB, r, [
      { sectionId: null, label: 'Maui', grams: 5, unitCost: 1, failed: false },
      { sectionId: null, label: 'Maui', grams: 5, unitCost: 1, failed: false },
    ])
    const ids = (await data.listMadeItems(SHOP, JOB)).map((i) => i.id)
    const { batchId } = await data.placeItems(SHOP, JOB, ids, { kind: 'shelf', productId: null, name: 'Maui tile', madeOn: '2026-10-22' })
    const productId = (currentDb.sqlite.prepare('select product_id from batches').get() as { product_id: string }).product_id
    await expect(data.deleteProduct(SHOP, productId)).rejects.toThrow(/batches off the shelf first/)
    await data.recordSale(SHOP, { batchId: batchId!, channelId: null, units: 1, unitPrice: 20, soldOn: '2026-10-22' })
    await expect(data.deleteBatch(SHOP, batchId!)).rejects.toThrow(/remove those sales first/)
    const sale = currentDb.sqlite.prepare('select id from sales').get() as { id: string }
    await data.deleteSale(SHOP, sale.id)
    await data.deleteBatch(SHOP, batchId!)
    expect((await data.listMadeItems(SHOP, JOB)).map((i) => [i.status, i.batchId])).toEqual([
      ['made', null],
      ['made', null],
    ])
    await data.deleteProduct(SHOP, productId)
    expect(currentDb.sqlite.prepare('select count(*) as n from products').get()).toEqual({ n: 0 })
  })
})
