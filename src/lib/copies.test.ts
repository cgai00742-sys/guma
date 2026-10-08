import { describe, expect, it } from 'vitest'
import { copiesOf, describeCopies, movable, moveCopies, statusOf } from './copies'

const five = copiesOf({ qty: 5, printedN: 0, passedN: 0, reprintN: 0 })

describe('copies of a part (CG, 8 Oct: one test plate of five)', () => {
  it('one test copy off the machine leaves four to print, and the part is not "printed"', () => {
    const c = moveCopies(five, 'printed', 1)
    expect(c).toEqual({ pending: 4, printed: 1, passed: 0, reprint: 0 })
    expect(statusOf(c)).toBe('pending')
    expect(describeCopies(c)).toBe('1 of 5 printed')
  })

  it('the test copy fails: it goes back, and the part reads as going back', () => {
    const c = moveCopies(moveCopies(five, 'printed', 1), 'reprint', 1)
    expect(c).toEqual({ pending: 4, printed: 0, passed: 0, reprint: 1 })
    expect(statusOf(c)).toBe('reprint')
  })

  it('a reprint coming off takes from "going back" before "not printed"', () => {
    const back = { pending: 4, printed: 0, passed: 0, reprint: 1 }
    expect(moveCopies(back, 'printed', 1)).toEqual({ pending: 4, printed: 1, passed: 0, reprint: 0 })
  })

  it('only copies off the machine can pass', () => {
    const c = moveCopies(five, 'printed', 2)
    expect(movable(c, 'passed')).toBe(2)
    expect(() => moveCopies(c, 'passed', 3)).toThrow(/Only 2 copies/)
  })

  it('all five off then all five passed reads printed, then passed', () => {
    const off = moveCopies(five, 'printed', 5)
    expect(statusOf(off)).toBe('printed')
    expect(statusOf(moveCopies(off, 'passed', 5))).toBe('passed')
  })

  it('a print that failed on the bed can fail straight from not printed', () => {
    expect(moveCopies(five, 'reprint', 1)).toEqual({ pending: 4, printed: 0, passed: 0, reprint: 1 })
  })
})
