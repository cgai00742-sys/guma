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

/** One row in the Jobs list — every job today has exactly one quote (there
 *  is no "revise and re-save" flow yet, so `version` never advances past
 *  1), but the type carries a possibly-null quote deliberately: a job
 *  whose only save so far was "Save draft" has quote fields, a job that's
 *  never been saved at all wouldn't exist as a row in the first place. */
export interface JobListRow {
  jobId: string
  ref: string
  title: string
  clientName: string
  createdAt: string
  quoteId: string | null
  quoteStatus: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | null
  total: number | null
}
