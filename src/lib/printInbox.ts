/**
 * The Print Inbox (CG, 24 Nov 2026).
 *
 * "Download all the files into a holding area ... the user has the final say
 * on if it was printed successfully, failed, needs a reprint, is in the
 * correct project." Prints from Prusa Connect land here with what the printer
 * said (the facts) and Guma's best guess at the rest (the decision). Nothing
 * reaches a project until a person approves it.
 *
 * Approving applies prints OLDEST FIRST. That is what links a reprint to its
 * failure: a failed plate sends its copies to "reprint", and a later plate
 * holding the same part fills those copies before untouched ones (copies.ts
 * plateCopies). Recorded in the wrong order -- the reprint before the
 * failure was known, as the first RS850 sync did -- the link is lost.
 *
 * Works against either backend: guma-mcp passes data.local, the app passes
 * the dispatcher.
 */
import type * as Local from './data.local'
import type { InboxAddInput, InboxDecision, InboxObjectCall, InboxRow, ItemPlace, ShopContext, SliceImportInput, SliceImportRow } from './data.types'
import { parseJsonObject, placeOf } from './data.types'
import { parseSliceFile, matchMaterial, matchPrinter, type SliceFileLike } from './sliceImport'
import { fileExtras } from './fileExtras'
import { packFile, unpackFile } from './sliceFile'
import { norm, plainName, recordConnectPrint, type RecordApi } from './plateSync'

export type InboxApi = RecordApi &
  Pick<
    typeof Local,
    | 'listJobs'
    | 'listInbox'
    | 'inboxFilePayload'
    | 'saveInboxFile'
    | 'addInboxItem'
    | 'setInboxStatus'
    | 'inboxForRun'
    | 'takeBackPlaced'
    | 'deletePrintRun'
    | 'sliceFileContent'
    | 'adoptInboxItem'
    | 'decideInbox'
    | 'listShelf'
    | 'saveInboxPhoto'
  >

async function sha1(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What an Inbox row shows without unpacking the file. */
function summaryOf(p: SliceImportInput): string {
  return JSON.stringify({
    sections: p.sections.map((s) => ({ label: s.label, qty: s.qty, estGrams: s.estGrams })),
    estMinutes: p.estMinutes,
    estGrams: p.estGrams,
    materialText: p.materialText,
  })
}

/** Read a plate file once and keep it for the Inbox. The same bytes are the
 *  same kept file, however many prints came from it. */
export async function keepInboxFile(
  ctx: ShopContext,
  api: Pick<InboxApi, 'saveInboxFile'>,
  file: SliceFileLike & { arrayBuffer(): Promise<ArrayBuffer> },
): Promise<{ fileId: string; fileName: string; payload: SliceImportInput }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const read = await parseSliceFile(file)
  const extras = await fileExtras(file).catch(() => ({ thumbnail: null, slicedAt: null }))
  const payload: SliceImportInput = {
    file: await packFile(bytes),
    fileName: read.fileName,
    kind: read.kind,
    printerModel: read.printerModel,
    printerId: matchPrinter(ctx.printerRows, read.printerModel)?.id ?? null,
    materialText: read.totals.material,
    materialId: matchMaterial(ctx.materials, read.totals.material)?.id ?? null,
    estMinutes: read.totals.estMinutes,
    estGrams: read.totals.estGrams,
    notes: read.notes,
    progress: read.progress,
    thumbnail: extras.thumbnail,
    slicedAt: extras.slicedAt,
    sections: read.sections.map((s) => ({ label: s.label, qty: s.qty, estMinutes: s.estMinutes, estGrams: s.estGrams, material: s.material })),
  }
  const fileId = await api.saveInboxFile(ctx.shop.id, read.fileName, await sha1(bytes), JSON.stringify(payload), summaryOf(payload))
  return { fileId, fileName: read.fileName, payload }
}

export interface Suggestion {
  jobId: string | null
  reason: string | null
}

