/**
 * The hours nobody paid for.
 *
 * Every shop using this spends a real share of its week on work with no
 * client attached: test prints, calibration, a material that would not
 * stick, samples for a pitch, designing something to sell itself. None of
 * it was visible to Guma before 0012_in_house.sql, and the consequence was
 * not a gap but a flattery — a shop reading margins on client jobs alone
 * sees healthy numbers on every one of them while the business loses money
 * on the third of its capacity that was never billed.
 *
 * This module is the arithmetic that fixes that. It is pure, like
 * actuals.ts and history.ts: job rows in, numbers out, no clock and no
 * database.
 *
 * THE ONE THAT MATTERS IS THE RATIO.
 *
 * derive.ts turns an hourly rate into a year by assuming twenty billable
 * hours in a forty-hour week. That assumption is doing enormous work — it
 * is the difference between "$50/hr is $104,000 a year" and "$50/hr is
 * $48,000 a year" — and it was a guess, because Guma had no way to know. It
 * still ships as the fallback, because a shop with no history has to start
 * somewhere. But once in-house work is logged the ratio is MEASURED, and
 * the rate guidance stops guessing about the single number it was least
 * equipped to guess about.
 *
 * A shop that discovers it bills nine hours in forty has not found a bug.
 * It has found the reason it is busy and broke.
 */
import type { JobListRow } from './data.types'

export interface Unbilled {
  /** Hours logged against client work. */
  billedHours: number
  /** Hours logged against the shop's own work. */
  unbilledHours: number
  totalHours: number
  /**
   * Billed hours as a share of all logged hours, 0..1. Null when nothing
   * has been logged at all — which is "we cannot know" and must never be
   * read as 1.0, or a shop with no data would be told every hour it works
   * is billable.
   */
  billableRatio: number | null
  /** What the shop's own work consumed, at the same cost basis client jobs
   *  are measured on: material, machine, wear and logged hours at rate. */
  unbilledCost: number
  /** In-house jobs counted. */
  unbilledJobs: number
  /** Material units drawn by in-house work. */
  unbilledMaterialUnits: number
  /** Units lost to runs that failed, across ALL work. Shrinkage. */
  failedUnits: number
  /** Machine hours run on in-house work. These wear the machine exactly
   *  like billed hours do, and belong in its lifetime usage. */
  unbilledMachineHours: number
}

/** Anything below this and the ratio is an anecdote, not a measurement. */
export const MIN_HOURS = 20

const hours = (r: JobListRow) => r.facts.actualHours
const isInHouse = (r: JobListRow) => r.facts.kind === 'inhouse'

/**
 * Fold a shop's jobs into what its unbilled work costs it.
 *
 * Counts every job with anything recorded against it, at any phase: an
 * in-house experiment abandoned half way still burned the material and the
 * afternoon, and waiting for it to reach 'delivered' would simply hide the
 * worst cases. This is the deliberate difference from history.ts, which
 * only counts finished work because it is measuring outcomes rather than
 * consumption.
 */
export function summarizeUnbilled(rows: JobListRow[]): Unbilled {
  let billedHours = 0
  let unbilledHours = 0
  let unbilledCost = 0
  let unbilledJobs = 0
  let unbilledMaterialUnits = 0
  let unbilledMachineHours = 0
  let failedUnits = 0

  for (const r of rows) {
    failedUnits += r.facts.failedUnits ?? 0
    if (isInHouse(r)) {
      unbilledJobs += 1
      unbilledHours += hours(r)
      unbilledCost += r.facts.actualCost
      unbilledMaterialUnits += r.facts.materialUnits ?? 0
      unbilledMachineHours += r.facts.machineHours ?? 0
    } else {
      billedHours += hours(r)
    }
  }

  const totalHours = billedHours + unbilledHours
  return {
    billedHours,
    unbilledHours,
    totalHours,
    billableRatio: totalHours > 0 ? billedHours / totalHours : null,
    unbilledCost,
    unbilledJobs,
    unbilledMaterialUnits,
    unbilledMachineHours,
    failedUnits,
  }
}

/** True once there are enough logged hours for the ratio to mean anything. */
export function ratioIsMeasured(u: Unbilled): boolean {
  return u.billableRatio !== null && u.totalHours >= MIN_HOURS
}

/**
 * Billable hours in a working week, measured where possible.
 *
 * Returns null rather than a number when the shop has not logged enough for
 * the ratio to be real, so the caller falls back to derive.ts's stated
 * assumption instead of quietly presenting a guess as a measurement. The
 * distinction is the whole point: a shop shown "your measured ratio" wants
 * that to be true.
 */
export function measuredBillableHours(
  u: Unbilled,
  hoursWorkedPerWeek = 40,
): number | null {
  if (!ratioIsMeasured(u)) return null
  return u.billableRatio! * hoursWorkedPerWeek
}

/**
 * What an hour of billed work has to earn to cover an hour of unbilled
 * work alongside it.
 *
 * If a third of the week is unbilled, every billed hour is carrying half an
 * unbilled one, and a rate set as though that were not true is short by
 * exactly that much. Null when the ratio is not measured, or when a shop
 * has somehow billed everything.
 */
export function unbilledLoad(u: Unbilled): number | null {
  if (!ratioIsMeasured(u) || u.billedHours === 0) return null
  return u.unbilledHours / u.billedHours
}
