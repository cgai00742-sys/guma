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
