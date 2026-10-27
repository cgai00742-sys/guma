/** quotedMargin subtracts overhead + failure; actualMargin never does. */
import { expect, it } from 'vitest'
import { compareToQuote } from '../actuals'
import { priceQuote } from '../pricing'
import { RATES, PLA, A } from './fixtures.test.helpers'

it('actuals identical to the quote report the same margin', () => {
  const rates = { ...RATES, overheadMonthly: 1000, productiveHoursMonth: 100, failurePct: 10 }
  const q = priceQuote({ assetOrigin: 'ready', designBilling: 'hourly', designQty: 0, revisions: 0, quantity: 1,
    unitsPerPart: 400, printHrsPerPart: 10, finishingHrs: 0, rush: false, flatEach: 0, discountPct: 0 },
    rates, PLA, { ...A, watts: null })
  const c = compareToQuote(q, { materialUnits: 400, failedUnits: 0, materialCost: q.materialCost, machineHours: 10,
    machineCost: q.machineAmt, wearCost: q.wearAmt, powerCost: 0, runs: 1, failedRuns: 0, designHours: 0,
    finishingHours: 0, adminHours: 0 }, rates)
  expect(c.lines.filter((l) => l.actual !== null).every((l) => l.delta === 0)).toBe(true)
  expect(c.quotedMargin).toBe(c.actualMargin) // like for like: // 110 net - (10 mat + 80 machine + 10 wear + 100 overhead + 20 failure)
  expect(c.actualMargin).toBe(10)
})

it('equipment and hardware come off the real margin, as their own lines, without making it partial (CG, 27 Oct)', () => {
  const rates = { ...RATES, overheadMonthly: 0, productiveHoursMonth: 100, failurePct: 0 }
  const q = priceQuote({ assetOrigin: 'ready', designBilling: 'hourly', designQty: 0, revisions: 0, quantity: 1,
    unitsPerPart: 400, printHrsPerPart: 10, finishingHrs: 0, rush: false, flatEach: 0, discountPct: 0 },
    rates, PLA, { ...A, watts: null })
  const base = { materialUnits: 400, failedUnits: 0, materialCost: q.materialCost, machineHours: 10,
    machineCost: q.machineAmt, wearCost: q.wearAmt, powerCost: 0, runs: 1, failedRuns: 0, designHours: 1,
    finishingHours: 0, adminHours: 0 }
  const without = compareToQuote(q, base, rates)
  const withExtras = compareToQuote(q, { ...base, equipmentHours: 6, equipmentCost: 0.53, hardwareCost: 1.2 }, rates)
  expect(withExtras.lines.map((l) => l.key)).toEqual(['material', 'machine', 'wear', 'labour', 'equipment', 'hardware'])
  expect(withExtras.actualCost).toBeCloseTo((without.actualCost ?? 0) + 1.73, 6)
  expect(withExtras.partial).toBe(without.partial)
  // Nothing recorded: no extra lines at all.
  expect(without.lines.map((l) => l.key)).toEqual(['material', 'machine', 'wear', 'labour'])
})
