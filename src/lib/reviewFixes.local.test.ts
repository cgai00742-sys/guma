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

describe('several parts to fewer copies at once (CG, 12 Oct)', () => {
  const row = (label: string) =>
    currentDb.sqlite.prepare('select qty, copy_states, spare_n, printed_n, reprint_n, status from job_parts where label = ?').get(label) as any

  it('drops what is not printed, keeps what is as spares, and says so once for the batch', async () => {
    const L = await import('./data.local')
    const lucha = await L.addPart(SHOP, JOB, ACTOR, { label: 'Lucha', qty: 5, note: null })
    const tagas = await L.addPart(SHOP, JOB, ACTOR, { label: 'Tagas', qty: 5, note: null })
    const ghan = await L.addPart(SHOP, JOB, ACTOR, { label: 'Ghan', qty: 5, note: null })
    await L.movePartCopies(SHOP, tagas, ACTOR, 'printed', 5, null)
    await L.movePartCopies(SHOP, ghan, ACTOR, 'printed', 3, null)

    const out = await L.setPartsCopies(
      SHOP,
      JOB,
      ACTOR,
      [
        { partId: lucha, qty: 4 },
        { partId: tagas, qty: 4 },
        { partId: ghan, qty: 4 },
      ],
      'Club only needs four',
    )
    expect(out.map((x) => [x.label, x.from, x.to, x.toSpare])).toEqual([
      ['Lucha', 5, 4, 0],
      ['Tagas', 5, 4, 1],
      ['Ghan', 5, 4, 0],
    ])
    expect(row('Lucha')).toMatchObject({ qty: 4, spare_n: 0, status: 'pending' })
    // Five printed, four owed: done, with one spare -- not refused.
    expect(row('Tagas')).toMatchObject({ qty: 4, spare_n: 1, printed_n: 4, status: 'printed' })
    expect(JSON.parse(row('Ghan').copy_states)).toEqual(['printed', 'printed', 'printed', 'pending'])

    const job = currentDb.sqlite.prepare("select body from job_events where kind = 'edit' order by rowid desc limit 1").get() as any
    expect(job.body).toBe('Copies changed on 3 parts: Lucha 5 → 4, Tagas 5 → 4, Ghan 5 → 4. Why: Club only needs four')
    const note = currentDb.sqlite.prepare("select note from part_events where part_id = ? and kind = 'note' order by id desc").get(tagas) as any
    expect(note.note).toBe('"Tagas" copies: 5 → 4 — 1 printed copy kept as a spare. Why: Club only needs four')

    // Back up to five: the spare is counted again, as printed.
    await L.setPartsCopies(SHOP, JOB, ACTOR, [{ partId: tagas, qty: 5 }], null)
    expect(row('Tagas')).toMatchObject({ qty: 5, spare_n: 0, printed_n: 5 })
  })

  it('checks every part before writing any', async () => {
    const L = await import('./data.local')
    const a = await L.addPart(SHOP, JOB, ACTOR, { label: 'Lucha', qty: 5, note: null })
    await expect(
      L.setPartsCopies(SHOP, JOB, ACTOR, [{ partId: a, qty: 4 }, { partId: a, qty: 0 }], null),
    ).rejects.toThrow(/at least one/)
    expect(row('Lucha').qty).toBe(5)
  })

  it('a failed copy that is no longer owed goes, and the history stays on the right copies', async () => {
    const L = await import('./data.local')
    const p = await L.addPart(SHOP, JOB, ACTOR, { label: 'Lucha', qty: 5, note: null })
    await L.setCopyStates(SHOP, p, ACTOR, [0, 1, 3, 4], 'printed', null)
    await L.setCopyStates(SHOP, p, ACTOR, [2], 'reprint', 'Warped')
    await L.setCopyStates(SHOP, p, ACTOR, [4], 'reprint', 'Layer shift')
    // Five owed, copies 3 and 5 failed; now four: the last failed copy goes.
    await L.setPartsCopies(SHOP, JOB, ACTOR, [{ partId: p, qty: 4 }], null)
    expect(JSON.parse(row('Lucha').copy_states)).toEqual(['printed', 'printed', 'reprint', 'printed'])
    const detail = await L.loadProjectDetail(SHOP, JOB)
    const lucha = detail.parts.find((x) => x.id === p)!
    // Copy 3's reason is still copy 3's; copy 5's left with copy 5.
    expect(lucha.history.find((h) => h.note === 'Warped')?.copies).toEqual([3])
    expect(lucha.history.find((h) => h.note === 'Layer shift')?.copies).toBeNull()
  })

  it('skipping a copy keeps the later copies with their own history (found 12 Oct)', async () => {
    const L = await import('./data.local')
    const p = await L.addPart(SHOP, JOB, ACTOR, { label: 'Lucha', qty: 4, note: null })
    await L.setCopyStates(SHOP, p, ACTOR, [1], 'reprint', 'Spaghetti')
    await L.setCopyStates(SHOP, p, ACTOR, [3], 'reprint', 'Warped')
    await L.skipCopy(SHOP, p, ACTOR, 1, null)
    const lucha = (await L.loadProjectDetail(SHOP, JOB)).parts.find((x) => x.id === p)!
    // What was copy 4 is copy 3 now, and its reason went with it.
    expect(lucha.history.find((h) => h.note === 'Warped')?.copies).toEqual([3])
  })
})

