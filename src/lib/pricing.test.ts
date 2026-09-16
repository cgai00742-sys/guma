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
  taxLabel: 'Sales tax',
  taxPct: 5,
  currency: 'USD',
  locale: 'en-US',
  electricityRateKwh: null,
  // Null across the board: these fixtures predate the overhead and failure
  // lines, and every figure they assert must be unchanged by adding them.
  // That is the whole point of a null default — no shop's quote moves.
  overheadMonthly: null,
  productiveHoursMonth: null,
  failurePct: null,
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
  watts: null,
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

describe('a tax rate with three decimal places', () => {
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

  it('flags itself incomplete without a printer watt rating and a shop electricity rate', () => {
    const q = priceQuote(MAST_BRACKETS, RATES, PACF, XL) // neither is set
    expect(q.costsIncomplete).toBe(true)
    expect(q.electricityCost).toBe(0)
  })

  it('does not flag a job that never touches a machine', () => {
    const q = priceQuote({ ...MAST_BRACKETS, flatEach: 250 }, RATES, PACF, XL) // byPiece
    expect(q.costsIncomplete).toBe(false)
  })
})

describe('electricity cost', () => {
  // A Prusa XL draws roughly this much mid-print; $0.15/kWh is a plausible
  // US average. Neither number needs to be realistic to prove the arithmetic
  // — only consistent.
  const XL_METERED: PrinterRef = { ...XL, watts: 350 }
  const RATES_METERED: RateSet = { ...RATES, electricityRateKwh: 0.15 }

  it('costs watts × hours ÷ 1000 × the rate, once both are on file', () => {
    const q = priceQuote(MAST_BRACKETS, RATES_METERED, PACF, XL_METERED)
    // 21 h × 0.35 kW × $0.15/kWh
    expect(round2(q.electricityCost)).toBe(1.1)
    expect(q.costsIncomplete).toBe(false)
  })

  it('stays incomplete if only one of the two numbers is set', () => {
    const onlyWatts = priceQuote(MAST_BRACKETS, RATES, PACF, XL_METERED)
    expect(onlyWatts.costsIncomplete).toBe(true)
    expect(onlyWatts.electricityCost).toBe(0)

    const onlyRate = priceQuote(MAST_BRACKETS, RATES_METERED, PACF, XL)
    expect(onlyRate.costsIncomplete).toBe(true)
    expect(onlyRate.electricityCost).toBe(0)
  })

  it('replaces the machine pass-through in margin with the real power cost', () => {
    const estimate = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    const metered = priceQuote(MAST_BRACKETS, RATES_METERED, PACF, XL_METERED)
    // Charging $9/h for power that costs five cents an hour is real margin —
    // the old pass-through assumption was hiding it, not being conservative.
    expect(round2(metered.margin)).toBe(258.2)
    expect(metered.margin).toBeGreaterThan(estimate.margin)
  })
})

/* ------------------------------------------------------------------ */
/* The true cost of a print                                            */
/* ------------------------------------------------------------------ */

