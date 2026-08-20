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
}

export interface MaterialRef {
  id: string
  name: string
  unit: 'g' | 'ml'
  /** what the shop pays, per gram or per mL */
  costPerUnit: number
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
  /** owner-only: never shown to a client */
  yourHours: number
  margin: number
  marginPctOfTotal: number
  qty: number
}

/** cost × the shop-wide multiplier, unless this material pins its own price. */
export function sellPerUnit(material: MaterialRef, markup: number): number {
  return material.sellOverride != null ? material.sellOverride : material.costPerUnit * markup
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

const money = (n: number) =>
  '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const trimNum = (n: number) =>
  Number(n.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 })
/** Percentages need three places — Maui's GET pass-on rate is 4.712%. */
const trimPct = (n: number) =>
  Number(n.toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 })

export function priceQuote(
  input: QuoteInputs,
  rates: RateSet,
  material: MaterialRef | null,
  printer: PrinterRef | null,
): PricedQuote {
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
  const margin = total - tax - materialCost - machineAmt - wearAmt - yourHours

  return {
    lines,
    adjustments,
    designAmt,
    materialSell,
    materialCost,
    machineAmt,
    wearAmt,
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
        }
      : null,
  }
}

export { money, money0, round2, trimNum, trimPct }
