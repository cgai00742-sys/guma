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
}

/** The handful of project fields the detail screen can edit in place. */
export interface ProjectFieldsInput {
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
