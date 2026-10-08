/** priceQuote computes electricity from the single `printer` argument even
 *  when every build line runs on another machine. */
import { expect, it } from 'vitest'
import { priceQuote } from '../pricing'
import { RATES, PLA, A, B } from './fixtures.test.helpers'

it('build lines are costed on their own machine, not the dropdown one', () => {
  const rates = { ...RATES, electricityRateKwh: 0.4 }
  const q = priceQuote({ assetOrigin: 'ready', designBilling: 'hourly', designQty: 0, revisions: 0, quantity: 1,
    unitsPerPart: 0, printHrsPerPart: 0, finishingHrs: 0, rush: false, flatEach: 0, discountPct: 0,
    builds: [{ key: 'x', label: 'Hull', printerId: 'a', materialId: 'pla', qty: 1, unitsPerPart: 100, printHrsPerPart: 10 }] },
    rates, PLA, B /* Intake's hidden dropdown default */, { materials: [PLA], printers: [A, B] })
  // 10 h x 1.0 kW x $0.40 = $4.00 on printer A
  expect(q.electricityCost).toBeCloseTo(4, 6) // costed on the line's own 1000 W machine
})
