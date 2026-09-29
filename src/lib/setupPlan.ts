/**
 * What this shop still needs before its numbers mean anything.
 *
 * Guma's setup asked three thin steps and then handed over a full
 * application: six screens, a rate card, a pipeline board and a quote
 * engine, with most of what decides a margin still blank. The result is a
 * program that appears to be working — quotes come out, totals add up — and
 * is quietly reporting break-even machine time and no material cost,
 * because nobody was ever walked through the fields those depend on.
 *
 * This module is the difference between a form and a guide. It looks at a
 * real shop and answers three questions for every part of its profile:
 * is it done, what does it decide, and what is it costing to leave blank.
 * The last one is the point. "Electricity rate — optional" is a field
 * somebody skips; "without this, every margin you see is a floor, not a
 * number" is a decision they get to make on purpose.
 *
 * Pure, like actuals.ts and history.ts: shop state in, plan out. No clock,
 * no database, no React. That is what lets the walkthrough, the banner and
 * the tests all read the same answer instead of three drifting copies.
 *
 * RE-RUNNABLE ON PURPOSE. This is not a first-launch gate. A shop that
 * skipped the machine wattage in week one should be able to come back in
 * week six and be taken straight to it, with everything already answered
 * left alone. Setup that only exists before the shop does is setup that
 * punishes you for not knowing the answers on day one.
 */
import type { MaterialRow, PrinterRow, RateCardRow, Shop } from './data.types'

export type SectionStatus = 'done' | 'partial' | 'missing'

export type SectionId =
  | 'identity'
  | 'place'
  | 'power'
  | 'machines'
  | 'materials'
  | 'labour'
  | 'terms'

export interface Section {
  id: SectionId
  title: string
  /** One line: what this decides downstream. */
  decides: string
  status: SectionStatus
  /** Named fields still blank, in the shop's words rather than the schema's. */
  missing: string[]
  /**
   * What leaving it costs, stated plainly. Null when nothing is missing, or
   * when the gap is cosmetic rather than arithmetic — this string is
   * reserved for consequences that change a number.
   */
  cost: string | null
  /**
   * True when the gap silently understates cost, and therefore overstates
   * margin. These are the ones worth interrupting somebody about; the rest
   * can wait until they go looking.
   */
  distorts: boolean
}