describe('what a print actually costs', () => {
  /** The shop from the worked example, now with its real running costs on
   *  file: 32c/kWh, EUR 2,400 a month of overhead across 300 billed
   *  machine-hours, and one plate in twelve going wrong. */
  const FULL: RateSet = {
    ...RATES,
    electricityRateKwh: 0.15,
    overheadMonthly: 2400,
    productiveHoursMonth: 300,
    failurePct: 8,
  }
  /** The same printer with its wattage on file — without it there is no
   *  honest power figure and the engine falls back, which is its own test
   *  above. */
  const METERED: PrinterRef = { ...XL, watts: 350 }
  /** A material whose cost has been measured against real receipts rather
   *  than typed once at setup. */
  const PAID: MaterialRef = { ...PACF, costBasis: 'purchases' }

  it('counts six things, not four', () => {
    const q = priceQuote(MAST_BRACKETS, FULL, PACF, METERED)
    expect(q.materialCost).toBeGreaterThan(0)
    expect(q.electricityCost).toBeGreaterThan(0)
    expect(q.wearAmt).toBeGreaterThan(0)
    expect(q.overheadCost).toBeGreaterThan(0)
    expect(q.failureCost).toBeGreaterThan(0)
    expect(q.yourHours).toBeGreaterThan(0)
    // And the total is exactly their sum — no rounding drift, nothing extra.
    expect(q.totalCost).toBeCloseTo(
      q.materialCost + q.electricityCost + q.wearAmt + q.overheadCost + q.failureCost + q.yourHours,
      2,
    )
  })

  it('allocates overhead per productive machine-hour', () => {
    // EUR 2400 / 300 h = EUR 8/h. 21 machine-hours on this job.
    const q = priceQuote(MAST_BRACKETS, FULL, PACF, METERED)
    expect(q.overheadCost).toBeCloseTo(21 * 8, 2)
  })

  it('never divides by zero productive hours', () => {
    // A shop that types 2400 and then 0 would otherwise have its entire
    // month's rent allocated to one bracket.
    const q = priceQuote(MAST_BRACKETS, { ...FULL, productiveHoursMonth: 0 }, PACF, METERED)
    expect(q.overheadCost).toBe(0)
    expect(Number.isFinite(q.totalCost)).toBe(true)
    expect(q.missingCosts.map((m) => m.key)).toContain('overhead')
  })

  it('applies the failure allowance to machine-side cost, not to design hours', () => {
    const q = priceQuote(MAST_BRACKETS, FULL, PACF, METERED)
    const machineSide = q.materialCost + q.electricityCost + q.wearAmt + q.overheadCost
    expect(q.failureCost).toBeCloseTo(machineSide * 0.08, 2)
    // A failed plate does not make you model the part again, so counting
    // design hours twice would overstate the loss on design-heavy jobs.
    expect(q.failureCost).toBeLessThan((machineSide + q.yourHours) * 0.08)
  })

  it('leaves every existing quote alone when the new figures are not supplied', () => {
    // The whole reason the columns default to null. A shop that upgrades
    // must not find its margin has moved overnight.
    const before = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    expect(before.overheadCost).toBe(0)
    expect(before.failureCost).toBe(0)
    expect(round2(before.total)).toBe(1063.23)
  })

  it('names every cost it cannot measure, with the control that fixes it', () => {
    const q = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    const keys = q.missingCosts.map((m) => m.key)
    expect(keys).toContain('overhead')
    expect(keys).toContain('failure')
    for (const m of q.missingCosts) {
      // A missing line that does not say what would fill it in is just a
      // complaint. Each one names a screen.
      expect(m.fix).toMatch(/Shop settings|electricity rate|wattage/i)
      expect(m.label.length).toBeGreaterThan(4)
    }
  })

  it('says nothing is missing once everything is measured', () => {
    const q = priceQuote(MAST_BRACKETS, FULL, PAID, METERED)
    expect(q.missingCosts).toEqual([])
  })

  it('states a break-even price and a cost per piece', () => {
    const q = priceQuote(MAST_BRACKETS, FULL, PACF, METERED)
    expect(q.breakEven).toBeCloseTo(q.totalCost, 2)
    expect(q.costPerUnit).toBeCloseTo(q.totalCost / q.qty, 2)
    // Quoting at break-even earns exactly nothing, by definition.
    expect(q.total - q.tax - q.totalCost).toBeCloseTo(q.margin, 2)
  })

  it('reports a smaller margin once the missing costs are filled in', () => {
    // The point of the whole exercise: a shop that has not entered its
    // overhead and its failure rate is being shown a margin it does not
    // have.
    const naive = priceQuote(MAST_BRACKETS, RATES, PACF, XL)
    const honest = priceQuote(MAST_BRACKETS, FULL, PACF, METERED)
    expect(honest.margin).toBeLessThan(naive.margin)
    expect(honest.total).toBe(naive.total) // and the client pays the same
  })
})