/**
 * Which project a print probably belongs to, and why -- a guess, shown as one.
 * Strong: this exact file is already a plate on a project (the newest such
 * project, if several). Weak: the file name starts with a word that is in
 * one open project's title ("RS850 - ..." and "RS850"). Otherwise nothing.
 */
export async function suggestProject(
  ctx: ShopContext,
  api: Pick<InboxApi, 'listJobs' | 'loadProjectDetail'>,
  fileName: string,
): Promise<Suggestion> {
  const want = plainName(fileName)
  // Delivered work is done; a print of its file now is most likely for
  // something newer. Newest project first.
  const jobs = (await api.listJobs(ctx.shop.id)).filter((j) => j.phase !== 'delivered')
  for (const j of [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const d = await api.loadProjectDetail(ctx.shop.id, j.jobId)
    if (d.slices.some((s) => plainName(s.fileName) === want)) return { jobId: j.jobId, reason: `This file is already a plate on ${j.title}.` }
  }
  // The first real word of the name: "A-RS850-Hull-Stern_..." and
  // "RS850 - 11.17..." both lead with RS850; a plate letter is skipped.
  const lead = fileName.trim().toLowerCase().split(/[\s_.\-]+/).find((w) => w.length >= 3)
  if (lead) {
    const hits = jobs.filter((j) => j.title.toLowerCase().split(/[^a-z0-9]+/).includes(lead))
    if (hits.length === 1) return { jobId: hits[0].jobId, reason: `The file name starts with “${lead.toUpperCase()}”, like ${hits[0].title}.` }
  }
  return { jobId: null, reason: null }
}

/** How each object on the plate came off: the shop's call where it made
 *  one, else what the printer implies -- good on a finished plate unless
 *  Connect cancelled it, failed on a plate stopped part way. */
export function objectCalls(row: Pick<InboxRow, 'objects' | 'state' | 'facts' | 'decision'>): { label: string; call: InboxObjectCall }[] {
  const cancelled = new Set((row.facts.cancelled ?? []).map(norm))
  return (row.objects ?? []).map((o) => ({
    label: o.label,
    call: row.decision.objects?.[o.label] ?? (row.state === 'stopped' || cancelled.has(norm(o.label)) ? 'failed' : 'good'),
  }))
}

/** What is still missing before a print can be approved, in words. */
export function notReady(row: InboxRow): string | null {
  if (row.status !== 'new') return 'Already decided.'
  if (!row.decision.jobId) return 'Pick the project it belongs to.'
  if (!row.fileId) return 'Guma has no copy of the file — add it again.'
  if (!row.decision.inspected) return 'Say how it came off.'
  const calls = objectCalls(row)
  if (calls.some((c) => c.call === 'failed') && !(row.decision.reason ?? '').trim()) return 'Say why what failed failed.'
  return null
}

export interface ApproveResult {
  id: string
  ok: boolean
  runId: string | null
  said: string
}

/**
 * Approve prints: each goes onto its project as a print, oldest first, its
 * plate added if the project does not have it yet. Stops at the first that
 * cannot be applied -- the ones after it may be its reprints.
 */
export async function approveInbox(ctx: ShopContext, api: InboxApi, ids: string[]): Promise<ApproveResult[]> {
  const want = new Set(ids)
  const waiting = await api.listInbox(ctx.shop.id, 'new')
  const rows = waiting.filter((r) => want.has(r.id))
  const at = (r: InboxRow) => r.endedAt ?? r.createdAt
  rows.sort((a, b) => at(a).localeCompare(at(b)))
  // An older print of the same piece, still undecided and not in this
  // batch, has to go first: it may be the failure this one reprints. (In
  // the preview, approving a reprint on its own before its failed plate
  // left the failure with nothing to fail.)
  const labels = (r: InboxRow) => new Set((r.objects ?? []).map((o) => norm(o.label)))
  const blockedBy = (row: InboxRow) => {
    const mine = labels(row)
    const job = row.decision.jobId
    return waiting.find(
      (o) =>
        !want.has(o.id) &&
        (o.decision.jobId ?? o.suggestedJobId) === job &&
        at(o) < at(row) &&
        [...labels(o)].some((l) => mine.has(l)),
    )
  }
  const out: ApproveResult[] = []
  for (const row of rows) {
    try {
      const why = notReady(row)
      if (why) throw new Error(why)
      const first = blockedBy(row)
      if (first)
        throw new Error(
          `an older print of the same piece is still waiting (${first.fileName}, ${(at(first) ?? '').slice(0, 10)}) — decide it first, or set it aside as not a project. It may be the failure this one reprints.`,
        )
      const d = row.decision
      const jobId = d.jobId!
      const importId = await plateFor(ctx, api, jobId, row, d)
      const calls = objectCalls(row)
      const failed = calls.filter((c) => c.call === 'failed').map((c) => c.label)
      const good = calls.length - failed.length
      const outcome = failed.length === 0 ? 'success' : good === 0 ? (row.state === 'stopped' ? 'cancelled' : 'failed') : row.state === 'stopped' ? 'cancelled' : 'success'
      const spoolGrams = (row.facts.spools ?? []).reduce((a, s) => a + (Number(s.grams) || 0), 0)
      // A new product with no name takes the first good piece's name -- and
      // so finds the product of that name already on the Shelf.
      const asked = placeOf(d)
      const named = asked?.kind === 'shelf' && !asked.productId && !asked.name?.trim() ? { ...asked, name: calls.find((c) => c.call === 'good')?.label ?? null } : asked
      const place = await resolvePlace(ctx, api, named, (row.endedAt ?? row.createdAt).slice(0, 10))
      const res = await recordConnectPrint(
        ctx,
        jobId,
        importId,
        {
          printedOn: (row.endedAt ?? row.createdAt).slice(0, 10),
          minutes: row.minutes,
          outcome,
          note: d.reason?.trim() || (outcome === 'cancelled' ? 'Stopped part way.' : null),
          materialId: d.materialId ?? null,
          failedObjects: failed,
          place,
          grams: spoolGrams > 0 ? spoolGrams : null,
          known: true,
        },
        api,
      )
      await api.setInboxStatus(ctx.shop.id, row.id, 'approved', res.runId)
      out.push({ id: row.id, ok: true, runId: res.runId, said: res.said })
    } catch (e) {
      out.push({ id: row.id, ok: false, runId: null, said: `${row.fileName}: ${e instanceof Error ? e.message : String(e)}` })
      break
    }
  }
  return out
}

/** The plate on the project this print came from: the one already there
 *  (same file, same slicer numbers), or the kept file put on now. */
async function plateFor(ctx: ShopContext, api: InboxApi, jobId: string, row: InboxRow, d: InboxDecision): Promise<string> {
  const detail = await api.loadProjectDetail(ctx.shop.id, jobId)
  const same = (s: SliceImportRow) =>
    plainName(s.fileName) === plainName(row.fileName) &&
    (row.estGrams == null || s.estGrams == null || Math.abs(Number(s.estGrams) - Number(row.estGrams)) < 0.5)
  const have = detail.slices.find(same)
  if (have) return have.id
  const text = row.fileId ? await api.inboxFilePayload(ctx.shop.id, row.fileId) : null
  if (!text) throw new Error('Guma has no copy of the file — add it again.')
  const payload = parseJsonObject<SliceImportInput>(text)
  if (d.materialId) payload.materialId = d.materialId
  const res = await api.importSlice(ctx.shop.id, jobId, ctx.profile.id, payload)
  return res.duplicateOf ?? res.importId
}

/**
 * Send a recorded print back to the Inbox: what it made comes back out of
 * assemblies and the Shelf, the copies it marked go back, the print is
 * removed, and it waits for a decision again -- its earlier decision kept
 * as the starting point. For a print in the wrong project, or one judged
 * wrongly. The plate stays on the project; remove it there if it does not
 * belong.
 *
 * A print that never came through the Inbox gets a row made from the
 * print itself (`fallback` supplies what Guma does not know: the printer's
 * job number, its times). Several at once go newest first, so each one's
 * copies come back in the order they were marked.
 */
export async function sendBackToInbox(
  ctx: ShopContext,
  api: InboxApi,
  jobId: string,
  runIds: string[],
  fallback: (runId: string) => Partial<InboxAddInput> = () => ({}),
): Promise<number> {
  const detail = await api.loadProjectDetail(ctx.shop.id, jobId)
  const runs = detail.runs.filter((r) => runIds.includes(r.id))
  if (runs.length !== runIds.length) throw new Error('Some of those prints are not on this project.')
  // Everything checked and made ready before anything is removed.
  const plans: { runId: string; existing: InboxRow | null; add: InboxAddInput | null }[] = []
  for (const r of runs) {
    const existing = await api.inboxForRun(ctx.shop.id, r.id)
    if (existing) {
      plans.push({ runId: r.id, existing, add: null })
      continue
    }
    plans.push({ runId: r.id, existing: null, add: await rowForRun(ctx, api, jobId, detail, r, fallback(r.id)) })
  }
  await api.takeBackPlaced(ctx.shop.id, runs.map((r) => r.id))
  const order = [...plans].sort((a, b) => {
    const ra = runs.find((r) => r.id === a.runId)!
    const rb = runs.find((r) => r.id === b.runId)!
    return (rb.startedAt ?? '').localeCompare(ra.startedAt ?? '') || runs.indexOf(rb) - runs.indexOf(ra)
  })
  for (const p of order) {
    await api.deletePrintRun(ctx.shop.id, p.runId, true)
    if (p.existing) {
      await api.setInboxStatus(ctx.shop.id, p.existing.id, 'new')
      // Sent back to be judged again: the earlier answers stay as a start,
      // but it is not inspected until the person says so again.
      await api.decideInbox(ctx.shop.id, p.existing.id, { ...p.existing.decision, inspected: false })
    } else {
      const res = await api.addInboxItem(ctx.shop.id, p.add!)
      if (res.existed) await api.setInboxStatus(ctx.shop.id, res.id, 'new')
    }
  }
  return plans.length
}

/**
 * Keep the printer camera's photo with a print already on a project (CG,
 * 27 Nov: the end-of-print snapshot on every plate, "for all projects in the
 * past and ... moving forward"). A print that came through the Inbox has its
 * row; one recorded before the Inbox existed (RS850, 17-24 Nov) gets a row
 * made from it, approved and tied to the print -- the person approved it
 * when they recorded it. `sourceRef` names it in the printer's log
 * ("connect:<printer>:160") so syncing that job later finds it, not a
 * second print. Nothing about the print changes: no copies, no grams.
 */
export async function photoForPrint(
  ctx: ShopContext,
  api: InboxApi,
  jobId: string,
  runId: string,
  photo: { kind: 'camera_last' | 'camera_first'; data: string; takenAt: string | null },
  sourceRef: string | null = null,
): Promise<{ inboxId: string; made: boolean }> {
  const had = await api.inboxForRun(ctx.shop.id, runId)
  if (had) {
    await api.saveInboxPhoto(ctx.shop.id, had.id, photo.kind, photo.data, photo.takenAt)
    return { inboxId: had.id, made: false }
  }
  const detail = await api.loadProjectDetail(ctx.shop.id, jobId)
  const r = detail.runs.find((x) => x.id === runId)
  if (!r) throw new Error('That print is not on this project.')
  if (sourceRef) {
    const taken = (await api.listInbox(ctx.shop.id, 'all')).find((x) => x.sourceRef === sourceRef)
    if (taken) throw new Error(`${sourceRef} is already a different print in Guma${taken.runId ? '' : ' (still in Prints to check)'} — check which job this print was.`)
  }
  const add = await rowForRun(ctx, api, jobId, detail, r, {
    ...(sourceRef ? { sourceRef } : {}),
    suggestReason: 'Recorded on this project before the Inbox; kept here for its photo.',
  })
  const res = await api.addInboxItem(ctx.shop.id, { ...add, decision: { ...add.decision, inspected: true } })
  await api.setInboxStatus(ctx.shop.id, res.id, 'approved', runId)
  await api.saveInboxPhoto(ctx.shop.id, res.id, photo.kind, photo.data, photo.takenAt)
  return { inboxId: res.id, made: true }
}

/**
 * An Inbox row made from a print recorded on a project: its kept plate file,
 * its earlier answers as the decision. For a print sent back, and for one
 * that never came through the Inbox but now has a photo to keep.
 */
async function rowForRun(
  ctx: ShopContext,
  api: InboxApi,
  jobId: string,
  detail: Awaited<ReturnType<InboxApi['loadProjectDetail']>>,
  r: Awaited<ReturnType<InboxApi['loadProjectDetail']>>['runs'][number],
  fb: Partial<InboxAddInput>,
): Promise<InboxAddInput> {
  const slice = detail.slices.find((s) => s.id === r.sliceImportId)
  if (!slice) throw new Error('A print with no plate cannot go to the Inbox — there is no file to approve it from.')
  const fileId = await keepFromPlate(ctx, api, slice)
  const results = (await api.listMadeItems(ctx.shop.id, jobId)).filter((m) => m.runId === r.id)
  const failedLabels = results.filter((m) => m.status === 'failed').map((m) => m.label)
  const date = (r.startedAt ?? '').slice(0, 10) || null
  return {
    sourceRef: `run:${r.id}`,
    printerId: r.printerId,
    fileId,
    fileName: slice.fileName,
    startedAt: date,
    endedAt: date,
    state: r.outcome === 'cancelled' ? 'stopped' : 'finished',
    minutes: r.hours == null ? null : Math.round(Number(r.hours) * 60),
    facts: {},
    suggestedJobId: jobId,
    suggestReason: 'It was recorded on this project before being sent back.',
    decision: {
      jobId,
      materialId: r.materialId,
      reason: r.failureReason,
      // Where its pieces were: the earlier answer, kept as the start.
      place: (() => {
        const asm = results.find((m) => m.status === 'assembled' && m.assemblyId)?.assemblyId
        if (asm) return { kind: 'assembly' as const, assemblyId: asm }
        return results.some((m) => m.status === 'kept') ? { kind: 'kept' as const } : null
      })(),
      objects: failedLabels.length ? Object.fromEntries(slice.sections.map((s) => [s.label, failedLabels.includes(s.label) ? 'failed' : 'good'])) : undefined,
    },
  ...fb,
  }
}

/** Keep a plate's stored file for the Inbox. */
async function keepFromPlate(ctx: ShopContext, api: InboxApi, slice: SliceImportRow): Promise<string> {
  const kept = await api.sliceFileContent(ctx.shop.id, slice.id)
  if (!kept) throw new Error(`Guma did not keep a copy of ${slice.fileName}, so it cannot be approved again from the Inbox.`)
  const bytes = await unpackFile(kept.content)
  const payload: SliceImportInput = {
    file: { content: kept.content, byteSize: kept.byteSize, storedSize: kept.content.length, encoding: 'gzip-base64' },
    fileName: slice.fileName,
    kind: slice.kind,
    printerModel: slice.printerModel,
    printerId: slice.printerId,
    materialText: slice.materialText,
    materialId: slice.materialId,
    estMinutes: slice.estMinutes,
    estGrams: slice.estGrams,
    notes: slice.notes,
    progress: slice.progress,
    thumbnail: slice.thumbnail,
    slicedAt: slice.slicedAt,
    sections: slice.sections.map((s) => ({ label: s.label, qty: s.qty, estMinutes: s.estMinutes, estGrams: s.estGrams, material: s.material ?? null })),
  }
  return api.saveInboxFile(ctx.shop.id, slice.fileName, await sha1(bytes), JSON.stringify(payload), summaryOf(payload))
}

export interface PrinterLogPrint {
  /** "connect:<printer uuid>:<job number>": the same print is one row. */
  sourceRef: string
  printerId: string | null
  /** ISO with the shop's offset, so the first ten characters are the day
   *  it ended where the shop is. */
  startedAt: string | null
  endedAt: string | null
  state: 'finished' | 'stopped'
  minutes: number | null
  facts: InboxAddInput['facts']
  /** A starting point the assistant may fill: the project if the person
   *  named it, a spool it was told, an assembly. Never how it came off. */
  jobId?: string | null
  materialId?: string | null
  assemblyId?: string | null
}

/**
 * A print from the printer's log, into the Inbox: the file kept, a project
 * suggested, and -- when a print sent back from a project matches it (same
 * file, same day, about the same time) -- that row adopted instead of a
 * second one made.
 */
export async function addPrinterLogPrint(
  ctx: ShopContext,
  api: InboxApi,
  file: SliceFileLike & { arrayBuffer(): Promise<ArrayBuffer> },
  print: PrinterLogPrint,
): Promise<{ id: string; existed: boolean; adopted: boolean; suggestion: Suggestion; fileName: string }> {
  const kept = await keepInboxFile(ctx, api, file)
  const all = await api.listInbox(ctx.shop.id, 'all')
  const same = all.find((r) => r.sourceRef === print.sourceRef)
  if (same) return { id: same.id, existed: true, adopted: false, suggestion: { jobId: same.suggestedJobId, reason: same.suggestReason }, fileName: kept.fileName }
  const day = (print.endedAt ?? '').slice(0, 10)
  const sentBack = all.find(
    (r) =>
      r.sourceRef.startsWith('run:') &&
      plainName(r.fileName) === plainName(kept.fileName) &&
      (r.endedAt ?? '').slice(0, 10) === day &&
      (r.minutes == null || print.minutes == null || Math.abs(r.minutes - print.minutes) <= 5),
  )
  if (sentBack) {
    await api.adoptInboxItem(ctx.shop.id, sentBack.id, {
      sourceRef: print.sourceRef,
      printerId: print.printerId,
      startedAt: print.startedAt,
      endedAt: print.endedAt,
      minutes: print.minutes,
      facts: print.facts,
      state: print.state,
    })
    return { id: sentBack.id, existed: true, adopted: true, suggestion: { jobId: sentBack.suggestedJobId, reason: sentBack.suggestReason }, fileName: kept.fileName }
  }
  const suggestion = print.jobId ? { jobId: print.jobId, reason: 'Named by the person syncing it.' } : await suggestProject(ctx, api, kept.fileName)
  const res = await api.addInboxItem(ctx.shop.id, {
    sourceRef: print.sourceRef,
    printerId: print.printerId,
    fileId: kept.fileId,
    fileName: kept.fileName,
    startedAt: print.startedAt,
    endedAt: print.endedAt,
    state: print.state,
    minutes: print.minutes,
    facts: print.facts,
    suggestedJobId: suggestion.jobId,
    suggestReason: suggestion.reason,
    // Only what the person said: the project when they named it, never the
    // guess (it is shown beside the field, one click to take).
    decision: {
      jobId: print.jobId ?? null,
      materialId: print.materialId ?? null,
      assemblyId: print.assemblyId ?? null,
    },
  })
  return { ...res, adopted: false, suggestion, fileName: kept.fileName }
}

/**
 * Where the good pieces go, ready to place: a new product whose name is
 * already on the Shelf goes to that product -- two prints of the Kauai
 * magnet each saying "a new product" are one product with two batches,
 * not two products. Shelved on the day the print ended.
 */
export async function resolvePlace(
  ctx: ShopContext,
  api: Pick<InboxApi, 'listShelf'>,
  place: ReturnType<typeof placeOf>,
  madeOn: string,
): Promise<ItemPlace | null> {
  if (!place) return null
  if (place.kind !== 'shelf') return place
  let productId = place.productId
  if (!productId && place.name?.trim()) {
    const want = place.name.trim().toLowerCase()
    productId = (await api.listShelf(ctx.shop.id)).find((p) => !p.archived && p.name.trim().toLowerCase() === want)?.id ?? null
  }
  return { kind: 'shelf', productId, name: place.name?.trim() || undefined, madeOn }
}
