/**
 * What this shop actually does, as opposed to what it believes it does.
 *
 * benchmarks.ts reports what other shops charge and derive.ts does
 * arithmetic on stated inputs. This module is the third and best kind of
 * suggestion, because it is neither a recommendation nor a projection: it
 * is the shop's own finished work, added up. A figure here cannot be
 * argued with on the grounds that "my market is different" — it IS their
 * market.
 *
 * It answers the questions a shop cannot answer from memory, and is
 * reliably wrong about when asked to guess:
 *
 *   - What does a job here actually bring in?
 *   - How many hours does one really take?
 *   - What does an hour of my time actually earn once the job is done?
 *   - Of what I quote, how much survives to the bottom?
 *   - How often does something get reprinted?
 *
 * Three rules keep it honest.
 *
 * ONLY FINISHED, MEASURED WORK COUNTS. A job with no recorded runs and no
 * logged hours has an actual cost of zero, which is not the same as having
 * been free. Those jobs are excluded, not counted as perfect margin. This
 * is the same distinction actuals.ts draws per project, applied across all
 * of them.
 *
 * MEDIANS, WITH A SPREAD. One catastrophic job or one dream client should
 * not move the number a shop sets its rates against, so nothing here is a
 * mean. And a single figure implies a precision that eight jobs cannot
 * support, so every statistic carries the middle half of the range with it.
 *
 * SILENCE UNTIL THERE IS SOMETHING TO SAY. Below MIN_SAMPLE finished jobs
 * this reports `enough: false` and the UI says so plainly rather than
 * drawing a confident conclusion from three data points. A shop's first
 * jobs are also its least typical.
 */
import type { JobListRow } from './data.types'

/** Finished, measured jobs needed before a figure is offered as guidance.
 *  Low enough to be reachable in a first season, high enough that one
 *  disaster cannot set the shop's rates. */
export const MIN_SAMPLE = 5

export interface HistoryStat {
  /** How many finished jobs are behind this figure. */
  n: number
  median: number
  /** 25th percentile — the low end of the middle half. */
  low: number
  /** 75th percentile — the high end of the middle half. */
  high: number
}

export interface ShopHistory {
  /** Jobs that were finished AND had something recorded against them. */
  counted: number
  /** Jobs that reached delivered but had nothing recorded, so could not be
   *  counted. Worth surfacing: it is the size of the shop's blind spot. */
  unmeasured: number
  /** True once there is enough finished work to say anything. */
  enough: boolean
  /** What a job is worth here, before tax. */
  jobValue: HistoryStat | null
  /** Hours logged against a job — design, finishing and admin together. */
  hoursPerJob: HistoryStat | null
  /** Job value ÷ hours logged. What an hour of being in this business
   *  actually returns, all-in, which is almost never the design rate. */
  revenuePerHour: HistoryStat | null
  /** (value − recorded cost) ÷ value, as a percentage. */
  realizedMarginPct: HistoryStat | null
  /** Share of counted jobs that had anything sent back, 0..1. */
  reprintRate: number | null
}

/** A finished job reduced to the five numbers this module reasons about. */
interface Measured {
  value: number
  cost: number
  hours: number
  reprints: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** null rather than a statistic when there is nothing to describe. */
function stat(values: number[]): HistoryStat | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    low: percentile(sorted, 0.25),
    high: percentile(sorted, 0.75),
  }
}

/**
 * Which jobs are allowed to speak.
 *
 * Delivered, sold for a real amount, and with something actually recorded
 * against them. The third condition is the one that matters: without it
 * every unmeasured job reports 100% margin and the shop's history becomes
 * a congratulation rather than a measurement.
 */
function measured(rows: JobListRow[]): { kept: Measured[]; unmeasured: number } {
  const kept: Measured[] = []
  let unmeasured = 0

  for (const r of rows) {
    if (r.phase !== 'delivered') continue
    const value = r.facts.quoteTotal ?? r.total ?? 0
    if (!(value > 0)) continue
    if (!r.facts.hasActuals) {
      unmeasured += 1
      continue
    }
    kept.push({
      value,
      cost: r.facts.actualCost,
      hours: r.facts.actualHours,
      reprints: r.facts.reprintsEver,
    })
  }

  return { kept, unmeasured }
}

/**
 * Fold a shop's job list into what it says about the shop. Pure: no clock,
 * no database, no rounding beyond what the arithmetic produces.
 */
export function summarizeHistory(rows: JobListRow[]): ShopHistory {
  const { kept, unmeasured } = measured(rows)

  if (kept.length === 0) {
    return {
      counted: 0,
      unmeasured,
      enough: false,
      jobValue: null,
      hoursPerJob: null,
      revenuePerHour: null,
      realizedMarginPct: null,
      reprintRate: null,
    }
  }

  // Hours are only in the denominator when they exist. A delivered job with
  // material recorded but no logged hours is real, and belongs in the margin
  // and value figures -- it just cannot say anything about an hourly return.
  const withHours = kept.filter((k) => k.hours > 0)

  return {
    counted: kept.length,
    unmeasured,
    enough: kept.length >= MIN_SAMPLE,
    jobValue: stat(kept.map((k) => k.value)),
    hoursPerJob: stat(withHours.map((k) => k.hours)),
    revenuePerHour: stat(withHours.map((k) => k.value / k.hours)),
    realizedMarginPct: stat(kept.map((k) => ((k.value - k.cost) / k.value) * 100)),
    reprintRate: kept.filter((k) => k.reprints > 0).length / kept.length,
  }
}

/**
 * The sentence to put under a rate field, or null when history has nothing
 * to add. Deliberately reports rather than advises: it states what the
 * shop's own finished work returned per hour and leaves the comparison to
 * the person, who knows things about their market that Guma does not.
 */
export function hourlyReality(h: ShopHistory): string | null {
  if (!h.enough || !h.revenuePerHour) return null
  const r = h.revenuePerHour
  return (
    `Across your last ${r.n} delivered jobs, an hour logged against a job ` +
    `returned a median of ${r.median.toFixed(2)} in revenue ` +
    `(middle half: ${r.low.toFixed(2)} to ${r.high.toFixed(2)}). ` +
    `That is everything the job earned over every hour you put into it, ` +
    `not what you bill for design alone.`
  )
}
