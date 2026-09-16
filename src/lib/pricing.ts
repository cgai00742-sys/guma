/**
 * The quote calculation, exactly as specified in README.md.
 *
 * The operation order is load-bearing and is the thing most likely to be broken
 * by a well-meaning edit, so it is written out once, here, and imported by both
 * the Shop Settings sample panel and the Job Intake screen. There is no second
 * copy of this arithmetic anywhere in the app.
 *
 *   1. the shop minimum applies to the raw subtotal, BEFORE rush and discount
 *   2. rush is a percentage of that subtotal
 *   3. discount is a percentage of (subtotal + rush)
 *   4. tax applies LAST, to the discounted total
 *   5. the deposit is a percentage of the FINAL total, tax included, and is
 *      waived entirely below the threshold
 *
 * No rate in this file is a constant. Everything arrives in `RateSet`,
 * `MaterialRef` and `PrinterRef`, all of which are rows read from the database.
 */

export type AssetOrigin = 'model' | 'fix' | 'ready'
export type DesignBilling = 'hourly' | 'flat'
export type DepositWhen = 'design' | 'print' | 'none'

/** Every number the quote touches. One row of `rate_cards` plus the shop's tax. */
export interface RateSet {
  designHourly: number
  finishingHourly: number
  rushPct: number
  minimumOrder: number
  depositPct: number
  depositWhen: DepositWhen
  depositWaiveBelow: number
  materialMarkup: number
  revisionsIncl: number
  revisionHourly: number | null
  taxLabel: string
  taxPct: number
  /** ISO 4217, e.g. 'USD', 'EUR', 'GBP'. Set once in setup, never assumed. */
  currency: string
  /** BCP 47, e.g. 'en-US', 'de-DE'. Drives digit grouping and separators. */
  locale: string
  /**
   * What the shop's own utility charges, in $/kWh, straight off their bill.
   * Never looked up or assumed from location — electricity rates vary by
   * utility, not just region, and a wrong guess baked into someone's margin
   * is worse than an honest blank. Null until the shop supplies it; margin
   * falls back to treating machine time as break-even until they do.
   */
  electricityRateKwh: number | null
  /**
   * Overhead the shop pays whether or not a machine is running — rent,
   * insurance, software, internet, the building's own power. Allocated to
   * jobs per productive machine-hour, which is the standard way and the
   * only one that does not require inventing a number.
   *
   * Stored as the two figures an owner can actually answer rather than the
   * one they cannot: nobody knows their "overhead per hour", everybody can
   * add up a month of fixed bills and estimate the hours their machines
   * run on paid work. Null until supplied; the cost panel says so instead
   * of quietly costing overhead at zero.
   */
  overheadMonthly: number | null
  productiveHoursMonth: number | null
  /**
   * What share of machine-side cost is lost to plates that fail — warps,
   * clogs, shifts, power blips. A failed plate burns its material and its
   * hours twice and earns once, so a shop that leaves this out has moved
   * the loss somewhere it cannot see.
   *
   * It is a COST, never a surcharge: it changes what the shop knows it is
   * earning, not what the client is asked to pay. Null until supplied.
   */
  failurePct: number | null
}

export interface MaterialRef {
  id: string
  name: string
  unit: 'g' | 'ml'
  /** What the shop pays, per gram or per mL. Once purchases have been
   *  logged this is the weighted average of what was actually paid; until
   *  then it is the figure typed at setup. `costBasis` says which. */
  costPerUnit: number
  /** 'purchases' = measured from the purchase log, 'estimate' = typed by
   *  hand and never checked against a receipt. Screens that show a margin
   *  should say which one they are standing on. */
  costBasis?: 'purchases' | 'estimate'
  /** pins this material away from the shop-wide multiplier when set */
  sellOverride: number | null
  swatch: string
}

export interface PrinterRef {
  id: string
  name: string
  model: string
  ratePerHour: number
  wearPerHour: number
  /** Rated power draw while printing, in watts. Null until the shop measures
   *  or looks up the machine's spec — optional, same as everything else here. */
  watts: number | null
}

/** Exactly the fields on the intake screen. */
export interface QuoteInputs {
  assetOrigin: AssetOrigin
  designBilling: DesignBilling
  /** hours OR dollars — meaning is set by designBilling */
  designQty: number
  revisions: number
  quantity: number
  /** grams or millilitres, per part */
  unitsPerPart: number
  printHrsPerPart: number
  /** for the whole batch, not per part */
  finishingHrs: number
  rush: boolean
  /** above zero, prices by the piece and overrides the build lines entirely */
  flatEach: number
  discountPct: number
}

