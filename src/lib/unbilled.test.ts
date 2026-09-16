/**
 * The hours nobody paid for.
 *
 * Two tests here carry the weight. The first is that a shop with no data
 * gets null rather than 1.0 — reading "no in-house jobs logged" as "every
 * hour you work is billable" would hand a brand-new shop the most
 * flattering number in the app and call it a measurement.
 *
 * The second is that the measured ratio only replaces derive.ts's stated
 * assumption once there is enough of it. A ratio off three hours is an
 * anecdote, and presenting it as "yours" would be worse than the honest
 * guess it displaced.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_HOURS,
  measuredBillableHours,
  ratioIsMeasured,
  summarizeUnbilled,
  unbilledLoad,
} from './unbilled'
import { rateImplies } from './derive'
import type { JobKind, JobListRow } from './data.types'

function job(p: {
  kind?: JobKind
  hours?: number
  cost?: number
  units?: number
  failed?: number
  machineHours?: number
}): JobListRow {
  return {
    jobId: 'j', ref: 'R', title: 'T',
    clientId: 'c', clientName: 'C', clientKind: 'business',
    createdAt: '2026-01-01', phase: 'building', priority: 'medium',
    quoteId: null, quoteStatus: null, total: null, gateAnswers: {},
    facts: {
      kind: p.kind ?? 'client',
      actualHours: p.hours ?? 0,
      actualCost: p.cost ?? 0,
      materialUnits: p.units ?? 0,
      failedUnits: p.failed ?? 0,
      machineHours: p.machineHours ?? 0,
      hasActuals: true,
    },
  } as unknown as JobListRow
}

describe('what is billed and what is not', () => {
  it('splits hours by whether anyone was paying', () => {
    const u = summarizeUnbilled([
      job({ kind: 'client', hours: 30 }),
      job({ kind: 'inhouse', hours: 10 }),
    ])
    expect(u.billedHours).toBe(30)
    expect(u.unbilledHours).toBe(10)
    expect(u.totalHours).toBe(40)
    expect(u.billableRatio).toBeCloseTo(0.75, 10)
    expect(u.unbilledJobs).toBe(1)
  })

  it('never reads "no data" as "everything is billable"', () => {
    // The flattering bug. A new shop has logged nothing; 1.0 would tell it
    // every hour of its week earns, which is the one thing no shop has ever
    // found to be true.
    const empty = summarizeUnbilled([])
    expect(empty.billableRatio).toBeNull()
    expect(ratioIsMeasured(empty)).toBe(false)
    expect(measuredBillableHours(empty)).toBeNull()
    expect(unbilledLoad(empty)).toBeNull()
  })

  it('counts in-house work at any phase, not just finished work', () => {
    // Deliberately unlike history.ts. An experiment abandoned half way
    // still burned the material and the afternoon, and waiting for
    // 'delivered' would hide exactly the worst cases.
    const u = summarizeUnbilled([
      { ...job({ kind: 'inhouse', hours: 6, cost: 40 }), phase: 'design' } as JobListRow,
      { ...job({ kind: 'inhouse', hours: 4, cost: 30 }), phase: 'building' } as JobListRow,
    ])
    expect(u.unbilledJobs).toBe(2)
    expect(u.unbilledHours).toBe(10)
    expect(u.unbilledCost).toBe(70)
  })

  it('totals what in-house work consumed, not just the time', () => {
    const u = summarizeUnbilled([
      job({ kind: 'inhouse', hours: 5, cost: 120, units: 900, machineHours: 14 }),
      job({ kind: 'client', hours: 5, cost: 400, units: 300, machineHours: 9 }),
    ])
    expect(u.unbilledCost).toBe(120)
    expect(u.unbilledMaterialUnits).toBe(900)
    // Machine hours are counted separately from human hours: a printer
    // running overnight is not somebody working overnight.
    expect(u.unbilledMachineHours).toBe(14)
    expect(u.unbilledHours).toBe(5)
  })

  it('reports shrinkage across all work, billed or not', () => {
    // A failed client print costs the shop exactly as much as a failed test
    // print. Splitting them would understate the real number.
    const u = summarizeUnbilled([
      job({ kind: 'client', failed: 120 }),
      job({ kind: 'inhouse', failed: 80 }),
    ])
    expect(u.failedUnits).toBe(200)
  })
})

describe('the ratio only speaks when it is a measurement', () => {
  it('stays quiet under the minimum, however lopsided it looks', () => {
    const u = summarizeUnbilled([
      job({ kind: 'client', hours: 2 }),
      job({ kind: 'inhouse', hours: 1 }),
    ])
    expect(u.billableRatio).toBeCloseTo(0.6667, 3)
    // The arithmetic is right and the sample is an anecdote.
    expect(u.totalHours).toBeLessThan(MIN_HOURS)
    expect(ratioIsMeasured(u)).toBe(false)
    expect(measuredBillableHours(u)).toBeNull()
  })

  it('speaks once there are enough hours behind it', () => {
    const u = summarizeUnbilled([
      job({ kind: 'client', hours: 30 }),
      job({ kind: 'inhouse', hours: 10 }),
    ])
    expect(ratioIsMeasured(u)).toBe(true)
    expect(measuredBillableHours(u, 40)).toBeCloseTo(30, 10)
  })

  it('says what each billed hour is carrying', () => {
    // A third of the week unbilled means every billed hour carries half an
    // unbilled one -- which is exactly how much a rate set as though it
    // were not true falls short.
    const u = summarizeUnbilled([
      job({ kind: 'client', hours: 20 }),
      job({ kind: 'inhouse', hours: 10 }),
    ])
    expect(unbilledLoad(u)).toBeCloseTo(0.5, 10)
  })
})

describe('the loop back into rate guidance', () => {
  it('replaces the guess with the measurement, and it matters', () => {
    // derive.ts assumes 20 billable hours in 40. A shop that actually bills
    // 30 is being told its rate is worth a third less than it is; a shop
    // billing 9 is being told the opposite, far more dangerously.
    const assumed = rateImplies(50)
    expect(assumed?.billableHoursPerWeek).toBe(20)
    expect(assumed?.perYear).toBe(48000)

    const busy = summarizeUnbilled([
      job({ kind: 'client', hours: 30 }),
      job({ kind: 'inhouse', hours: 10 }),
    ])
    const measured = rateImplies(50, {
      billableHoursPerWeek: measuredBillableHours(busy, 40)!,
    })
    expect(measured?.perYear).toBe(72000)

    const rnd = summarizeUnbilled([
      job({ kind: 'client', hours: 9 }),
      job({ kind: 'inhouse', hours: 31 }),
    ])
    const thin = rateImplies(50, {
      billableHoursPerWeek: measuredBillableHours(rnd, 40)!,
    })
    // The number that explains being busy and broke.
    expect(thin!.perYear).toBeCloseTo(21600, 6)
    expect(thin!.perYear).toBeLessThan(assumed!.perYear)
  })
})
