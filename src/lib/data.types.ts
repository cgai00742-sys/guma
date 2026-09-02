/**
 * Types and pure logic shared by both data backends — the hosted Supabase
 * layer (data.supabase.ts) and the local SQLite layer (data.local.ts).
 *
 * Nothing in this file touches a network, a database, or a filesystem, so
 * it is always safe to import: it has no side effects at module-load time,
 * unlike data.supabase.ts (which throws on import if Supabase env vars are
 * missing — see supabase.ts) or data.local.ts (which only reaches out to
 * SQLite when one of its functions is actually called). data.ts, the
 * runtime dispatcher between the two backends, re-exports everything here
 * directly rather than through either backend, so screens never need to
 * know this file exists.
 */
import type { MaterialRef, PrinterRef, RateSet } from './pricing'

export interface Shop {
  id: string
  name: string
  slug: string
  accent: string
  accent_alt: string
  tax_label: string
  tax_pct: number
  currency: string
  locale: string
  legal_name: string | null
  address: string | null
  /** Two-letter US state code, e.g. 'HI'. Powers the tax-name helper only
   *  (src/lib/taxHelp.ts) -- never read by pricing.ts. Null until supplied. */
  state: string | null
  email: string | null
  phone: string | null
  license_no: string | null
  terms_text: string | null
  revision_policy: string | null
  payment_info: string | null
  quote_valid_days: number
  lead_days: number
  /** $/kWh off the shop's own utility bill. Null until they supply it. */
  electricity_rate_kwh: number | null
  /** The desktop welcome dialog, shown on launch until dismissed with
   *  "don't show this again". SQLite stores it as 0/1; data.local.ts
   *  coerces it to a real boolean on the way out. */
  show_welcome: boolean
}

export interface RateCardRow {
  id: string
  shop_id: string
  effective_from: string
  design_hourly: number
  finishing_hourly: number
  rush_pct: number
  minimum_order: number
  deposit_pct: number
  deposit_when: 'design' | 'print' | 'none'
  deposit_waive_below: number
  material_markup: number
  revisions_incl: number
  revision_hourly: number | null
}

/** The raw printers row — the Machines tab needs the id and tech to edit it,
 *  which PrinterRef (the pricing module's shape) deliberately doesn't carry. */
export interface PrinterRow {
  id: string
  name: string
  model: string
  tech: 'fdm' | 'resin' | 'composite' | 'sls'
  rate_hourly: number
  wear_hourly: number
  watts: number | null
}

export interface Profile {
  id: string
  shop_id: string
  full_name: string
  initials: string | null
  role: 'owner' | 'staff' | 'viewer'
}

/** Bundle every screen needs before it can draw anything. */
export interface ShopContext {
  profile: Profile
  shop: Shop
  rateCard: RateCardRow
  materials: MaterialRef[]
  printers: PrinterRef[]
  printerRows: PrinterRow[]
}

/** The rate card and the shop's tax, in the shape the pricing module wants. */
export function toRateSet(card: RateCardRow, shop: Shop): RateSet {
  return {
    designHourly: Number(card.design_hourly),
    finishingHourly: Number(card.finishing_hourly),
    rushPct: Number(card.rush_pct),
    minimumOrder: Number(card.minimum_order),
    depositPct: Number(card.deposit_pct),
    depositWhen: card.deposit_when,
    depositWaiveBelow: Number(card.deposit_waive_below),
    materialMarkup: Number(card.material_markup),
    revisionsIncl: card.revisions_incl,
    revisionHourly: card.revision_hourly == null ? null : Number(card.revision_hourly),
    taxLabel: shop.tax_label,
    taxPct: Number(shop.tax_pct),
    currency: shop.currency || 'USD',
    locale: shop.locale || 'en-US',
    electricityRateKwh: shop.electricity_rate_kwh == null ? null : Number(shop.electricity_rate_kwh),
  }
}

/** Thrown when there's no shop yet — the setup wizard's cue, from either backend. */
export class NeedsSetup extends Error {
  constructor() {
    super('no shop yet')
    this.name = 'NeedsSetup'
  }
}

export interface SetupPayload {
  shop: Record<string, unknown>
  rates: Record<string, unknown>
  printer: Record<string, unknown> | null
  materials: Record<string, unknown>[]
  fullName: string
}

export interface ShopIdentityInput {
  name: string
  legal_name: string
  address: string
  state: string
  email: string
  phone: string
  license_no: string
  electricity_rate_kwh: number | null
}