export interface QuoteLine {
  key: string
  label: string
  /** the arithmetic, shown to the client on the PDF and to the shop on screen */
  basis: string
  amount: number
}

export interface QuoteAdjustment {
  key: string
  label: string
  amount: number
  /** '+' adds, '-' subtracts — drives the sign and the colour */
  sign: '+' | '-'
  ink: string
}

export interface PricedQuote {
  lines: QuoteLine[]
  adjustments: QuoteAdjustment[]
  designAmt: number
  materialSell: number
  materialCost: number
  machineAmt: number
  wearAmt: number
  /** Actual power cost for the machine hours on this job — watts × hours ÷
   *  1000 × the shop's $/kWh. Zero when that data is not both set; see
   *  `costsIncomplete` to tell "genuinely free" from "not measured yet". */
  electricityCost: number
  /**
   * True when this job burned machine time but the shop hasn't supplied both
   * the printer's wattage and its own electricity rate. Margin still
   * computes — as the old break-even assumption, machine time costing
   * exactly what it's charged — but it is an estimate, not a real number,
   * and the UI should say so rather than imply precision that isn't there.
   */
  costsIncomplete: boolean
  finishingAmt: number
  pieceAmt: number
  byPiece: boolean
  needsDesign: boolean
  rawSubtotal: number
  subtotal: number
  minimumApplied: boolean
  rushAmt: number
  discountAmt: number
  preTax: number
  tax: number
  total: number
  perUnit: number
  deposit: number
  balance: number
  depositWaived: boolean
  /* --- owner-only, never shown to a client or printed on anything --- */
  /** Overhead allocated to this job's machine hours. Zero when the shop has
   *  not supplied both figures; `missingCosts` says which. */
  overheadCost: number
  /** The failure allowance on this job's machine-side costs. */
  failureCost: number
  /** Your own design and finishing hours, at the rate you charge for them. */
  yourHours: number
  /** Everything above added up: what this job costs the shop to deliver. */
  totalCost: number
  /** The price at which this job earns exactly nothing, before tax. Quote
   *  below this and the shop is paying to do the work. */
  breakEven: number
  /** What one piece costs to make. The figure a shop needs before agreeing
   *  to "and can you do fifty more". */
  costPerUnit: number
  margin: number
  marginPctOfTotal: number
  /**
   * Which cost inputs are not on file, so the panel can name them instead
   * of presenting an incomplete total as a complete one. Empty means every
   * cost in this quote is measured rather than assumed.
   */
  missingCosts: MissingCost[]
  qty: number
}

/** A cost Guma cannot compute yet, and the control that fixes it. */
export interface MissingCost {
  key: 'electricity' | 'overhead' | 'failure' | 'material'
  label: string
  /** Names the screen and field, in the shop's own words. */
  fix: string
}

/** cost × the shop-wide multiplier, unless this material pins its own price. */
export function sellPerUnit(material: MaterialRef, markup: number): number {
  return material.sellOverride != null ? material.sellOverride : material.costPerUnit * markup
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface MoneyFormat {
  /** Two decimals — every figure a client sees. */
  money: (n: number) => string
  /** Whole units — rates in hints and basis lines, where cents are noise. */
  money0: (n: number) => string
}

/**
 * Currency formatting is per-shop, never global. A shop in Berlin gets
 * "1.234,56 €" from the same code that gives a shop in Hilo "$1,234.56".
 * Falls back to plain grouped digits if a locale or currency is not
 * recognised, so a typo in setup degrades to something readable rather
 * than throwing in front of a client.
 */
export function makeMoney(currency: string, locale: string): MoneyFormat {
  let two: Intl.NumberFormat, zero: Intl.NumberFormat
  try {
    two = new Intl.NumberFormat(locale, {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    })
    zero = new Intl.NumberFormat(locale, {
      style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
    })
  } catch {
    // No currency style at all rather than someone else's currency: a number
    // with no symbol is obviously incomplete, a number with the wrong symbol
    // reads as a price.
    two = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    zero = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  }
  return {
    money: (n) => two.format(round2(n)),
    money0: (n) => zero.format(Math.round(n)),
  }
}

/**
 * Plain numbers on a quote's basis line ("740 g at ...", "21 h on ...") are
 * grouped and pointed the shop's own way, not one hard-coded region's: a
 * German quote reading "1.250 g" beside "1.250,00 €" is right, and the same
 * line reading "1,250 g" beside it is a bug the shop has to explain to a
 * client. Falls back to the runtime's locale rather than to en-US.
 */
const trimCache = new Map<string, { trimNum: (n: number) => string; trimPct: (n: number) => string }>()

const makeTrim = (locale: string) => {
  const hit = trimCache.get(locale)
  if (hit) return hit
  const fmt = (max: number) => {
    try {
      return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: max })
    } catch {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: max })
    }
  }
  const two = fmt(2)
  // Percentages carry three places — some jurisdictions levy e.g. 4.712%.
  const three = fmt(3)
  const made = {
    trimNum: (n: number) => two.format(Number(n.toFixed(2))),
    trimPct: (n: number) => three.format(Number(n.toFixed(3))),
  }
  trimCache.set(locale, made)
  return made
}

