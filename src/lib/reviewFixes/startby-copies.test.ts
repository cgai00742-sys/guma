/** startBy reads a variant's estMinutes as the whole part, ignoring part.qty,
 *  variant.sectionQty and copies already printed. */
import { expect, it } from 'vitest'
import { startBy } from '../schedule'
import type { PartRow } from '../data.types'

it('five copies of a 6 h part are scheduled as 30 h', () => {
  const p: PartRow = { id: 'p', label: 'Hull', qty: 5, status: 'pending', note: null, sort: 0, history: [],
    printedN: 0, passedN: 0, reprintN: 0, copyStates: [], spareN: 0, chosenSectionId: null,
    variants: [{ sectionId: 's', importId: 'i', fileName: 'test-plate.gcode', printerModel: null, printerId: null,
      printerName: null, estMinutes: 360, estGrams: 100, material: null, importedAt: '2026-09-01', plateParts: 1,
      sectionQty: 1, materialId: null }] }
  const got = startBy({ neededBy: '2026-10-20', deliveryHow: 'Collected in person', parts: [p], quote: null,
    today: new Date(2026, 9, 8) })
  expect(got.printHours).toBe(30) // five copies of a 6 h single-copy plate
  expect(got.date).toBe('2026-10-16')
})
