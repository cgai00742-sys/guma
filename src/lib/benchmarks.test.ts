/**
 * The benchmark table makes the one kind of claim the rest of this codebase
 * refuses to make: it tells a shop what other shops charge. These tests are
 * the conditions that claim is allowed to ship under.
 *
 * The load-bearing one is "money does not travel". Everything else here is
 * hygiene; that one is the difference between research and a wrong number
 * wearing research's clothes.
 */
import { describe, expect, it } from 'vitest'
import {
  BENCHMARKS,
  REVIEWED_ON,
  REVIEW_INTERVAL_MONTHS,
  benchmarksFor,
  benchmarksStale,
  hasLocalRates,
  ratedCurrencies,
  reviewAgeMonths,
  type Benchmark,
} from './benchmarks'

const money = (b: Benchmark) => b.currency !== ''
const portable = (b: Benchmark) => b.currency === ''

describe('every figure is sourced', () => {
  it('has a publication, a URL and a date on all of them', () => {
    for (const b of BENCHMARKS) {
      expect(b.source, `${b.id} has no source`).toBeTruthy()
      expect(b.url, `${b.id} has no URL`).toMatch(/^https?:\/\//)
      expect(b.asOf, `${b.id} has no date`).toMatch(/^\d{4}(-\d{2})?(-\d{2})?$/)
      expect(b.note.length, `${b.id} has no note explaining itself`).toBeGreaterThan(20)
    }
  })

  it('never states a range backwards', () => {
    for (const b of BENCHMARKS) {
      expect(b.low, `${b.id} low is not positive`).toBeGreaterThan(0)
      if (b.high !== null) expect(b.high, `${b.id} high is below low`).toBeGreaterThanOrEqual(b.low)
    }
  })

  it('uses unique ids, so the UI can key on them', () => {
    const ids = BENCHMARKS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('money does not travel', () => {
  it('shows a shop only the figures collected in its own currency', () => {
    // The bug this exists to prevent: a shop invoicing in zloty reading a
    // range collected in dollars as though somebody researched Poland.
    const forPln = benchmarksFor('designHourly', 'PLN')
    expect(forPln.every(portable)).toBe(true)

    const forUsd = benchmarksFor('designHourly', 'USD')
    expect(forUsd.some((b) => b.currency === 'USD')).toBe(true)
  })

  it('lets every currency see the portable figures', () => {
    // A multiple, a percentage and a count of hours mean the same thing
    // everywhere, so withholding them from a Polish shop would be a
    // different kind of failure -- useless rather than misleading.
    for (const currency of ['USD', 'PLN', 'JPY', 'ZZZ', '']) {
      const got = benchmarksFor('depositPct', currency)
      expect(got.length, `${currency || 'blank'} got no portable deposit figure`).toBeGreaterThan(0)
      expect(got.every(portable)).toBe(true)
    }
  })

  it('leaks no money figure to any field for an unknown currency', () => {
    // The sweep: every field, a currency nothing is published in, and not
    // one figure carrying a currency may come back.
    const fields = [...new Set(BENCHMARKS.map((b) => b.field))]
    for (const field of fields) {
      const got = benchmarksFor(field, 'XTS')
      expect(got.filter(money), `${field} leaked a money figure to XTS`).toEqual([])
    }
  })

  it('is case-insensitive about the currency, like the rest of the app', () => {
    expect(benchmarksFor('designHourly', 'usd')).toEqual(benchmarksFor('designHourly', 'USD'))
  })

  it('knows which currencies it actually has rates for, and admits the rest', () => {
    expect(hasLocalRates('USD')).toBe(true)
    expect(hasLocalRates('PLN')).toBe(false)
    expect(hasLocalRates('')).toBe(false)
    expect(ratedCurrencies()).toContain('USD')
    // Every rated currency is a plausible ISO 4217 code rather than a typo.
    for (const c of ratedCurrencies()) expect(c).toMatch(/^[A-Z]{3}$/)
  })

  it('marks as portable only the units that genuinely are', () => {
    // A per-hour or per-kg figure is money and must carry a currency; a
    // multiple, percentage or hour count must not.
    for (const b of BENCHMARKS) {
      if (b.unit === 'multiple' || b.unit === 'percent' || b.unit === 'hours') {
        expect(b.currency, `${b.id} is a ${b.unit} but claims a currency`).toBe('')
      } else {
        expect(b.currency, `${b.id} is money with no currency`).not.toBe('')
      }
    }
  })
})

describe('it goes stale, and says so', () => {
  it('is currently inside its review window', () => {
    // If this fails, the table has not been checked against its sources in
    // over REVIEW_INTERVAL_MONTHS. Re-read every url, update the figures
    // and REVIEWED_ON. Do not simply move the date.
    expect(
      benchmarksStale(),
      `Benchmarks last reviewed ${REVIEWED_ON}, ${reviewAgeMonths()} months ago. Re-check the sources.`,
    ).toBe(false)
  })

  it('counts whole months, and turns stale exactly on the interval', () => {
    const [y, m, d] = REVIEWED_ON.split('-').map(Number)
    expect(reviewAgeMonths(new Date(y, m - 1, d))).toBe(0)
    // The day before the interval elapses: still fresh.
    expect(benchmarksStale(new Date(y, m - 1 + REVIEW_INTERVAL_MONTHS, d - 1))).toBe(false)
    // The day it elapses: stale.
    expect(benchmarksStale(new Date(y, m - 1 + REVIEW_INTERVAL_MONTHS, d))).toBe(true)
  })
})
