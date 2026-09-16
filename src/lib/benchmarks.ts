/**
 * What other shops charge — with the receipts, and with the limits stated.
 *
 * Setup used to say "Guma ships no default rates on purpose", and then, two
 * fields later, "machine price ÷ lifetime hours is a fair start" — telling
 * someone the formula and leaving them to do the division. That gap is what
 * this file and derive.ts close, and they close it from opposite directions:
 * derive.ts does arithmetic on numbers the shop already knows, and this file
 * reports what published sources say other shops actually charge.
 *
 * The second one is a recommendation, which is exactly the thing the old
 * notice refused to make. It is made here anyway, because a beginner staring
 * at an empty "design per hour" box is not helped by principle, and because
 * the alternative is what they do instead: guess, guess low, and find out a
 * year later. But it is made under four rules, and every one of them is
 * enforced below rather than promised.
 *
 * 1. EVERY FIGURE IS SOURCED. No number appears here without a publication,
 *    a URL and a date. If it cannot be cited it does not ship.
 *
 * 2. NOTHING IS PRE-FILLED. These are shown beside a field, never written
 *    into it. Accepting one is a click the shop makes, not a default they
 *    have to notice and undo. A quote is still priced with their numbers.
 *
 * 3. MONEY DOES NOT TRAVEL, SO IT DOES NOT TRAVEL. Every published rate
 *    below was collected in one currency in one market. "$50-90/hr" is
 *    useful in Honolulu and actively misleading in Kraków, so a figure
 *    tagged with a currency is shown ONLY to a shop invoicing in that
 *    currency. Everyone else gets the portable half — lifetime hours,
 *    markup multiples, deposit percentages — which hold anywhere, plus a
 *    plain statement that Guma has no local rate data for their market.
 *    This is the same rule as locale.ts: a blank is honest, a wrong figure
 *    that looks researched is not.
 *
 * 4. IT GOES STALE, AND SAYS SO. Rates move. REVIEWED_ON below is the day
 *    a human last checked these against their sources, and benchmarks.test.ts
 *    fails the build once it is old enough to be doubted. A number with a
 *    2026 date sitting unexamined in 2029 is worse than no number, because
 *    it still looks like research.
 */

/** The day someone last checked every figure below against its source. */
export const REVIEWED_ON = '2026-09-16'

/** How long a review is trusted before the suite starts failing. Rates in
 *  this trade move slowly, but not this slowly. */
export const REVIEW_INTERVAL_MONTHS = 18

export type BenchmarkUnit =
  /** Money per hour. */
  | 'per-hour'
  /** Money per kilogram. */
  | 'per-kg'
  /** A flat money amount. */
  | 'flat'
  /** A multiplier, e.g. sell = cost x 2.5. Currency-free. */
  | 'multiple'
  /** A percentage. Currency-free. */
  | 'percent'
  /** A count of hours. Currency-free. */
  | 'hours'

/** The setup/settings field a figure informs. */
export type BenchmarkField =
  | 'designHourly'
  | 'finishingHourly'
  | 'printerRate'
  | 'wearHourly'
  | 'materialPerKg'
  | 'markup'
  | 'minimumOrder'
  | 'depositPct'

export interface Benchmark {
  id: string
  field: BenchmarkField
  /** Which kind of shop or machine this figure describes. */
  label: string
  low: number
  /** Null for an open-ended figure ("15,000 hours and up"). */
  high: number | null
  unit: BenchmarkUnit
  /**
   * '' means the figure carries no currency and is therefore portable to
   * any market — a multiple, a percentage, a count of hours. Anything else
   * is an ISO 4217 code, and the figure is shown only to shops invoicing in
   * it. See rule 3 above.
   */
  currency: string
  source: string
  url: string
  /** Publication or last-observed date of the source itself. */
  asOf: string
  /** Said to the shop, in the shop's language, including the caveats. */
  note: string
}

const LAYERMATH = {
  source: 'LayerMath, 3D printing hourly rate guide',
  url: 'https://layermath.com/blog/3d-printing-hourly-rate',
  asOf: '2026',
}

const THREE_DPI = {
  source: '3D Printing Industry, "You’re Pricing Wrong: How to Accurately Price for FFF/FDM"',
  url: 'https://3dprintingindustry.com/news/youre-pricing-wrong-how-to-accurately-price-for-fff-fdm-169164/',
  asOf: '2026',
}

