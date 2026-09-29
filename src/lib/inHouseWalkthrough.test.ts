/// <reference types="node" />
/**
 * One trial print, start to finish, through the whole in-house ladder.
 *
 * Every other test here checks one thing in isolation. This one walks the
 * ACTUAL ROUTE a person takes -- start something of my own, import the
 * sliced file, print it, say what came out, close it -- and asserts at each
 * step that the gate in front of them can actually be cleared with the
 * tools the screen offers at that stage.
 *
 * It exists because the three worst bugs in this project so far were all
 * the same shape: a correct feature that could not be REACHED from where
 * the person was standing. A suite of green unit tests says nothing about
 * that. A walkthrough does, and it is the cheapest way to find the next
 * one before CG does.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allowedStatuses } from './parts'
import { gateStatus, ladderFor, nextPhase } from './gates'
import type { SetupPayload } from './data.types'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '../../src-tauri/migrations')
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n')

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SQL)
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
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

const SETUP: SetupPayload = {
  shop: {
    name: 'Kahului Fab',
    currency: 'USD',
    locale: 'en-US',
    paper: 'letter',
    tax_label: 'GET',
    tax_pct: 4.712,
    state: 'HI',
    quote_valid_days: 30,
    lead_days: 10,
    electricity_rate_kwh: 0.4299,
  },
  rates: {
    design_hourly: 85,
    finishing_hourly: 55,
    rush_pct: 0,
    minimum_order: 0,
    deposit_pct: 0,
    deposit_when: 'design',
    deposit_waive_below: 0,
    material_markup: 1,
    revisions_incl: 0,
    revision_hourly: null,
  },
  printer: { name: 'Sakman', model: 'Prusa XL', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 340 },
  materials: [
    { name: 'PETG black', kind: 'PETG', swatch: '#2A3442', unit: 'g', cost_per_unit: 0.025 },
  ],
  fullName: 'CG',
} as unknown as SetupPayload

const GCODE = `
; printing object Paddle grip id:0 copy 0
; printing object Paddle grip id:0 copy 1
; printing object End cap id:1 copy 0
; filament used [g] = 184
; total filament used [g] = 184
; estimated printing time (normal mode) = 6h 20m
; filament_type = PETG
; printer_model = XL
`

beforeEach(() => {
  currentDb = freshDb()
  vi.resetModules()
})

describe('a trial print, all the way through', () => {
  it('clears every gate on the in-house ladder with the controls that stage offers', async () => {
    const data = await import('./data')
    const shopId = await data.setupShop(SETUP)
    const ctx = await data.loadShopContext()
    currentDb.sqlite.exec('update materials set on_hand = 1000')

    // --- Working -------------------------------------------------------
    const jobId = await data.createInHouseJob(shopId, {
      title: 'Paddle grips — PETG trial',
      brief: 'Testing grip geometry before the club order.',
    })
    let detail = await data.loadProjectDetail(shopId, jobId)
    expect(detail.phase).toBe('design')
    // BOTTLENECK CHECK, found by CG rather than by this test: in-house
    // work was born a DRAFT, so it never reached the board or the
    // dashboard and its page offered "Take it into Intake" on a ladder that
    // has no Intake. There is no quote to agree to on the shop's own work,
    // so there is nothing to take in -- it is live from the moment it exists.
    expect(detail.facts.takenInAt, 'a new in-house project is live, not a draft').not.toBeNull()
    const onBoard = (await data.listJobs(shopId)).find((r) => r.jobId === jobId)
    expect(onBoard?.facts.takenInAt).not.toBeNull()
    expect(ladderFor('inhouse')).toEqual(['design', 'review', 'delivered'])

    // The sliced file fills the build sheet.
    const parsed = await (await import('./sliceImport')).parseSliceFile(
      new File([GCODE], 'Paddle grips_sliced.gcode', { type: 'text/plain' }),
    )
    const imported = await data.importSlice(shopId, jobId, ctx.profile.id, {
      fileName: parsed.fileName,
      kind: parsed.kind,
      printerModel: parsed.printerModel,
      printerId: ctx.printers[0].id,
      materialText: parsed.totals.material,
      materialId: ctx.materials[0].id,
      estMinutes: parsed.totals.estMinutes,
      estGrams: parsed.totals.estGrams,
      notes: parsed.notes,
      sections: parsed.sections,
    })
    expect(imported.partsAdded).toBe(2)

    detail = await data.loadProjectDetail(shopId, jobId)
    // BOTTLENECK CHECK: the person is standing in 'design' (Working) with
    // parts on the sheet. If the stage offers no way to mark them printed,
    // an in-house project can never finish its build sheet.
    expect(allowedStatuses(detail.phase, 'inhouse')).toContain('printed')

    // The print happens, from the file's own numbers.
    await data.recordPrintRun(shopId, jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 184,
      hours: 6.33,
      outcome: 'success',
      failureReason: null,
      note: `From ${parsed.fileName}`,
      startedAt: '2026-09-27',
      sliceImportId: imported.importId,
    })
    for (const p of detail.parts) {
      await data.setPartStatus(shopId, p.id, ctx.profile.id, 'printed', null)
    }
    await data.logWork(shopId, jobId, ctx.profile.id, {
      kind: 'design',
      hours: 2,
      workedOn: '2026-09-26',
      note: 'Grip geometry',
    })

    detail = await data.loadProjectDetail(shopId, jobId)
    // The material came off the shelf and the hours landed.
    const shelf = currentDb.sqlite.prepare('select on_hand from materials').get() as {
      on_hand: number
    }
    expect(Number(shelf.on_hand)).toBe(816)
    expect(detail.actuals.machineHours).toBeCloseTo(6.33, 2)

    let gate = gateStatus(detail.phase, detail.gates[detail.phase] ?? {}, detail.facts)
    expect(gate.blocked, `Working is blocked: ${gate.reason}`).toBe(false)
    await data.updateJobPhase(shopId, jobId, ctx.profile.id, nextPhase('design', 'inhouse')!)

    // --- Made ----------------------------------------------------------
    detail = await data.loadProjectDetail(shopId, jobId)
    expect(detail.phase).toBe('review')
    // QC happens here, so the stage has to offer it.
    expect(allowedStatuses(detail.phase, 'inhouse')).toContain('passed')
    for (const p of detail.parts) {
      await data.setPartStatus(shopId, p.id, ctx.profile.id, 'passed', null)
    }

    // What it made goes on the shelf.
    const productId = await data.saveProduct(shopId, {
      name: 'Paddle grip',
      design_job_id: jobId,
    } as never)
    await data.saveBatch(shopId, {
      productId,
      jobId,
      unitsMade: 2,
      unitCost: 2.3,
      madeOn: '2026-09-27',
    })

    detail = await data.loadProjectDetail(shopId, jobId)
    gate = gateStatus(detail.phase, detail.gates[detail.phase] ?? {}, detail.facts)
    expect(gate.blocked, `Made is blocked: ${gate.reason}`).toBe(false)
    await data.updateJobPhase(shopId, jobId, ctx.profile.id, nextPhase('review', 'inhouse')!)

    // --- Done ----------------------------------------------------------
    detail = await data.loadProjectDetail(shopId, jobId)
    expect(detail.phase).toBe('delivered')

    // And the closeout has something in it. Everything below is what CG
    // went looking for on a finished project and did not find.
    expect(detail.slices, 'the sliced file it was printed from').toHaveLength(1)
    expect(detail.slices[0].fileName).toBe('Paddle grips_sliced.gcode')
    expect(detail.runs, 'the run that produced it').toHaveLength(1)
    expect(detail.runs[0].sliceImportId).toBe(imported.importId)
    expect(detail.parts.every((p) => p.status === 'passed')).toBe(true)
    expect(detail.actuals.materialUnits).toBe(184)
    expect(detail.actuals.designHours).toBe(2)
    expect(detail.facts.hasActuals).toBe(true)
  })
})

describe('what happens to a project after it is finished', () => {
  async function finished() {
    const data = await import('./data')
    const shopId = await data.setupShop(SETUP)
    const ctx = await data.loadShopContext()
    const jobId = await data.createInHouseJob(shopId, { title: 'Keychain run' })
    await data.logWork(shopId, jobId, ctx.profile.id, {
      kind: 'design',
      hours: 4,
      workedOn: '2026-09-20',
      note: 'The keychain itself',
    })
    for (const to of ['review', 'delivered'] as const) {
      await data.updateJobPhase(shopId, jobId, ctx.profile.id, to)
    }
    return { data, shopId, ctx, jobId }
  }

  it('files it off the board without deleting anything or stopping any figure', async () => {
    const { data, shopId, ctx, jobId } = await finished()
    await data.archiveProject(shopId, jobId, ctx.profile.id, true)

    const detail = await data.loadProjectDetail(shopId, jobId)
    expect(detail.facts.archivedAt).not.toBeNull()
    // Still in the shop's own list, still carrying its hours: archiving is
    // a board decision, not an accounting one.
    const rows = await data.listJobs(shopId)
    expect(rows.find((r) => r.jobId === jobId)?.facts.archivedAt).not.toBeNull()
    expect(detail.actuals.designHours).toBe(4)

    await data.archiveProject(shopId, jobId, ctx.profile.id, false)
    expect((await data.loadProjectDetail(shopId, jobId)).facts.archivedAt).toBeNull()
  })

  it('refuses to archive work that is still live', async () => {
    const data = await import('./data')
    const shopId = await data.setupShop(SETUP)
    const ctx = await data.loadShopContext()
    const jobId = await data.createInHouseJob(shopId, { title: 'Still going' })
    await expect(data.archiveProject(shopId, jobId, ctx.profile.id, true)).rejects.toThrow(
      /still live/i,
    )
  })

  it('links a follow-on to the project that paid for the design, without copying the hours', async () => {
    const { data, shopId, jobId } = await finished()
    const second = await data.createInHouseJob(shopId, { title: 'Keychain run — second batch' })
    await data.setRelatedProject(shopId, second, jobId)

    const follow = await data.loadProjectDetail(shopId, second)
    expect(follow.relatedTo?.jobId).toBe(jobId)
    expect(follow.relatedTo?.designHours).toBe(4)
    // The hours stayed where they were spent. A follow-on that inherited
    // them would report a cost it never paid.
    expect(follow.actuals.designHours).toBe(0)

    const original = await data.loadProjectDetail(shopId, jobId)
    expect(original.related.map((r) => r.jobId)).toEqual([second])
  })

  it('keeps families one level deep — linking to a follow-on attaches to its original', async () => {
    const { data, shopId, jobId } = await finished()
    const second = await data.createInHouseJob(shopId, { title: 'Second' })
    const third = await data.createInHouseJob(shopId, { title: 'Third' })
    await data.setRelatedProject(shopId, second, jobId)
    await data.setRelatedProject(shopId, third, second)

    const t = await data.loadProjectDetail(shopId, third)
    expect(t.relatedTo?.jobId).toBe(jobId)
    const original = await data.loadProjectDetail(shopId, jobId)
    expect(original.related).toHaveLength(2)
  })

  it('will not let a project continue from itself', async () => {
    const { data, shopId, jobId } = await finished()
    await expect(data.setRelatedProject(shopId, jobId, jobId)).rejects.toThrow(/itself/i)
  })
})