export interface ShopQuoteTermsInput {
  tax_label: string
  tax_pct: number
  quote_valid_days: number
  lead_days: number
  terms_text: string
  revision_policy: string
  payment_info: string
}

export interface SaveQuoteArgs {
  shopId: string
  ref: string
  client: { name: string; contact: string; email: string; phone: string; source: string }
  job: { title: string; brief: string; neededBy: string | null; assetOrigin: string }
  quote: {
    design_billing: 'hourly' | 'flat' | 'none'
    design_qty: number
    revisions_incl: number
    quantity: number
    material_id: string | null
    printer_id: string | null
    units_per_part: number
    print_hrs_part: number
    finishing_hrs: number
    rush: boolean
    flat_each: number
    discount_pct: number
  }
  /** set only when sending — a draft carries no snapshot and no frozen total */
  send?: {
    rates_snapshot: unknown
    total: number
    deposit_due: number
    valid_until: string
  }
}

export interface SavedQuote {
  jobId: string
  clientId: string
  quoteId: string
  ref: string
}

/** The seven stages a job moves through — same values in both backends
 *  (SQLite's jobs.phase check constraint and Postgres's job_phase enum).
 *  Ordered: this is also the Pipeline board's column order. */
export const JOB_PHASES = [
  'intake',
  'design',
  'approval',
  'scheduled',
  'building',
  'review',
  'delivered',
] as const
export type JobPhase = (typeof JOB_PHASES)[number]

export type JobPriority = 'low' | 'medium' | 'high' | 'urgent'

/** One row in the Jobs list (and the Pipeline board) — every job today has
 *  exactly one quote (there is no "revise and re-save" flow yet, so
 *  `version` never advances past 1), but the type carries a possibly-null
 *  quote deliberately: a job whose only save so far was "Save draft" has
 *  quote fields, a job that's never been saved at all wouldn't exist as a
 *  row in the first place. */
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired'

/**
 * What sort of buyer a client is, ordered the way a small print farm meets
 * them: one-off individuals and local businesses first, institutions after.
 * Not cosmetic -- a school buying with a purchase order, a hobbyist paying
 * on collection and a government contract differ on deposits, paperwork and
 * how long they take to pay, and a shop wants that split visible.
 *
 * Lives here rather than in gates.ts (which owns the logic that reads it)
 * so that data.types.ts stays the one module with no imports of its own --
 * gates.ts imports from here, never the reverse, and there is no cycle to
 * reason about.
 *
 * Stored as plain text on clients.kind with no database check constraint:
 * SQLite cannot relax one later without rebuilding the table, and this
 * vocabulary is exactly the sort that grows.
 */
export const CLIENT_KINDS = [
  'individual',
  'business',
  'club',
  'nonprofit',
  'government',
  'other',
] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

export const CLIENT_KIND_LABEL: Record<ClientKind, string> = {
  individual: 'Individual',
  business: 'Business',
  club: 'Club or school',
  nonprofit: 'Nonprofit',
  government: 'Government',
  other: 'Other',
}

/** Coerce whatever is in the column to a kind we understand. */
export function asClientKind(v: string | null | undefined): ClientKind {
  return (CLIENT_KINDS as readonly string[]).includes(v ?? '') ? (v as ClientKind) : 'other'
}

/** One answer on one stage-gate checklist item (see gates.ts and job_gates). */
export interface GateAnswer {
  checked: boolean
  note: string | null
}

/**
 * Everything the gate and flag logic in gates.ts is allowed to read about a
 * project. Assembled by whichever backend is in play from jobs + quotes +
 * the job_money view, so that all of that logic stays pure and testable
 * without a database anywhere near it.
 */
