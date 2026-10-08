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
import { osCurrency, osLocale } from './locale'

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
   *  (src/lib/taxHelp.ts) -- never read by pricing.ts, and never shown to a
   *  shop outside the US. Null until supplied. */
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
  /** What the shop pays every month whether or not a machine runs — rent,
   *  insurance, software, internet. Null until supplied. */
  overhead_monthly: number | null
  /** Machine-hours the shop actually bills in a typical month. The
   *  denominator that turns the figure above into a per-hour cost. */
  productive_hours_month: number | null
  /** Share of machine-side cost lost to failed plates, as a percentage.
   *  A cost the shop absorbs, never a surcharge added to a quote. */
  failure_pct: number | null
  /** 'letter' | 'a4' | 'legal', or null meaning "derive it from the locale"
   *  -- see src/lib/locale.ts. Null is not a synonym for Letter. */
  paper: string | null
  /** The desktop welcome dialog, shown on launch until dismissed with
   *  "don't show this again". SQLite stores it as 0/1; data.local.ts
   *  coerces it to a real boolean on the way out. */
  show_welcome: boolean
  /** How the shop mostly gets paid, as answered in setup. Null until
   *  answered -- which decides which setup questions apply. */
  sell_branch: SellBranch | null
}

export type SellBranch = 'clients' | 'selling' | 'both'

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
  /** 1 once the machine has been retired. Retired machines keep every run
   *  they ever did and stop appearing anywhere work is priced -- see
   *  0011_retire_machines.sql. SQLite has no booleans, so this is 0 or 1
   *  and every read of it goes through Number(). */
  archived: number
}

/** What a caller supplies when adding or editing a machine. Retiring is its
 *  own operation (setPrinterRetired), not a field on the edit form -- a
 *  checkbox that can silently take a printer out of every quote is not a
 *  thing to put next to "model". */
export type PrinterInput = Omit<PrinterRow, 'id' | 'archived'> & { id?: string }

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
    // No hard-coded region behind these. A shop row always carries both,
    // set at setup from the machine's own locale; the fallbacks exist only
    // for a row written by an older build, and they ask the OS rather than
    // assuming a country.
    currency: shop.currency || osCurrency(),
    locale: shop.locale || osLocale(),
    electricityRateKwh: shop.electricity_rate_kwh == null ? null : Number(shop.electricity_rate_kwh),
    // Null, not zero. Zero would claim the shop pays no rent and never
    // fails a plate, and would present an incomplete cost as a complete
    // one; null makes the cost panel name what is missing instead.
    overheadMonthly: shop.overhead_monthly == null ? null : Number(shop.overhead_monthly),
    productiveHoursMonth:
      shop.productive_hours_month == null ? null : Number(shop.productive_hours_month),
    failurePct: shop.failure_pct == null ? null : Number(shop.failure_pct),
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
  /** US state code, or '' -- only ever collected when the shop's locale is
   *  a US one, because it exists solely to name the tax correctly there. */
  state: string
  email: string
  phone: string
  license_no: string
  electricity_rate_kwh: number | null
  /** ISO 4217. */
  currency: string
  /** BCP 47. Drives money format, number grouping, document dates and the
   *  default paper size. */
  locale: string
  /** '' means "follow the locale". */
  paper: string
}

/**
 * Everything that decides what a job COSTS, as opposed to what it sells for.
 *
 * Kept as one input and one screen on purpose. These four numbers were
 * scattered — electricity under Identity, the other three not asked at all —
 * and a shop cannot see whether its cost figure is trustworthy when the
 * things that make it trustworthy live in three places. Every one of them
 * may be null: a blank says "not supplied" and the cost panel names it,
 * where a zero would quietly claim the shop pays no rent.
 */
