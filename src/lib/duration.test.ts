import { describe, expect, it } from 'vitest'
import { fmtHours, joinHours, splitHours } from './duration'

describe('hours and minutes, not decimal hours (CG, 14 Oct)', () => {
  it('shows what people say', () => {
    expect(fmtHours(16.4333)).toBe('16h 26m')
    expect(fmtHours(0.5)).toBe('30m')
    expect(fmtHours(2)).toBe('2h')
    expect(fmtHours(0)).toBe('0m')
    expect(fmtHours(15 + 20 / 60)).toBe('15h 20m')
    expect(fmtHours(null)).toBe('—')
    expect(fmtHours(undefined, 'none')).toBe('none')
  })
  it('rounds to the minute, and 59.6 minutes is the next hour', () => {
    expect(splitHours(0.9933)).toEqual({ h: 1, m: 0 }) // 59.6 minutes
    expect(splitHours(1.9999)).toEqual({ h: 2, m: 0 })
    expect(splitHours(-3)).toEqual({ h: 0, m: 0 })
  })
  it('turns what was typed back into hours for storage', () => {
    expect(joinHours(15, 20)).toBeCloseTo(15.3333, 4)
    expect(joinHours('0', '30')).toBe(0.5)
    expect(joinHours('', '')).toBe(0)
    expect(joinHours(1, 90)).toBe(2.5) // 90 minutes is fine to type
    // A round trip loses nothing a clock shows.
    expect(fmtHours(joinHours(16, 26))).toBe('16h 26m')
  })
})
