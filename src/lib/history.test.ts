/**
 * A shop's own finished work, added up.
 *
 * The test that matters most is "an unmeasured job is not a perfect job".
 * Every delivered project with nothing recorded against it has an actual
 * cost of zero, and counting those would report 100% margin on them --
 * turning the one screen meant to tell a shop the truth about its pricing
 * into the most confident liar in the app.
 */
import { describe, expect, it } from 'vitest'
import { MIN_SAMPLE, hourlyReality, summarizeHistory } from './history'
import type { JobListRow, JobPhase } from './data.types'

/** A delivered job with only the fields summarizeHistory reads. */
function job(p: {
  value?: number
  cost?: number
  hours?: number
  reprints?: number
  phase?: JobPhase
  hasActuals?: boolean
}): JobListRow {
  const value = p.value ?? 1000
  return {
    jobId: 'j', ref: 'R', title: 'T',
    clientId: 'c', clientName: 'C', clientKind: 'business',
    createdAt: '2026-01-01', phase: p.phase ?? 'delivered',
    priority: 'medium', quoteId: 'q', quoteStatus: 'accepted',
    total: value,
    gateAnswers: {},
    facts: {
      quoteTotal: value,
      actualCost: p.cost ?? 600,
      actualHours: p.hours ?? 10,
      reprintsEver: p.reprints ?? 0,
      hasActuals: p.hasActuals ?? true,
      actualRuns: 1,
    },
  } as unknown as JobListRow
}

const many = (n: number, p: Parameters<typeof job>[0] = {}) =>
  Array.from({ length: n }, () => job(p))

describe('which jobs are allowed to speak', () => {
  it('counts only delivered work', () => {
    const h = summarizeHistory([
      ...many(5),
      job({ phase: 'building' }),
      job({ phase: 'design' }),
    ])
    expect(h.counted).toBe(5)
  })

  it('does not let an unmeasured job report a perfect margin', () => {
    // Five real jobs at 40% margin, plus five delivered jobs nobody logged
    // anything against. If the second group counted, the reported margin
    // would be 70%, and the shop would raise nothing and wonder why.
    const h = summarizeHistory([
      ...many(5, { value: 1000, cost: 600 }),
      ...many(5, { value: 1000, hasActuals: false }),
    ])
    expect(h.counted).toBe(5)
    expect(h.unmeasured).toBe(5)
    expect(h.realizedMarginPct?.median).toBeCloseTo(40, 6)
  })

  it('ignores a job that sold for nothing', () => {
    const h = summarizeHistory([...many(5), job({ value: 0 })])
    expect(h.counted).toBe(5)
  })

  it('says it has nothing rather than inventing a figure', () => {
    const empty = summarizeHistory([])
    expect(empty.counted).toBe(0)
    expect(empty.enough).toBe(false)
    expect(empty.jobValue).toBeNull()
    expect(empty.realizedMarginPct).toBeNull()
    expect(empty.reprintRate).toBeNull()
  })
})

describe('silence until there is something to say', () => {
  it('stays quiet below the sample threshold', () => {
    const h = summarizeHistory(many(MIN_SAMPLE - 1))
    expect(h.counted).toBe(MIN_SAMPLE - 1)
    expect(h.enough).toBe(false)
    // The statistics still exist -- a screen may show "so far" -- but the
    // flag that gates guidance is off.
    expect(h.jobValue).not.toBeNull()
    expect(hourlyReality(h)).toBeNull()
  })

  it('speaks up once there is enough', () => {
    const h = summarizeHistory(many(MIN_SAMPLE))
    expect(h.enough).toBe(true)
    expect(hourlyReality(h)).toContain('delivered jobs')
  })
})

describe('medians, with a spread', () => {
  it('is not moved by one catastrophe', () => {
    // Nine ordinary jobs and one that went badly wrong. A mean job value
    // here is 1,900; the median is the number a shop should set rates by.
    const rows = [...many(9, { value: 1000, cost: 600 }), job({ value: 10000, cost: 40000 })]
    const h = summarizeHistory(rows)
    expect(h.jobValue?.median).toBe(1000)
    expect(h.realizedMarginPct?.median).toBeCloseTo(40, 6)
  })

  it('reports the middle half, not just a point', () => {
    const rows = [
      job({ value: 100 }), job({ value: 200 }), job({ value: 300 }),
      job({ value: 400 }), job({ value: 500 }),
    ]
    const h = summarizeHistory(rows)
    expect(h.jobValue?.median).toBe(300)
    expect(h.jobValue?.low).toBe(200)
    expect(h.jobValue?.high).toBe(400)
    expect(h.jobValue?.n).toBe(5)
  })

  it('handles a single job without dividing by zero', () => {
    const h = summarizeHistory([job({ value: 800 })])
    expect(h.jobValue?.median).toBe(800)
    expect(h.jobValue?.low).toBe(800)
    expect(h.jobValue?.high).toBe(800)
  })
})

describe('what an hour actually returns', () => {
  it('divides what the job earned by every hour that went into it', () => {
    const h = summarizeHistory(many(5, { value: 1000, hours: 10 }))
    expect(h.revenuePerHour?.median).toBeCloseTo(100, 6)
  })

  it('leaves hourless jobs out of the hourly figure but keeps them in margin', () => {
    // A job with material recorded and no logged hours is real work and
    // belongs in the margin; it just cannot say anything about an hourly
    // return, and dividing by zero would say something infinite.
    const h = summarizeHistory([
      ...many(5, { value: 1000, cost: 600, hours: 10 }),
      job({ value: 1000, cost: 600, hours: 0 }),
    ])
    expect(h.counted).toBe(6)
    expect(h.revenuePerHour?.n).toBe(5)
    expect(h.realizedMarginPct?.n).toBe(6)
    expect(Number.isFinite(h.revenuePerHour!.median)).toBe(true)
  })
})

describe('reprints', () => {
  it('is the share of finished jobs that had anything sent back', () => {
    const h = summarizeHistory([
      ...many(3, { reprints: 0 }),
      ...many(1, { reprints: 2 }),
    ])
    expect(h.reprintRate).toBeCloseTo(0.25, 6)
  })
})
