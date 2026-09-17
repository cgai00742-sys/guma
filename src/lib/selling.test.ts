/**
 * The profit side.
 *
 * Every test here is really the same assertion from a different angle: the
 * flattering number is never the one Guma reports. Fees come off before
 * profit, cost follows the unit that sold rather than the unit that was
 * made, and an unrecovered design is shown as unrecovered rather than
 * smeared thin enough to disappear.
 */
import { describe, expect, it } from 'vitest'
import {
  ETSY_US,
  feeFor,
  netOfFees,
  productResult,
  summarize,
  unitMargin,
  type BatchStock,
  type Channel,
} from './selling'

const etsy: Channel = { id: 'c1', name: 'Etsy', feePct: ETSY_US.feePct, feeFlat: ETSY_US.feeFlat }
const market: Channel = { id: 'c2', name: 'Market', feePct: 0, feeFlat: 0 }

const batch = (over: Partial<BatchStock> = {}): BatchStock => ({
  batchId: 'b1',
  productId: 'p1',
  unitsMade: 200,
  unitsSold: 0,
  unitsLeft: 200,
  unitCost: 1.4,
  revenue: 0,
  fees: 0,
  costOfSold: 0,
  madeOn: '2026-08-01',
  ...over,
})

describe('the platform takes its cut before anything is called profit', () => {
  it('charges Etsy the way Etsy actually charges', () => {
    // 6.5% + 3% + $0.20 listing + $0.25 processing. On $50 that is $5.20,
    // which is the figure Etsy's own published example gives -- and about
    // half again what the commonly quoted "6.5%" would suggest.
    expect(feeFor(etsy, 1, 50)).toBeCloseTo(5.2, 2)
    expect(netOfFees(etsy, 1, 50)).toBeCloseTo(44.8, 2)
  })

  it('shows the flat part biting harder on cheap things', () => {
    // The reason a shop selling $5 items through an expensive channel is in
    // more trouble than the headline percentage suggests.
    const onFifty = feeFor(etsy, 1, 50) / 50
    const onFive = feeFor(etsy, 1, 5) / 5
    expect(onFifty).toBeCloseTo(0.104, 3)
    expect(onFive).toBeCloseTo(0.186, 3)
    expect(onFive).toBeGreaterThan(onFifty)
  })

  it('takes nothing at a market stall', () => {
    expect(feeFor(market, 10, 12)).toBe(0)
    expect(netOfFees(market, 10, 12)).toBe(120)
  })

  it('treats no channel as no fee rather than as an error', () => {
    expect(feeFor(null, 3, 20)).toBe(0)
  })
})

describe('what a unit actually earns', () => {
  it('is the price minus the cut minus what it cost to make', () => {
    // $12 keychain, $9.40 to make, sold on Etsy. Feels like $2.60 of
    // margin. It is not.
    const m = unitMargin(etsy, 12, 9.4)!
    expect(m).toBeLessThan(0.15)
    expect(netOfFees(etsy, 1, 12)).toBeCloseTo(10.41, 2)
    // A dollar and one penny, on a twelve dollar sale.
    expect(netOfFees(etsy, 1, 12) - 9.4).toBeCloseTo(1.01, 2)
  })

  it('says nothing rather than dividing by a giveaway', () => {
    expect(unitMargin(etsy, 0, 3)).toBeNull()
  })

  it('goes negative when it should, instead of clamping at zero', () => {
    // Selling below cost is a thing shops do by accident. The number has to
    // be allowed to say so.
    expect(unitMargin(etsy, 5, 9.4)!).toBeLessThan(0)
  })
})

