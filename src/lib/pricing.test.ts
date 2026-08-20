/**
 * Checks the pricing module against the worked examples in the design package.
 * Run with: npm test
 *
 * The Quote PDF design file is a fully worked quote with every figure printed on
 * it, which makes it the best available oracle for the calculation. That case is
 * reproduced first, at Guam's 5% so the numbers can be compared to the printed
 * page directly. Everything after it tests the operation ORDER, which is the
 * part a later edit is most likely to get wrong.
 */
import { describe, expect, it } from 'vitest'
import { priceQuote, round2, type MaterialRef, type PrinterRef, type QuoteInputs, type RateSet } from './pricing'

const RATES: RateSet = {
  designHourly: 85,
  finishingHourly: 55,
  rushPct: 35,
  minimumOrder: 85,
  depositPct: 50,
  depositWhen: 'design',
  depositWaiveBelow: 150,
  materialMarkup: 2,
  revisionsIncl: 2,
  revisionHourly: 85,
  taxLabel: 'Guam GRT',
  taxPct: 5,
}

const PACF: MaterialRef = {
  id: 'pacf',
  name: 'PA-CF black',
  unit: 'g',
  costPerUnit: 0.095, // $95/kg
  sellOverride: null,
  swatch: '#2A3442',
}

const XL: PrinterRef = {
  id: 'xl',
  name: 'Tasa 1',
  model: 'Prusa XL 2T',
  ratePerHour: 9,
  wearPerHour: 3,
}

/** The exact job on Quote PDF.dc.html. */
const MAST_BRACKETS: QuoteInputs = {
  assetOrigin: 'model',
  designBilling: 'hourly',
  designQty: 6,
  revisions: 2,
  quantity: 4,
  unitsPerPart: 185,
  printHrsPerPart: 5.25,
  finishingHrs: 2,
  rush: false,
  flatEach: 0,
  discountPct: 0,
}

describe('the Quote PDF worked example', () => {
  const q = priceQuote(MAST_BRACKETS, RATES, PACF, XL)

  it('matches every line item printed on the PDF', () => {
    expect(round2(q.designAmt)).toBe(510.0)
    expect(round2(q.materialSell)).toBe(140.6) // 740 g × $190/kg
    expect(round2(q.machineAmt)).toBe(189.0) //  21 h × $9
    expect(round2(q.wearAmt)).toBe(63.0) //      21 h × $3
    expect(round2(q.finishingAmt)).toBe(110.0) //  2 h × $55
  })

  it('matches the printed totals block', () => {
    expect(round2(q.subtotal)).toBe(1012.6)
    expect(round2(q.tax)).toBe(50.63)
    expect(round2(q.total)).toBe(1063.23)
    expect(round2(q.perUnit)).toBe(265.81)
  })

  it('matches the printed deposit block, including the odd cent', () => {
    expect(q.deposit).toBe(531.62) // 50% of 1063.23 rounds up
    expect(q.balance).toBe(531.61) // and the balance carries the remainder
    expect(round2(q.deposit + q.balance)).toBe(round2(q.total))
  })

  it('shows the arithmetic in the basis line, not just the amount', () => {
    const basis = Object.fromEntries(q.lines.map((l) => [l.key, l.basis]))
    expect(basis.design).toContain('6 h × $85/h')
    expect(basis.material).toContain('740 g at $190/kg')
    expect(basis.machine).toContain('21 h')
    expect(basis.finishing).toContain('2 h × $55/h')
  })
})

describe('operation order', () => {
  it('applies the shop minimum BEFORE rush and discount', () => {
    // A tiny job: raw subtotal well under the $85 minimum.
    const tiny: QuoteInputs = {
      ...MAST_BRACKETS,
      designQty: 0,
      assetOrigin: 'ready',
      quantity: 1,
      unitsPerPart: 10,
      printHrsPerPart: 0.5,
      finishingHrs: 0,
      rush: true,
    }
    const q = priceQuote(tiny, RATES, PACF, XL)
    expect(q.minimumApplied).toBe(true)
    expect(round2(q.subtotal)).toBe(85)
    // rush is 35% of the MINIMUM (85), not of the raw subtotal
    expect(round2(q.rushAmt)).toBe(29.75)
  })

  it('takes the discount off subtotal + rush, not off subtotal alone', () => {
    const q = priceQuote({ ...MAST_BRACKETS, rush: true, discountPct: 10 }, RATES, PACF, XL)
    const expectedRush = round2(1012.6 * 0.35)
    expect(round2(q.rushAmt)).toBe(expectedRush)
    expect(round2(q.discountAmt)).toBe(round2((1012.6 + q.rushAmt) * 0.1))
  })

  it('applies tax LAST, to the discounted total', () => {
    const q = priceQuote({ ...MAST_BRACKETS, discountPct: 10 }, RATES, PACF, XL)
    const preTax = round2(1012.6 * 0.9)
    expect(round2(q.preTax)).toBe(preTax)
    expect(round2(q.tax)).toBe(round2(preTax * 0.05))
    // tax is NOT charged on the pre-discount figure
    expect(round2(q.tax)).not.toBe(round2(1012.6 * 0.05))
  })

  it('bases the deposit on the total INCLUDING tax', () => {
    const q = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    expect(q.deposit).toBe(round2(q.total * 0.5))
    expect(q.deposit).not.toBe(round2(q.preTax * 0.5))
  })
})

