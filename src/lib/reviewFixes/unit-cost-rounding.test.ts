import { expect, it } from 'vitest'
import { splitJobCost, unitCostFrom } from '../selling'

it('per-unit cost keeps fractions of a cent', () => {
  const split = splitJobCost({ actualCost: 1.2, designHours: 0 }, 85)
  expect(unitCostFrom(split, 250)).toBeCloseTo(0.0048, 6)
  const s2 = splitJobCost({ actualCost: 12.4, designHours: 0 }, 85)
  expect(unitCostFrom(s2, 400) * 400).toBeCloseTo(12.4, 6) // $0.40 of $12.40 vanishes
})
