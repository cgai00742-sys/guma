/**
 * When printing has to start for this to arrive on time.
 *
 * Voltage's most useful single number, and the one Guma was missing. A due
 * date tells you nothing you can act on today: "needed 12 October" and
 * "start printing by 3 October" are the same fact, but only the second one
 * makes you walk over to a machine. Everything before the start date is
 * slack; everything after it is a late delivery that nobody has noticed
 * yet.
 *
 * WHAT THIS IS NOT. It is not a scheduler and does not look at what the
 * fleet is already doing -- Voltage called that Phase C and never built
 * it either. It works backwards from the delivery date through the work
 * this project itself needs. A second project needing the same machine on
 * the same day is a conflict this cannot see, which is why the answer is
 * shown as a date to beat rather than a promise.
 *
 * HONEST ABOUT ASSUMPTIONS. Three numbers here are not measured:
 * how many hours a machine runs in a day, how long a day of finishing is,
 * and how much slack to keep. Guma's standing rule is never to pre-fill a
 * field with a guess -- but this is not a field, it is a derived estimate,
 * and an estimate that hides its assumptions is the actual danger. So each
 * one is a named constant, stated in the sentence the screen prints, and
 * every figure it produced can be traced back to them. They become shop
 * settings the first time a real shop disagrees with one.
 */
import { daysBetweenLocal, parseStored, toISODate } from './dates'
import { fmtHours } from './duration'
import { chosenVariant } from './parts'
import { countsOf, statesOf } from './copies'
import type { PartRow, QuoteInputsRow } from './data.types'

/** A printer left running overnight is normal in a small shop, but not
 *  24 hours: someone has to clear the plate and start the next one. */
export const MACHINE_HOURS_PER_DAY = 12
/** Hand work -- supports off, sanding, assembly -- in a day that also has
 *  everything else in it. */
export const FINISHING_HOURS_PER_DAY = 4
/** One day of slack. Not a safety margin for the whole project; just
 *  enough that the last print finishing at 11pm is not a crisis. */
export const SAFETY_DAYS = 1

/**
 * Days between the work being done and it being in the client's hands.
 * Deliberately coarse: a shop that needs per-zone transit has outgrown
 * this, and Voltage's own spec kept per-zone padding as a later upgrade.
 */
export const HANDOVER_DAYS: Record<string, number> = {
  'Collected in person': 0,
  'Hand-delivered': 1,
  Courier: 2,
  Post: 5,
  'Digital files only': 0,
}
export const DEFAULT_HANDOVER_DAYS = 2

export interface StartByInput {
  neededBy: string | null
  /** How the thing gets to the client, as chosen on the project. */
  deliveryHow: string | null
  parts: PartRow[]
  /** Used only when the build sheet has no sliced files to read. */
  quote: QuoteInputsRow | null
  /** Parts already off the machine do not need printing again. */
  today?: Date
}

export interface StartBy {
  /** ISO date printing has to start. Null when there is not enough to say. */
  date: string | null
  /** Machine hours still to print, from the chosen slice of each part
   *  that is not printed yet. */
  printHours: number
  /** Where the print hours came from, in a word the screen can print. */
  source: 'slices' | 'quote' | 'none'
  /** Days from today. Negative means the start date has passed. */
  daysLeft: number | null
  status: 'unknown' | 'ok' | 'soon' | 'late' | 'done'
  /** Every assumption that went into the date, in plain words. */
  assumptions: string[]
}

/** Whole days of machine time, rounded up: half a day of printing still
 *  occupies a day you cannot also use for the next thing. */
function daysFor(hours: number, perDay: number): number {
  return hours <= 0 ? 0 : Math.ceil(hours / perDay)
}

export function startBy(input: StartByInput): StartBy {
  const today = input.today ?? new Date()
  const assumptions: string[] = []

  // Only work not yet done, counted in COPIES. A part needing five with one
  // off the machine still needs four printed; a slice's estimate is for the
  // copies on its plate, so it is divided down to one copy first.
  const copiesLeft = (p: PartRow) => {
    const c = countsOf(statesOf(p))
    return c.pending + c.reprint
  }
  const left = input.parts.filter((p) => copiesLeft(p) > 0)
  const sliced = left
    .map((p) => {
      const v = chosenVariant(p).variant
      if (v?.estMinutes == null) return null
      return (v.estMinutes / Math.max(1, v.sectionQty ?? 1)) * copiesLeft(p)
    })
    .filter((m): m is number => m != null)

  // A build sheet with nothing left on it is finished work, whatever the
  // quote still says the job was going to take.
  const allPrinted = input.parts.length > 0 && left.length === 0

  let printHours = 0
  let source: StartBy['source'] = 'none'
  if (allPrinted) {
    return { date: null, printHours: 0, source: 'slices', daysLeft: null, status: 'done', assumptions }
  }
  if (sliced.length) {
    printHours = sliced.reduce((a, b) => a + b, 0) / 60
    source = 'slices'
  } else if (input.quote && input.quote.printHrsPart > 0 && input.quote.quantity > 0) {
    printHours = input.quote.printHrsPart * input.quote.quantity
    source = 'quote'
    assumptions.push('print time from the quote, not from a sliced file')
  }

  const finishingHours = input.quote?.finishingHrs ?? 0
  const handover =
    input.deliveryHow && input.deliveryHow in HANDOVER_DAYS
      ? HANDOVER_DAYS[input.deliveryHow]
      : DEFAULT_HANDOVER_DAYS
  if (!input.deliveryHow) assumptions.push(`${DEFAULT_HANDOVER_DAYS} days to get there — no handover chosen yet`)

  if (!input.neededBy || source === 'none') {
    return {
      date: null,
      printHours,
      source,
      daysLeft: null,
      status: 'unknown',
      assumptions,
    }
  }

  // Nothing left to print: the date has no work to be a deadline for.
  if (printHours === 0) {
    return { date: null, printHours: 0, source, daysLeft: null, status: 'done', assumptions }
  }

  const printDays = daysFor(printHours, MACHINE_HOURS_PER_DAY)
  const finishDays = daysFor(finishingHours, FINISHING_HOURS_PER_DAY)
  const lead = printDays + finishDays + handover + SAFETY_DAYS

  assumptions.push(`${MACHINE_HOURS_PER_DAY} machine hours a day → ${printDays} day${printDays === 1 ? '' : 's'} of printing`)
  if (finishDays) assumptions.push(`${fmtHours(finishingHours)} of finishing → ${finishDays} day${finishDays === 1 ? '' : 's'}`)
  if (handover) assumptions.push(`${handover} day${handover === 1 ? '' : 's'} to reach them`)
  assumptions.push(`${SAFETY_DAYS} day of slack`)

  const due = parseStored(input.neededBy)
  const start = new Date(due.getFullYear(), due.getMonth(), due.getDate() - lead)
  const date = toISODate(start)
  const daysLeft = -daysBetweenLocal(date, today)

  return {
    date,
    printHours,
    source,
    daysLeft,
    status: daysLeft < 0 ? 'late' : daysLeft <= 2 ? 'soon' : 'ok',
    assumptions,
  }
}
