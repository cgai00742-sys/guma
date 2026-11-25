/**
 * Prints from Prusa Connect, into Guma (CG, 23 Nov 2026).
 *
 * CG slices in PrusaSlicer and sends to the printer through Connect, and
 * "at the end of the day the history of what was printed" is what Guma
 * should hold. Connect has no API and no export, so an assistant reads the
 * history page and calls these through guma-mcp. They do what the project
 * screen does when a plate file is dropped and recorded -- same import,
 * same marks on the build sheet, same pieces made -- and nothing more.
 *
 * Connect gives, per print: the file name, FINISHED or STOPPED, the real
 * printing time, and when it ended. Grams come from the file itself.
 */
// Type only: the app passes the dispatcher (data.ts) and guma-mcp passes
// data.local, so the desktop database is never bundled into the web build.
import type * as Local from './data.local'
import type { ItemPlace, PrintRunInput, RunOutcome, ShopContext, SliceImportRow } from './data.types'
import { parseSliceFile, matchMaterial, matchPrinter, type SliceFileLike } from './sliceImport'
import { fileExtras } from './fileExtras'
import { packFile } from './sliceFile'
import { progressAt } from './gcodeWalk'
import { madeFromPrint, objectsOf } from './madeItems'

/** "x copy.bgcode", "x 1.bgcode", "x (2).bgcode" -> "x.bgcode", lower case. */
export function plainName(f: string): string {
  return f
    .trim()
    .toLowerCase()
    .replace(/\s(\(\d+\)|\d+|copy(\s\d+)?)(?=\.[a-z0-9.]+$|$)/, '')
}

export interface PlateMatch {
  jobId: string
  ref: string
  title: string
  phase: string
  kind: 'client' | 'inhouse'
  importId: string
  fileName: string
  estMinutes: number | null
  estGrams: number | null
  /** Prints already recorded from this plate. */
  prints: { date: string | null; hours: number; outcome: RunOutcome | null }[]
}

/** Every plate on any project that is this file, by name. */
export async function findPlates(
  ctx: ShopContext,
  fileName: string,
  local: Pick<typeof Local, 'listJobs' | 'loadProjectDetail'>,
): Promise<PlateMatch[]> {
  const want = plainName(fileName)
  const jobs = await local.listJobs(ctx.shop.id)
  const out: PlateMatch[] = []
  for (const j of jobs) {
    const detail = await local.loadProjectDetail(ctx.shop.id, j.jobId)
    for (const s of detail.slices) {
      if (plainName(s.fileName) !== want) continue
      out.push({
        jobId: j.jobId,
        ref: j.ref,
        title: j.title,
        phase: j.phase,
        kind: j.facts.kind,
        importId: s.id,
        fileName: s.fileName,
        estMinutes: s.estMinutes,
        estGrams: s.estGrams,
        prints: detail.runs
          .filter((r) => r.sliceImportId === s.id)
          .map((r) => ({ date: r.startedAt ? r.startedAt.slice(0, 10) : null, hours: Number(r.hours ?? 0), outcome: r.outcome })),
      })
    }
  }
  return out
}

export interface ConnectPrint {
  /** The day it ended, YYYY-MM-DD -- Connect's "Print end". */
  printedOn: string
  /** Connect's "Printing time", in minutes. Missing on some entries. */
  minutes: number | null
  /** FINISHED -> success; STOPPED -> cancelled (stopped part way). */
  outcome: 'success' | 'cancelled' | 'failed'
  note?: string | null
  /** The spool it really ran on, when not the file's (e.g. a wood PLA
   *  printed from a file sliced as PLA). */
  materialId?: string | null
  /** Objects that did not come off, by label -- Connect's "Cancelled" ones,
   *  or what the inspection found. Only with outcome success. */
  failedObjects?: string[]
  /** An open assembly of this project to put the good pieces into. */
  assemblyId?: string | null
  /** Anywhere the Made list can send them: the shelf, an assembly, kept.
   *  Wins over assemblyId. */
  place?: ItemPlace | null
  /** What the printer measured off the spool, when it says -- truer than
   *  the file's estimate, above all for a print stopped part way. */
  grams?: number | null
  /** Skip the same-day check: the caller knows this is a new print (the
   *  Inbox does -- each print there is one printer job, once). */
  known?: boolean
}

