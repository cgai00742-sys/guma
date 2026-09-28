import { describe, expect, it } from 'vitest'
import { CEILING_PCT, ceilingCheck, validateRevision } from './data.types'

describe('the accepted quote as a ceiling', () => {
  it('has nothing to say until a quote has been accepted', () => {
    expect(ceilingCheck(null, 900)).toEqual({ ceiling: null, over: false, overPct: 0 })
  })

  it('allows the shop rule exactly: ten percent, not eleven', () => {
    expect(ceilingCheck(1000, 1100).over).toBe(false)
    expect(ceilingCheck(1000, 1100.01).over).toBe(true)
    expect(CEILING_PCT).toBe(10)
  })

  it('reports how far over it is, in the number a person would say', () => {
    expect(ceilingCheck(1000, 1250).overPct).toBe(25)
  })

  it('asks nothing of a revision that stayed inside the ceiling', () => {
    expect(validateRevision(1000, 1050, undefined)).toBeNull()
  })

  it('asks nothing of a revision that came DOWN', () => {
    expect(validateRevision(1000, 800, undefined)).toBeNull()
  })

  it('refuses an unexplained rise above the ceiling', () => {
    expect(() => validateRevision(1000, 1400, undefined)).toThrow(/what the client changed/i)
  })

  it('refuses a reason that is only whitespace', () => {
    expect(() => validateRevision(1000, 1400, { cause: 'added_work', reason: '   ' })).toThrow()
  })

  it('refuses a cause that is not one of the client-caused ones', () => {
    expect(() =>
      validateRevision(1000, 1400, { cause: 'we_underquoted' as never, reason: 'my mistake' }),
    ).toThrow()
  })

  it('allows it once the shop has said what the client changed — warn, not block', () => {
    expect(
      validateRevision(1000, 1400, { cause: 'added_work', reason: ' Two more brackets ' }),
    ).toEqual({ cause: 'added_work', reason: 'Two more brackets' })
  })

  it('treats a revision with no total (a draft) as nothing to check', () => {
    expect(validateRevision(1000, null, undefined)).toBeNull()
  })
})
