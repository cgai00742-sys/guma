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
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
  JobListRow,
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
  PartStatus,
  QuoteInputsRow,
  PrintRunRow,
  PrintRunInput,
  WorkEntryRow,
  WorkEntryInput,
  QuoteStatus,
} from './data.types'

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
} from './data.types'
export type {
  Shop,
  RateCardRow,
  PrinterRow,
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
  JobListRow,
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
  PartStatus,
  QuoteInputsRow,
  PrintRunRow,
  PrintRunInput,
  WorkEntryRow,
  WorkEntryInput,
  QuoteStatus,
}

type Backend = typeof Local | typeof Hosted

let backendPromise: Promise<Backend> | null = null
function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri() ? import('./data.local') : import('./data.supabase')
  }
  return backendPromise
}

export async function setupShop(p: SetupPayload): Promise<string> {
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

export async function saveShopQuoteTerms(shopId: string, next: ShopQuoteTermsInput): Promise<Shop> {
  return (await backend()).saveShopQuoteTerms(shopId, next)
}

export async function dismissWelcome(shopId: string): Promise<void> {
  return (await backend()).dismissWelcome(shopId)
}

export async function savePrinter(
  shopId: string,
  next: Omit<PrinterRow, 'id'> & { id?: string },
): Promise<PrinterRow> {
  return (await backend()).savePrinter(shopId, next)
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
): Promise<void> {
  return (await backend()).updateJobPhase(shopId, jobId, actorId, toPhase)
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
): Promise<void> {
  return (await backend()).updateProjectFields(shopId, jobId, fields)
}

export async function listClients(shopId: string): Promise<ClientRow[]> {
  return (await backend()).listClients(shopId)
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

export async function deletePrintRun(shopId: string, runId: string): Promise<void> {
  return (await backend()).deletePrintRun(shopId, runId)
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
): Promise<void> {
  return (await backend()).updatePart(shopId, partId, input)
}

export async function deletePart(shopId: string, partId: string): Promise<void> {
  return (await backend()).deletePart(shopId, partId)
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
