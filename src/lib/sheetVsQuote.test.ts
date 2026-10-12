import { describe, expect, it } from 'vitest'
import { sheetVsQuote } from './sheetVsQuote'
import type { PartRow, PartVariant, QuoteBuildInput } from './data.types'

const line = (label: string, qty = 1): QuoteBuildInput => ({
  label, printerId: 'pr', materialId: 'pla', qty, unitsPerPart: 3.4, printHrsPerPart: 0.22,
})
const variant = (o: Partial<PartVariant> = {}): PartVariant => ({
  sectionId: 's1', importId: 'imp', fileName: 'x.bgcode', printerModel: null, printerId: 'xl',
  printerName: 'XL', estMinutes: 120, estGrams: 40, material: 'PLA', importedAt: '2026-10-08',
  plateParts: 1, sectionQty: 2, materialId: 'petg', ...o,
})
let n = 0
const part = (label: string, qty: number, variants: PartVariant[] = []): PartRow => ({
  id: `p${++n}`, label, qty, status: 'pending', note: null, sort: n, history: [], variants, chosenSectionId: null, printedN: 0, passedN: 0, reprintN: 0, copyStates: [], spareN: 0,
})

describe('the build sheet, read back as quote lines (CG, 8 Oct)', () => {
  it('five of every part reprices every line at five copies', () => {
    const quoted = [line('Tachang Falina to Gahet'), line('Gahet (Instance 1)'), line('Gahet (Instance 2)')]
    const parts = quoted.map((q) => part(q.label, 5))
    const r = sheetVsQuote(quoted, 3, parts)
    expect(r.changed).toBe(true)
    expect(r.builds.map((b) => b.qty)).toEqual([5, 5, 5])
    // Per-copy figures stay as quoted.
    expect(r.builds[0].unitsPerPart).toBe(3.4)
    expect([r.quotedCopies, r.sheetCopies]).toEqual([3, 15])
  })

  it('nothing changed reads as nothing changed', () => {
    const quoted = [line('A', 2)]
    expect(sheetVsQuote(quoted, 2, [part('A', 2)]).changed).toBe(false)
    expect(sheetVsQuote(quoted, 2, []).changed).toBe(false)
  })

  it('two parts with one name take one line each, in order', () => {
    const r = sheetVsQuote([line('Peg'), line('Peg')], 2, [part('Peg', 3), part('Peg', 4)])
    expect(r.builds.map((b) => b.qty)).toEqual([3, 4])
  })

  it('a part added from a file since quoting prices from the file, per copy', () => {
    const r = sheetVsQuote([line('A')], 1, [part('A', 1), part('Lid', 3, [variant()])])
    expect(r.added).toEqual(['Lid'])
    const lid = r.builds[1]
    expect([lid.qty, lid.unitsPerPart, lid.printHrsPerPart, lid.printerId, lid.materialId]).toEqual([3, 20, 1, 'xl', 'petg'])
  })

  it('a part with no file and no line is named, never priced at zero', () => {
    const r = sheetVsQuote([line('A')], 1, [part('A', 1), part('Hand-typed', 2)])
    expect(r.unpriced).toEqual(['Hand-typed'])
    expect(r.builds).toHaveLength(1)
  })

  it('a quote line no part matches is kept as quoted, and named', () => {
    const r = sheetVsQuote([line('A'), line('Assembly kit', 1)], 2, [part('A', 4)])
    expect(r.quotedOnly).toEqual(['Assembly kit'])
    expect(r.builds.map((b) => [b.label, b.qty])).toEqual([['A', 4], ['Assembly kit', 1]])
  })

  it('a single-line quote takes the sheet total as its quantity', () => {
    const r = sheetVsQuote([], 12, [part('Bracket', 10), part('Cap', 10)])
    expect([r.quantity, r.changed]).toEqual([20, true])
  })
})
