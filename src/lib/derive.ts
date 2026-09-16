/**
 * The arithmetic Setup used to describe and then leave to the user.
 *
 * "Machine price ÷ lifetime hours is a fair start" was already printed under
 * the wear field. "Paired with your electricity rate, this is what turns
 * machine time from a guess into an actual cost" was already printed under
 * wattage. Both sentences told a shop owner to go and do a division, in a
 * form, on a screen that had every input it needed sitting a few pixels
 * away. This module does those divisions.
 *
 * Nothing here is a recommendation and nothing here needs a source. Every
 * function takes numbers the shop supplied about their own machine, their
 * own utility bill, their own spool, and returns what those numbers imply.
 * If the answer is wrong it is because an input was wrong, which the shop
 * can see and fix — the opposite of a benchmark, where being wrong is
 * invisible.
 *
 * Two conventions, both load-bearing:
 *
 * - Anything unknowable returns null, never zero and never a guess. A zero
 *   wear rate reads as "this machine is free to run", which is the same
 *   flattering lie actuals.ts refuses to tell about an unrecorded cost.
 * - Nothing is rounded for storage, only for display, and the display
 *   rounding is the caller's business. A wear rate of 0.2083 is not
 *   improved by being stored as 0.21.
 */

/** Coerce a form value to a positive finite number, or null. Blank, zero,
 *  negative and nonsense all mean "not answered" rather than "zero". */
export function positive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

export interface WearInput {
  /** What the machine cost. */
  price: unknown
  /** Print hours expected out of it before a serious overhaul. */
  lifetimeHours: unknown
  /** Parts and consumables per year — nozzles, belts, fans, plates. */
  maintenancePerYear?: unknown
  /** Hours a year it realistically runs, to turn annual maintenance into
   *  a per-hour share. */
  hoursPerYear?: unknown
}

export interface WearResult {
  /** Money per print hour. */
  perHour: number
  /** The purchase-price share alone. */
  fromPrice: number
  /** The consumables share, or 0 when maintenance was not supplied. */
  fromMaintenance: number
  /** True when maintenance was folded in — the UI says so, because a wear
   *  rate that covers only the purchase price is knowingly light. */
  includesMaintenance: boolean
}

/**
 * Wear per print hour: what an hour of running costs in machine, not power.
 *
 * (price ÷ lifetime hours) is the floor. Consumables are the part shops
 * forget — the sources put them at real money per machine per year — so
 * when both annual maintenance and annual running hours are on file they
 * are folded in at their true per-hour share.
 */
export function wearPerHour(input: WearInput): WearResult | null {
  const price = positive(input.price)
  const life = positive(input.lifetimeHours)
  if (price === null || life === null) return null

  const fromPrice = price / life

  const maint = positive(input.maintenancePerYear)
  const hoursYear = positive(input.hoursPerYear)
  const fromMaintenance = maint !== null && hoursYear !== null ? maint / hoursYear : 0

  return {
    perHour: fromPrice + fromMaintenance,
    fromPrice,
    fromMaintenance,
    includesMaintenance: fromMaintenance > 0,
  }
}

/**
 * Electricity per print hour: watts x hours x price of a kilowatt-hour.
 * The one number that genuinely varies by location rather than by opinion,
 * which is why Setup asks for it rather than assuming it.
 */
export function powerPerHour(watts: unknown, ratePerKwh: unknown): number | null {
  const w = positive(watts)
  const rate = positive(ratePerKwh)
  if (w === null || rate === null) return null
  return (w / 1000) * rate
}

/** What a spool costs per gram, from its price and its weight in kilograms. */
export function costPerGram(pricePerSpool: unknown, spoolKg: unknown): number | null {
  const price = positive(pricePerSpool)
  const kg = positive(spoolKg)
  if (price === null || kg === null) return null
  return price / (kg * 1000)
}

/** Price per kilogram from a spool price and weight — the form Guma stores. */
export function pricePerKg(pricePerSpool: unknown, spoolKg: unknown): number | null {
  const price = positive(pricePerSpool)
  const kg = positive(spoolKg)
  if (price === null || kg === null) return null
  return price / kg
}

export interface RateImplication {
  /** A working day at this rate. */
  perDay: number
  /** A year of billable weeks at this rate. */
  perYear: number
  dayHours: number
  billableHoursPerWeek: number
  weeksPerYear: number
}

/**
 * What an hourly rate actually comes to.
 *
 * This is the informational half of rate-setting, and it suggests nothing:
 * it takes the number the shop just typed and says what a day and a year of
 * it look like. Someone who cannot say whether $35/hr is right can usually
 * say immediately whether $46,000 a year is right, because that is a number
 * they have a lifetime of intuition about.
 *
 * The defaults are deliberately conservative on billable hours. Twenty
 * billable hours in a forty-hour week is the realistic figure for a shop
 * where the other twenty go on quoting, cleaning, failed prints, packing
 * and email — and a rate set against forty billable hours is the classic
 * way to work a full year and earn half of what you planned.
 */
export function rateImplies(
  hourly: unknown,
  opts: { dayHours?: number; billableHoursPerWeek?: number; weeksPerYear?: number } = {},
): RateImplication | null {
  const rate = positive(hourly)
  if (rate === null) return null
  const dayHours = opts.dayHours ?? 8
  const billableHoursPerWeek = opts.billableHoursPerWeek ?? 20
  const weeksPerYear = opts.weeksPerYear ?? 48
  return {
    perDay: rate * dayHours,
    perYear: rate * billableHoursPerWeek * weeksPerYear,
    dayHours,
    billableHoursPerWeek,
    weeksPerYear,
  }
}

/**
 * The hourly rate implied by a target annual take, run backwards through
 * the same conservative assumptions. The question most people can actually
 * answer — "I need this to make $60k" — turned into the one the form asks.
 */
export function hourlyForTarget(
  targetPerYear: unknown,
  opts: { billableHoursPerWeek?: number; weeksPerYear?: number } = {},
): number | null {
  const target = positive(targetPerYear)
  if (target === null) return null
  const billableHoursPerWeek = opts.billableHoursPerWeek ?? 20
  const weeksPerYear = opts.weeksPerYear ?? 48
  return target / (billableHoursPerWeek * weeksPerYear)
}

/**
 * The true cost of one print hour on one machine: wear plus power.
 * What a machine-time rate has to clear before any of it is margin.
 */
export function machineHourFloor(
  wear: number | null,
  power: number | null,
): { floor: number; complete: boolean } | null {
  if (wear === null && power === null) return null
  return {
    floor: (wear ?? 0) + (power ?? 0),
    // False when one half is missing: the figure is a floor under a floor,
    // and the UI must not present it as the whole cost.
    complete: wear !== null && power !== null,
  }
}
