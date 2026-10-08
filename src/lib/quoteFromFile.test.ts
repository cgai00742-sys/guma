import { describe, expect, it } from 'vitest'
import { buildsFromFile } from './quoteFromFile'
import type { SliceFile } from './sliceImport'

describe('a sliced file as quote lines', () => {
  it('gives one line per object, per-copy figures that add back to the plate', () => {
    const f = {
      sections: [
        { label: 'Buoy shell', qty: 2, estMinutes: 82, estGrams: 57.7, material: 'PETG' },
        { label: 'Cap', qty: 1, estMinutes: 41, estGrams: 28.8, material: 'PETG' },
      ],
    } as unknown as SliceFile
    const lines = buildsFromFile(f, 'a', 'p1', 'm1')
    expect(lines).toEqual([
      { key: 'a:0', label: 'Buoy shell', printerId: 'p1', materialId: 'm1', qty: 2, unitsPerPart: 28.85, printHrsPerPart: 0.68 },
      { key: 'a:1', label: 'Cap', printerId: 'p1', materialId: 'm1', qty: 1, unitsPerPart: 28.8, printHrsPerPart: 0.68 },
    ])
  })

  it('leaves the numbers at zero when the file had none, rather than inventing them', () => {
    const f = { sections: [{ label: 'X', qty: 1, estMinutes: null, estGrams: null, material: null }] } as unknown as SliceFile
    expect(buildsFromFile(f, 'b', null, null)[0]).toMatchObject({ unitsPerPart: 0, printHrsPerPart: 0 })
  })
})
