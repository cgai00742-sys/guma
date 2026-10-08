import { expect, it } from 'vitest'
import { flagsFor } from '../gates'
import type { ProjectFacts } from '../data.types'

const base = { phase: 'building', kind: 'client', priority: 'medium', createdAt: '2026-08-01T00:00:00Z', takenInAt: null,
  neededBy: null, windowFrom: null, windowLocked: false, atRisk: false, overCeiling: null,
  wentAheadWithout: { accepted: null, deposit: null }, printerId: null, deliveryOn: null, deliveryHow: null, brief: null,
  poc: null, quoteStatus: 'accepted', depositDue: 0, depositOwed: 0, balanceOwed: 0, lastActivityAt: null,
  actualRuns: 1, actualHours: 0, machineHours: 0, materialUnits: 0, failedUnits: 0, parts: 0, partsPrinted: 0,
  partsPassed: 0, partsReprint: 0, reprintsEver: 0, unitsMade: 0, archivedAt: null, relatedTo: null, seriesId: null,
} as unknown as ProjectFacts

it('a discounted quote priced AT the minimum is not flagged under minimum', () => {
  // raw 30 -> minimum 50, 10% discount -> 45, +4.712% tax -> 47.12
  const f = flagsFor({ ...base, quoteTotal: 47.12, quotePreTax: 45, quoteListPrice: 50, minimumOrder: 50, actualCost: 0, hasActuals: false }, new Date(2026, 9, 8))
  expect(f.some((x) => x.key === 'under-minimum')).toBe(false)
})
