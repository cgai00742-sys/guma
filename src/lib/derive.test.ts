/**
 * The calculators. Every one of these is a division somebody would
 * otherwise do wrong on a phone, so the tests are mostly about the two
 * things that make a calculator dangerous rather than useless: returning a
 * confident zero when an input is missing, and quietly dropping a term.
 */
import { describe, expect, it } from 'vitest'
import {
  costPerGram,
  hourlyForTarget,
  machineHourFloor,
  positive,
  powerPerHour,
  pricePerKg,
  rateImplies,
  wearPerHour,
} from './derive'

describe('positive', () => {
  it('reads a number out of whatever a form hands over', () => {
    expect(positive('12.5')).toBe(12.5)
    expect(positive(12.5)).toBe(12.5)
    expect(positive('  40 ')).toBe(40)
  })

  it('treats blank, zero, negative and nonsense as "not answered"', () => {
    // Zero is the important one. A zero wear rate is not a cheap machine,
    // it is an unanswered question, and the difference is a shop that
    // thinks its machine time is free.
    expect(positive('')).toBeNull()
    expect(positive('0')).toBeNull()
    expect(positive(0)).toBeNull()
    expect(positive('-5')).toBeNull()
    expect(positive('abc')).toBeNull()
    expect(positive(null)).toBeNull()
    expect(positive(undefined)).toBeNull()
    expect(positive(NaN)).toBeNull()
    expect(positive(Infinity)).toBeNull()
  })
})

describe('wearPerHour', () => {
  it('does the division Setup used to print as a sentence', () => {
    const w = wearPerHour({ price: 1200, lifetimeHours: 6000 })
    expect(w?.perHour).toBeCloseTo(0.2, 10)
    expect(w?.fromPrice).toBeCloseTo(0.2, 10)
    expect(w?.includesMaintenance).toBe(false)
  })

  it('folds consumables in when it has both halves of them', () => {
    // $600 a year of nozzles and belts over 1,000 running hours is 60c an
    // hour -- three times the machine's own depreciation here, which is
    // exactly why leaving it out flatters the number.
    const w = wearPerHour({
      price: 1200,
      lifetimeHours: 6000,
      maintenancePerYear: 600,
      hoursPerYear: 1000,
    })
    expect(w?.fromPrice).toBeCloseTo(0.2, 10)
    expect(w?.fromMaintenance).toBeCloseTo(0.6, 10)
    expect(w?.perHour).toBeCloseTo(0.8, 10)
    expect(w?.includesMaintenance).toBe(true)
  })

  it('ignores maintenance it cannot spread, rather than guessing the hours', () => {
    const w = wearPerHour({ price: 1200, lifetimeHours: 6000, maintenancePerYear: 600 })
    expect(w?.perHour).toBeCloseTo(0.2, 10)
    expect(w?.includesMaintenance).toBe(false)
  })

  it('returns nothing at all without a price and a life', () => {
    expect(wearPerHour({ price: '', lifetimeHours: 6000 })).toBeNull()
    expect(wearPerHour({ price: 1200, lifetimeHours: '' })).toBeNull()
    expect(wearPerHour({ price: 0, lifetimeHours: 0 })).toBeNull()
  })
})

describe('powerPerHour', () => {
  it('is watts over a thousand, times the price of a kilowatt-hour', () => {
    // 350W at 45c/kWh -- roughly a mid-size FDM machine in Hawaii.
    expect(powerPerHour(350, 0.45)).toBeCloseTo(0.1575, 10)
  })

  it('says nothing when either half is missing', () => {
    expect(powerPerHour(350, '')).toBeNull()
    expect(powerPerHour('', 0.45)).toBeNull()
  })
})

describe('material arithmetic', () => {
  it('turns a spool into a price per gram and per kilo', () => {
    expect(costPerGram(25, 1)).toBeCloseTo(0.025, 10)
    expect(pricePerKg(25, 1)).toBeCloseTo(25, 10)
    // A 750g spool is the trap: it is not a kilo, and pricing it as one
    // under-reads material cost by a quarter on every job.
    expect(pricePerKg(25, 0.75)).toBeCloseTo(33.3333, 3)
  })

  it('refuses a spool with no price or no weight', () => {
    expect(costPerGram('', 1)).toBeNull()
    expect(costPerGram(25, 0)).toBeNull()
  })
})

describe('rateImplies', () => {
  it('turns an hourly rate into the numbers people have intuition about', () => {
    const r = rateImplies(50)
    expect(r?.perDay).toBe(400)
    // 50 x 20 billable hours x 48 weeks.
    expect(r?.perYear).toBe(48000)
  })

  it('assumes half a week is billable, not all of it', () => {
    // The default that matters. A rate set against 40 billable hours is how
    // a shop works a full year and earns half of what it planned.
    const r = rateImplies(50)
    expect(r?.billableHoursPerWeek).toBe(20)
    expect(r?.weeksPerYear).toBe(48)
    expect(r?.dayHours).toBe(8)
  })

  it('lets a shop that knows better say so', () => {
    const r = rateImplies(50, { billableHoursPerWeek: 30, weeksPerYear: 50, dayHours: 6 })
    expect(r?.perDay).toBe(300)
    expect(r?.perYear).toBe(75000)
  })

  it('says nothing about an empty field', () => {
    expect(rateImplies('')).toBeNull()
    expect(rateImplies(0)).toBeNull()
  })
})

describe('hourlyForTarget', () => {
  it('runs the same assumptions backwards', () => {
    expect(hourlyForTarget(48000)).toBeCloseTo(50, 10)
  })

  it('round-trips against rateImplies', () => {
    const rate = hourlyForTarget(60000)!
    expect(rateImplies(rate)?.perYear).toBeCloseTo(60000, 6)
  })
})

describe('machineHourFloor', () => {
  it('adds wear and power into what an hour has to clear', () => {
    const f = machineHourFloor(0.2, 0.1575)
    expect(f?.floor).toBeCloseTo(0.3575, 10)
    expect(f?.complete).toBe(true)
  })

  it('still reports a floor with one half missing, and flags it as partial', () => {
    // Useful but incomplete: the UI must be able to tell the shop this is a
    // floor under a floor rather than the cost of an hour.
    const f = machineHourFloor(0.2, null)
    expect(f?.floor).toBeCloseTo(0.2, 10)
    expect(f?.complete).toBe(false)
  })

  it('says nothing when it knows nothing', () => {
    expect(machineHourFloor(null, null)).toBeNull()
  })
})
