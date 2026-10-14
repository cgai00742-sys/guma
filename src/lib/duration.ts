/**
 * Durations as people say them: hours and minutes.
 *
 * CG, 14 Oct 2026: "change the way we track hours in the program to be
 * hours and minutes instead of for example 0.5 for 30 minutes" -- a failed
 * print stopped at 15h 20m is typed as 15 and 20, not worked out as 15.33.
 *
 * Storage does not change: every table keeps decimal hours, because rates
 * are per hour and every sum and price multiplies by them. Only what is
 * typed and what is shown changes. Everything is rounded to the minute on
 * the way in; the clock has nothing finer to offer.
 */

/** Decimal hours -> whole hours and minutes, rounded to the minute. */
export function splitHours(hours: number | null | undefined): { h: number; m: number } {
  const total = Math.max(0, Math.round((Number(hours) || 0) * 60))
  return { h: Math.floor(total / 60), m: total % 60 }
}

/** Hours and minutes -> decimal hours, to the minute (stored as hours). */
export function joinHours(h: number | string | null | undefined, m: number | string | null | undefined): number {
  const hh = Math.max(0, Math.floor(Number(h) || 0))
  const mm = Math.max(0, Math.floor(Number(m) || 0))
  return (hh * 60 + mm) / 60
}

/**
 * "16h 26m", "45m", "2h", "0m". Null-ish gives `empty`. Minutes only when
 * there are some, hours only when there are some -- "2h 0m" is noise.
 */
export function fmtHours(hours: number | null | undefined, empty = '—'): string {
  if (hours == null || !Number.isFinite(Number(hours))) return empty
  const { h, m } = splitHours(hours)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
