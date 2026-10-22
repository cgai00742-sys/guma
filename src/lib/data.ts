/**
 * The runtime dispatcher. Every screen imports from here — never from
 * data.supabase.ts or data.local.ts directly — so switching backends never
 * touches a screen's import statements or call sites.
 *
 * Which backend is active is decided once, lazily, the first time any
 * function below is actually called: isTauri() is true only inside the
 * desktop app, in which case we dynamically import data.local.ts (SQLite,
 * no auth); everywhere else (the Cloudflare Pages web build) we dynamically
 * import data.supabase.ts (hosted, auth-gated).
 *
 * The dynamic import matters, not just the isTauri() check: a plain static
 * `import` of data.supabase.ts at the top of this file would evaluate its
 * `import { supabase } from './supabase'` immediately, on every load of
 * data.ts — including inside the desktop app — and supabase.ts throws at
 * module-load time if its env vars are missing (see supabase.ts). Once the
 * desktop build stops carrying Supabase secrets (the p4-authdrop board
 * task), a static import here would crash the app on startup. The dynamic
 * import defers evaluation until we already know, via isTauri(), that we
 * are not going to touch that module at all.
 *
 * Types and other side-effect-free logic (toRateSet, NeedsSetup, and every
 * shared interface) are re-exported directly from data.types.ts rather than
 * routed through either backend, since both backends already do the same.
 */
import { isTauri } from '@tauri-apps/api/core'
import type * as Local from './data.local'
import type * as Hosted from './data.supabase'
import type {
  Shop,
  RateCardRow,
  PrinterRow,
  PrinterInput,
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopCostsInput,
  ChannelRow,
  ChannelInput,
  ProductRow,
  ProductInput,
  BatchRow,
  BatchInput,
  SaleRow,
  SaleInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
  JobListRow,
  JobKind,
  JobPhase,
  JobPriority,
  ProjectDetail,
  ProjectEvent,
  ProjectFacts,
  ProjectFieldsInput,
  GateAnswer,
  ClientRow,
  ClientEditInput,
  ClientKind,
  PaymentRow,
  PaymentInput,
  PaymentKind,
  PaymentMethod,
  MaterialRow,
  MaterialInput,
  MaterialPurchaseRow,
  MaterialPurchaseInput,
  ProjectActuals,
  WorkKind,
  RunOutcome,
  PartRow,
  PartInput,
  PartCopiesChange,
  PartCopiesResult,
  RunCorrection,
  QuoteBuildRow,
  SliceImportInput,
  SliceImportResult,
  SliceImportRow,
  PartStatus,
  QuoteInputsRow,
  PrintRunRow,
  PrintRunInput,
  WorkEntryRow,
  WorkEntryInput,
  QuoteStatus,
  RelatedProject,
  SellBranch,
  StockCountInput,
  StockEntry,
  ChangeCause,
  QuoteChange,
} from './data.types'

import type { SeriesRow, SeriesInput, StockHoldRow, StockHoldInput } from './data.types'
export {
  NeedsSetup,
  toRateSet,
  JOB_PHASES,
  CLIENT_KINDS,
  CLIENT_KIND_LABEL,
  asClientKind,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  WORK_KINDS,
  WORK_KIND_LABEL,
  PART_STATUSES,
  PART_STATUS_LABEL,
  CEILING_PCT,
  CHANGE_CAUSES,
  CHANGE_CAUSE_LABEL,
  ceilingCheck,
  validateRevision,
  sameSliceFile,
} from './data.types'
import type { ProgressPoint } from './gcodeWalk'
export type {
  QuoteBuildRow,
  SeriesRow,
  SeriesInput,
  RelatedProject,
  SellBranch,
  StockCountInput,
  StockEntry,
  ChangeCause,
  QuoteChange,
  Shop,
  RateCardRow,
  PrinterRow,
  PrinterInput,
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopCostsInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
  JobListRow,
  JobKind,
  JobPhase,
  JobPriority,
  ProjectDetail,
  ProjectEvent,
  ProjectFacts,
  ProjectFieldsInput,
  GateAnswer,
  ClientRow,
  ClientEditInput,
  ClientKind,
  PaymentRow,
  PaymentInput,
  PaymentKind,
  PaymentMethod,
  MaterialRow,
  MaterialInput,
  MaterialPurchaseRow,
  MaterialPurchaseInput,
  ProjectActuals,
  WorkKind,
  RunOutcome,
  PartRow,
  PartInput,
  PartCopiesChange,
  PartCopiesResult,
  RunCorrection,
  PartStatus,
  QuoteInputsRow,
  PrintRunRow,
  PrintRunInput,
  WorkEntryRow,
  WorkEntryInput,
  QuoteStatus,
  ChannelRow,
  ChannelInput,
  ProductRow,
  ProductInput,
  BatchRow,
  BatchInput,
  SaleRow,
  SaleInput,
}