const PEA3D = {
  source: 'PEA3D, printer longevity and maintenance guide',
  url: 'https://pea3d.com/en/how-long-does-a-3d-printer-last-2026-guide/',
  asOf: '2026',
}

const WHATTOCHARGE = {
  source: 'GetWhatToCharge, 3D printing pricing survey',
  url: 'https://getwhattocharge.com/how-much-to-charge-for/3d-printing',
  asOf: '2026',
}

const WOODWEB = {
  source: 'WoodWeb knowledge base, deposits and payment schedules for custom work',
  url: 'https://woodweb.com/knowledge_base/Deposits_and_Payment.html',
  asOf: '2026',
}

/**
 * The currency caveat that rides along with every LayerMath tier. Their
 * ranges are published without an explicit currency and their worked
 * examples use both pounds and dollars, so at this magnitude the tiers are
 * an order-of-magnitude guide rather than a precise figure. Saying so is
 * cheaper than being quietly wrong.
 */
const LM_CURRENCY_CAVEAT =
  'The source publishes this range without naming a currency and uses both £ and $ in its examples, so read it as the right order of magnitude rather than an exact figure.'

export const BENCHMARKS: Benchmark[] = [
  /* ---- machine time ------------------------------------------------- */
  {
    id: 'printer-fdm-hobby',
    field: 'printerRate',
    label: 'FDM, printing on the side',
    low: 0.75,
    high: 1.5,
    unit: 'per-hour',
    currency: 'USD',
    ...LAYERMATH,
    note: `What people charge when the machine is a hobby that pays for itself. ${LM_CURRENCY_CAVEAT}`,
  },
  {
    id: 'printer-fdm-shop',
    field: 'printerRate',
    label: 'FDM, selling properly',
    low: 2,
    high: 4,
    unit: 'per-hour',
    currency: 'USD',
    ...LAYERMATH,
    note: `The band most small shops taking outside work sit in. ${LM_CURRENCY_CAVEAT}`,
  },
  {
    id: 'printer-fdm-pro',
    field: 'printerRate',
    label: 'FDM, professional / engineering work',
    low: 5,
    high: 8,
    unit: 'per-hour',
    currency: 'USD',
    ...LAYERMATH,
    note: `Tighter tolerances, engineering materials, business clients. ${LM_CURRENCY_CAVEAT}`,
  },
  {
    id: 'printer-resin',
    field: 'printerRate',
    label: 'Resin / MSLA',
    low: 4,
    high: 10,
    unit: 'per-hour',
    currency: 'USD',
    ...LAYERMATH,
    note: `Higher than FDM across the board: consumables, wash and cure, and a shorter life on the FEP. ${LM_CURRENCY_CAVEAT}`,
  },

  /* ---- your hours --------------------------------------------------- */
  {
    id: 'design-maker',
    field: 'designHourly',
    label: 'CAD at maker level',
    low: 25,
    high: 45,
    unit: 'per-hour',
    currency: 'USD',
    ...LAYERMATH,
    note: `The entry band. The source is explicit that experienced product-design work for business clients justifies more than this, so treat the top of the range as a floor rather than a ceiling once you are good. ${LM_CURRENCY_CAVEAT}`,
  },
  {
    id: 'design-flat-job',
    field: 'designHourly',
    label: 'Whole-job modeling fee',
    low: 50,
    high: 200,
    unit: 'flat',
    currency: 'USD',
    ...WHATTOCHARGE,
    note: 'What a custom model is billed at as a single line rather than by the hour. Useful as a sanity check: if your hourly rate times your real modeling hours lands far outside this, one of the two numbers is wrong.',
  },

  /* ---- material ----------------------------------------------------- */
  {
    id: 'material-pla',
    field: 'materialPerKg',
    label: 'PLA and common filament, what you pay',
    low: 15,
    high: 45,
    unit: 'per-kg',
    currency: 'USD',
    ...THREE_DPI,
    note: 'Purchase cost, not sell. Engineering and filled materials sit above this.',
  },
  {
    id: 'markup-material',
    field: 'markup',
    label: 'Material markup',
    low: 2,
    high: 3,
    unit: 'multiple',
    currency: '',
    ...WHATTOCHARGE,
    note: 'The widely used pricing formula multiplies material cost by three. Two is the common floor. This one is a ratio, so it holds in any currency.',
  },

  /* ---- the machine as an asset -------------------------------------- */
  {
    id: 'life-fdm-consumer',
    field: 'wearHourly',
    label: 'Consumer FDM, mechanical life',
    low: 5000,
    high: 10000,
    unit: 'hours',
    currency: '',
    ...PEA3D,
    note: 'Print hours before a serious overhaul. Divide the machine price plus its lifetime consumables by this to get wear per hour — Guma will do it for you above.',
  },
  {
    id: 'life-fdm-pro',
    field: 'wearHourly',
    label: 'Professional FDM, mechanical life',
    low: 15000,
    high: null,
    unit: 'hours',
    currency: '',
    ...PEA3D,
    note: 'Built to run. Note the same source puts business obsolescence at three to five years regardless, so a machine can age out before it wears out.',
  },
  {
    id: 'life-prosumer-basis',
    field: 'wearHourly',
    label: 'Prosumer machine, working basis',
    low: 6000,
    high: 6000,
    unit: 'hours',
    currency: '',
    ...THREE_DPI,
    note: 'The figure this source depreciates a $5-10k machine over, across five years. A deliberately conservative basis: guessing long on life is the same mistake as guessing low on wear.',
  },
  {
    id: 'maintenance-annual',
    field: 'wearHourly',
    label: 'Annual maintenance and consumables',
    low: 500,
    high: 1000,
    unit: 'flat',
    currency: 'USD',
    ...THREE_DPI,
    note: 'Per machine per year, in parts and consumables — nozzles, belts, fans, plates. Fold it into wear rather than pretending the machine only cost its purchase price.',
  },

  /* ---- terms -------------------------------------------------------- */
  {
    id: 'minimum-small',
    field: 'minimumOrder',
    label: 'Shop minimum, small sellers',
    low: 10,
    high: 15,
    unit: 'flat',
    currency: 'USD',
    ...LAYERMATH,
    note: `The source recommends a materially higher minimum for custom CAD and commercial work, since the setup conversation costs the same on a small job as a large one. ${LM_CURRENCY_CAVEAT}`,
  },
  {
    id: 'deposit-custom',
    field: 'depositPct',
    label: 'Deposit on custom, made-to-order work',
    low: 50,
    high: 50,
    unit: 'percent',
    currency: '',
    ...WOODWEB,
    note: 'Fifty percent up front is the long-standing norm across custom trades that build to order, for the same reason it applies here: the shop buys material and spends labor before it sees anything. Larger jobs commonly step it down into milestones instead. A percentage travels, so this one is shown everywhere.',
  },
]

