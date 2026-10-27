/**
 * Quoted against actual — the comparison a shop only ever makes in hindsight,
 * usually by feel, usually wrong.
 *
 * Guma already knows both halves. The quote's cost basis is frozen in
 * rates_snapshot at send (the same idea as Voltage's quoted_cost column),
 * and job_actuals folds every recorded run and work entry into what the job
 * really consumed. This module is the arithmetic between them, and nothing
 * else: it is pure, it takes a clock from nobody, and it never touches a
 * database — so the numbers can be tested against fixtures rather than
 * against a screenshot.
 *
 * One rule runs through all of it: where the actual side has no data, the
 * line says "not recorded" rather than quietly reading zero. A zero looks
 * like "this cost nothing", which is the single most flattering lie an
 * unfinished cost report can tell.
 */
import {
  priceQuote,
  ratesFromSnapshot,
  type MaterialRef,
  type PricedQuote,
  type PrinterRef,
  type RatesSnapshot,
  type RateSet,
} from './pricing'
import { toRateSet, type QuoteBuildInput, type ProjectActuals, type ProjectDetail, type RateCardRow, type Shop } from './data.types'
import { fmtHours } from './duration'

export interface VarianceLine {
  key: 'material' | 'machine' | 'wear' | 'labour' | 'equipment' | 'hardware'
  label: string
  quoted: number
  /** null when nothing has been recorded for this line yet. */
  actual: number | null
  /** actual − quoted. Positive means it cost more than planned. */
  delta: number | null
  /** delta as a share of quoted; null when quoted is zero or nothing is recorded. */
  pct: number | null
  /** What the actual figure is made of, in words. */
  detail: string
}

export interface Comparison {
  lines: VarianceLine[]
  quotedCost: number
  /** null until at least one run or work entry exists. */
  actualCost: number | null
  /** What the client pays, tax excluded — the top of the margin sum. */
  netRevenue: number
  quotedMargin: number
  actualMargin: number | null
  actualMarginPct: number | null
  /** True once anything at all has been recorded against the project. */
  hasActuals: boolean
  /** True when SOME lines are recorded and others are not, so the actual
   *  total is a floor rather than a figure. */
  partial: boolean
}

/**
 * Machine time costs a shop electricity, not the rate it charges for it —
 * pricing.ts's own reasoning, applied to the actual side so the two halves
 * are compared on the same terms. Power cost is used when the printer's
 * wattage and the shop's $/kWh are both on file; otherwise the printer's
 * hourly rate stands in, which is the same conservative fallback the quote
 * makes.
 */
function actualMachineCost(a: ProjectActuals): number {
  return a.powerCost > 0 ? a.powerCost : a.machineCost
}

