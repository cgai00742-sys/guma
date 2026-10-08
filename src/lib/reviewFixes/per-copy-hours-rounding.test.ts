import { expect, it } from 'vitest'
import { buildsFromFile } from '../quoteFromFile'

it('qty x per-part gives back the plate time', () => {
  const file = { kind: '3mf' as const, fileName: 'k.3mf', printerModel: null, suggestedGroup: 'k', notes: [],
    sections: [{ label: 'Keychain', qty: 48, estMinutes: 300, estGrams: 480, material: 'PLA' }],
    totals: { sections: 1, units: 48, estMinutes: 300, estGrams: 480, material: 'PLA' } }
  const [b] = buildsFromFile(file, 'f', null, null)
  expect(b.qty * b.printHrsPerPart).toBeCloseTo(5, 1) // slicer said 5.0 h
})
