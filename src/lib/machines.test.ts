import { describe, expect, it } from 'vitest'
import { findModel, MACHINE_MODELS, RATE_BANDS, suggestionsFor, wearFrom } from './machines'

describe('the model list', () => {
  it('finds a model by the name a shop would pick', () => {
    expect(findModel('Prusa XL (single toolhead)')?.watts).toBe(200)
    expect(findModel('  prusa xl (single toolhead) ')?.class).toBe('large-format')
    expect(findModel('A printer nobody sells')).toBeNull()
  })

  it('never invents a figure it has no source for', () => {
    for (const m of MACHINE_MODELS) {
      expect(m.source.length).toBeGreaterThan(10)
      if (/name only/i.test(m.source)) {
        expect(m.watts).toBeUndefined()
        expect(m.listPriceUsd).toBeUndefined()
      }
    }
  })
})

describe('what a Prusa XL suggests', () => {
  const xl = findModel('Prusa XL (single toolhead)')!

  it('wear from its list price over 5,000 hours', () => {
    expect(wearFrom(2129)).toBe(0.43)
  })

  it('fills only what is empty', () => {
    expect(suggestionsFor(xl, { watts: null, wear_hourly: 0, rate_hourly: 0 })).toEqual({
      watts: 200,
      wear_hourly: 0.43,
      rate_hourly: 6,
    })
  })

  it('leaves every number the shop already typed alone', () => {
    expect(suggestionsFor(xl, { watts: 230, wear_hourly: 0.5, rate_hourly: 7 })).toEqual({})
  })

  it('charges a large-format machine at a large-format rate', () => {
    expect(RATE_BANDS['large-format'].low).toBeGreaterThan(RATE_BANDS.entry.low)
  })
})
