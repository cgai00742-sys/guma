import { describe, expect, it } from 'vitest'
import { materialCheck } from './scheduleCheck'

const pla = { id: 'pla', name: 'PLA Black', unit: 'g' as const, onHand: 1000 }
const petg = { id: 'petg', name: 'PETG', unit: 'g' as const, onHand: 100 }
const line = (materialId: string | null, qty: number, unitsPerPart: number) => ({
  label: 'x', printerId: 'p', materialId, qty, unitsPerPart, printHrsPerPart: 1,
})

describe('material on hand for Scheduled (CG, 8 Oct)', () => {
  it('adds the build sheet up per spool, failures included, against what is on the shelf', () => {
    const c = materialCheck([line('pla', 5, 127), line('petg', 5, 24)], null, [pla, petg], 10)
    expect(c.lines.map((l) => [l.name, l.need, l.needWithFailures, l.ok])).toEqual([
      ['PLA Black', 635, 699, true],
      ['PETG', 120, 132, false],
    ])
    expect(c.ok).toBe(false)
  })

  it('no failure rate on file means no allowance, and says so', () => {
    const c = materialCheck([line('pla', 1, 500)], null, [pla], null)
    expect([c.failurePct, c.lines[0].needWithFailures]).toEqual([null, 500])
  })

  it('a single-line quote checks quantity times grams each', () => {
    const c = materialCheck([], { materialId: 'pla', quantity: 12, unitsPerPart: 100 }, [pla], 0)
    expect([c.lines[0].need, c.ok]).toEqual([1200, false])
  })

  it('nothing with grams is nothing to check, not a pass', () => {
    expect(materialCheck([line('pla', 3, 0)], null, [pla], 5).ok).toBeNull()
  })

  it('a line with no spool is counted separately, never silently dropped', () => {
    const c = materialCheck([line(null, 2, 50), line('pla', 1, 10)], null, [pla], null)
    expect([c.unassigned, c.lines.length]).toEqual([100, 1])
  })
})
