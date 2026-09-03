/// <reference types="node" />
/**
 * Dates, from a shop that is not in Greenwich.
 *
 * The whole suite runs pinned to Pacific/Honolulu, because that is where
 * the bug lived: UTC-10 with no daylight saving, so from 2pm local until
 * midnight the UTC calendar date is already tomorrow. Every one of these
 * assertions passes trivially in UTC and fails on the old code in Hawaii,
 * which is exactly why none of the ninety-nine tests before this one
 * noticed.
 */
process.env.TZ = 'Pacific/Honolulu'

import { describe, expect, it } from 'vitest'
import { addDaysISO, daysBetweenLocal, todayISO, toISODate } from './dates'
import { flagsFor } from './gates'
import type { ProjectFacts } from './data.types'

/** 3pm on 2 September in Honolulu. In UTC it is already the 3rd. */
const HAWAII_AFTERNOON = new Date('2026-09-03T01:00:00Z')

describe('local calendar dates', () => {
  it('the test environment really is in Hawaii', () => {
    expect(HAWAII_AFTERNOON.getHours()).toBe(15)
    expect(HAWAII_AFTERNOON.toISOString().slice(0, 10)).toBe('2026-09-03')
  })

  it('today is the day the shop is having, not the day UTC is having', () => {
    expect(todayISO(HAWAII_AFTERNOON)).toBe('2026-09-02')
    // The old implementation. Kept as an assertion so the difference is
    // stated rather than assumed.
    expect(HAWAII_AFTERNOON.toISOString().slice(0, 10)).not.toBe(todayISO(HAWAII_AFTERNOON))
  })

  it('still agrees with UTC in the morning', () => {
    const morning = new Date('2026-09-02T18:00:00Z') // 8am Honolulu
    expect(todayISO(morning)).toBe('2026-09-02')
    expect(morning.toISOString().slice(0, 10)).toBe('2026-09-02')
  })

  it('formats a date without drifting through UTC', () => {
    expect(toISODate(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(toISODate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('adds days by the calendar, so a quote expires on the day it says', () => {
    expect(addDaysISO(30, HAWAII_AFTERNOON)).toBe('2026-10-02')
    expect(addDaysISO(0, HAWAII_AFTERNOON)).toBe('2026-09-02')
    // Across a month and a year boundary.
    expect(addDaysISO(1, new Date(2026, 11, 31, 15))).toBe('2027-01-01')
  })

  it('counts whole calendar days, not 24-hour blocks', () => {
    expect(daysBetweenLocal('2026-09-02', HAWAII_AFTERNOON)).toBe(0)
    expect(daysBetweenLocal('2026-09-01', HAWAII_AFTERNOON)).toBe(1)
    expect(daysBetweenLocal('2026-08-28', HAWAII_AFTERNOON)).toBe(5)
    // A future date counts backwards rather than clamping.
    expect(daysBetweenLocal('2026-09-05', HAWAII_AFTERNOON)).toBe(-3)
  })

  it('reads a bare date as local midnight, not as a UTC instant', () => {
    // new Date('2026-09-02') would be UTC midnight — 2pm the previous day
    // in Honolulu — which is the trap daysBetweenLocal exists to avoid.
    expect(daysBetweenLocal('2026-09-02', new Date(2026, 8, 2, 23, 59))).toBe(0)
  })

  it('converts a full timestamp to the local day it happened on', () => {
    // Recorded at 3pm Honolulu, stored as a UTC instant on the 3rd.
    expect(daysBetweenLocal('2026-09-03T01:00:00Z', HAWAII_AFTERNOON)).toBe(0)
  })

  it('survives a daylight-saving jump, where a day is 23 hours', () => {
    // Honolulu has no DST, so borrow one that does for this case only.
    const tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      // 8 March 2026 is the US spring-forward.
      expect(daysBetweenLocal('2026-03-07', new Date(2026, 2, 9, 12))).toBe(2)
      expect(daysBetweenLocal('2026-03-08', new Date(2026, 2, 9, 12))).toBe(1)
    } finally {
      process.env.TZ = tz
    }
  })
})

describe('flags, from Hawaii', () => {
  const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
    phase: 'design', priority: 'medium', createdAt: '2026-08-01T00:00:00Z',
    takenInAt: '2026-08-01T00:00:00Z', neededBy: null, windowFrom: null,
    windowLocked: false, atRisk: false, deliveryOn: null, deliveryHow: null,
    brief: null, poc: null, quoteStatus: 'accepted', quoteTotal: 500,
    depositDue: 0, depositOwed: 0, balanceOwed: 0, lastActivityAt: null,
    minimumOrder: 0, actualCost: 0, hasActuals: false, actualRuns: 0,
    actualHours: 0, parts: 0, partsPrinted: 0, partsPassed: 0,
    partsReprint: 0, reprintsEver: 0, ...over,
  })

  it('a project due today is not overdue at 3pm local', () => {
    // This is the one that mattered. Under the old UTC arithmetic the
    // clock had already rolled over, so Guma told a shop its project was a
    // day late while the client still had until close of business.
    const keys = flagsFor(facts({ neededBy: '2026-09-02' }), HAWAII_AFTERNOON).map((f) => f.key)
    expect(keys).not.toContain('overdue')
  })

  it('and is overdue the following afternoon, by exactly one day', () => {
    const nextDay = new Date('2026-09-04T01:00:00Z') // 3pm on the 3rd
    const f = flagsFor(facts({ neededBy: '2026-09-02' }), nextDay).find((x) => x.key === 'overdue')!
    expect(f).toBeDefined()
    expect(f.cause).toContain('1 day')
    expect(f.cause).not.toContain('2 days')
  })

  it('does not call a project stalled a day early', () => {
    // Activity 13 local days ago. The threshold is 14.
    const keys = flagsFor(
      facts({ lastActivityAt: '2026-08-20T20:00:00Z' }),
      HAWAII_AFTERNOON,
    ).map((f) => f.key)
    expect(keys).not.toContain('stalled')
  })
})
