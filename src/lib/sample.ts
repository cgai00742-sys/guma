/**
 * A worked example, in the demo workspace.
 *
 * Asked for directly: "a sample project taken through each phase of the
 * In-House build... create a sample project and place them in each phase
 * or take a sample project through the entire phases and see where you get
 * bottlenecked."
 *
 * Both, as it turns out. The walkthrough that finds the bottlenecks is a
 * test (inHouseWalkthrough.test.ts) and runs on every commit. This is the
 * other half: the same route, left standing in the app so there is
 * something to click through, with one project parked at each rung of the
 * ladder and real numbers behind all of them -- a sliced file, a run that
 * took material off the shelf, a part that failed and says why, units
 * costed onto a shelf.
 *
 * TWO RULES.
 *
 * It refuses to run outside the demo workspace. Sample records in a real
 * shop's books are worse than no sample at all: they are indistinguishable
 * from work, they land in the actuals, and they quietly move every figure
 * the shop makes decisions from.
 *
 * Everything it writes goes through the ordinary data layer -- importSlice,
 * recordPrintRun, setPartStatus, saveBatch -- and never straight into SQL.
 * A seed that writes rows by hand is a seed that can produce a state the
 * app itself cannot, which is how a demo ends up showing something that
 * never happens in use.
 */
import {
  createInHouseJob,
  importSlice,
  logWork,
  recordPrintRun,
  saveBatch,
  saveProduct,
  setPartStatus,
  updateJobPhase,
  updateProjectFields,
  type ShopContext,
} from './data'
import { isDemo } from './workspace'
import { addDaysISO, todayISO } from './dates'

export interface SampleResult {
  jobIds: string[]
  note: string
}

/** Objects on one plate, as a slicer would report them. */
const PLATE = [
  { label: 'Paddle grip', qty: 2, estMinutes: 212, estGrams: 118, material: 'PETG' },
  { label: 'End cap', qty: 1, estMinutes: 68, estGrams: 41, material: 'PETG' },
]

export async function seedSample(ctx: ShopContext): Promise<SampleResult> {
  if (!isDemo()) {
    throw new Error(
      'The worked example only goes into the demo shop. Open the demo from Settings → Workspace first.',
    )
  }
  const printer = ctx.printerRows[0]
  const material = ctx.materials[0]
  if (!printer || !material) {
    throw new Error('Add a machine and a material first — the example prints on yours.')
  }

  const shopId = ctx.shop.id
  const actor = ctx.profile.id
  const jobIds: string[] = []

  /** One in-house project with its file imported, parked at `stopAt`. */
  async function make(
    title: string,
    brief: string,
    stopAt: 'design' | 'review' | 'delivered',
  ): Promise<string> {
    const jobId = await createInHouseJob(shopId, { title, brief })
    jobIds.push(jobId)
    await updateProjectFields(shopId, jobId, {
      neededBy: addDaysISO(stopAt === 'design' ? 9 : 2),
      deliveryHow: 'Collected in person',
    })

    const { importId } = await importSlice(shopId, jobId, actor, {
      fileName: 'H2S_Paddle grips_sliced.gcode.3mf',
      kind: '3mf',
      printerModel: printer.model ?? null,
      printerId: printer.id,
      materialText: material.name,
      materialId: material.id,
      estMinutes: 280,
      estGrams: 159,
      notes: ['Time and filament are slicer estimates, split across sections by quantity.'],
      sections: PLATE,
    })

    // Stage one: Working. The file is in, nothing has been printed, so the
    // gate is honestly blocked on "what it took is logged" -- which is what
    // that stage looks like in real use.
    if (stopAt === 'design') return jobId

    await logWork(shopId, jobId, actor, {
      kind: 'design',
      hours: 1.5,
      workedOn: todayISO(),
      note: 'Grip geometry and a test cylinder',
    })

    // The first plate warped. A failure is a run: same material, same
    // hours, and a reason that travels with the part.
    await recordPrintRun(shopId, jobId, actor, {
      printerId: printer.id,
      materialId: material.id,
      unitsUsed: 159,
      hours: 4.7,
      outcome: 'failed',
      failureReason: 'Warped off the plate at the third grip',
      note: 'From H2S_Paddle grips_sliced.gcode.3mf',
      startedAt: addDaysISO(-3),
      sliceImportId: importId,
    })
    // Then it worked.
    await recordPrintRun(shopId, jobId, actor, {
      printerId: printer.id,
      materialId: material.id,
      unitsUsed: 159,
      hours: 4.67,
      outcome: 'success',
      failureReason: null,
      note: 'Brim on, bed up 5°',
      startedAt: addDaysISO(-2),
      sliceImportId: importId,
    })

    return jobId
  }

  // --- Working: a file imported, nothing printed yet -------------------
  await make(
    'DEMO · Paddle grips — PETG trial',
    'Testing the grip geometry before the club order. Imported, not printed yet.',
    'design',
  )

  // --- Made: printed, one plate failed, now being looked at ------------
  const made = await make(
    'DEMO · Deck cleats — second attempt',
    'Reprint of the cleat that warped. The reason is on the part.',
    'review',
  )
  {
    const { loadProjectDetail } = await import('./data')
    const d = await loadProjectDetail(shopId, made)
    for (const p of d.parts) await setPartStatus(shopId, p.id, actor, 'printed', null)
    // One of them goes back, with a reason, so the build sheet shows what
    // a reprint looks like rather than a clean sheet nobody learns from.
    const first = d.parts[0]
    if (first) {
      await setPartStatus(shopId, first.id, actor, 'reprint', 'Layer shift at 40 mm — slow the X')
    }
    await updateJobPhase(shopId, made, actor, 'review')
  }

  // --- Done: finished, costed, units on the shelf ----------------------
  const done = await make(
    'DEMO · Keychain run — PETG offcuts',
    'Forty keychains from offcut spools. Closed out, on the shelf.',
    'delivered',
  )
  {
    const { loadProjectDetail } = await import('./data')
    const d = await loadProjectDetail(shopId, done)
    for (const p of d.parts) await setPartStatus(shopId, p.id, actor, 'printed', null)
    await updateJobPhase(shopId, done, actor, 'review')
    const after = await loadProjectDetail(shopId, done)
    for (const p of after.parts) await setPartStatus(shopId, p.id, actor, 'passed', null)

    const productId = await saveProduct(shopId, {
      name: 'DEMO · Paddle keychain',
      design_job_id: done,
    } as never)
    await saveBatch(shopId, {
      productId,
      jobId: done,
      unitsMade: 40,
      unitCost: 0.62,
      madeOn: todayISO(),
      note: 'From the offcut run',
    })
    await updateProjectFields(shopId, done, {
      deliveryOn: todayISO(),
      deliveryHow: 'Collected in person',
    })
    await updateJobPhase(shopId, done, actor, 'delivered')
  }

  return {
    jobIds,
    note: 'Three trial prints, one at each stage: one imported and not yet printed, one printed with a part sent back, one finished and on the shelf.',
  }
}
