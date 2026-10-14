/**
 * The profit side: what was made, what sold, and what was actually kept.
 *
 * Pure, like actuals.ts, history.ts and unbilled.ts -- rows in, numbers
 * out, no clock and no database. That is what lets a screen, a check and a
 * test all read one answer instead of three that drift.
 *
 * Three things here are deliberately not what a shop expects, and each one
 * is the difference between a flattering number and a true one.
 *
 * THE FEE IS PART OF THE PRICE. A $12 keychain sold on Etsy is not $12 of
 * revenue. Etsy takes 6.5% plus 3% + $0.25 processing plus $0.20 to list --
 * roughly a tenth, and more than most sellers think. Guma subtracts it
 * before it says "profit", because a profit figure that ignores the
 * platform's cut is wrong in the direction that feels best.
 *
 * COST FOLLOWS THE UNIT THAT SOLD, NOT THE UNIT THAT WAS MADE. Making two
 * hundred and selling twelve is not a loss of a hundred and eighty units'
 * worth; it is twelve units of profit and a shelf full of money that has
 * not come back yet. Those are different problems with different answers,
 * so they are reported as different numbers.
 *
 * DESIGN IS A PAYBACK, NOT A PER-UNIT COST. See 0014_selling.sql for why.
 * The evening spent designing the thing is either recovered or it is not,
 * and smearing it across a per-unit figure that has to keep changing as
 * more units are made would quietly rewrite what last month cost.
 */

export interface Channel {
  id: string
  name: string
  feePct: number
  feeFlat: number
}

export interface BatchStock {
  batchId: string
  productId: string
  unitsMade: number
  unitsSold: number
  unitsLeft: number
  /** Production cost of ONE unit, frozen when the batch was made. */
  unitCost: number
  revenue: number
  fees: number
  /** unitCost x unitsSold. */
  costOfSold: number
  madeOn: string
}

export interface ProductResult {
  productId: string
  name: string
  unitsMade: number
  unitsSold: number
  unitsLeft: number
  revenue: number
  fees: number
  costOfSold: number
  /** revenue - fees - costOfSold. What the selling actually produced. */
  grossProfit: number
  /** What is still on the shelf, at what it cost to make. Money out that
   *  has not come back. */
  stockAtCost: number
  /** The design investment, if it was tracked. */
  designCost: number | null
  /** Gross profit as a share of the design investment, 0..1+, or null when
   *  there was no tracked design cost. 1 means it has just paid for itself. */
  designRecovered: number | null
  /** True once gross profit covers the design. */
  designPaidBack: boolean
}

/**
 * What a channel takes out of a sale.
 *
 * Percentage first, then the flat part, which is how every marketplace
 * actually charges: Etsy's listing fee and payment-processing flat both
 * apply per transaction regardless of size, which is why a fee that looks
 * like 10% on a $50 sale is nearer 15% on a $5 one. A shop selling cheap
 * things through an expensive channel deserves to see that.
 */
export function feeFor(channel: Channel | null, units: number, unitPrice: number): number {
  if (!channel) return 0
  const gross = units * unitPrice
  return round2(gross * (channel.feePct / 100) + channel.feeFlat)
}

/** What the shop keeps from one sale, before the cost of making it. */
export function netOfFees(channel: Channel | null, units: number, unitPrice: number): number {
  return round2(units * unitPrice - feeFor(channel, units, unitPrice))
}

/**
 * The real margin on one unit through one channel, as a fraction.
 *
 * Null when the price is zero -- a giveaway has no margin, it has a cost,
 * and dividing by nothing to say so would be worse than silence.
 */
export function unitMargin(
  channel: Channel | null,
  unitPrice: number,
  unitCost: number,
): number | null {
  if (!(unitPrice > 0)) return null
  const kept = netOfFees(channel, 1, unitPrice)
  return (kept - unitCost) / unitPrice
}

/**
 * Fold a product's batches into what the product has actually done.
 *
 * `designCost` is passed separately because it lives on the product, not on
 * any batch, and is reported as a payback rather than folded into cost.
 */