/** Standalone forms for screens that show a rate outside a priced quote.
 *  Pass the shop's locale; omitting it uses the machine's. */
export const trimNum = (n: number, locale = '') => makeTrim(locale).trimNum(n)
export const trimPct = (n: number, locale = '') => makeTrim(locale).trimPct(n)

export function priceQuote(
  input: QuoteInputs,
  rates: RateSet,
  material: MaterialRef | null,
  printer: PrinterRef | null,
): PricedQuote {
  const { money, money0 } = makeMoney(rates.currency, rates.locale)
  const { trimNum, trimPct } = makeTrim(rates.locale)
  const qty = Math.max(1, input.quantity || 1)
  const needsDesign = input.assetOrigin !== 'ready'

  // --- build lines ---------------------------------------------------------
  const designAmt = !needsDesign
    ? 0
    : input.designBilling === 'flat'
      ? input.designQty || 0
      : (input.designQty || 0) * rates.designHourly

  const unitSell = material ? sellPerUnit(material, rates.materialMarkup) : 0
  const unitCost = material ? material.costPerUnit : 0
  const totalUnits = (input.unitsPerPart || 0) * qty

  const materialSell = totalUnits * unitSell
  const materialCost = totalUnits * unitCost
  const machineHours = (input.printHrsPerPart || 0) * qty
  const machineAmt = machineHours * (printer ? printer.ratePerHour : 0)
  const wearAmt = machineHours * (printer ? printer.wearPerHour : 0)
  const finishingAmt = (input.finishingHrs || 0) * rates.finishingHourly
  const pieceAmt = (input.flatEach || 0) * qty
  const byPiece = (input.flatEach || 0) > 0

  const lines: QuoteLine[] = []
  if (needsDesign) {
    lines.push({
      key: 'design',
      label: input.designBilling === 'flat' ? 'Design — flat fee' : 'Design and modelling',
      basis:
        input.designBilling === 'flat'
          ? `agreed up front · ${input.revisions} revision rounds`
          : `${trimNum(input.designQty || 0)} h × ${money0(rates.designHourly)}/h · ${input.revisions} revisions`,
      amount: designAmt,
    })
  }
  if (byPiece) {
    lines.push({
      key: 'piece',
      label: 'Parts',
      basis: `${qty} × ${money(input.flatEach)} agreed per piece`,
      amount: pieceAmt,
    })
  } else {
    const perUnitLabel =
      material?.unit === 'g'
        ? `${money0(unitSell * 1000)}/kg`
        : `${money(unitSell)}/mL`
    lines.push({
      key: 'material',
      label: `Material — ${material ? material.name : 'not set'}`,
      basis: `${trimNum(totalUnits)} ${material?.unit === 'ml' ? 'mL' : 'g'} at ${perUnitLabel}`,
      amount: materialSell,
    })
    lines.push({
      key: 'machine',
      label: 'Machine time',
      basis: `${trimNum(machineHours)} h on ${printer ? printer.name : 'machine'} at ${money0(printer?.ratePerHour ?? 0)}/h`,
      amount: machineAmt,
    })
    lines.push({
      key: 'wear',
      label: 'Machine wear',
      basis: `${money0(printer?.wearPerHour ?? 0)}/h toward nozzles, belts, plates`,
      amount: wearAmt,
    })
    lines.push({
      key: 'finishing',
      label: 'Finishing',
      basis: `${trimNum(input.finishingHrs || 0)} h × ${money0(rates.finishingHourly)}/h`,
      amount: finishingAmt,
    })
  }

  // --- the order that matters ----------------------------------------------
  const rawSubtotal = designAmt + (byPiece ? pieceAmt : materialSell + machineAmt + wearAmt + finishingAmt)
  const minimumApplied = rawSubtotal < rates.minimumOrder
  const subtotal = minimumApplied ? rates.minimumOrder : rawSubtotal

  const rushAmt = input.rush ? (subtotal * rates.rushPct) / 100 : 0
  const discountAmt =
    (input.discountPct || 0) > 0 ? ((subtotal + rushAmt) * (input.discountPct || 0)) / 100 : 0
  const preTax = subtotal + rushAmt - discountAmt
  const tax = (preTax * rates.taxPct) / 100
  const total = preTax + tax

  const adjustments: QuoteAdjustment[] = []
  if (input.rush) {
    adjustments.push({
      key: 'rush',
      label: `Rush surcharge · ${trimPct(rates.rushPct)}%`,
      amount: rushAmt,
      sign: '+',
      ink: 'var(--warn)',
    })
  }
  if (discountAmt > 0) {
    adjustments.push({
      key: 'discount',
      label: `Discount · ${trimPct(input.discountPct)}%`,
      amount: discountAmt,
      sign: '-',
      ink: 'var(--ok)',
    })
  }
  adjustments.push({
    key: 'tax',
    label: `${rates.taxLabel} · ${trimPct(rates.taxPct)}%`,
    amount: tax,
    sign: '+',
    ink: 'var(--txt-2)',
  })

  // Deposit is a percentage of the FINAL total, tax included, waived below the
  // threshold — chasing $30 costs more than it collects.
  const depositWaived = rates.depositWhen === 'none' || total < rates.depositWaiveBelow
  const deposit = depositWaived ? 0 : round2((total * rates.depositPct) / 100)
  const balance = round2(total) - deposit

  // --- owner-only ----------------------------------------------------------
  // Your own hours are counted at the rate you charge, so margin is what is left
  // after paying yourself. A flat design fee is not counted as your hours: the
  // overrun is exactly the risk you took on by quoting flat.
  const yourHours =
    (needsDesign && input.designBilling === 'hourly' ? (input.designQty || 0) * rates.designHourly : 0) +
    (input.finishingHrs || 0) * rates.finishingHourly

  // Machine time actually costs the shop electricity, not whatever rate_hourly
  // happens to be — rate_hourly is a PRICE the shop chose, not a cost. Wear is
  // billed separately as its own reserve line and stays a straight cost either
  // way. Until both the printer's wattage and the shop's own $/kWh are on
  // file, there is no honest number to compute, so margin falls back to the
  // old, conservative assumption (machine time costs exactly what it's
  // charged) and `costsIncomplete` says so rather than presenting a guess as
  // fact.
  const needsElectricityData = !byPiece && machineHours > 0
  const hasElectricityData =
    needsElectricityData && printer?.watts != null && rates.electricityRateKwh != null
  const electricityCost = hasElectricityData
    ? machineHours * ((printer!.watts as number) / 1000) * (rates.electricityRateKwh as number)
    : 0
  const costsIncomplete = needsElectricityData && !hasElectricityData

  // Overhead per productive machine-hour: a month of fixed bills divided by
  // the machine-hours the shop actually bills in a month. Guarded against a
  // zero denominator, which would otherwise allocate the shop's entire rent
  // to one bracket.
  const overheadPerHour =
    rates.overheadMonthly != null &&
    rates.productiveHoursMonth != null &&
    rates.productiveHoursMonth > 0
      ? rates.overheadMonthly / rates.productiveHoursMonth
      : null
  const overheadCost = overheadPerHour != null ? machineHours * overheadPerHour : 0

  // The allowance applies to the MACHINE-side costs only. A failed plate
  // burns its filament, its power, its wear and its share of the rent a
  // second time; it does not usually make you model the part again, and
  // counting design hours twice would overstate the loss on exactly the
  // jobs where design dominates.
  const machineSideCost =
    materialCost + (hasElectricityData ? electricityCost : machineAmt) + wearAmt + overheadCost
  const failureCost =
    rates.failurePct != null && rates.failurePct > 0
      ? (machineSideCost * rates.failurePct) / 100
      : 0

  const totalCost = machineSideCost + failureCost + yourHours
  const margin = total - tax - totalCost

  // Every cost Guma cannot measure yet, named with the control that fixes
  // it. A total presented as complete when two of its lines are silently
  // zero is worse than no total: it reads as a margin the shop does not
  // have. Each `fix` names the screen and the field, in the shop's words.
  const missingCosts: MissingCost[] = []
  if (costsIncomplete) {
    missingCosts.push({
      key: 'electricity',
      label: 'Power for the machines',
      fix:
        printer?.watts == null
          ? `Set the wattage for ${printer ? printer.name : 'this printer'} under Shop settings → Machines.`
          : 'Set your electricity rate under Shop settings → Identity.',
    })
  }
  if (!byPiece && machineHours > 0 && overheadPerHour == null) {
    missingCosts.push({
      key: 'overhead',
      label: 'Rent, software and the rest',
      fix: 'Add your monthly overhead and your productive machine-hours under Shop settings → Cost of doing business.',
    })
  }
  if (!byPiece && rates.failurePct == null) {
    missingCosts.push({
      key: 'failure',
      label: 'Plates that fail',
      fix: 'Set a failure allowance under Shop settings → Cost of doing business.',
    })
  }
  if (material && material.costBasis === 'estimate' && materialCost > 0) {
    missingCosts.push({
      key: 'material',
      label: 'What the filament really cost',
      fix: `Log a spool purchase for ${material.name} under Shop settings → Materials — this is still the figure typed at setup.`,
    })
  }

  return {
    lines,
    adjustments,
    designAmt,
    materialSell,
    materialCost,
    machineAmt,
    wearAmt,
    electricityCost,
    costsIncomplete,
    overheadCost,
    failureCost,
    totalCost: round2(totalCost),
    breakEven: round2(totalCost),
    costPerUnit: round2(totalCost / qty),
    missingCosts,
    finishingAmt,
    pieceAmt,
    byPiece,
    needsDesign,
    rawSubtotal,
    subtotal,
    minimumApplied,
    rushAmt,
    discountAmt,
    preTax,
    tax,
    total,
    perUnit: total / qty,
    deposit,
    balance,
    depositWaived,
    yourHours,
    margin,
    marginPctOfTotal: total > 0 ? margin / total : 0,
    qty,
  }
}