export interface ShopCostsInput {
  electricity_rate_kwh: number | null
  overhead_monthly: number | null
  productive_hours_month: number | null
  failure_pct: number | null
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

/** A row of quote_builds, on the way in. */
export interface QuoteBuildInput {
  /** 'print' is the only kind today; hardware (magnets, dowels, inserts)
   *  lands here later as its own kind. */
  kind?: 'print'
  label: string
  printerId: string | null
  materialId: string | null
  /** copies of THIS line, not of the job */
  qty: number
  /** grams or mL for ONE copy */
  unitsPerPart: number
  /** print hours for ONE copy */
  printHrsPerPart: number
  /** the sliced file this came off, so a read figure is distinguishable
   *  from a typed one. Null means typed by hand. */
  sliceImportId?: string | null
}

/** A row of quote_builds, on the way back out. */
export interface QuoteBuildRow extends QuoteBuildInput {
  id: string
  kind: 'print'
  sliceImportId: string | null
  sort: number
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
  /**
   * One line per thing being made, each on its own machine and material.
   *
   * When present, these DESCRIBE the quote and the single-machine fields
   * above (quantity, material_id, printer_id, units_per_part,
   * print_hrs_part) are ignored rather than mirrored. Two copies of one
   * fact are free to disagree, and the one that disagrees silently is the
   * one that bills a client. See 0016_quote_builds.sql.
   */
  builds?: QuoteBuildInput[]
  /**
   * Re-quoting an existing project: this saves a NEW VERSION against that
   * job and its client rather than creating another project. Versioned by
   * insert, like everything else priced here -- the accepted version stays
   * exactly as the client saw it.
   */
  reviseJobId?: string
  /** Required when the new total lands above the accepted ceiling. */
  change?: QuoteChange
  /** set only when sending — a draft carries no snapshot and no frozen total */
  send?: {
    rates_snapshot: unknown
    total: number
    deposit_due: number
    valid_until: string
  }
}

/* ------------------------------------------------------------------ */
/* The accepted quote is a ceiling                                     */
/* ------------------------------------------------------------------ */

/**
 * How far above an accepted total a revision may go before it needs a
 * change order. The shop's own rule, not an industry one.
 */
export const CEILING_PCT = 10

/**
 * The only reasons a revision may go over. Every one of them is something
 * the CLIENT did -- which is the whole point. A shop that under-quoted its
 * own print time has made a mistake, and charging the client for it is how
 * a shop loses the client. Recording it as a shop-caused overrun instead
 * is what makes the same mistake visible the third time it happens.
 */
export const CHANGE_CAUSES = [
  'added_work',
  'design_change',
  'material_change',
  'rush',
  'scope_clarified',
] as const
export type ChangeCause = (typeof CHANGE_CAUSES)[number]

export const CHANGE_CAUSE_LABEL: Record<ChangeCause, string> = {
  added_work: 'They added parts or copies',
  design_change: 'They changed the design after acceptance',
  material_change: 'They asked for a different material or finish',
  rush: 'They moved the deadline in',
  scope_clarified: 'What they wanted turned out to be more than what was described',
}

export interface QuoteChange {
  cause: ChangeCause
  reason: string
}

/** What a revision does to the accepted price, in numbers a screen can
 *  print before anybody presses anything. */
export function ceilingCheck(
  acceptedTotal: number | null,
  newTotal: number | null,
): { ceiling: number | null; over: boolean; overPct: number } {
  if (acceptedTotal == null || acceptedTotal <= 0 || newTotal == null) {
    return { ceiling: null, over: false, overPct: 0 }
  }
  const ceiling = Math.round(acceptedTotal * (1 + CEILING_PCT / 100) * 100) / 100
  const overPct = Math.round(((newTotal - acceptedTotal) / acceptedTotal) * 1000) / 10
  return { ceiling, over: newTotal > ceiling, overPct }
}

/**
 * Shared by both backends so the two cannot disagree about when a change
 * order is required.
 *
 * Warn, don't block, was the decision -- so this refuses ONLY the case
 * where the shop has not said why. An unexplained rise above a price the
 * client agreed to is the one thing that must not be possible to record,
 * because six months later nobody can tell it from a billing error.
 */
export function validateRevision(
  acceptedTotal: number | null,
  newTotal: number | null,
  change: QuoteChange | undefined,
): QuoteChange | null {
  const { over } = ceilingCheck(acceptedTotal, newTotal)
  if (!over) return null
  const reason = (change?.reason ?? '').trim()
  if (!change || !CHANGE_CAUSES.includes(change.cause) || !reason) {
    throw new Error(
      `This is more than ${CEILING_PCT}% above the price they accepted. Say what the client ` +
        'changed before saving it.',
    )
  }
  return { cause: change.cause, reason }
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
  'approval',
  'design',
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
  /** Skipped on purpose, with this reason (0027_gate_skips.sql). Clears the
   *  item for advancing without pretending it was done. */
  skipped?: string | null
}

/**
 * Everything the gate and flag logic in gates.ts is allowed to read about a
 * project. Assembled by whichever backend is in play from jobs + quotes +
 * the job_money view, so that all of that logic stays pure and testable
 * without a database anywhere near it.
 */
/** Work somebody is paying for, or work the shop does for itself.
 *  In-house covers R&D, test prints, calibration, samples and designing
 *  the shop's own products -- everything that consumes machine hours,
 *  material and labour without a client on the other end. See
 *  0012_in_house.sql for why this is a job kind rather than a client. */
export type JobKind = 'client' | 'inhouse'

export interface ProjectFacts {
  phase: JobPhase
  /** Billed work or the shop's own. In-house jobs never carry a quote,
   *  a deposit or a receivable, and are excluded from every client count. */
  kind: JobKind
  priority: JobPriority
  createdAt: string
  /**
   * When someone decided this was a real project rather than a saved
   * price. Null means it is still a draft: findable and priced, but off
   * the pipeline board. See 0008_drafts.sql for why the two are different
   * acts.
   */
  takenInAt: string | null
  /** ISO date (YYYY-MM-DD) the client is holding the shop to. */
  neededBy: string | null
  /** ISO date the delivery window opens, if the shop quoted a range. */
  windowFrom: string | null
  /** The window has been promised to the client and shouldn't move. */
  windowLocked: boolean
  /** Someone marked this project as at risk by hand. */
  atRisk: boolean
  /** Set when a change order took the price above what the client
   *  accepted; says how. Stays until someone clears it. */
  overCeiling: string | null
  /**
   * Client approval items the shop moved past on purpose, with the reason
   * written at the time. Not a pass: the money flags still show, but as a
   * decision on the record rather than an oversight (CG, 7 Oct).
   */
  wentAheadWithout: { accepted: string | null; deposit: string | null }
  /** The machine it is booked on; null until Scheduled picks one. */
  printerId: string | null
  /**
   * Checks only the project page can make -- they need the build sheet,
   * stock on hand and the start-by date, which the board does not load.
   * Absent on the board, where those gate items read as plain ticks.
   */
  schedule?: { materialOk: boolean | null; slotOk: boolean | null }
  /** ISO date it actually changed hands. */
  deliveryOn: string | null
  deliveryHow: string | null
  brief: string | null
  poc: string | null
  quoteStatus: QuoteStatus | null
  quoteTotal: number | null
  /** The same quote before tax -- what the shop earns. Null with no quote.
   *  Tax is collected for someone else, so cost is never measured against
   *  it (review fix, 8 Oct). */
  quotePreTax: number | null
  /** Before tax AND discount: subtotal plus rush, the figure the shop
   *  minimum is applied to. */
  quoteListPrice: number | null
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
  /** Machine hours logged. Separate from actualHours, which is human time:
   *  a print runs unattended, and counting the two together would say a
   *  shop worked a fourteen-hour day because a printer did. */
  machineHours: number
  /** Material units drawn, and of those the ones consumed by runs that
   *  failed. Shrinkage is the second one, and it is a real cost that
   *  otherwise leaves no trace anywhere. */
  materialUnits: number
  failedUnits: number
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
  /** The project this one sits under, if any -- BathyTopo for "Fiji".
   *  Programs nest to any depth; see setRelatedProject and lib/programs.ts. */
  relatedTo: string | null
  /** The series this project is a piece of (0026_series.sql), or null. */
  seriesId: string | null
  /** Filed off the working board, keeping every figure it contributes.
   *  Only a delivered project can be. Null means it is still on the board. */
  archivedAt: string | null
  /** Units this project put on the shelf, across every batch made from it.
   *  Zero is a real answer -- a trial that produced nothing sellable still
   *  cost money -- which is why the gate that reads this can still be
   *  ticked by hand to say exactly that. */
  unitsMade: number
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
  /** The project this one continues from -- the one that paid for the
   *  design. Null when this is the original, or stands alone. */
  relatedTo: RelatedProject | null
  /** Projects that point at this one. */
  related: RelatedProject[]
  runs: PrintRunRow[]
  work: WorkEntryRow[]
  parts: PartRow[]
  /** Every sliced file imported against this project, newest first. The
   *  screen needs them here rather than in a second fetch because each one
   *  offers a one-click run, and that offer has to disappear the moment
   *  the run exists. */
  slices: SliceImportRow[]
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
  /** The quote's build lines (quote_builds). Empty means the single-machine
   *  shape above. Present means they ARE the print -- quantity, units and
   *  hours above are then ignored by priceQuote. */
  builds: QuoteBuildRow[]
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
  /** Only ever cleared from the screen (null); saveQuote sets it. */
  overCeiling?: string | null
  /** The machine it is booked on (Scheduled). */
  printerId?: string | null
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
  /** Null on an UPDATE means "leave the stock count alone". The setup
   *  wizard edits a material's name and price and must never touch how
   *  much of it is on the shelf -- it used to pass 0, which quietly wiped
   *  the stock every time somebody re-answered the material question. */
  onHand: number | null
  reorderAt: number | null
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

/** Somebody weighed the spool. See 0024_stock_counts.sql. */
export interface StockCountInput {
  countedOn: string
  /** What is actually there, in the material's own unit. */
  counted: number
  note: string | null
}

/**
 * One movement of one material: every reason on-hand has changed, in one
 * list. Purchases add, prints take away (failed ones too -- they burned it),
 * and counts correct the difference between what Guma believed and what
 * the scale said.
 */
export interface StockEntry {
  id: string
  kind: 'purchase' | 'print' | 'count'
  /** ISO date the movement belongs to. */
  on: string
  /** Signed, in the material's unit: + onto the shelf, − off it. */
  qty: number
  /** Purchases only. */
  cost: number | null
  /** Prints only: which project burned it, and whether it worked. */
  jobId: string | null
  jobRef: string | null
  jobTitle: string | null
  outcome: RunOutcome | null
  /** Counts only: what the scale said. */
  counted: number | null
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
  /** The imported slicer file this run confirms, when it came from one.
   *  Null for a run typed in by hand, which stays the normal case. */
  sliceImportId: string | null
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
  /** Set when the run was confirmed from an import, so the screen can show
   *  that file as recorded and nobody logs the same plate twice. */
  sliceImportId?: string | null
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
  reprint: 'Failed — reprint',
}

export interface PartRow {
  id: string
  label: string
  qty: number
  /** Summary of where the copies are (see lib/copies.ts). */
  status: PartStatus
  /** Copies off the machine, not checked; passed QC; going back. The rest
   *  are not printed yet (0031_part_copies.sql). */
  printedN: number
  passedN: number
  reprintN: number
  /** Each copy's state, copy 1 first (0032_copy_states.sql). Always the
   *  length of qty -- read from the counts when never split out. */
  copyStates: PartStatus[]
  note: string | null
  sort: number
  /** Newest first. Empty until something has happened to this part. */
  history: PartEvent[]
  /** Every sliced file this part has been read out of, one per machine.
   *  Empty for a part typed in by hand. See 0018_slice_variants.sql. */
  variants: PartVariant[]
  /** Which variant is being printed. Null means nobody has chosen, and
   *  the screen falls back to the fastest -- saying so. */
  chosenSectionId: string | null
}

/**
 * One part as sliced for one machine.
 *
 * Time is per this machine and must not be averaged across variants: the
 * swing between two printers is up to 20%. Grams barely move (about 1%),
 * so any variant answers "how much filament" honestly.
 */
export interface PartVariant {
  /** The slice_sections row. This is what chosenSectionId points at. */
  sectionId: string
  importId: string
  fileName: string
  /** The machine as the FILE named it -- kept verbatim, matched or not.
   *  Voltage lost a month of variant matching to a "Pursa XL" typo. */
  printerModel: string | null
  printerId: string | null
  printerName: string | null
  estMinutes: number | null
  estGrams: number | null
  material: string | null
  importedAt: string
  /** How many objects were on the plate this came off. More than one and
   *  the print is indivisible: you cannot print half a plate. */
  plateParts: number
  /** Copies of this object the FILE had on its plate. estGrams and
   *  estMinutes cover all of them, so one copy is est / sectionQty. */
  sectionQty: number
  /** The spool the file was imported against, when matched. */
  materialId: string | null
}

/**
 * One member of a project family, as the other members need to see it.
 *
 * Design hours travel with the row rather than being summed into it: the
 * point of the family is that the hours were spent ONCE, on one project,
 * and the others can see that without either copying them or paying for
 * them again.
 */
export interface RelatedProject {
  jobId: string
  ref: string
  title: string
  phase: JobPhase
  kind: JobKind
  designHours: number
  archivedAt: string | null
}

export interface PartEvent {
  id: number
  kind: 'status' | 'note'
  fromStatus: PartStatus | null
  toStatus: PartStatus | null
  /** Copies this moved; null on events that moved all of them. */
  n: number | null
  /** Which copies, 1-based, when the event named them. */
  copies: number[] | null
  note: string | null
  actor: string | null
  at: string
}

export interface PartInput {
  label: string
  qty: number
  note?: string | null
  sort?: number
  /** Why a part is being added after the sheet was checked (Review on).
   *  Logged with the part and in Activity. */
  reason?: string | null
}

/* ---- slicer imports ---------------------------------------------------- */
/**
 * What a slicer said about a file, kept deliberately apart from what a
 * machine did. See 0015_slice_imports.sql: these never reach job_actuals,
 * because job_actuals sums print_runs and a prediction is not a measurement.
 *
 * Every number here is named est* for the same reason.
 */

export type SliceImportKind = '3mf' | 'gcode' | '3mf-model'

/** One object on the plate, and the build-sheet row it filled in. */
export interface SliceSectionRow {
  id: string
  /** Null once the part has been deleted. The prediction still happened. */
  partId: string | null
  label: string
  qty: number
  estMinutes: number | null
  estGrams: number | null
  material: string | null
}

export interface SliceImportRow {
  id: string
  fileName: string
  kind: SliceImportKind
  /** The machine as the file named it, verbatim, matched or not. */
  printerModel: string | null
  printerId: string | null
  printerName: string | null
  materialText: string | null
  materialId: string | null
  materialName: string | null
  estMinutes: number | null
  estGrams: number | null
  /** What the reader should know: plates combined, labels missing, and so on. */
  notes: string[]
  importedAt: string
  sections: SliceSectionRow[]
  /** The real file's size when Guma kept a copy, null when it did not.
   *  Read from slice_files without dragging the bytes along: every screen
   *  wants to say whether the file is there, and none of them want it. */
  keptBytes: number | null
}

export interface SliceSectionInput {
  label: string
  qty: number
  estMinutes: number | null
  estGrams: number | null
  material: string | null
}

/** The file itself, packed by sliceFile.ts. Absent when it was over the
 *  cap or the platform could not compress -- the import still happens. */
export interface KeptFileInput {
  content: string
  byteSize: number
  storedSize: number
  encoding: 'gzip-base64'
}

export interface SliceImportInput {
  file?: KeptFileInput | null
  fileName: string
  kind: SliceImportKind
  printerModel: string | null
  printerId: string | null
  materialText: string | null
  materialId: string | null
  estMinutes: number | null
  estGrams: number | null
  notes: string[]
  sections: SliceSectionInput[]
  /** A replacement file for ONE failed part. When the file holds a single
   *  object it is linked to this part whatever the slicer called it, and
   *  becomes the slice the part is printed from -- no duplicate row. */
  forPartId?: string | null
}

/** What an import did, so the screen can say it rather than guess. */
export interface SliceImportResult {
  importId: string
  /** Build-sheet rows created by this file. */
  partsAdded: number
  /** Rows that already existed and were matched by name -- a re-slice. */
  partsMatched: number
  /** Set when this exact file (same name, same slicer numbers) was already
   *  on the project: nothing new was written, and importId is the earlier
   *  import. The date it first arrived, so the screen can say so. */
  duplicateOf?: string | null
}

/** Two imports are the same file when the name and the slicer's own numbers
 *  agree. Re-uploading a file must never count its print twice. */
export function sameSliceFile(
  a: { fileName: string; estMinutes: number | null; estGrams: number | null },
  b: { fileName: string; estMinutes: number | null; estGrams: number | null },
): boolean {
  const n = (v: number | null) => (v == null ? null : Math.round(Number(v) * 10) / 10)
  return (
    a.fileName.trim().toLowerCase() === b.fileName.trim().toLowerCase() &&
    n(a.estMinutes) === n(b.estMinutes) &&
    n(a.estGrams) === n(b.estGrams)
  )
}

/* ---- the selling side ------------------------------------------------- */
/**
 * What a shop makes for itself and sells, rather than what somebody
 * commissioned. See 0014_selling.sql for why design cost lives on the
 * product and production cost is frozen on the batch.
 */

/** Where a shop sells, and what that place takes. */
export interface ChannelRow {
  id: string
  name: string
  /** Percent of the sale price, 0..100. */
  fee_pct: number
  /** Taken per sale regardless of size -- listing and processing fees. */
  fee_flat: number
  archived: number
}

export interface ChannelInput {
  id?: string
  name: string
  feePct: number
  feeFlat: number
  archived?: boolean
}

/** A run of units, made on a day, at a cost that never moves again. */
export interface BatchRow {
  id: string
  product_id: string
  job_id: string | null
  units_made: number
  unit_cost: number
  made_on: string
  note: string | null
  units_sold: number
  units_left: number
  revenue: number
  fees: number
  cost_of_sold: number
  /**
   * True when the unit cost was typed rather than derived from logged runs
   * and hours -- stock that existed before Guma did. Guma still counts it,
   * and still says which number it is standing on.
   *
   * Derived from job_id rather than stored: a batch with no job behind it
   * is exactly one whose cost nobody can check. A stored flag would be a
   * second version of the same fact, free to disagree with the first.
   */
  estimated: boolean
}

export interface BatchInput {
  id?: string
  productId: string
  jobId?: string | null
  unitsMade: number
  unitCost: number
  madeOn: string
  note?: string | null
}

/** A thing the shop makes more than once, with every batch of it. */
export interface ProductRow {
  id: string
  name: string
  design_job_id: string | null
  design_cost: number | null
  design_hours: number | null
  archived: number
  batches: BatchRow[]
}

export interface ProductInput {
  id?: string
  name: string
  designJobId?: string | null
  designCost?: number | null
  designHours?: number | null
  archived?: boolean
}

export interface SaleRow {
  id: string
  batch_id: string
  channel_id: string | null
  channel_name: string | null
  units: number
  unit_price: number
  fee_total: number
  sold_on: string
  note: string | null
}

export interface SaleInput {
  id?: string
  batchId: string
  channelId: string | null
  units: number
  unitPrice: number
  soldOn: string
  note?: string | null
}

/** A series: the shop's own body of work, holding projects the way a client
 *  holds theirs. Nests -- BathyTopo › Hawaiian Islands. See 0026_series.sql. */
export interface SeriesRow {
  id: string
  name: string
  brief: string | null
  parentId: string | null
  createdAt: string
  archivedAt: string | null
}

export interface SeriesInput {
  name?: string
  brief?: string | null
  parentId?: string | null
  archived?: boolean
}

/**
 * Material set aside for a project (0030_stock_holds.sql). `remaining` is
 * what is still held once the project's own print runs have drawn on it;
 * only projects in Scheduled, In build or Review appear at all.
 */
export interface StockHoldRow {
  jobId: string
  ref: string
  title: string
  phase: JobPhase
  materialId: string
  held: number
  used: number
  remaining: number
}

export interface StockHoldInput {
  materialId: string
  units: number
}

/** "Set aside 699g PLA Black, 132g PETG." -- one wording, both backends. */
export function describeHolds(
  holds: { name: string; unit: string; units: number }[],
): string {
  if (holds.length === 0) return 'Released the material set aside for this project.'
  return `Set aside ${holds.map((h) => `${Math.round(h.units).toLocaleString()}${h.unit} ${h.name}`).join(', ')}.`
}

/**
 * A stored quote total, taken back to before tax and before discount. The
 * tax rate comes from the quote's own frozen rates; a draft (no snapshot)
 * falls back to treating the total as pre-tax, which errs toward flagging.
 */
export function quoteBases(
  total: number | null,
  snapshot: unknown,
  discountPct: number | null | undefined,
): { preTax: number | null; listPrice: number | null } {
  if (total == null) return { preTax: null, listPrice: null }
  let snap: unknown = snapshot
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap)
    } catch {
      snap = null
    }
  }
  const tax = Number((snap as { rates?: { taxPct?: number } } | null)?.rates?.taxPct ?? 0) || 0
  const preTax = Number(total) / (1 + tax / 100)
  const d = Number(discountPct ?? 0) || 0
  const listPrice = d > 0 && d < 100 ? preTax / (1 - d / 100) : preTax
  const r = (n: number) => Math.round(n * 100) / 100
  return { preTax: r(preTax), listPrice: r(listPrice) }
}