type Backend = typeof Local | typeof Hosted

let backendPromise: Promise<Backend> | null = null
function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri() ? import('./data.local') : import('./data.supabase')
  }
  return backendPromise
}

/**
 * Rate-card values for a shop that has not been asked about rates yet.
 *
 * The wizard creates the shop on its FIRST answer -- the name -- so that
 * closing the window leaves a shop with that name rather than nothing. The
 * rate card is therefore written before a single rate exists, and
 * design_hourly and finishing_hourly are the only two columns in that table
 * with no default on either backend. An unanswered rate arrived as
 * undefined and SQLite refused the insert:
 *
 *   NOT NULL constraint failed: rate_cards.design_hourly
 *
 * on question one, as the first thing the program ever did.
 *
 * Normalising HERE rather than in each backend is deliberate: the hosted
 * side hands the payload to a SECURITY DEFINER SQL function, so a fix
 * written only in data.local.ts would have left Postgres failing the same
 * way, and nothing would have caught it until somebody hit it.
 *
 * Zero is the right value rather than a guess -- it is what setupPlan and
 * the field guidance already read as "still to do", so a shop with no rates
 * is visibly unfinished instead of quietly priced at somebody else's
 * numbers. Markup is 1x for the same reason: material at cost, rather than
 * Guma choosing a margin on the shop's behalf and never saying so.
 */
const UNANSWERED_RATES: Record<string, unknown> = {
  design_hourly: 0,
  finishing_hourly: 0,
  rush_pct: 0,
  minimum_order: 0,
  deposit_pct: 0,
  deposit_when: 'design',
  deposit_waive_below: 0,
  material_markup: 1,
  revisions_incl: 0,
  revision_hourly: null,
}

export async function setupShop(p: SetupPayload): Promise<string> {
  p = { ...p, rates: { ...UNANSWERED_RATES, ...(p.rates ?? {}) } }
  return (await backend()).setupShop(p)
}

export async function loadShopContext(): Promise<ShopContext> {
  return (await backend()).loadShopContext()
}

export async function saveRateCard(
  shopId: string,
  next: Omit<RateCardRow, 'id' | 'shop_id' | 'effective_from'>,
): Promise<RateCardRow> {
  return (await backend()).saveRateCard(shopId, next)
}

export async function saveShopIdentity(shopId: string, next: ShopIdentityInput): Promise<Shop> {
  return (await backend()).saveShopIdentity(shopId, next)
}

export async function saveShopCosts(shopId: string, next: ShopCostsInput): Promise<Shop> {
  return (await backend()).saveShopCosts(shopId, next)
}

export async function saveShopQuoteTerms(shopId: string, next: ShopQuoteTermsInput): Promise<Shop> {
  return (await backend()).saveShopQuoteTerms(shopId, next)
}

export async function dismissWelcome(shopId: string): Promise<void> {
  return (await backend()).dismissWelcome(shopId)
}

export async function listGuideSeen(shopId: string): Promise<string[]> {
  return (await backend()).listGuideSeen(shopId)
}

export async function createInHouseJob(
  shopId: string,
  input: { title: string; brief?: string | null; relatedTo?: string | null; seriesId?: string | null; neededBy?: string | null },
): Promise<string> {
  return (await backend()).createInHouseJob(shopId, input)
}

