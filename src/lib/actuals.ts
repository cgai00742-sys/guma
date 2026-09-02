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
import type { PricedQuote, RateSet } from './pricing'
import type { ProjectActuals } from './data.types'

export interface VarianceLine {
  key: 'material' | 'machine' | 'wear' | 'labour'
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
  return q.costsIncomplete ? q.machineAmt : q.electricityCost
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
          (actuals.powerCost > 0 ? '' : ' — no wattage or $/kWh on file, so this is the rate you charge, not what it cost')
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
            actuals.designHours > 0 ? `${actuals.designHours}h design` : null,
            actuals.finishingHours > 0 ? `${actuals.finishingHours}h finishing` : null,
            actuals.adminHours > 0 ? `${actuals.adminHours}h admin` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : 'No hours logged yet',
    },
  ]

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
    quotedMargin: round2(quoted.margin),
    actualMargin: actualCost === null ? null : round2(netRevenue - actualCost),
    actualMarginPct:
      actualCost === null || netRevenue <= 0 ? null : (netRevenue - actualCost) / netRevenue,
    hasActuals,
    partial: hasActuals && recorded.length < lines.length,
  }
}