/** What recording a print needs from a backend: local for guma-mcp, the
 *  dispatcher (data.ts) for the app's own Print Inbox. */
export type RecordApi = Pick<
  typeof Local,
  | 'loadProjectDetail'
  | 'recordPrintRun'
  | 'recordMadeItems'
  | 'markPlateParts'
  | 'markPlatePrinted'
  | 'markPlateFailed'
  | 'listMadeItems'
  | 'placeItems'
  | 'importSlice'
>

export interface RecordResult {
  recorded: boolean
  runId: string | null
  said: string
}

/**
 * Record one Connect print against a plate already on a project. Refuses a
 * print that is already there -- same plate, same day, same time within a
 * few minutes -- so syncing twice never counts a print twice.
 */
export async function recordConnectPrint(
  ctx: ShopContext,
  jobId: string,
  importId: string,
  print: ConnectPrint,
  api: RecordApi,
): Promise<RecordResult> {
  const detail = await api.loadProjectDetail(ctx.shop.id, jobId)
  const slice = detail.slices.find((s) => s.id === importId)
  if (!slice) throw new Error('That plate is not on this project.')
  const minutes = print.minutes ?? slice.estMinutes ?? 0
  const hours = Math.round((minutes / 60) * 100) / 100
  const dup = detail.runs.find(
    (r) =>
      r.sliceImportId === importId &&
      (r.startedAt ?? '').slice(0, 10) === print.printedOn &&
      Math.abs(Number(r.hours ?? 0) - hours) <= 0.1,
  )
  if (dup && !print.known) return { recorded: false, runId: dup.id, said: `${slice.fileName} on ${print.printedOn} is already recorded.` }

  const printerId = slice.printerId ?? matchPrinter(ctx.printerRows, slice.printerModel)?.id ?? null
  if (!printerId) throw new Error(`No machine matches ${slice.printerModel ?? 'this file'} — pick it on the plate in Guma first.`)
  const materialId = print.materialId ?? slice.materialId ?? matchMaterial(ctx.materials, slice.materialText)?.id ?? null
  const clean = print.outcome === 'success'
  const failedSet = new Set((print.failedObjects ?? []).map(norm))
  const objects = objectsOf(slice, detail.parts)
  const isFailed = (label: string) => failedSet.has(norm(label))
  // Some objects good and some not -- on a finished plate, or on one
  // stopped part way where a few still came off.
  const someGood = objects.some((o) => !isFailed(o.label))
  const partial = failedSet.size > 0 && someGood && (clean || objects.length > 1)
  const measured = print.grams != null && print.grams >= 0 ? print.grams : null
  const grams = measured ?? (clean ? (slice.estGrams ?? 0) : gramsAt(slice, minutes))
  const why = print.note?.trim() || (print.outcome === 'cancelled' ? 'Stopped part way (Prusa Connect: STOPPED).' : 'The plate failed.')
  const run: PrintRunInput = {
    printerId,
    materialId,
    unitsUsed: materialId ? Math.round(grams) : 0,
    hours,
    outcome: print.outcome,
    failureReason: partial ? print.note?.trim() || `Did not come off: ${print.failedObjects!.join(', ')}.` : clean ? null : why,
    note: `From Prusa Connect: ${slice.fileName}`,
    startedAt: print.printedOn,
    sliceImportId: importId,
  }
  const runId = await api.recordPrintRun(ctx.shop.id, jobId, ctx.profile.id, run)
  if (detail.facts.kind === 'inhouse') {
    const results = partial ? objects.map((o) => ({ ...o, failed: isFailed(o.label), weighed: null })) : null
    await api.recordMadeItems(ctx.shop.id, jobId, runId, madeFromPrint(ctx, run, objects, results))
  }
  let marked: number
  if (partial) {
    const ok: Record<string, number> = {}
    for (const sec of slice.sections) {
      const label = detail.parts.find((p) => p.id === sec.partId)?.label ?? sec.label
      if (sec.partId && !isFailed(label) && !isFailed(sec.label)) ok[sec.partId] = (ok[sec.partId] ?? 0) + Math.max(1, sec.qty || 1)
    }
    const r = await api.markPlateParts(ctx.shop.id, jobId, ctx.profile.id, importId, runId, ok, run.failureReason)
    marked = r.printed
  } else
    marked = clean
      ? await api.markPlatePrinted(ctx.shop.id, jobId, ctx.profile.id, importId, runId)
      : await api.markPlateFailed(ctx.shop.id, jobId, ctx.profile.id, importId, runId, why)
  let placed = 0
  const to: ItemPlace | null = print.place ?? (print.assemblyId ? { kind: 'assembly', assemblyId: print.assemblyId } : null)
  if (to && detail.facts.kind === 'inhouse') {
    const good = (await api.listMadeItems(ctx.shop.id, jobId)).filter((m) => m.runId === runId && m.status === 'made')
    if (good.length) {
      await api.placeItems(ctx.shop.id, jobId, good.map((m) => m.id), to.kind === 'shelf' && !to.name && !to.productId ? { ...to, name: good[0].label } : to)
      placed = good.length
    }
  }
  const where = to?.kind === 'shelf' ? 'put on the Shelf' : to?.kind === 'kept' ? 'kept, not for sale' : 'put in the assembly'
  return {
    recorded: true,
    runId,
    said:
      `${slice.fileName}: ${clean ? 'printed' : print.outcome === 'failed' ? 'failed' : 'stopped part way'} ${print.printedOn}, ${hours}h` +
      (materialId ? `, ${Math.round(grams)} g off the shelf` : ', no material matched so nothing came off the shelf') +
      (marked ? `, ${marked} part${marked === 1 ? '' : 's'} marked ${clean ? 'printed' : 'failed'}` : '') +
      (partial ? `; did not come off: ${print.failedObjects!.join(', ')}` : '') +
      (placed ? `; ${placed} piece${placed === 1 ? '' : 's'} ${where}` : '') +
      (clean || partial ? '.' : '. If some objects came off, open the plate in Guma and use correct to say which.'),
  }
}