export async function markGuideSeen(shopId: string, chapter: string): Promise<void> {
  return (await backend()).markGuideSeen(shopId, chapter)
}

export async function savePrinter(shopId: string, next: PrinterInput): Promise<PrinterRow> {
  return (await backend()).savePrinter(shopId, next)
}

export async function setPrinterRetired(
  shopId: string,
  printerId: string,
  retired: boolean,
): Promise<void> {
  return (await backend()).setPrinterRetired(shopId, printerId, retired)
}

export async function deletePrinter(shopId: string, printerId: string): Promise<void> {
  return (await backend()).deletePrinter(shopId, printerId)
}

export async function nextJobRef(shopId: string): Promise<string> {
  return (await backend()).nextJobRef(shopId)
}

export async function listJobs(shopId: string): Promise<JobListRow[]> {
  return (await backend()).listJobs(shopId)
}

export async function updateJobPhase(
  shopId: string,
  jobId: string,
  actorId: string,
  toPhase: JobPhase,
  note: string | null = null,
): Promise<void> {
  return (await backend()).updateJobPhase(shopId, jobId, actorId, toPhase, note)
}

export async function updateJobPriority(
  shopId: string,
  jobId: string,
  priority: JobPriority,
): Promise<void> {
  return (await backend()).updateJobPriority(shopId, jobId, priority)
}

export async function saveQuote(args: SaveQuoteArgs): Promise<SavedQuote> {
  return (await backend()).saveQuote(args)
}

export async function loadQuoteForPrint(quoteId: string) {
  return (await backend()).loadQuoteForPrint(quoteId)
}

export async function loadProjectDetail(shopId: string, jobId: string): Promise<ProjectDetail> {
  return (await backend()).loadProjectDetail(shopId, jobId)
}

export async function setGateItem(
  shopId: string,
  jobId: string,
  actorId: string,
  phase: JobPhase,
  itemKey: string,
  checked: boolean,
  note: string | null,
): Promise<void> {
  return (await backend()).setGateItem(shopId, jobId, actorId, phase, itemKey, checked, note)
}

export async function addProjectNote(jobId: string, actorId: string, body: string): Promise<void> {
  return (await backend()).addProjectNote(jobId, actorId, body)
}

export async function updateProjectFields(
  shopId: string,
  jobId: string,
  fields: ProjectFieldsInput,
  actorId: string | null = null,
): Promise<void> {
  return (await backend()).updateProjectFields(shopId, jobId, fields, actorId)
}

export async function listClients(shopId: string): Promise<ClientRow[]> {
  return (await backend()).listClients(shopId)
}

export async function createClient(shopId: string, input: ClientEditInput): Promise<string> {
  return (await backend()).createClient(shopId, input)
}

export async function deleteClient(shopId: string, clientId: string): Promise<void> {
  return (await backend()).deleteClient(shopId, clientId)
}

export async function updateClientRecord(
  shopId: string,
  clientId: string,
  input: ClientEditInput,
): Promise<void> {
  return (await backend()).updateClientRecord(shopId, clientId, input)
}

export async function recordPayment(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PaymentInput,
): Promise<string> {
  return (await backend()).recordPayment(shopId, jobId, actorId, input)
}

export async function listMaterials(shopId: string): Promise<MaterialRow[]> {
  return (await backend()).listMaterials(shopId)
}

export async function saveSellBranch(shopId: string, branch: SellBranch | null): Promise<void> {
  return (await backend()).saveSellBranch(shopId, branch)
}

export async function recordStockCount(
  shopId: string,
  materialId: string,
  actorId: string,
  input: StockCountInput,
): Promise<{ id: string; delta: number }> {
  return (await backend()).recordStockCount(shopId, materialId, actorId, input)
}

export async function listMaterialLedger(shopId: string, materialId: string): Promise<StockEntry[]> {
  return (await backend()).listMaterialLedger(shopId, materialId)
}