export interface ProjectFacts {
  phase: JobPhase
  priority: JobPriority
  createdAt: string
  /** ISO date (YYYY-MM-DD) the client is holding the shop to. */
  neededBy: string | null
  /** ISO date the delivery window opens, if the shop quoted a range. */
  windowFrom: string | null
  /** The window has been promised to the client and shouldn't move. */
  windowLocked: boolean
  /** Someone marked this project as at risk by hand. */
  atRisk: boolean
  /** ISO date it actually changed hands. */
  deliveryOn: string | null
  deliveryHow: string | null
  brief: string | null
  poc: string | null
  quoteStatus: QuoteStatus | null
  quoteTotal: number | null
  /** All four already derived by the job_money view from append-only payments. */
  depositDue: number
  depositOwed: number
  balanceOwed: number
  /** ISO timestamp of the most recent job_events row, if any. */
  lastActivityAt: string | null
  /** The current rate card's minimum_order, for the under-minimum flag. */
  minimumOrder: number
  /** What has actually been spent on this project so far, from job_actuals:
   *  material at today's weighted cost, machine power (or the machine rate
   *  when wattage is missing), wear, and logged hours at the shop's rates.
   *  Zero when nothing has been recorded, which `hasActuals` distinguishes
   *  from a genuinely free job. */
  actualCost: number
  hasActuals: boolean
  /** Build runs recorded. Backs the "material spend is logged" gate item,
   *  which until now was a question with nothing behind it. */
  actualRuns: number
  /** Design + finishing + admin hours logged. */
  actualHours: number
  /** Build-sheet rollup. `parts` is zero for a project that does not use
   *  one, which is what lets the QC gate fall back to a manual tick rather
   *  than becoming permanently unclearable. */
  parts: number
  partsPrinted: number
  partsPassed: number
  partsReprint: number
  /** How many times anything has been sent back, ever. A part reprinted
   *  twice and then passed costs the shop twice and would otherwise leave
   *  no trace. */
  reprintsEver: number
}

export interface JobListRow {
  jobId: string
  ref: string
  title: string
  clientId: string
  clientName: string
  clientKind: ClientKind
  createdAt: string
  phase: JobPhase
  priority: JobPriority
  quoteId: string | null
  quoteStatus: QuoteStatus | null
  total: number | null
  /** Enough to compute this project's flags and gate without a second query. */
  facts: ProjectFacts
  /** Gate answers for the CURRENT phase only -- the board and the list never
   *  need the earlier ones, and loadProjectDetail fetches all of them. */
  gateAnswers: Record<string, GateAnswer>
}

/** One entry in a project's activity log (a job_events row, joined to its actor). */
export interface ProjectEvent {
  id: number
  kind: string
  body: string | null
  fromPhase: JobPhase | null
  toPhase: JobPhase | null
  at: string
  actorName: string | null
}

/** Everything the project detail screen draws, in one round trip. */
export interface ProjectDetail {
  jobId: string
  ref: string
  title: string
  brief: string | null
  phase: JobPhase
  priority: JobPriority
  assetOrigin: 'model' | 'fix' | 'ready'
  createdAt: string
  updatedAt: string
  client: {
    id: string
    name: string
    kind: ClientKind
    contact: string | null
    email: string | null
    phone: string | null
  }
  quote: { id: string; status: QuoteStatus; total: number | null } | null
  facts: ProjectFacts
  /** Answers for EVERY phase, so earlier stages can be shown as cleared. */
  gates: Record<string, Record<string, GateAnswer>>
  events: ProjectEvent[]
  /** Every payment recorded against this project, newest first. */
  payments: PaymentRow[]
  /** What the project actually consumed, folded from runs and work entries. */
  actuals: ProjectActuals
  /** The quote's own inputs, so the project page can reprice it from its
   *  frozen snapshot and compare line by line against the actuals. Null
   *  when the project has never been quoted. */
  quoteInputs: QuoteInputsRow | null
  runs: PrintRunRow[]
  work: WorkEntryRow[]
  parts: PartRow[]
}

/** The pricing inputs stored on a quote row, plus its frozen rate snapshot. */
export interface QuoteInputsRow {
  designBilling: 'hourly' | 'flat' | 'none'
  designQty: number
  revisionsIncl: number
  quantity: number
  materialId: string | null
  printerId: string | null
  unitsPerPart: number
  printHrsPart: number
  finishingHrs: number
  rush: boolean
  flatEach: number
  discountPct: number
  /** Parsed, not the raw TEXT column. Null on a draft, which has none. */
  ratesSnapshot: unknown | null
}

/** The handful of project fields the detail screen can edit in place. */
export interface ProjectFieldsInput {
  /** Editable after intake on purpose: the intake gate reads it, so a
   *  project saved with an empty brief would otherwise be stuck forever
   *  with no way to satisfy the thing blocking it. Every fact a gate reads
   *  has to have somewhere it can be changed. */
  brief?: string | null
  title?: string
  poc?: string | null
  neededBy?: string | null
  windowFrom?: string | null
  windowLocked?: boolean
  atRisk?: boolean
  deliveryOn?: string | null
  deliveryHow?: string | null
  priority?: JobPriority
}

