import { describe, expect, it } from 'vitest'
import { assemblyStatus, gramsUsed, parseNeeds, plateObjects, runCost, splitCost } from './madeItems'

const mat = [{ id: 'pla', name: 'PLA', unit: 'g' as const, costPerUnit: 0.02, sellOverride: null, swatch: '' }]
const prn = [{ id: 'xl', name: 'Hatsa', model: 'XL', ratePerHour: 1.5, wearPerHour: 0.25, watts: null }]

describe('what a print cost, and each object of it (CG, 21 Oct)', () => {
  it('costs a run the way job_actuals does', () => {
    expect(runCost({ hours: 2, unitsUsed: 100, materialId: 'pla', printerId: 'xl' }, mat, prn, null)).toBe(2 + 3 + 0.5)
    const metered = [{ ...prn[0], watts: 300 }]
    expect(runCost({ hours: 2, unitsUsed: 100, materialId: 'pla', printerId: 'xl' }, mat, metered, 0.4)).toBeCloseTo(2 + 0.24 + 0.5, 6)
  })
  it('lists every copy of every object on the plate', () => {
    const objs = plateObjects(
      [
        { id: 's1', label: 'Tile', qty: 2, estGrams: 40 },
        { id: 's2', label: 'Cap', qty: 1, estGrams: 12 },
      ],
      52,
    )
    expect(objs.map((o) => [o.label, o.grams])).toEqual([
      ['Tile', 20],
      ['Tile', 20],
      ['Cap', 12],
    ])
  })
  it('splits the cost by grams, a failed object at what it weighed, and the shares add up', () => {
    const objs = [
      { sectionId: 'a', label: 'BATHY', grams: 117, failed: false, weighed: null },
      { sectionId: 'b', label: 'FLUSH', grams: 42, failed: false, weighed: null },
      { sectionId: 'c', label: 'Outer Islands', grams: 2, failed: true, weighed: 1 },
    ]
    const s = splitCost(objs, 16)
    expect(s.map((x) => x.unitCost).reduce((a, b) => a + b, 0)).toBeCloseTo(16, 5)
    expect(s[0].unitCost).toBeCloseTo((16 * 117) / 160, 5)
    expect(s[2]).toEqual({ grams: 1, unitCost: expect.closeTo(0.1, 5) })
    expect(gramsUsed(objs)).toBe(160)
  })
  it('splits evenly when the file gave no grams', () => {
    expect(splitCost([{ sectionId: null, label: 'A', grams: null, failed: false, weighed: null }, { sectionId: null, label: 'B', grams: null, failed: false, weighed: null }], 3).map((x) => x.unitCost)).toEqual([1.5, 1.5])
  })
})

describe('an assembly, and what it still needs', () => {
  it('counts what it has against what it needs, by name', () => {
    const st = assemblyStatus(
      [
        { label: 'Maui BATHY 3x', qty: 1 },
        { label: 'Maui LAND FLUSH 3x', qty: 2 },
      ],
      [{ label: 'maui bathy 3x' }, { label: 'Maui LAND FLUSH 3x' }, { label: 'Spare pin' }],
    )
    expect(st.lines).toEqual([
      { label: 'Maui BATHY 3x', qty: 1, have: 1, missing: 0 },
      { label: 'Maui LAND FLUSH 3x', qty: 2, have: 1, missing: 1 },
    ])
    expect(st.extras).toEqual([{ label: 'Spare pin', n: 1 }])
    expect(st).toMatchObject({ missing: 1, complete: false })
  })
  it('reads needs back safely', () => {
    expect(parseNeeds('[{"label":" Base ","qty":2},{"label":"","qty":1},{"x":1}]')).toEqual([{ label: 'Base', qty: 2 }])
    expect(parseNeeds('nope')).toEqual([])
  })
})
