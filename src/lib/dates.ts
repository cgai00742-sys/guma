/**
 * Calendar dates, in the shop's own timezone.
 *
 * Every date this app stores as a bare `YYYY-MM-DD` — a payment's received
 * date, the day an hour was worked, when a run started, when a quote
 * expires — is a CALENDAR date in the shop's local reckoning, not an
 * instant. `new Date().toISOString().slice(0, 10)` gives the UTC calendar
 * date instead, and those are different things for most of the world for
 * part of every day.
 *
 * For a shop on Maui at UTC-10, they diverge from 2pm local until midnight:
 * ten hours of every working day, during which a payment taken this
 * afternoon would be filed under tomorrow. That is not a cosmetic error in
 * a tool whose whole subject is money — it lands in the ledger, in the
 * closeout sheet, and in the arithmetic behind "27 days overdue".
 *
 * So nothing in this app calls toISOString() for a date any more. It calls
 * these.
 */

/** The local calendar date, as `YYYY-MM-DD`. */
export function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today, as the shop would write it on a receipt. */
export function todayISO(now: Date = new Date()): string {
  return toISODate(now)
}

/** `n` days from now, as a local calendar date — for a quote's expiry. */
export function addDaysISO(days: number, from: Date = new Date()): string {
  // Built from local Y/M/D rather than by adding milliseconds, so a date
  // that crosses a daylight-saving boundary still lands on the right day.
  return toISODate(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days))
}

/** Local midnight of a Date, as a timestamp. */
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Whole calendar days from `fromISO` up to `to`, counted the way a person
 * counts them: local midnights, not 24-hour blocks.
 *
 * Accepts either a bare date (parsed as LOCAL midnight — note that
 * `new Date('2026-09-30')` would parse as UTC, which is the trap this
 * function exists to avoid) or a full ISO timestamp, which is an instant
 * and gets converted to whatever local day it fell on.
 *
 * Rounded, not floored, because a day is 23 or 25 hours twice a year and
 * flooring turns those into an off-by-one.
 */
export function daysBetweenLocal(fromISO: string, to: Date): number {
  const parsed = new Date(fromISO.length <= 10 ? `${fromISO}T00:00:00` : fromISO)
  if (Number.isNaN(parsed.getTime())) return 0
  return Math.round((localMidnight(to) - localMidnight(parsed)) / 86_400_000)
}