export async function saveMaterial(shopId: string, next: MaterialInput): Promise<MaterialRow> {
  return (await backend()).saveMaterial(shopId, next)
}

export async function recordMaterialPurchase(
  shopId: string,
  materialId: string,
  actorId: string,
  input: MaterialPurchaseInput,
): Promise<string> {
  return (await backend()).recordMaterialPurchase(shopId, materialId, actorId, input)
}

export async function listMaterialPurchases(
  shopId: string,
  materialId: string,
): Promise<MaterialPurchaseRow[]> {
  return (await backend()).listMaterialPurchases(shopId, materialId)
}

export async function deleteMaterialPurchase(shopId: string, purchaseId: string): Promise<void> {
  return (await backend()).deleteMaterialPurchase(shopId, purchaseId)
}

export async function recordPrintRun(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PrintRunInput,
): Promise<string> {
  return (await backend()).recordPrintRun(shopId, jobId, actorId, input)
}

/** Correct a recorded print in place; optionally fail the copies it marked printed. */
export async function correctPrintRun(
  shopId: string,
  runId: string,
  actorId: string,
  input: RunCorrection,
  failCopies = false,
): Promise<number> {
  return (await backend()).correctPrintRun(shopId, runId, actorId, input, failCopies)
}

/** Remove a recorded print. With undoCopies, the copies it marked printed
 *  or failed go back to not printed first (CG, 13 Oct). Returns how many. */
export async function deletePrintRun(shopId: string, runId: string, undoCopies = false): Promise<number> {
  return (await backend()).deletePrintRun(shopId, runId, undoCopies)
}

/** Save the progress read later from a kept file. */
export async function setSliceProgress(shopId: string, importId: string, progress: ProgressPoint[]): Promise<void> {
  return (await backend()).setSliceProgress(shopId, importId, progress)
}

export async function logWork(
  shopId: string,
  jobId: string,
  actorId: string,
  input: WorkEntryInput,
): Promise<string> {
  return (await backend()).logWork(shopId, jobId, actorId, input)
}

export async function deleteWorkEntry(shopId: string, entryId: string): Promise<void> {
  return (await backend()).deleteWorkEntry(shopId, entryId)
}

export async function addPart(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PartInput,
): Promise<string> {
  return (await backend()).addPart(shopId, jobId, actorId, input)
}

export async function setPartStatus(
  shopId: string,
  partId: string,
  actorId: string,
  status: PartStatus,
  note: string | null,
): Promise<void> {
  return (await backend()).setPartStatus(shopId, partId, actorId, status, note)
}

export async function updatePart(
  shopId: string,
  partId: string,
  input: PartInput,
  actorId: string | null = null,
): Promise<void> {
  return (await backend()).updatePart(shopId, partId, input, actorId)
}

export async function choosePartVariant(
  shopId: string,
  partId: string,
  sectionId: string | null,
): Promise<void> {
  return (await backend()).choosePartVariant(shopId, partId, sectionId)
}

export async function deletePart(
  shopId: string,
  partId: string,
  actorId: string | null = null,
  reason: string | null = null,
): Promise<void> {
  return (await backend()).deletePart(shopId, partId, actorId, reason)
}

export async function setQuoteStatus(
  shopId: string,
  quoteId: string,
  actorId: string,
  status: QuoteStatus,
): Promise<void> {
  return (await backend()).setQuoteStatus(shopId, quoteId, actorId, status)
}

export async function takeProjectIn(shopId: string, jobId: string, actorId: string): Promise<void> {
  return (await backend()).takeProjectIn(shopId, jobId, actorId)
}

export async function deleteProject(shopId: string, jobId: string): Promise<void> {
  return (await backend()).deleteProject(shopId, jobId)
}

/* ---- the selling side ------------------------------------------------- */

export async function listChannels(shopId: string): Promise<ChannelRow[]> {
  return (await backend()).listChannels(shopId)
}

export async function saveChannel(shopId: string, next: ChannelInput): Promise<ChannelRow> {
  return (await backend()).saveChannel(shopId, next)
}