/** One row on the Clients screen -- a client, plus what they are worth. */
export interface ClientRow {
  id: string
  name: string
  kind: ClientKind
  contact: string | null
  email: string | null
  phone: string | null
  /** Projects of any age. */
  projects: number
  /** Projects not yet delivered. */
  active: number
  /** Sum of sent/accepted quote totals. Draft quotes are not money. */
  value: number
  /** Still owed across everything delivered. */
  owed: number
  /** Most recent job_events timestamp across all their projects. */
  lastActivity: string | null
}

/** Editable fields on the Clients screen. */
export interface ClientEditInput {
  name?: string
  kind?: ClientKind
  contact?: string | null
  email?: string | null
  phone?: string | null
}


/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export const PAYMENT_KINDS = ['deposit', 'balance', 'partial', 'refund'] as const
export type PaymentKind = (typeof PAYMENT_KINDS)[number]

export const PAYMENT_METHODS = ['cash', 'transfer', 'check', 'card', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  deposit: 'Deposit',
  balance: 'Balance',
  partial: 'Part payment',
  refund: 'Refund',
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  transfer: 'Bank transfer',
  check: 'Cheque',
  card: 'Card',
  other: 'Other',
}

/**
 * One payment, exactly as it was recorded. Payments are append-only facts:
 * there is no "mark as paid" flag anywhere in the schema, and every owed
 * figure in the app is the job_money view folding these rows. A payment
 * entered by mistake is corrected with a refund row, not by editing
 * history — which is also what an accountant would expect to find.
 */
export interface PaymentRow {
  id: string
  kind: PaymentKind
  amount: number
  method: PaymentMethod
  receivedOn: string
  note: string | null
  recordedBy: string | null
}

export interface PaymentInput {
  kind: PaymentKind
  amount: number
  method: PaymentMethod
  receivedOn: string
  note: string | null
  /** The quote this is being paid against, when there is one. */
  quoteId: string | null
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

/**
 * One material as the Materials screen sees it: the row a shop can edit,
 * plus what the purchase log says it actually costs.
 *
 * Same split as PrinterRef / PrinterRow above -- MaterialRef (in
 * pricing.ts) is the narrow shape the pricing engine wants; this is the
 * wide one, with the id, the stock figures and the cost provenance the
 * pricing engine has no business knowing about.
 */
export interface MaterialRow {
  id: string
  name: string
  kind: string
  swatch: string
  unit: 'g' | 'ml'
  /** The figure typed at setup. Kept even once purchases exist: it is the
   *  fallback if every purchase is later deleted, and the comparison that
   *  tells a shop how wrong its original guess was. */
  costPerUnit: number
  /** Charge this instead of cost x markup, when the shop has a set price. */
  sellOverride: number | null
  onHand: number
  reorderAt: number
  archived: boolean
  /* --- from the material_costs view --- */
  /** Weighted average of everything actually paid, or costPerUnit if nothing
   *  has been logged yet. This is what quotes are priced against. */
  avgCostPerUnit: number
  costBasis: 'purchases' | 'estimate'
  purchases: number
  purchasedQty: number
  purchasedSpend: number
  lastCostPerUnit: number | null
  lastPurchasedOn: string | null
}

export interface MaterialInput {
  id?: string
  name: string
  kind: string
  swatch: string
  unit: 'g' | 'ml'
  costPerUnit: number
  sellOverride: number | null
  onHand: number
  reorderAt: number
  archived?: boolean
}

export interface MaterialPurchaseRow {
  id: string
  materialId: string
  purchasedOn: string
  /** In the material's own unit -- grams for filament, mL for resin. */
  qty: number
  totalCost: number
  /** Derived, not stored: totalCost / qty. */
  costPerUnit: number
  supplier: string | null
  note: string | null
  recordedBy: string | null
}

export interface MaterialPurchaseInput {
  purchasedOn: string
  qty: number
  totalCost: number
  supplier: string | null
  note: string | null
}

/* ------------------------------------------------------------------ */
/* What a project actually took                                        */
/* ------------------------------------------------------------------ */

export const WORK_KINDS = ['design', 'finishing', 'admin'] as const
export type WorkKind = (typeof WORK_KINDS)[number]

export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  design: 'Design',
  finishing: 'Finishing',
  admin: 'Admin & handling',
}