describe('the build sheet, the plates and What it took, linked (CG, 13 Oct)', () => {
  const plateFile = (fileName: string, label: string, qty = 1) => ({
    fileName,
    kind: 'gcode' as const,
    printerModel: 'Prusa XL',
    printerId: 'printer-1',
    materialText: 'PLA',
    materialId: 'material-1',
    estMinutes: 120,
    estGrams: 50,
    notes: [],
    sections: [{ label, qty, estMinutes: 120, estGrams: 50, material: 'PLA' }],
    progress: [
      { min: 0, pct: 0, grams: 0, z: 0 },
      { min: 120, pct: 100, grams: 50, z: 12 },
    ],
  })
  const run = (sliceImportId: string, outcome: 'success' | 'failed' = 'success') => ({
    printerId: 'printer-1',
    materialId: 'material-1',
    unitsUsed: 50,
    hours: 2,
    outcome,
    failureReason: outcome === 'failed' ? 'Spaghetti at layer 40' : null,
    note: null,
    startedAt: '2026-10-13',
    sliceImportId,
  })
  const states = () =>
    JSON.parse((currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Maui'").get() as any).copy_states)

  it('a plate recorded, then removed with undo: its copies go back; without undo they stay', async () => {
    const L = await import('./data.local')
    const imp = await L.importSlice(SHOP, JOB, ACTOR, plateFile('maui.bgcode', 'Maui', 2))
    const partId = (currentDb.sqlite.prepare("select id from job_parts where label = 'Maui'").get() as any).id
    await L.updatePart(SHOP, partId, { label: 'Maui', qty: 4, note: null }, ACTOR)
    const r1 = await L.recordPrintRun(SHOP, JOB, ACTOR, run(imp.importId))
    await L.markPlatePrinted(SHOP, JOB, ACTOR, imp.importId, r1)
    const r2 = await L.recordPrintRun(SHOP, JOB, ACTOR, run(imp.importId))
    await L.markPlatePrinted(SHOP, JOB, ACTOR, imp.importId, r2)
    expect(states()).toEqual(['printed', 'printed', 'printed', 'printed'])

    // The second print removed, its two copies put back.
    await expect(L.deletePrintRun(SHOP, r2, true)).resolves.toBe(2)
    expect(states()).toEqual(['printed', 'printed', 'pending', 'pending'])
    // The first removed WITHOUT undo: the copies stay, the run goes.
    await expect(L.deletePrintRun(SHOP, r1, false)).resolves.toBe(0)
    expect(states()).toEqual(['printed', 'printed', 'pending', 'pending'])
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 0 })
  })

  it('a failed plate marks its copies failed with the reason; removing it puts them back', async () => {
    const L = await import('./data.local')
    const imp = await L.importSlice(SHOP, JOB, ACTOR, plateFile('maui.bgcode', 'Maui'))
    const r = await L.recordPrintRun(SHOP, JOB, ACTOR, run(imp.importId, 'failed'))
    await L.markPlateFailed(SHOP, JOB, ACTOR, imp.importId, r, 'Spaghetti at layer 40')
    expect(states()).toEqual(['reprint'])
    const detail = await L.loadProjectDetail(SHOP, JOB)
    const ev = detail.parts[0].history.find((h) => h.toStatus === 'reprint')!
    expect(ev).toMatchObject({ note: 'Spaghetti at layer 40', runId: r, copies: [1] })
    await L.deletePrintRun(SHOP, r, true)
    expect(states()).toEqual(['pending'])
    // What it recorded did not happen as recorded: kept as a note, no longer
    // a failure on the copy, in the tally or in "sent back N times".
    const after = (await L.loadProjectDetail(SHOP, JOB)).parts[0]
    expect(after.history.some((h) => h.kind === 'status' && h.toStatus === 'reprint')).toBe(false)
    expect(after.history.some((h) => h.kind === 'note' && h.note === 'Undone (print removed): Spaghetti at layer 40')).toBe(true)
    expect(currentDb.sqlite.prepare('select reprints_ever from job_parts_summary').get()).toEqual({ reprints_ever: 0 })
  })

  it('a copy reprinted from a fixed file goes back to waiting for that file', async () => {
    const L = await import('./data.local')
    await L.importSlice(SHOP, JOB, ACTOR, plateFile('maui.bgcode', 'Maui'))
    const partId = (currentDb.sqlite.prepare("select id from job_parts where label = 'Maui'").get() as any).id
    await L.setCopyStates(SHOP, partId, ACTOR, [0], 'reprint', 'Warped')
    const fix = await L.importSlice(SHOP, JOB, ACTOR, { ...plateFile('maui v2.bgcode', 'Maui'), forPartId: partId })
    await L.requeueCopyFromFile(SHOP, partId, ACTOR, 0, fix.importId, 'maui v2.bgcode')
    const r = await L.recordPrintRun(SHOP, JOB, ACTOR, run(fix.importId))
    await L.markPlatePrinted(SHOP, JOB, ACTOR, fix.importId, r)
    expect(states()).toEqual(['printed'])
    await L.deletePrintRun(SHOP, r, true)
    expect(states()).toEqual(['pending'])
    const last = (await L.loadProjectDetail(SHOP, JOB)).parts[0].history[0]
    expect(last).toMatchObject({ toStatus: 'pending', sliceImportId: fix.importId, copies: [1] })
  })

  it('keeps the progress read from the moves with the import', async () => {
    const L = await import('./data.local')
    const imp = await L.importSlice(SHOP, JOB, ACTOR, plateFile('maui.bgcode', 'Maui'))
    const [row] = await L.listSliceImports(SHOP, JOB)
    expect(row.progress).toEqual(plateFile('x', 'y').progress)
    await L.setSliceProgress(SHOP, imp.importId, [{ min: 0, pct: 0, grams: 0, z: 0 }])
    expect((await L.listSliceImports(SHOP, JOB))[0].progress).toHaveLength(1)
  })
})