export interface SetupPlan {
  sections: Section[]
  /** 0..1 across all sections, a done section counting one and a partial a half. */
  completeness: number
  /** Everything not finished, in the order it should be tackled. */
  remaining: Section[]
  /** The gaps actively making the shop's numbers wrong. */
  distorting: Section[]
  done: boolean
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const filled = (v: unknown): boolean => String(v ?? '').trim().length > 0

function statusOf(missing: string[], anyDone: boolean): SectionStatus {
  if (missing.length === 0) return 'done'
  return anyDone ? 'partial' : 'missing'
}

export interface ShopSnapshot {
  shop: Shop
  rateCard: RateCardRow
  printerRows: PrinterRow[]
  materials: MaterialRow[]
}

/**
 * Read a shop and say what it still needs.
 *
 * Order matters: the sections come back in the order somebody should work
 * through them, which is not the order they appear in Settings. Place
 * before power because the state answers the power question. Machines
 * before materials because a shop with no printer has nothing to spend
 * material on. Labour last of the cost inputs, because it is the one people
 * arrive with an opinion about and the one the published guidance helps
 * with most.
 */
export function planFor({ shop, rateCard, printerRows, materials }: ShopSnapshot): SetupPlan {
  const live = printerRows.filter((p) => !p.archived)
  const stocked = materials.filter((m) => !m.archived)

  const sections: Section[] = []

  /* ---- who you are ---------------------------------------------------- */
  // What applies depends on how the shop gets paid. A shop that only sells
  // what it makes sends no quotes, so a contact line on a quote and the
  // terms of a quote are not unfinished setup for it -- they are simply not
  // its business. Asking anyway meant a selling shop could answer every
  // question in setup and still be told it was not done. Unknown (null)
  // is treated as quoting, the stricter reading, until it is answered.
  const branch = (shop as { sell_branch?: string | null }).sell_branch ?? null
  const quotes = branch !== 'selling'

  const identityMissing: string[] = []
  if (!filled(shop.name)) identityMissing.push('shop name')
  if (quotes && !filled(shop.email) && !filled(shop.phone)) identityMissing.push('an email or phone')
  sections.push({
    id: 'identity',
    title: 'Your shop',
    decides: 'What a client sees at the top of every quote.',
    status: statusOf(identityMissing, filled(shop.name)),
    missing: identityMissing,
    cost: identityMissing.includes('an email or phone')
      ? 'Quotes go out with no way to reply to them.'
      : null,
    distorts: false,
  })

  /* ---- where you are -------------------------------------------------- */
  const placeMissing: string[] = []
  if (!filled(shop.currency)) placeMissing.push('currency')
  if (!filled(shop.address)) placeMissing.push('address')
  // A named tax at 0% is an answer, not a gap: Oregon, Montana, a shop
  // under a registration threshold. Requiring a non-zero rate meant those
  // shops could never finish setup, whatever they typed.
  if (!filled(shop.tax_label)) placeMissing.push('tax name and rate')
  sections.push({
    id: 'place',
    title: 'Where you are',
    decides: 'Currency, page size, the name of your tax, and what power costs.',
    status: statusOf(placeMissing, filled(shop.currency)),
    missing: placeMissing,
    cost: placeMissing.includes('tax name and rate')
      ? 'Every quote total is missing its tax, so what you invoice will not match what you quoted.'
      : null,
    distorts: placeMissing.includes('tax name and rate'),
  })

  /* ---- what power costs ----------------------------------------------- */
  const powerMissing: string[] = shop.electricity_rate_kwh == null ? ['electricity rate'] : []
  sections.push({
    id: 'power',
    title: 'What your power costs',
    decides: 'Whether machine time is priced at its real cost or at break-even.',
    status: powerMissing.length === 0 ? 'done' : 'missing',
    missing: powerMissing,
    cost:
      powerMissing.length > 0
        ? 'Guma refuses to guess, so it prices machine time at break-even and every margin you see is a floor rather than a figure.'
        : null,
    distorts: powerMissing.length > 0,
  })

  /* ---- the machines --------------------------------------------------- */
  const machineMissing: string[] = []
  if (live.length === 0) machineMissing.push('at least one machine')
  else {
    if (live.some((p) => num(p.wear_hourly) <= 0)) machineMissing.push('wear per hour')
    if (live.some((p) => p.watts == null)) machineMissing.push('power draw in watts')
  }
  sections.push({
    id: 'machines',
    title: 'Your machines',
    decides: 'Machine time, wear, and the electricity each job actually burns.',
    status: statusOf(machineMissing, live.length > 0),
    missing: machineMissing,
    cost:
      live.length === 0
        ? 'Nothing can be priced for machine time at all.'
        : machineMissing.length > 0
          ? 'Machine hours are costing you more than Guma can see, so jobs look more profitable than they are.'
          : null,
    distorts: machineMissing.length > 0,
  })

  /* ---- the materials -------------------------------------------------- */
  const materialMissing: string[] = []
  if (stocked.length === 0) materialMissing.push('at least one material')
  else if (stocked.some((m) => num(m.costPerUnit) <= 0)) materialMissing.push('what it costs you')
  sections.push({
    id: 'materials',
    title: 'What you print with',
    decides: 'The material line on every quote, and what a failed print really costs.',
    status: statusOf(materialMissing, stocked.length > 0),
    missing: materialMissing,
    cost:
      materialMissing.length > 0
        ? 'Material reads as free, which flatters every quote and hides what your failures cost.'
        : null,
    distorts: materialMissing.length > 0,
  })

  /* ---- your hours ----------------------------------------------------- */
  const labourMissing: string[] = []
  if (num(rateCard.design_hourly) <= 0) labourMissing.push('design rate')
  if (num(rateCard.finishing_hourly) <= 0) labourMissing.push('finishing rate')
  sections.push({
    id: 'labour',
    title: 'What your time is worth',
    decides: 'The biggest line on most quotes.',
    status: statusOf(labourMissing, num(rateCard.design_hourly) > 0),
    missing: labourMissing,
    cost:
      labourMissing.length > 0
        ? 'Your own hours are being quoted at nothing, which is the most common way a shop works a full year for free.'
        : null,
    distorts: labourMissing.length > 0,
  })

  /* ---- the terms ------------------------------------------------------ */
  const termsMissing: string[] = []
  if (quotes) {
    if (num(rateCard.minimum_order) <= 0) termsMissing.push('shop minimum')
    if (num(rateCard.deposit_pct) <= 0) termsMissing.push('deposit')
    if (num(rateCard.material_markup) <= 1) termsMissing.push('material markup')
  }
  if (branch === null) termsMissing.push('how you get paid')
  sections.push({
    id: 'terms',
    title: 'How you sell',
    decides: 'Your floor, what you take up front, and what you make on material.',
    status: statusOf(termsMissing, !quotes || num(rateCard.deposit_pct) > 0),
    missing: termsMissing,
    cost:
      termsMissing.includes('material markup')
        ? 'Material is being sold at cost.'
        : termsMissing.includes('deposit')
          ? 'You are funding every job yourself until it is delivered.'
          : null,
    // These lose money on purpose-built terms rather than misreporting a
    // cost, so they are not distortions -- a shop can rationally choose a
    // zero minimum. The others cannot be rationally chosen blank.
    distorts: false,
  })

  const score = sections.reduce(
    (n, s) => n + (s.status === 'done' ? 1 : s.status === 'partial' ? 0.5 : 0),
    0,
  )

  return {
    sections,
    completeness: score / sections.length,
    remaining: sections.filter((s) => s.status !== 'done'),
    distorting: sections.filter((s) => s.distorts),
    done: sections.every((s) => s.status === 'done'),
  }
}