export type RunOutcome = 'success' | 'failed' | 'cancelled'

/** One build run: a machine, a material, what it burned, and whether it
 *  worked. A failed run still consumed material and machine time, which is
 *  precisely why it is worth recording. */
export interface PrintRunRow {
  id: string
  printerId: string | null
  printerName: string | null
  materialId: string | null
  materialName: string | null
  unit: 'g' | 'ml' | null
  unitsUsed: number | null
  hours: number | null
  outcome: RunOutcome | null
  failureReason: string | null
  note: string | null
  startedAt: string | null
  endedAt: string | null
  operator: string | null
}

export interface PrintRunInput {
  printerId: string
  materialId: string | null
  unitsUsed: number
  hours: number
  outcome: RunOutcome
  failureReason: string | null
  note: string | null
  startedAt: string | null
}

export interface WorkEntryRow {
  id: string
  kind: WorkKind
  hours: number
  workedOn: string
  note: string | null
  actor: string | null
}

export interface WorkEntryInput {
  kind: WorkKind
  hours: number
  workedOn: string
  note: string | null
}

/**
 * The job_actuals view, folded. Every figure derived at read time from
 * append-only runs and work entries, exactly like job_money folds payments
 * — so nothing here can be stale and there is no "recalculate" button.
 */
export interface ProjectActuals {
  materialUnits: number
  /** Of those units, the ones that went into runs that failed. Real cost. */
  failedUnits: number
  materialCost: number
  machineHours: number
  /** Machine hours at the printer's rate — a PRICE, used only as the
   *  conservative fallback when wattage or the shop's $/kWh is missing. */
  machineCost: number
  wearCost: number
  /** hours x kW x $/kWh. Zero when either number is not on file. */
  powerCost: number
  runs: number
  failedRuns: number
  designHours: number
  finishingHours: number
  adminHours: number
}

/** Shared by both backends' recordPrintRun, so the two cannot validate
 *  differently. Hours may be zero (a run that failed on the first layer
 *  still consumed material); units may not be negative. */
export function validateRun(input: PrintRunInput): { hours: number; unitsUsed: number } {
  const hours = Number(input.hours)
  const unitsUsed = Number(input.unitsUsed)
  if (!Number.isFinite(hours) || hours < 0) throw new Error('Machine hours cannot be negative.')
  if (!Number.isFinite(unitsUsed) || unitsUsed < 0) {
    throw new Error('Material used cannot be negative.')
  }
  if (hours === 0 && unitsUsed === 0) {
    throw new Error('A run that used no material and no machine time is not a run.')
  }
  return { hours, unitsUsed }
}

export function validateHours(raw: number): number {
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Log more than zero hours.')
  if (hours > 24) throw new Error('More than 24 hours in one entry — split it across days.')
  return hours
}

export function runEventBody(input: PrintRunInput): string {
  const bits = [`${input.hours}h`, input.unitsUsed > 0 ? `${input.unitsUsed} used` : null]
    .filter(Boolean)
    .join(', ')
  return `Run recorded — ${bits} · ${input.outcome}${input.failureReason ? ` (${input.failureReason})` : ''}`
}




/* ------------------------------------------------------------------ */
/* The build sheet                                                     */
/* ------------------------------------------------------------------ */

/**
 * Voltage's four statuses, kept exactly: a part is waiting, off the
 * machine, checked and good, or going back. Proven in a real shop, and
 * there was no reason to invent a fifth.
 */
export const PART_STATUSES = ['pending', 'printed', 'passed', 'reprint'] as const
export type PartStatus = (typeof PART_STATUSES)[number]

export const PART_STATUS_LABEL: Record<PartStatus, string> = {
  pending: 'Not printed',
  printed: 'Printed, not checked',
  passed: 'Passed QC',
  reprint: 'Going back',
}

export interface PartRow {
  id: string
  label: string
  qty: number
  status: PartStatus
  note: string | null
  sort: number
  /** Newest first. Empty until something has happened to this part. */
  history: PartEvent[]
}

export interface PartEvent {
  id: number
  kind: 'status' | 'note'
  fromStatus: PartStatus | null
  toStatus: PartStatus | null
  note: string | null
  actor: string | null
  at: string
}

export interface PartInput {
  label: string
  qty: number
  note?: string | null
  sort?: number
}