describe('correcting a print recorded as clean (CG, 14 Oct)', () => {
  const plate = {
    fileName: 'Sliced_Maui_BATHY_3x_16h26m.bgcode',
    kind: 'gcode' as const,
    printerModel: 'Prusa XL',
    printerId: 'printer-1',
    materialText: 'PLA',
    materialId: 'material-1',
    estMinutes: 986,
    estGrams: 355,
    notes: [],
    sections: [{ label: 'Maui BATHY 3x', qty: 1, estMinutes: 986, estGrams: 355, material: 'PLA' }],
  }
  const onHand = () => (currentDb.sqlite.prepare("select on_hand from materials where id = 'material-1'").get() as any).on_hand
  const state = () => JSON.parse((currentDb.sqlite.prepare('select copy_states from job_parts').get() as any).copy_states)

  it('moves the spool by the difference, says what changed, and fails the copy it marked printed', async () => {
    const L = await import('./data.local')
    const imp = await L.importSlice(SHOP, JOB, ACTOR, plate)
    // Uploaded with "Already printed": the whole plate, clean.
    const run = await L.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 355, hours: 16.43, outcome: 'success',
      failureReason: null, note: null, startedAt: '2026-10-14', sliceImportId: imp.importId,
    })
    await L.markPlatePrinted(SHOP, JOB, ACTOR, imp.importId, run)
    expect(onHand()).toBe(645)
    expect(state()).toEqual(['printed'])

    // It had stopped at 15 h; filament quit at 9 h -- 270 g by the file.
    const failed = await L.correctPrintRun(
      SHOP, run, ACTOR,
      { unitsUsed: 270, hours: 15, outcome: 'cancelled', failureReason: 'Ghost printing', note: 'Stopped at 15h of 16h 26m.' },
      true,
    )
    expect(failed).toBe(1)
    expect(onHand()).toBe(730) // 85 g back on the shelf
    expect(state()).toEqual(['reprint'])
    expect(currentDb.sqlite.prepare('select units_used, hours, outcome, failure_reason from print_runs').get()).toEqual({
      units_used: 270, hours: 15, outcome: 'cancelled', failure_reason: 'Ghost printing',
    })
    const ev = currentDb.sqlite.prepare("select body from job_events where kind = 'run' order by rowid desc").get() as any
    expect(ev.body).toBe('Corrected a print — 355 g → 270 g · 16.43 h → 15 h · came off clean → stopped part way. Why: Ghost printing')
  })

  it('leaves copies already failed by hand alone, and moves no stock when the grams did not change', async () => {
    const L = await import('./data.local')
    const imp = await L.importSlice(SHOP, JOB, ACTOR, plate)
    const run = await L.recordPrintRun(SHOP, JOB, ACTOR, {
      printerId: 'printer-1', materialId: 'material-1', unitsUsed: 355, hours: 16.43, outcome: 'success',
      failureReason: null, note: null, startedAt: null, sliceImportId: imp.importId,
    })
    await L.markPlatePrinted(SHOP, JOB, ACTOR, imp.importId, run)
    const partId = (currentDb.sqlite.prepare('select id from job_parts').get() as any).id
    await L.setCopyStates(SHOP, partId, ACTOR, [0], 'reprint', 'Started ghost printing')
    const failed = await L.correctPrintRun(SHOP, run, ACTOR, { unitsUsed: 355, hours: 15, outcome: 'cancelled', failureReason: 'Ghost printing', note: null }, true)
    expect(failed).toBe(0)
    expect(onHand()).toBe(645)
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
