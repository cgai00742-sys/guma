import { describe, expect, it } from 'vitest'
import { changeCopies, renumberCopies } from './copies'
import type { PartStatus } from './data.types'

const S = (s: string) => s.split(' ') as PartStatus[]

describe('setting a part to fewer or more copies (CG, 12 Oct)', () => {
  it('drops copies not printed yet, from the last back', () => {
    const r = changeCopies(S('printed pending printed pending pending'), 0, 4)
    expect(r.states).toEqual(S('printed pending printed pending'))
    expect(r).toMatchObject({ removed: [4], spare: 0, toSpare: 0, dropped: { pending: 1, reprint: 0 } })
  })

  it('then a failed copy waiting to go again: that reprint is no longer owed', () => {
    const r = changeCopies(S('printed printed reprint printed printed'), 0, 4)
    expect(r.states).toEqual(S('printed printed printed printed'))
    expect(r).toMatchObject({ removed: [2], dropped: { pending: 0, reprint: 1 }, toSpare: 0 })
  })

  it('then keeps a printed copy as a spare rather than refusing', () => {
    const r = changeCopies(S('printed printed printed printed printed'), 0, 4)
    expect(r.states).toEqual(S('printed printed printed printed'))
    expect(r).toMatchObject({ removed: [4], spare: 1, toSpare: 1 })
  })

  it('takes printed before passed as the spare', () => {
    const r = changeCopies(S('passed printed passed'), 0, 2)
    expect(r.states).toEqual(S('passed passed'))
    expect(r.removed).toEqual([1])
  })

  it('more copies take the spares back first, as printed', () => {
    const r = changeCopies(S('printed printed'), 1, 4)
    expect(r.states).toEqual(S('printed printed printed pending'))
    expect(r).toMatchObject({ spare: 0, fromSpare: 1, removed: [] })
  })

  it('the same count changes nothing', () => {
    expect(changeCopies(S('printed pending'), 2, 2)).toMatchObject({ states: S('printed pending'), spare: 2, removed: [] })
  })

  it('refuses fewer than one', () => {
    expect(() => changeCopies(S('pending'), 0, 0)).toThrow(/at least one/)
  })
})

describe('history copy numbers after copies leave', () => {
  it('drops the copies that left and moves the rest down', () => {
    expect(renumberCopies('2', [1])).toBeNull()
    expect(renumberCopies('3', [1])).toBe('2')
    expect(renumberCopies('1,3,5', [1, 3])).toBe('1,2,3')
    expect(renumberCopies('1', [4])).toBe('1')
    expect(renumberCopies(null, [0])).toBeNull()
    expect(renumberCopies('4', [])).toBe('4')
  })
})