export async function listShelf(shopId: string): Promise<ProductRow[]> {
  return (await backend()).listShelf(shopId)
}

export async function saveProduct(shopId: string, next: ProductInput): Promise<string> {
  return (await backend()).saveProduct(shopId, next)
}

export async function saveBatch(shopId: string, next: BatchInput): Promise<string> {
  return (await backend()).saveBatch(shopId, next)
}

export async function listSales(shopId: string, batchId?: string): Promise<SaleRow[]> {
  return (await backend()).listSales(shopId, batchId)
}

export async function recordSale(shopId: string, next: SaleInput): Promise<string> {
  return (await backend()).recordSale(shopId, next)
}

export async function deleteSale(shopId: string, saleId: string): Promise<void> {
  return (await backend()).deleteSale(shopId, saleId)
}

/* ---- slicer imports ---------------------------------------------------- */

export async function importSlice(
  shopId: string,
  jobId: string,
  actorId: string,
  input: SliceImportInput,
): Promise<SliceImportResult> {
  return (await backend()).importSlice(shopId, jobId, actorId, input)
}

export async function sliceFileContent(
  shopId: string,
  importId: string,
): Promise<{ content: string; byteSize: number } | null> {
  return (await backend()).sliceFileContent(shopId, importId)
}

export async function listSliceImports(
  shopId: string,
  jobId: string,
): Promise<SliceImportRow[]> {
  return (await backend()).listSliceImports(shopId, jobId)
}

export async function archiveProject(
  shopId: string,
  jobId: string,
  actorId: string,
  archived: boolean,
): Promise<void> {
  return (await backend()).archiveProject(shopId, jobId, actorId, archived)
}

export async function setRelatedProject(
  shopId: string,
  jobId: string,
  relatedTo: string | null,
): Promise<void> {
  return (await backend()).setRelatedProject(shopId, jobId, relatedTo)
}

export async function deleteSliceImport(shopId: string, importId: string): Promise<void> {
  return (await backend()).deleteSliceImport(shopId, importId)
}

/** A quote's build lines, in order. Empty for a single-machine quote. */
export async function listQuoteBuilds(quoteId: string): Promise<QuoteBuildRow[]> {
  return (await backend()).listQuoteBuilds(quoteId)
}

/** Empty the demo workspace. Refuses unless the demo is active; desktop
 *  only. See lib/workspace.ts. */
export async function resetWorkspace(): Promise<void> {
  return (await backend()).resetWorkspace()
}

export async function listSeries(shopId: string): Promise<SeriesRow[]> {
  return (await backend()).listSeries(shopId)
}

export async function createSeries(
  shopId: string,
  input: { name: string; brief?: string | null; parentId?: string | null },
): Promise<string> {
  return (await backend()).createSeries(shopId, input)
}

export async function updateSeries(shopId: string, id: string, input: SeriesInput): Promise<void> {
  return (await backend()).updateSeries(shopId, id, input)
}

export async function setJobSeries(
  shopId: string,
  jobId: string,
  seriesId: string | null,
  actorId: string | null = null,
): Promise<void> {
  return (await backend()).setJobSeries(shopId, jobId, seriesId, actorId)
}

export async function skipGateItem(
  jobId: string,
  actorId: string,
  phase: JobPhase,
  itemKey: string,
  itemLabel: string,
  reason: string | null,
): Promise<void> {
  return (await backend()).skipGateItem(jobId, actorId, phase, itemKey, itemLabel, reason)
}

export async function listStockHolds(shopId: string): Promise<StockHoldRow[]> {
  return (await backend()).listStockHolds(shopId)
}

export async function setStockHolds(
  shopId: string,
  jobId: string,
  actorId: string | null,
  holds: StockHoldInput[],
): Promise<void> {
  return (await backend()).setStockHolds(shopId, jobId, actorId, holds)
}

export async function movePartCopies(
  shopId: string,
  partId: string,
  actorId: string | null,
  to: PartStatus,
  n: number,
  note: string | null,
): Promise<void> {
  return (await backend()).movePartCopies(shopId, partId, actorId, to, n, note)
}