/**
 * Frozen onto the `quotes` row at send time. A later rate change must never
 * alter a quote a client already holds, so the quote carries its own copy of
 * every number it was priced with — including the material and machine, which
 * can be edited or archived after the fact.
 */
export function buildRatesSnapshot(
  rates: RateSet,
  material: MaterialRef | null,
  printer: PrinterRef | null,
) {
  return {
    snapshot_version: 1,
    taken_at: new Date().toISOString(),
    rates,
    material: material
      ? {
          id: material.id,
          name: material.name,
          unit: material.unit,
          cost_per_unit: material.costPerUnit,
          sell_per_unit: sellPerUnit(material, rates.materialMarkup),
          swatch: material.swatch,
        }
      : null,
    printer: printer
      ? {
          id: printer.id,
          name: printer.name,
          model: printer.model,
          rate_hourly: printer.ratePerHour,
          wear_hourly: printer.wearPerHour,
          watts: printer.watts,
        }
      : null,
  }
}

export type RatesSnapshot = ReturnType<typeof buildRatesSnapshot>

/** Re-hydrate a sent quote from its own snapshot, never from today's rates. */
export function ratesFromSnapshot(snap: RatesSnapshot): {
  rates: RateSet
  material: MaterialRef | null
  printer: PrinterRef | null
} {
  return {
    rates: snap.rates,
    material: snap.material
      ? {
          id: snap.material.id,
          name: snap.material.name,
          unit: snap.material.unit,
          costPerUnit: snap.material.cost_per_unit,
          sellOverride: snap.material.sell_per_unit,
          swatch: snap.material.swatch,
        }
      : null,
    printer: snap.printer
      ? {
          id: snap.printer.id,
          name: snap.printer.name,
          model: snap.printer.model,
          ratePerHour: snap.printer.rate_hourly,
          wearPerHour: snap.printer.wear_hourly,
          // Older snapshots, sent before wattage existed, simply don't have
          // this key — undefined reads the same as "not measured" everywhere
          // costsIncomplete is checked.
          watts: (snap.printer as { watts?: number | null }).watts ?? null,
        }
      : null,
  }
}

export { round2 }
