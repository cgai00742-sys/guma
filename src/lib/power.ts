/**
 * What electricity costs, by US state.
 *
 * Setup asks for a $/kWh rate and calls it "the one number that genuinely
 * varies by location rather than by guesswork" — which was true, and then
 * left the field blank and the shop to go and find a utility bill. Most
 * never do. A blank rate is not neutral: pricing.ts degrades machine time to
 * break-even without it, so the margin on every quote reads lower than it is
 * and the shop cannot tell a thin job from a fat one.
 *
 * So this is a published table, on the same terms as benchmarks.ts: sourced,
 * dated, and shown rather than silently applied. It is a state AVERAGE, not
 * a bill, and the UI says so — but an average within a few cents beats a
 * zero by a mile, and the spread between states is far too wide to guess at.
 * Hawaii is 43c and North Dakota is 7c. There is no sensible default that
 * serves both, which is exactly why the question has to be asked rather than
 * assumed.
 *
 * US ONLY, AND HONEST ABOUT IT. The EIA publishes this for US states and
 * nobody publishes an equivalent Guma could use worldwide. A shop outside
 * the US gets nothing here rather than a converted US figure — same rule as
 * benchmarks.ts, for the same reason.
 */

/** Cents per kWh, commercial retail, by USPS state code. */
const CENTS_PER_KWH: Record<string, number> = {
  HI: 42.99, CA: 25.75, MA: 24.02, CT: 23.56, ME: 23.27, DC: 23.26,
  AK: 22.74, RI: 22.31, NY: 21.88, VT: 20.92, NH: 20.55, NJ: 16.77,
  MD: 16.41, MI: 15.55, AL: 14.44, MS: 14.12, TN: 14.07, IL: 13.89,
  IN: 13.78, PA: 13.68, OH: 13.65, WI: 13.38, DE: 13.31, KY: 13.07,
  CO: 12.92, MT: 12.66, MN: 12.49, LA: 12.31, WA: 11.74, WV: 11.63,
  SC: 11.61, FL: 11.56, AZ: 11.49, SD: 11.47, KS: 11.39, NM: 11.08,
  AR: 11.04, OR: 10.62, GA: 10.56, MO: 10.49, NC: 10.39, VA: 10.33,
  IA: 10.26, UT: 10.24, ID: 9.87, WY: 9.5, NV: 8.99, TX: 8.35,
  NE: 8.25, OK: 7.77, ND: 7.05,
}

/** The US commercial average, for context beside a state figure. */
export const US_AVERAGE_CENTS = 13.51

export const POWER_SOURCE = 'EIA Electric Power Monthly, table 5.6.A'
export const POWER_SOURCE_SHORT = 'EIA'
export const POWER_AS_OF = 'Apr 2026'

export interface PowerRate {
  /** Dollars per kWh, the unit Guma stores and prices in. */
  perKwh: number
  /** The US average, same unit, for the "is this high?" comparison. */
  usAverage: number
  /** How this state compares, e.g. 3.2 means over three times the average. */
  timesAverage: number
  source: string
  sourceShort: string
  asOf: string
}

/**
 * The published commercial rate for a US state, or null.
 *
 * Null for every non-US shop and any code not in the table, which callers
 * must treat as "ask the shop" rather than "assume the average" — a shop in
 * Hawaii handed the US average would under-read its power cost by a factor
 * of three, and would never know.
 */
export function powerRateFor(state: string | null | undefined): PowerRate | null {
  const code = (state ?? '').trim().toUpperCase()
  const cents = CENTS_PER_KWH[code]
  if (cents === undefined) return null
  return {
    perKwh: cents / 100,
    usAverage: US_AVERAGE_CENTS / 100,
    timesAverage: cents / US_AVERAGE_CENTS,
    source: POWER_SOURCE,
    sourceShort: POWER_SOURCE_SHORT,
    asOf: POWER_AS_OF,
  }
}

/** True when a state's power is far enough from the national average that
 *  quietly using a generic figure would materially misprice machine time. */
export function isOutlier(rate: PowerRate): boolean {
  return rate.timesAverage >= 1.5 || rate.timesAverage <= 0.67
}

/** Every state code the table covers, for tests and for the UI to check
 *  before offering the suggestion at all. */
export function ratedStates(): string[] {
  return Object.keys(CENTS_PER_KWH).sort()
}