/** A label compared loosely: case, spacing and the .stl ending ignored. */
export const norm = (s: string) => s.trim().toLowerCase().replace(/\.(stl|3mf|obj)(?=\s*\(|$)/, '').replace(/\s+/g, ' ')

/** Grams pushed by `minutes` into a print: from the file's own progress
 *  marks, else in proportion to time. */
export function gramsAt(slice: SliceImportRow, minutes: number): number {
  const at = slice.progress ? progressAt(slice.progress, minutes, slice.estGrams) : null
  if (at) return at.grams
  if (slice.estGrams && slice.estMinutes) return slice.estGrams * Math.min(1, minutes / slice.estMinutes)
  return 0
}

/**
 * Read a sliced file and put it on a project as a plate, exactly as dropping
 * it on the project page does. Parts are matched or added the same way.
 */
export async function importPlateFile(
  ctx: ShopContext,
  jobId: string,
  file: SliceFileLike & { arrayBuffer(): Promise<ArrayBuffer> },
  materialId: string | null,
  local: Pick<typeof Local, 'importSlice'>,
): Promise<{ importId: string; duplicateOf: string | null; partsAdded: number; partsMatched: number; fileName: string }> {
  const read = await parseSliceFile(file)
  const extras = await fileExtras(file).catch(() => ({ thumbnail: null, slicedAt: null }))
  const kept = await packFile(new Uint8Array(await file.arrayBuffer()))
  const printer = matchPrinter(ctx.printerRows, read.printerModel)
  const material = materialId ? (ctx.materials.find((m) => m.id === materialId) ?? null) : matchMaterial(ctx.materials, read.totals.material)
  const res = await local.importSlice(ctx.shop.id, jobId, ctx.profile.id, {
    file: kept,
    fileName: read.fileName,
    kind: read.kind,
    printerModel: read.printerModel,
    printerId: printer?.id ?? null,
    materialText: read.totals.material,
    materialId: material?.id ?? null,
    estMinutes: read.totals.estMinutes,
    estGrams: read.totals.estGrams,
    notes: read.notes,
    progress: read.progress,
    thumbnail: extras.thumbnail,
    slicedAt: extras.slicedAt,
    sections: read.sections.map((sec) => ({
      label: sec.label,
      qty: sec.qty,
      estMinutes: sec.estMinutes,
      estGrams: sec.estGrams,
      material: sec.material,
    })),
  })
  return {
    importId: res.importId,
    duplicateOf: res.duplicateOf ?? null,
    partsAdded: res.partsAdded,
    partsMatched: res.partsMatched,
    fileName: read.fileName,
  }
}