/** Move one object of a plate to another part, or a new one; the copies its
 *  prints marked move with it (CG, 16 Oct). */
export async function moveSliceSection(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sectionId: string,
  to: import('./data.types').SectionAssign,
): Promise<import('./data.types').SectionMoveResult> {
  return (await backend()).moveSliceSection(shopId, jobId, actorId, sectionId, to)
}

export async function markPlatePrinted(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null = null,
): Promise<number> {
  return (await backend()).markPlatePrinted(shopId, jobId, actorId, sliceImportId, runId)
}

/** A failed plate: its copies marked failed with the reason, stamped with the print. */
export async function markPlateFailed(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null,
  reason: string | null,
): Promise<number> {
  return (await backend()).markPlateFailed(shopId, jobId, actorId, sliceImportId, runId, reason)
}

export async function setCopyStates(
  shopId: string,
  partId: string,
  actorId: string | null,
  copies: number[],
  to: PartStatus,
  note: string | null,
): Promise<void> {
  return (await backend()).setCopyStates(shopId, partId, actorId, copies, to, note)
}

/** Several parts to new copy counts at once; extras kept as spares. */
export async function setPartsCopies(
  shopId: string,
  jobId: string,
  actorId: string | null,
  changes: PartCopiesChange[],
  reason: string | null,
): Promise<PartCopiesResult[]> {
  return (await backend()).setPartsCopies(shopId, jobId, actorId, changes, reason)
}

/** A failed copy, back in the queue to print from a replacement file. */
export async function requeueCopyFromFile(
  shopId: string,
  partId: string,
  actorId: string | null,
  copy: number,
  sliceImportId: string,
  fileName: string,
): Promise<void> {
  return (await backend()).requeueCopyFromFile(shopId, partId, actorId, copy, sliceImportId, fileName)
}

export async function skipCopy(
  shopId: string,
  partId: string,
  actorId: string | null,
  copy: number,
  note: string | null,
): Promise<void> {
  return (await backend()).skipCopy(shopId, partId, actorId, copy, note)
}


/* ---- what each print made (0039) ---- */
export async function listMadeItems(shopId: string, jobId: string): Promise<import('./data.types').MadeItemRow[]> {
  return (await backend()).listMadeItems(shopId, jobId)
}
export async function recordMadeItems(shopId: string, jobId: string, runId: string, items: import('./data.types').MadeItemInput[]): Promise<void> {
  return (await backend()).recordMadeItems(shopId, jobId, runId, items)
}
export async function placeItems(shopId: string, jobId: string, ids: string[], to: import('./data.types').ItemPlace): Promise<{ batchId?: string }> {
  return (await backend()).placeItems(shopId, jobId, ids, to)
}
export async function listAssemblies(shopId: string, jobId: string): Promise<import('./data.types').AssemblyRow[]> {
  return (await backend()).listAssemblies(shopId, jobId)
}
export async function saveAssembly(shopId: string, jobId: string, next: import('./data.types').AssemblyInput): Promise<string> {
  return (await backend()).saveAssembly(shopId, jobId, next)
}
export async function finishAssembly(
  shopId: string,
  assemblyId: string,
  to: { kind: 'shelf'; productId: string | null; name?: string; madeOn: string } | { kind: 'kept' },
): Promise<{ batchId?: string }> {
  return (await backend()).finishAssembly(shopId, assemblyId, to)
}
export async function deleteAssembly(shopId: string, assemblyId: string): Promise<void> {
  return (await backend()).deleteAssembly(shopId, assemblyId)
}

export async function deleteBatch(shopId: string, batchId: string): Promise<void> {
  return (await backend()).deleteBatch(shopId, batchId)
}
export async function deleteProduct(shopId: string, productId: string): Promise<void> {
  return (await backend()).deleteProduct(shopId, productId)
}

export async function setSliceExtras(shopId: string, importId: string, thumbnail: string | null, slicedAt: string | null): Promise<void> {
  return (await backend()).setSliceExtras(shopId, importId, thumbnail, slicedAt)
}
