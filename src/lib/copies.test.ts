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

import { countsOf, moveStates, resizeStates, setStates, statesOf } from './copies'

describe('each copy in its own place (CG, 8 Oct: a dropdown per instance)', () => {
  const fresh = statesOf({ qty: 5, printedN: 0, passedN: 0, reprintN: 0, copyStates: null })

  it('a part never split out reads from its counts', () => {
    expect(statesOf({ qty: 3, printedN: 1, passedN: 1, reprintN: 0, copyStates: null })).toEqual(['passed', 'printed', 'pending'])
  })

  it('copy 3 can fail on its own and stays copy 3', () => {
    const s = setStates(moveStates(fresh, 'printed', 5).states, [2], 'reprint')
    expect(s).toEqual(['printed', 'printed', 'reprint', 'printed', 'printed'])
    expect(countsOf(s)).toEqual({ pending: 0, printed: 4, passed: 0, reprint: 1 })
  })

  it('a copy marked by mistake goes back to neutral', () => {
    const s = setStates(moveStates(fresh, 'printed', 2).states, [1], 'pending')
    expect(s).toEqual(['printed', 'pending', 'pending', 'pending', 'pending'])
  })

  it('bulk "printed" takes the reprint first, then the lowest copy, and names them', () => {
    const s: ReturnType<typeof statesOf> = ['printed', 'pending', 'reprint', 'pending', 'pending']
    const r = moveStates(s, 'printed', 2)
    expect(r.moved).toEqual([1, 2])
    expect(r.states).toEqual(['printed', 'printed', 'printed', 'pending', 'pending'])
  })

  it('stored states are used when they fit the qty', () => {
    expect(statesOf({ qty: 2, printedN: 0, passedN: 0, reprintN: 0, copyStates: '["pending","reprint"]' })).toEqual(['pending', 'reprint'])
  })

  it('resizing keeps made copies and drops not-printed ones from the end', () => {
    const s: ReturnType<typeof statesOf> = ['printed', 'pending', 'reprint', 'pending']
    expect(resizeStates(s, 6)).toEqual(['printed', 'pending', 'reprint', 'pending', 'pending', 'pending'])
    expect(resizeStates(s, 2)).toEqual(['printed', 'reprint'])
    expect(() => resizeStates(s, 1)).toThrow(/cannot be fewer than 2/)
  })
})

describe('copies moved into a combined part (CG, 27 Oct)', () => {
  it('follow the copies before them, and an all-copies event is spelled out', async () => {
    const { shiftCopies } = await import('./copies')
    expect(shiftCopies('1,2', 3, 2, true)).toBe('4,5')
    expect(shiftCopies(null, 2, 3, true)).toBe('3,4,5')
    expect(shiftCopies(null, 2, 3, false)).toBeNull()
  })
})