describe('the deposit threshold', () => {
  const small: QuoteInputs = {
    ...MAST_BRACKETS,
    assetOrigin: 'ready',
    quantity: 1,
    unitsPerPart: 100,
    printHrsPerPart: 2,
    finishingHrs: 0,
  }

  it('waives the deposit under the threshold', () => {
    const q = priceQuote(small, RATES, PACF, XL) // ~$63 build, held at $85 min
    expect(q.total).toBeLessThan(RATES.depositWaiveBelow)
    expect(q.depositWaived).toBe(true)
    expect(q.deposit).toBe(0)
    expect(q.balance).toBe(round2(q.total))
  })

  it('takes a deposit once the total clears the threshold', () => {
    const q = priceQuote({ ...small, quantity: 4, finishingHrs: 1 }, RATES, PACF, XL)
    expect(q.total).toBeGreaterThan(RATES.depositWaiveBelow)
    expect(q.depositWaived).toBe(false)
    expect(q.deposit).toBeGreaterThan(0)
  })

  it('takes no deposit at all when the shop has turned them off', () => {
    const q = priceQuote(MAST_BRACKETS, { ...RATES, depositWhen: 'none' }, PACF, XL)
    expect(q.deposit).toBe(0)
  })
})

describe('asset origin', () => {
  it('removes the design line entirely for a print-ready file', () => {
    const q = priceQuote({ ...MAST_BRACKETS, assetOrigin: 'ready' }, RATES, PACF, XL)
    expect(q.needsDesign).toBe(false)
    expect(q.designAmt).toBe(0)
    expect(q.lines.find((l) => l.key === 'design')).toBeUndefined()
  })

  it('reads the design figure as dollars when billing is flat', () => {
    const q = priceQuote({ ...MAST_BRACKETS, designBilling: 'flat', designQty: 600 }, RATES, PACF, XL)
    expect(q.designAmt).toBe(600) // not 600 × $85
  })

  it('does not credit a flat design fee to your own hours', () => {
    const hourly = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    const flat = priceQuote({ ...MAST_BRACKETS, designBilling: 'flat', designQty: 510 }, RATES, PACF, XL)
    expect(hourly.yourHours).toBe(510 + 110)
    expect(flat.yourHours).toBe(110) // finishing only — the overrun is yours
  })
})

describe('flat per-item pricing', () => {
  it('overrides the material, machine and finishing lines', () => {
    const q = priceQuote({ ...MAST_BRACKETS, flatEach: 250 }, RATES, PACF, XL)
    expect(q.byPiece).toBe(true)
    expect(round2(q.rawSubtotal)).toBe(round2(510 + 250 * 4))
    const keys = q.lines.map((l) => l.key)
    expect(keys).toContain('piece')
    expect(keys).not.toContain('material')
    expect(keys).not.toContain('machine')
  })

  it('still counts material as a real cost against margin', () => {
    const q = priceQuote({ ...MAST_BRACKETS, flatEach: 250 }, RATES, PACF, XL)
    expect(round2(q.materialCost)).toBe(70.3) // 740 g × $95/kg — you still bought it
  })
})

describe('no rate is a constant', () => {
  it('re-prices when the shop moves its rates', () => {
    const cheaper = priceQuote(MAST_BRACKETS, { ...RATES, designHourly: 60 }, PACF, XL)
    expect(round2(cheaper.designAmt)).toBe(360)
  })

  it('re-prices when the material markup moves', () => {
    const q = priceQuote(MAST_BRACKETS, { ...RATES, materialMarkup: 3 }, PACF, XL)
    expect(round2(q.materialSell)).toBe(round2(740 * 0.095 * 3))
  })

  it('honours a per-material sell override against the shop multiplier', () => {
    const pinned = { ...PACF, sellOverride: 0.25 }
    const q = priceQuote(MAST_BRACKETS, RATES, pinned, XL)
    expect(round2(q.materialSell)).toBe(185)
  })

  it('handles a resin material priced per mL', () => {
    const resin: MaterialRef = {
      id: 'resin', name: 'Flexible 80A', unit: 'ml',
      costPerUnit: 0.16, sellOverride: null, swatch: '#8E7BFF',
    }
    const q = priceQuote({ ...MAST_BRACKETS, unitsPerPart: 40 }, RATES, resin, XL)
    expect(round2(q.materialSell)).toBe(round2(40 * 4 * 0.32))
    expect(q.lines.find((l) => l.key === 'material')?.basis).toContain('mL')
  })
})

describe('Maui — Hawaii GET at 4.712%', () => {
  const HI: RateSet = { ...RATES, taxLabel: 'Hawaii GET', taxPct: 4.712 }

  it('carries three decimal places through the tax line', () => {
    const q = priceQuote(MAST_BRACKETS, HI, PACF, XL)
    expect(round2(q.tax)).toBe(round2(1012.6 * 0.04712))
    expect(round2(q.total)).toBe(1060.31)
    expect(q.adjustments.find((a) => a.key === 'tax')?.label).toBe('Hawaii GET · 4.712%')
  })
})

describe('margin', () => {
  it('is what is left after paying yourself, and excludes tax', () => {
    const q = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    // 1063.23 − 50.63 tax − 70.30 material − 189 machine − 63 wear − 620 your hours
    expect(round2(q.margin)).toBe(70.3)
  })

  it('goes negative when the rates do not cover the work', () => {
    const q = priceQuote(MAST_BRACKETS, { ...RATES, materialMarkup: 0.5 }, PACF, XL)
    expect(q.margin).toBeLessThan(0)
  })
})
