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

it('a job costing more than its net price is Underwater, tax aside', () => {
  // preTax 100 + 20% VAT = 120 total; 110 spent -> losing 10
  const f = flagsFor({ ...base, quoteTotal: 120, quotePreTax: 100, quoteListPrice: 100, minimumOrder: 0, actualCost: 110, hasActuals: true }, new Date(2026, 9, 8))
  expect(f.find((x) => x.key === 'over-budget')?.label).toBe('Underwater')
})