function quotedMachineCost(q: PricedQuote): number {
  return q.machineCost
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * @param quoted  the quote repriced from its own frozen snapshot
 * @param actuals the job_actuals row
 * @param rates   the rate set the quote was priced under, for labour rates
 * @param unit    'g' or 'ml', for the material detail line
 */
export function compareToQuote(
  quoted: PricedQuote,
  actuals: ProjectActuals,
  rates: RateSet,
  unit: 'g' | 'ml' = 'g',
): Comparison {
  const anyRuns = actuals.runs > 0
  const anyWork = actuals.designHours + actuals.finishingHours + actuals.adminHours > 0

  // Admin hours are counted at the finishing rate. They are shop time
  // whatever they are called, and leaving them out would flatter the margin
  // — which is the exact failure this whole comparison exists to catch.
  const actualLabour =
    actuals.designHours * rates.designHourly +
    (actuals.finishingHours + actuals.adminHours) * rates.finishingHourly

  const lines: VarianceLine[] = [
    {
      key: 'material',
      label: 'Material',
      quoted: round2(quoted.materialCost),
      actual: anyRuns ? round2(actuals.materialCost) : null,
      delta: null,
      pct: null,
      detail: anyRuns
        ? `${actuals.materialUnits.toLocaleString()}${unit} across ${actuals.runs} run${actuals.runs === 1 ? '' : 's'}` +
          (actuals.failedUnits > 0
            ? `, of which ${actuals.failedUnits.toLocaleString()}${unit} went into ${actuals.failedRuns} that failed`
            : '')
        : 'No runs recorded yet',
    },
    {
      key: 'machine',
      label: quoted.costsIncomplete ? 'Machine time (at your rate)' : 'Power for the machines',
      quoted: round2(quotedMachineCost(quoted)),
      actual: anyRuns ? round2(actualMachineCost(actuals)) : null,
      delta: null,
      pct: null,
      detail: anyRuns
        ? `${actuals.machineHours} machine hour${actuals.machineHours === 1 ? '' : 's'}` +
          (actuals.powerCost > 0 ? '' : ' — no wattage or electricity rate on file, so this is the rate you charge, not what it cost')
        : 'No runs recorded yet',
    },
    {
      key: 'wear',
      label: 'Machine wear',
      quoted: round2(quoted.wearAmt),
      actual: anyRuns ? round2(actuals.wearCost) : null,
      delta: null,
      pct: null,
      detail: anyRuns ? 'Set aside against the next service' : 'No runs recorded yet',
    },
    {
      key: 'labour',
      label: 'Your hours',
      quoted: round2(quoted.yourHours),
      actual: anyWork ? round2(actualLabour) : null,
      delta: null,
      pct: null,
      detail: anyWork
        ? [
            actuals.designHours > 0 ? `${fmtHours(actuals.designHours)} design` : null,
            actuals.finishingHours > 0 ? `${fmtHours(actuals.finishingHours)} finishing` : null,
            actuals.adminHours > 0 ? `${fmtHours(actuals.adminHours)} admin` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : 'No hours logged yet',
    },
  ]

  // Equipment that is not a printer, and hardware (0043). Only shown once
  // something was recorded: a quote has no line for them yet (step 2), and
  // a row that reads "—" for every project would be noise, not a warning.
  const base = lines.length
  const eqCost = actuals.equipmentCost ?? 0
  if (eqCost > 0)
    lines.push({
      key: 'equipment',
      label: 'Other equipment',
      quoted: 0,
      actual: round2(eqCost),
      delta: null,
      pct: null,
      detail:
        (actuals.equipmentHours ?? 0) > 0
          ? `${fmtHours(actuals.equipmentHours ?? 0)} logged, plus any riding along with print hours`
          : 'Riding along with print hours',
    })
  const hwCost = actuals.hardwareCost ?? 0
  if (hwCost > 0)
    lines.push({
      key: 'hardware',
      label: 'Hardware',
      quoted: 0,
      actual: round2(hwCost),
      delta: null,
      pct: null,
      detail: 'Magnets, inserts and other pieces used',
    })

  for (const l of lines) {
    if (l.actual === null) continue
    l.delta = round2(l.actual - l.quoted)
    l.pct = l.quoted > 0 ? l.delta / l.quoted : null
  }

  const recorded = lines.filter((l) => l.actual !== null)
  const hasActuals = recorded.length > 0
  const actualCost = hasActuals ? round2(recorded.reduce((n, l) => n + (l.actual ?? 0), 0)) : null

  // Tax is collected on behalf of a government, not earned, so it never
  // belongs in a margin. Same treatment as pricing.ts's own margin line.
  const netRevenue = round2(quoted.total - quoted.tax)
  const quotedCost = round2(lines.reduce((n, l) => n + l.quoted, 0))

  return {
    lines,
    quotedCost,
    actualCost,
    netRevenue,
    // Like for like with actualMargin below: the same four lines on both
    // sides. priced.margin also takes off overhead and the failure
    // allowance, which no recorded run carries -- comparing the two made a
    // job that cost exactly what was quoted read as $120 better than quoted.
    quotedMargin: round2(netRevenue - quotedCost),
    actualMargin: actualCost === null ? null : round2(netRevenue - actualCost),
    actualMarginPct:
      actualCost === null || netRevenue <= 0 ? null : (netRevenue - actualCost) / netRevenue,
    hasActuals,
    // Over the four lines every project has: equipment and hardware are
    // only listed when recorded, so they can never make a total partial.
    partial: hasActuals && lines.slice(0, base).filter((l) => l.actual !== null).length < base,
  }
}

/** Just the bits of ShopContext this needs, so a test can hand it four
 *  values rather than assembling a whole context. */
export interface PricingContext {
  rateCard: RateCardRow
  shop: Shop
  materials: MaterialRef[]
  printers: PrinterRef[]
}

/**
 * Reprice a project's quote from its own frozen snapshot and compare it to
 * what was actually recorded. Returns null when there is nothing to compare
 * — no quote, or a snapshot this build can no longer read.
 *
 * A draft quote has no snapshot, so it falls back to today's rates. That is
 * correct rather than a compromise: a draft has not been given to anyone,
 * so there is no promise to hold it to.
 *
 * This lives here rather than in the project screen because it is pure
 * logic that merely happens to run during a render — and because it was the
 * one piece of new code most likely to throw (JSON round-trip, a rehydrated
 * snapshot from an older schema, priceQuote with a printer that has since
 * been deleted) and the one piece with no test around it. The catch below
 * keeps a bad snapshot from blanking the page, which is the same failure
 * the quote PDF had; the tests make sure the catch is a backstop rather
 * than the normal path.
 */
export function buildComparison(detail: ProjectDetail, ctx: PricingContext): Comparison | null {
  const p = priceProjectQuote(detail, ctx)
  if (!p) return null
  try {
    return compareToQuote(p.priced, detail.actuals, p.rates, p.unit)
  } catch {
    return null
  }
}

/**
 * The project's quote, priced -- at its frozen rates when it has them, at
 * today's when it is a draft. `override` swaps the build lines and copies
 * for another set (the build sheet as it stands now) while every other
 * term of the quote -- design, finishing, rush, discount -- stays as agreed.
 */
export function priceProjectQuote(
  detail: ProjectDetail,
  ctx: PricingContext,
  override?: { builds: QuoteBuildInput[]; quantity: number },
): { priced: PricedQuote; rates: RateSet; unit: 'g' | 'ml' } | null {
  const q = detail.quoteInputs
  if (!q) return null
  try {
    const snap = q.ratesSnapshot as RatesSnapshot | null
    const basis = snap
      ? ratesFromSnapshot(snap)
      : {
          rates: toRateSet(ctx.rateCard, ctx.shop),
          material: ctx.materials.find((m) => m.id === q.materialId) ?? null,
          printer: ctx.printers.find((p) => p.id === q.printerId) ?? null,
          fleet: null,
        }
    const builds = override ? override.builds : (q.builds ?? [])
    // Build lines price at the machines and spools frozen with the quote; a
    // line added since (a new part, sliced for another machine) prices at
    // today's figures for that machine, because there is no frozen one.
    const frozen = basis.fleet
    const fleet = frozen
      ? {
          materials: [...frozen.materials, ...ctx.materials.filter((m) => !frozen.materials.some((f) => f.id === m.id))],
          printers: [...frozen.printers, ...ctx.printers.filter((p) => !frozen.printers.some((f) => f.id === p.id))],
        }
      : { materials: ctx.materials, printers: ctx.printers }
    const priced = priceQuote(
      {
        assetOrigin: detail.assetOrigin,
        designBilling: q.designBilling === 'none' ? 'hourly' : q.designBilling,
        designQty: q.designQty,
        revisions: q.revisionsIncl,
        quantity: override ? override.quantity : q.quantity,
        unitsPerPart: q.unitsPerPart,
        printHrsPerPart: q.printHrsPart,
        finishingHrs: q.finishingHrs,
        rush: q.rush,
        flatEach: q.flatEach,
        discountPct: q.discountPct,
        builds: builds.map((b, i) => ({
          key: (b as { id?: string }).id ?? String(i),
          label: b.label,
          printerId: b.printerId,
          materialId: b.materialId,
          qty: b.qty,
          unitsPerPart: b.unitsPerPart,
          printHrsPerPart: b.printHrsPerPart,
        })),
      },
      basis.rates,
      basis.material,
      basis.printer,
      fleet,
    )
    return { priced, rates: basis.rates, unit: basis.material?.unit ?? 'g' }
  } catch {
    // A snapshot from an older schema, or a quote whose material was
    // deleted. Better to show no figure than a wrong one.
    return null
  }
}