/**
 * The figures it is honest to show a shop invoicing in `currency`.
 *
 * Portable figures (multiples, percentages, hours) always come back. A
 * figure published in money comes back only to a shop working in that same
 * money — never converted, because Guma has no exchange rate and a stale
 * one would turn a cited figure into a fabricated one.
 */
export function benchmarksFor(field: BenchmarkField, currency: string): Benchmark[] {
  const want = (currency || '').toUpperCase()
  return BENCHMARKS.filter(
    (b) => b.field === field && (b.currency === '' || b.currency === want),
  )
}

/** True when Guma holds published money figures for this currency at all.
 *  False is not a failure — it is the thing to tell the shop out loud. */
export function hasLocalRates(currency: string): boolean {
  const want = (currency || '').toUpperCase()
  if (!want) return false
  return BENCHMARKS.some((b) => b.currency === want)
}

/** Every currency any money figure in the table is quoted in. */
export function ratedCurrencies(): string[] {
  return [...new Set(BENCHMARKS.map((b) => b.currency).filter(Boolean))].sort()
}

/** Whole months between the last human review and `now`. */
export function reviewAgeMonths(now: Date = new Date()): number {
  const [y, m, d] = REVIEWED_ON.split('-').map(Number)
  let months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m)
  if (now.getDate() < d) months -= 1
  return months
}

/** Past its review interval: the UI stops presenting it as current, and the
 *  test suite fails so somebody has to actually look. */
export function benchmarksStale(now: Date = new Date()): boolean {
  return reviewAgeMonths(now) >= REVIEW_INTERVAL_MONTHS
}
