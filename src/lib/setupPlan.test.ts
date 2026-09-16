/**
 * What a shop still needs, and what the gaps are costing it.
 *
 * The assertion that carries this file is that a MISSING COST INPUT IS NOT
 * NEUTRAL. Guma degrades gracefully when it does not know something — it
 * prices machine time at break-even rather than guessing — which is the
 * right behaviour and also the reason a half-configured shop looks fine
 * while reporting margins that cannot be true. A plan that only said
 * "electricity rate: not set" would be a worse version of the blank field
 * it is describing.
 */
import { describe, expect, it } from 'vitest'
import { planFor, type ShopSnapshot } from './setupPlan'
import { makeRateCard, makeShop, PRINTER_ROW } from './fixtures'
import type { MaterialRow, PrinterRow } from './data.types'

const material = (over: Partial<MaterialRow> = {}): MaterialRow =>
  ({
    id: 'mat-1', name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g',
    costPerUnit: 0.095, sellOverride: null, archived: 0, stockUnits: 0,
    ...over,
  }) as unknown as MaterialRow

const printer = (over: Partial<PrinterRow> = {}): PrinterRow => ({ ...PRINTER_ROW, ...over })

/** A shop with everything answered. Each test takes something away. */
const complete = (over: Partial<ShopSnapshot> = {}): ShopSnapshot => ({
  shop: makeShop(),
  rateCard: makeRateCard(),
  printerRows: [printer()],
  materials: [material()],
  ...over,
})

const section = (s: ShopSnapshot, id: string) =>
  planFor(s).sections.find((x) => x.id === id)!

describe('a shop with everything answered', () => {
  it('is finished, and says so without qualification', () => {
    const plan = planFor(complete())
    expect(plan.done).toBe(true)
    expect(plan.completeness).toBe(1)
    expect(plan.remaining).toEqual([])
    expect(plan.distorting).toEqual([])
  })
})

describe('a gap in a cost input is never reported as neutral', () => {
  it('says what a missing electricity rate does to every margin', () => {
    const s = complete({ shop: makeShop({ electricity_rate_kwh: null }) })
    const power = section(s, 'power')
    expect(power.status).toBe('missing')
    expect(power.distorts).toBe(true)
    // Not "optional" -- the consequence, in a sentence somebody can act on.
    expect(power.cost).toMatch(/break-even|floor/i)
  })

  it('says material reading as free flatters the quote', () => {
    const s = complete({ materials: [material({ costPerUnit: 0 })] })
    const mats = section(s, 'materials')
    expect(mats.status).toBe('partial')
    expect(mats.distorts).toBe(true)
    expect(mats.cost).toMatch(/free|flatter/i)
  })

  it('says unpriced hours are how a shop works a year for free', () => {
    const s = complete({ rateCard: makeRateCard({ design_hourly: 0, finishing_hourly: 0 }) })
    const labour = section(s, 'labour')
    expect(labour.missing).toEqual(['design rate', 'finishing rate'])
    expect(labour.distorts).toBe(true)
    expect(labour.cost).toBeTruthy()
  })

  it('separates a machine with no wear from having no machine at all', () => {
    const none = section(complete({ printerRows: [] }), 'machines')
    expect(none.status).toBe('missing')
    expect(none.cost).toMatch(/nothing can be priced/i)

    const incomplete = section(complete({ printerRows: [printer({ watts: null })] }), 'machines')
    expect(incomplete.status).toBe('partial')
    expect(incomplete.missing).toContain('power draw in watts')
    expect(incomplete.cost).toMatch(/more profitable than they are/i)
  })

  it('ignores a retired machine when deciding whether there is one', () => {
    const s = complete({ printerRows: [printer({ archived: 1 })] })
    expect(section(s, 'machines').missing).toContain('at least one machine')
  })
})

describe('what counts as a distortion', () => {
  it('does not treat a deliberate terms choice as one', () => {
    // A shop can rationally run with no minimum and no markup. It cannot
    // rationally run with material priced at zero, and the difference is
    // the whole point of the flag: distortions are worth interrupting
    // somebody about, preferences are not.
    const s = complete({
      rateCard: makeRateCard({ minimum_order: 0, deposit_pct: 0, material_markup: 1 }),
    })
    const terms = section(s, 'terms')
    expect(terms.status).toBe('missing')
    expect(terms.distorts).toBe(false)
    expect(planFor(s).distorting.map((x) => x.id)).not.toContain('terms')
  })

  it('does not treat a missing phone number as one', () => {
    const s = complete({ shop: makeShop({ email: '', phone: '' }) })
    expect(section(s, 'identity').distorts).toBe(false)
    expect(section(s, 'identity').cost).toMatch(/no way to reply/i)
  })

  it('collects every distortion so one banner can carry them all', () => {
    const s = complete({
      shop: makeShop({ electricity_rate_kwh: null }),
      materials: [material({ costPerUnit: 0 })],
    })
    expect(planFor(s).distorting.map((x) => x.id).sort()).toEqual(['materials', 'power'])
  })
})

describe('completeness', () => {
  it('counts a half-answered section as half', () => {
    const s = complete({ printerRows: [printer({ watts: null })] })
    const plan = planFor(s)
    expect(plan.done).toBe(false)
    // Six of seven done, one partial.
    expect(plan.completeness).toBeCloseTo((6 + 0.5) / 7, 6)
  })

  it('orders what is left so the answers arrive before the questions that need them', () => {
    // Place before power: the state is what answers the power question.
    // Machines before materials: nothing to print with until there is a
    // printer to print on.
    const ids = planFor(complete({
      shop: makeShop({ currency: '', electricity_rate_kwh: null }),
      printerRows: [],
      materials: [],
    })).remaining.map((s) => s.id)
    expect(ids.indexOf('place')).toBeLessThan(ids.indexOf('power'))
    expect(ids.indexOf('machines')).toBeLessThan(ids.indexOf('materials'))
  })
})