describe('made is not sold', () => {
  it('counts cost against what left, and the rest as stock', () => {
    // 200 made at $1.40, 12 sold at $12 through a stall. The shelf still
    // holds $263.20 of spent money.
    const b = batch({
      unitsSold: 12,
      unitsLeft: 188,
      revenue: 144,
      fees: 0,
      costOfSold: 16.8,
    })
    const r = productResult({ id: 'p1', name: 'Keychain', designCost: null }, [b])

    expect(r.unitsMade).toBe(200)
    expect(r.unitsSold).toBe(12)
    expect(r.costOfSold).toBeCloseTo(16.8, 2)
    expect(r.grossProfit).toBeCloseTo(127.2, 2)
    // The number a shop with a full shelf most needs to see.
    expect(r.stockAtCost).toBeCloseTo(263.2, 2)
  })

  it('does not call unsold stock a loss', () => {
    // Nothing sold yet. That is not negative profit, it is no profit and a
    // shelf -- and the two get fixed in completely different ways.
    const r = productResult({ id: 'p1', name: 'Keychain', designCost: null }, [batch()])
    expect(r.grossProfit).toBe(0)
    expect(r.stockAtCost).toBeCloseTo(280, 2)
  })

  it('adds up across batches made at different costs', () => {
    // Filament got dearer between runs. Both batches keep what they
    // actually cost, which is the whole point of freezing it.
    const cheap = batch({ batchId: 'b1', unitsMade: 100, unitsSold: 100, unitsLeft: 0, unitCost: 1.2, revenue: 1200, costOfSold: 120 })
    const dear = batch({ batchId: 'b2', unitsMade: 100, unitsSold: 50, unitsLeft: 50, unitCost: 1.8, revenue: 600, costOfSold: 90 })
    const r = productResult({ id: 'p1', name: 'Keychain', designCost: null }, [cheap, dear])

    expect(r.costOfSold).toBeCloseTo(210, 2)
    expect(r.grossProfit).toBeCloseTo(1590, 2)
    expect(r.stockAtCost).toBeCloseTo(90, 2)
  })
})

describe('design is a payback, not a per-unit cost', () => {
  it('reports how much of the evening has come back', () => {
    // 11 hours at $45 = $495 of design. $310 of gross profit so far.
    const b = batch({ unitsSold: 40, unitsLeft: 160, revenue: 480, fees: 14, costOfSold: 156 })
    const r = productResult({ id: 'p1', name: 'Keychain', designCost: 495 }, [b])

    expect(r.grossProfit).toBeCloseTo(310, 2)
    expect(r.designRecovered).toBeCloseTo(310 / 495, 4)
    expect(r.designPaidBack).toBe(false)
  })

  it('says so once it has paid for itself', () => {
    const b = batch({ unitsSold: 200, unitsLeft: 0, revenue: 2400, fees: 0, costOfSold: 280 })
    const r = productResult({ id: 'p1', name: 'Keychain', designCost: 495 }, [b])
    expect(r.designPaidBack).toBe(true)
    expect(r.designRecovered!).toBeGreaterThan(1)
  })

  it('does not invent a payback when the design was never tracked', () => {
    const r = productResult({ id: 'p1', name: 'Keychain', designCost: null }, [batch()])
    expect(r.designRecovered).toBeNull()
    expect(r.designPaidBack).toBe(false)
  })

  it('never lets design cost move a batch unit cost', () => {
    // The tension 0014_selling.sql resolves: unit cost is production only,
    // so making a second batch cannot retroactively change what the first
    // one cost.
    const one = productResult({ id: 'p1', name: 'K', designCost: 495 }, [
      batch({ unitsSold: 10, unitsLeft: 190, revenue: 120, costOfSold: 14 }),
    ])
    const two = productResult({ id: 'p1', name: 'K', designCost: 495 }, [
      batch({ unitsSold: 10, unitsLeft: 190, revenue: 120, costOfSold: 14 }),
      batch({ batchId: 'b2', unitsMade: 500, unitsLeft: 500, unitCost: 1.4 }),
    ])
    // Making 500 more did not change what the first ten cost to produce.
    expect(two.costOfSold).toBeCloseTo(one.costOfSold, 6)
    expect(two.grossProfit).toBeCloseTo(one.grossProfit, 6)
  })
})

describe('the one line at the top', () => {
  it('totals the shelf and the outstanding design across products', () => {
    const a = productResult({ id: 'p1', name: 'Keychain', designCost: 495 }, [
      batch({ unitsSold: 40, unitsLeft: 160, revenue: 480, fees: 14, costOfSold: 156 }),
    ])
    const b = productResult({ id: 'p2', name: 'Bracket', designCost: 90 }, [
      batch({ productId: 'p2', unitsMade: 20, unitsSold: 20, unitsLeft: 0, unitCost: 3, revenue: 600, costOfSold: 60 }),
    ])
    const s = summarize([a, b])

    expect(s.products).toBe(2)
    expect(s.grossProfit).toBeCloseTo(310 + 540, 2)
    expect(s.stockAtCost).toBeCloseTo(224, 2)
    // Keychain still owes $185 of its design; the bracket has repaid its
    // $90 and does not count as negative outstanding.
    expect(s.designOutstanding).toBeCloseTo(185, 2)
  })
})
