import { describe, expect, it } from 'vitest'
import type { PartRow } from './data.types'
import { guessSort, nameFromFile, sameSize, toAssign } from './sortParts'

const part = (id: string, label: string, sizes: { g: number; m: number; q?: number }[]): PartRow =>
  ({
    id,
    label,
    variants: sizes.map((s, i) => ({
      sectionId: `${id}-${i}`,
      importId: 'i',
      fileName: 'f',
      printerModel: null,
      printerId: null,
      printerName: null,
      estMinutes: s.m,
      estGrams: s.g,
      material: null,
      importedAt: '',
      plateParts: 1,
      sectionQty: s.q ?? 1,
      materialId: null,
    })),
  }) as unknown as PartRow

describe('naming a part from a PrusaSlicer file name', () => {
  it('drops the slicer settings and the browser copy number', () => {
    expect(nameFromFile('Sliced_Outer Islands_Maui_BATHY_3x_0.4n_0.1mm_PLA_XLIS_29m.bgcode')).toBe('Outer Islands Maui BATHY 3x')
    expect(nameFromFile('Sliced_Maui_BATHY_3x_0.4n_0.1mm_PLA_XLIS_16h26m (1).bgcode')).toBe('Maui BATHY 3x')
    expect(nameFromFile('MauiNui_12×7inch_model_0.4n_0.1mm_PLA,PLA_XLIS_13h35m.bgcode')).toBe('MauiNui 12×7inch model')
    expect(nameFromFile('Reef buoy.gcode.3mf')).toBe('Reef buoy')
  })
})

describe('guessing where each object goes (CG, 16 Oct)', () => {
  const bathy = part('p1', 'Maui BATHY 3x', [{ g: 355, m: 986 }])
  it('matches a same-named object of the same size', () => {
    const [g] = guessSort([{ label: 'Maui BATHY 3x', qty: 1, estGrams: 340, estMinutes: 990 }], 'x.bgcode', [bathy])
    expect(g).toEqual({ choice: { kind: 'part', partId: 'p1' }, why: null })
  })
  it('does not match a same-named object of a different size, and says why', () => {
    const [g] = guessSort(
      [{ label: 'Maui BATHY 3x', qty: 1, estGrams: 117, estMinutes: 434 }],
      'Sliced_Maui_BATHY_3x_0.4n_0.1mm_PLA_XLIS_7h14m.bgcode',
      [bathy],
    )
    expect(g.choice).toEqual({ kind: 'new', label: 'Maui BATHY 3x (2)' })
    expect(g.why).toMatch(/Same name as Maui BATHY 3x \(355 g, 16h 26m a copy\), but this is 117 g, 7h 14m/)
  })
  it('names a one-object file after the file when its object name is taken by a different part', () => {
    const flush = part('p2', 'Maui LAND FLUSH 3x', [{ g: 140, m: 600 }])
    const [g] = guessSort(
      [{ label: 'Maui LAND FLUSH 3x', qty: 2, estGrams: 2, estMinutes: 29 }],
      'Sliced_Outer Islands_Maui_BATHY_3x_0.4n_0.1mm_PLA_XLIS_29m.bgcode',
      [flush],
    )
    expect(g.choice).toEqual({ kind: 'new', label: 'Outer Islands Maui BATHY 3x' })
  })
  it('compares one copy with one copy', () => {
    const two = part('p3', 'Tile', [{ g: 100, m: 60, q: 2 }])
    expect(guessSort([{ label: 'Tile', qty: 1, estGrams: 50, estMinutes: 30 }], 't.gcode', [two])[0].choice).toEqual({ kind: 'part', partId: 'p3' })
  })
  it('joins an object to the new part an earlier file of the batch is making', () => {
    const [g] = guessSort([{ label: 'Cap', qty: 1, estGrams: 12, estMinutes: 41 }], 'b.gcode', [], [
      { label: 'Cap', objectLabel: 'Cap', grams: 12, minutes: 41, fileName: 'a.gcode' },
    ])
    expect(g.choice).toEqual({ kind: 'join', label: 'Cap' })
    expect(toAssign(g.choice)).toEqual({ label: 'Cap' })
  })
  it('names an object with no label of its own after the cleaned file name', () => {
    expect(
      guessSort(
        [{ label: 'Maui STANDALONE 3x 0.4n 0.1mm PLA XLIS 7h16m', qty: 1, estGrams: 66, estMinutes: 436 }],
        'Maui_STANDALONE_3x_0.4n_0.1mm_PLA_XLIS_7h16m.gcode',
        [],
      )[0].choice,
    ).toEqual({ kind: 'new', label: 'Maui STANDALONE 3x' })
  })
  it('a part with no file yet is matched by name', () => {
    expect(guessSort([{ label: 'Cap', qty: 1, estGrams: 12, estMinutes: 41 }], 'b.gcode', [part('p4', 'cap', [])])[0].choice).toEqual({
      kind: 'part',
      partId: 'p4',
    })
  })
  it('within 15%', () => {
    expect(sameSize({ grams: 100, minutes: null }, { grams: 120, minutes: null })).toBe(false)
    expect(sameSize({ grams: 100, minutes: null }, { grams: 114, minutes: null })).toBe(true)
  })
})

