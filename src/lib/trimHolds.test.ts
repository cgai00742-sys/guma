import { describe, expect, it } from 'vitest'
import { trimHolds } from './scheduleCheck'

const line = (materialId: string, needWithFailures: number) => ({ materialId, name: materialId.toUpperCase(), unit: 'g' as const, needWithFailures })

describe('the hold after the build sheet needs less (CG, 12 Oct)', () => {
  it('comes down to the new need, and says how much went back', () => {
    expect(trimHolds([line('pla', 560)], [{ materialId: 'pla', held: 700 }])).toEqual({
      holds: [{ materialId: 'pla', units: 560 }],
      released: [{ name: 'PLA', unit: 'g', units: 140 }],
    })
  })
  it('never goes up', () => {
    expect(trimHolds([line('pla', 900)], [{ materialId: 'pla', held: 700 }])).toBeNull()
  })
  it('leaves a spool the sheet no longer prices alone, and keeps it in the list', () => {
    const r = trimHolds([line('pla', 100)], [{ materialId: 'pla', held: 300 }, { materialId: 'petg', held: 50 }])
    expect(r?.holds).toEqual([{ materialId: 'pla', units: 100 }, { materialId: 'petg', units: 50 }])
  })
  it('nothing held, nothing to release', () => {
    expect(trimHolds([line('pla', 100)], [])).toBeNull()
  })
})
