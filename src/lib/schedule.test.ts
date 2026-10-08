import { describe, expect, it } from 'vitest'
import { startBy, MACHINE_HOURS_PER_DAY } from './schedule'
import type { PartRow, PartVariant, QuoteInputsRow } from './data.types'

const TODAY = new Date(2026, 8, 28) // 28 September 2026, local

function variant(estMinutes: number | null): PartVariant {
  return {
    sectionId: 's',
    importId: 'i',
    fileName: 'f.gcode',
    printerModel: 'Prusa XL',
    printerId: null,
    printerName: null,
    estMinutes,
    estGrams: 100,
    material: 'PETG',
    importedAt: '2026-09-01',
    plateParts: 1,
    sectionQty: 1,
    materialId: null,
  }
}

function part(status: PartRow['status'], minutes: number | null): PartRow {
  // One copy, its counts in step with its status, as the data layer keeps them.
  return {
    id: Math.random().toString(),
    label: 'Part',
    qty: 1,
    status,
    note: null,
    sort: 0,
    history: [],
    variants: minutes == null ? [] : [variant(minutes)],
    chosenSectionId: null,
    printedN: status === 'printed' ? 1 : 0,
    passedN: status === 'passed' ? 1 : 0,
    reprintN: status === 'reprint' ? 1 : 0,
    copyStates: [status],
  }
}

/** A part of `qty` copies with the given per-copy states, sliced on a plate
 *  that carries `sectionQty` copies in `plateMinutes`. */
function copiesPart(states: PartRow['status'][], plateMinutes: number, sectionQty: number): PartRow {
  const n = (s: PartRow['status']) => states.filter((x) => x === s).length
  return {
    ...part('pending', plateMinutes),
    qty: states.length,
    status: n('reprint') ? 'reprint' : n('pending') === states.length ? 'pending' : 'printed',
    printedN: n('printed'),
    passedN: n('passed'),
    reprintN: n('reprint'),
    copyStates: states,
    variants: [{ ...variant(plateMinutes), sectionQty }],
  }
}

const QUOTE = {
  designBilling: 'none',
  designQty: 0,
  revisionsIncl: 0,
  quantity: 4,
  materialId: null,
  printerId: null,
  unitsPerPart: 50,
  printHrsPart: 3,
  finishingHrs: 0,
  rush: false,
  flatEach: 0,
  discountPct: 0,
} as unknown as QuoteInputsRow

describe('when printing has to start', () => {
  it('says nothing without a delivery date — there is no runway to work back from', () => {
    const got = startBy({ neededBy: null, deliveryHow: null, parts: [part('pending', 600)], quote: null, today: TODAY })
    expect(got.status).toBe('unknown')
    expect(got.date).toBeNull()
  })

  it('says nothing when there is no estimate of the work either', () => {
    const got = startBy({ neededBy: '2026-10-20', deliveryHow: null, parts: [part('pending', null)], quote: null, today: TODAY })
    expect(got.status).toBe('unknown')
    expect(got.source).toBe('none')
  })

  it('works back from the date through print days, handover and slack', () => {
    // 24 h of printing at 12 h a day = 2 days, collected in person = 0,
    // plus 1 day of slack: start 3 days before 20 October.
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Collected in person',
      parts: [part('pending', 12 * 60), part('pending', 12 * 60)],
      quote: null,
      today: TODAY,
    })
    expect(got.printHours).toBe(24)
    expect(got.date).toBe('2026-10-17')
    expect(got.status).toBe('ok')
  })

  it('leaves five days for the post, and says so', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Post',
      parts: [part('pending', 12 * 60)],
      quote: null,
      today: TODAY,
    })
    // 1 print day + 5 post + 1 slack = 7
    expect(got.date).toBe('2026-10-13')
    expect(got.assumptions.some((a) => /5 days to reach them/.test(a))).toBe(true)
  })

  it('counts only work still to do — a printed part needs no runway', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Collected in person',
      parts: [part('printed', 12 * 60), part('pending', 6 * 60)],
      quote: null,
      today: TODAY,
    })
    expect(got.printHours).toBe(6)
  })

  it('counts a part sent back for reprint as work still to do', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Collected in person',
      parts: [part('reprint', 6 * 60)],
      quote: null,
      today: TODAY,
    })
    expect(got.printHours).toBe(6)
  })

  it('counts copies still to print, not parts — one test copy of five leaves four', () => {
    // A plate of 1 copy takes 3 h; 5 needed, 1 printed, 1 failed and going
    // back: 3 not printed + 1 reprint = 4 copies x 3 h.
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Collected in person',
      parts: [copiesPart(['printed', 'reprint', 'pending', 'pending', 'pending'], 3 * 60, 1)],
      quote: null,
      today: TODAY,
    })
    expect(got.printHours).toBe(12)
  })

  it('divides a plate estimate by the copies on that plate', () => {
    // The plate carries 2 copies in 4 h, so 2 h a copy; 6 copies, none
    // printed, is 12 h -- not 4 h (one plate) and not 24 h (6 plates).
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Collected in person',
      parts: [copiesPart(Array(6).fill('pending'), 4 * 60, 2)],
      quote: null,
      today: TODAY,
    })
    expect(got.printHours).toBe(12)
  })

  it('reports done when every copy is off the machine, whatever the copy count', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Courier',
      parts: [copiesPart(['printed', 'passed', 'passed'], 600, 1)],
      quote: QUOTE,
      today: TODAY,
    })
    expect(got.status).toBe('done')
  })

  it('reports done when everything is off the machines', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Courier',
      parts: [part('printed', 600), part('passed', 600)],
      quote: QUOTE,
      today: TODAY,
    })
    expect(got.status).toBe('done')
    expect(got.date).toBeNull()
  })

  it('falls back to the quote when nothing has been sliced, and admits it', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Collected in person',
      parts: [],
      quote: QUOTE,
      today: TODAY,
    })
    expect(got.source).toBe('quote')
    expect(got.printHours).toBe(12)
    expect(got.assumptions[0]).toMatch(/from the quote/)
  })

  it('goes late once the start date has passed, and says how far', () => {
    const got = startBy({
      neededBy: '2026-09-29',
      deliveryHow: 'Post',
      parts: [part('pending', 24 * 60)],
      quote: null,
      today: TODAY,
    })
    expect(got.status).toBe('late')
    expect(got.daysLeft).toBeLessThan(0)
  })

  it('warns when the start date is within two days', () => {
    // 1 print day + 0 handover + 1 slack = start two days before.
    const got = startBy({
      neededBy: '2026-10-01',
      deliveryHow: 'Collected in person',
      parts: [part('pending', MACHINE_HOURS_PER_DAY * 60)],
      quote: null,
      today: TODAY,
    })
    expect(got.date).toBe('2026-09-29')
    expect(got.status).toBe('soon')
  })

  it('every figure it used is stated, so nobody has to guess where the date came from', () => {
    const got = startBy({
      neededBy: '2026-10-20',
      deliveryHow: 'Courier',
      parts: [part('pending', 20 * 60)],
      quote: { ...QUOTE, finishingHrs: 6 },
      today: TODAY,
    })
    expect(got.assumptions.join(' ')).toMatch(/12 machine hours a day/)
    expect(got.assumptions.join(' ')).toMatch(/6 h of finishing/)
    expect(got.assumptions.join(' ')).toMatch(/2 days to reach them/)
    expect(got.assumptions.join(' ')).toMatch(/1 day of slack/)
  })
})