describe('a part with a failed copy owed gets first call on a new file (CG, 26 Oct)', () => {
  const failing = (label: string, g: number) =>
    ({ ...part('pf', label, [{ g, m: 14 }]), copyStates: ['printed', 'reprint', 'pending'] }) as PartRow

  it('fills the failed copy of a same-named part, even when the reprint was re-sliced to a different size', () => {
    const [g] = guessSort([{ label: 'Tachang Hafen Falina to Gahet', qty: 1, estGrams: 2.5, estMinutes: 9 }], 'Gahet (2).bgcode', [
      failing('Tachang Hafen Falina to Gahet', 0.5),
    ])
    expect(g.choice).toEqual({ kind: 'part', partId: 'pf' })
    expect(g.why).toMatch(/has 1 failed copy going back, so this is set to fill it — though this one is/)
  })
  it('says nothing extra when the size matches too', () => {
    const [g] = guessSort([{ label: 'Gahet', qty: 1, estGrams: 4.9, estMinutes: 14 }], 'g.bgcode', [failing('Gahet', 4.9)])
    expect(g).toEqual({ choice: { kind: 'part', partId: 'pf' }, why: null })
  })
  it('matches the same piece numbered differently', () => {
    const [g] = guessSort([{ label: 'Gahet (Instance 2)', qty: 1, estGrams: 4.9, estMinutes: 14 }], 'g.bgcode', [failing('Gahet', 4.9)])
    expect(g.choice).toEqual({ kind: 'part', partId: 'pf' })
  })
  it('does not reach a differently named part with no failures', () => {
    const ok = { ...part('po', 'Gahet', [{ g: 4.9, m: 14 }]), copyStates: ['printed'] } as PartRow
    const [g] = guessSort([{ label: 'Gahet (Instance 2)', qty: 1, estGrams: 4.9, estMinutes: 14 }], 'g.bgcode', [ok])
    expect(g.choice.kind).toBe('new')
  })
})

describe('a part on the sheet with no file yet is waiting for one (CG, 26 Oct)', () => {
  const waiting = (id: string, label: string) => ({ ...part(id, label, []), copyStates: ['pending', 'pending', 'pending', 'pending', 'pending'] }) as PartRow
  it('fills it by name, or the same piece numbered, one object each', () => {
    const gs = guessSort(
      [
        { label: 'Gahet', qty: 1, estGrams: 5, estMinutes: 14 },
        { label: 'Gahet', qty: 1, estGrams: 5, estMinutes: 14 },
      ],
      'Gahet.bgcode',
      [waiting('a', 'Gahet (Instance 1)'), waiting('b', 'Gahet (Instance 2)')],
    )
    expect(gs.map((g) => g.choice)).toEqual([
      { kind: 'part', partId: 'a' },
      { kind: 'part', partId: 'b' },
    ])
    expect(gs[0].why).toMatch(/on the sheet with no file yet/)
  })
  it('says nothing extra when the name is exactly the same', () => {
    const [g] = guessSort([{ label: 'Lahi', qty: 1, estGrams: 5, estMinutes: 14 }], 'x.bgcode', [waiting('l', 'Lahi')])
    expect(g).toEqual({ choice: { kind: 'part', partId: 'l' }, why: null })
  })
})