export function productResult(
  product: { id: string; name: string; designCost: number | null },
  batches: BatchStock[],
): ProductResult {
  const mine = batches.filter((b) => b.productId === product.id)

  const unitsMade = sum(mine.map((b) => b.unitsMade))
  const unitsSold = sum(mine.map((b) => b.unitsSold))
  const revenue = round2(sum(mine.map((b) => b.revenue)))
  const fees = round2(sum(mine.map((b) => b.fees)))
  const costOfSold = round2(sum(mine.map((b) => b.costOfSold)))
  const grossProfit = round2(revenue - fees - costOfSold)
  const stockAtCost = round2(sum(mine.map((b) => b.unitsLeft * b.unitCost)))

  const designCost = product.designCost
  const designRecovered =
    designCost !== null && designCost > 0 ? grossProfit / designCost : null

  return {
    productId: product.id,
    name: product.name,
    unitsMade,
    unitsSold,
    unitsLeft: unitsMade - unitsSold,
    revenue,
    fees,
    costOfSold,
    grossProfit,
    stockAtCost,
    designCost,
    designRecovered,
    designPaidBack: designRecovered !== null && designRecovered >= 1,
  }
}

export interface SellingSummary {
  products: number
  unitsMade: number
  unitsSold: number
  revenue: number
  fees: number
  costOfSold: number
  grossProfit: number
  /** Everything unsold, at what it cost to make. The shelf. */
  stockAtCost: number
  /** Design investment not yet recovered, across every product. */
  designOutstanding: number
}

/** Every product added up, for the one line at the top of a screen. */
export function summarize(results: ProductResult[]): SellingSummary {
  return {
    products: results.length,
    unitsMade: sum(results.map((r) => r.unitsMade)),
    unitsSold: sum(results.map((r) => r.unitsSold)),
    revenue: round2(sum(results.map((r) => r.revenue))),
    fees: round2(sum(results.map((r) => r.fees))),
    costOfSold: round2(sum(results.map((r) => r.costOfSold))),
    grossProfit: round2(sum(results.map((r) => r.grossProfit))),
    stockAtCost: round2(sum(results.map((r) => r.stockAtCost))),
    designOutstanding: round2(
      sum(
        results.map((r) =>
          r.designCost === null ? 0 : Math.max(0, r.designCost - r.grossProfit),
        ),
      ),
    ),
  }
}

/**
 * Etsy's published US fees, as one channel's numbers.
 *
 * Offsite ads are deliberately NOT in here. They are 15% (or 12% over $10k
 * of annual sales) and they apply only to sales that came through an ad, so
 * folding them into every sale would overstate the cut on most of them.
 * A shop that gets a lot of ad-driven sales should say so separately.
 */
export const ETSY_US = {
  name: 'Etsy',
  /** 6.5% transaction + 3% payment processing. */
  feePct: 9.5,
  /** $0.20 listing + $0.25 processing. */
  feeFlat: 0.45,
  source: 'Etsy published seller fees, US',
  asOf: '2026',
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Splitting what an in-house job cost into the two halves that belong in
 * different places.
 *
 * A job's recorded cost is one number: material, machine, wear, and every
 * hour logged against it. But design and production do not behave the same
 * way. The filament and the machine hours went into THESE units and belong
 * on the batch, frozen. The evening spent modelling it went into the
 * DESIGN, and belongs to the product however many batches follow.
 *
 * Putting design in both places is the bug this function exists to stop:
 * the unit cost would carry it, the payback would count it again, and the
 * shop would be told the thing costs more than it does while also being
 * told it has recovered less than it has.
 */
export interface JobCostSplit {
  /** Material, machine, wear and the hands-on hours that made these units. */
  production: number
  /** The design hours, at the rate in force. Belongs to the product. */
  design: number
}

export function splitJobCost(
  job: { actualCost: number; designHours: number },
  designHourly: number,
): JobCostSplit {
  const design = round2(Math.max(0, job.designHours) * Math.max(0, designHourly))
  return {
    // Never below zero: a job whose only recorded cost IS design hours has
    // no production cost, not a negative one.
    production: round2(Math.max(0, job.actualCost - design)),
    design,
  }
}

/** What one unit cost to produce. Zero units is not a division. */
export function unitCostFrom(split: JobCostSplit, units: number): number {
  if (!(units > 0)) return 0
  // Unrounded: $1.20 over 250 units is $0.0048 each, and rounding to
  // cents stored it as $0.00 -- free stock. Screens round for display.
  return Math.round((split.production / units) * 1e6) / 1e6
}

/**
 * The production cost not yet carried onto the shelf (CG, 13 Oct: a piece
 * sits in Working for months, putting batches on the shelf as they come
 * off). Each batch takes what was logged since the one before -- never the
 * whole job's cost again, which made a second batch pay for the first.
 */
export function unshelvedProduction(
  split: JobCostSplit,
  batches: { unitsMade: number; unitCost: number }[],
): number {
  const shelved = batches.reduce((a, b) => a + Math.max(0, b.unitsMade) * Math.max(0, b.unitCost), 0)
  return round2(Math.max(0, split.production - shelved))
}
