import { describe, expect, it } from 'vitest'
import { plateRemoval, strandedParts, type RemovalPart } from './plateRemoval'

const part = (id: string, over: Partial<RemovalPart> = {}): RemovalPart => ({
  id, label: id, qty: 2, copyStates: ['pending', 'pending'], variants: [{ importId: 'plate' }], history: [], ...over,
})

describe('removing a plate makes the build sheet match (CG, 23 Oct)', () => {
  it('takes off a part only this plate made, once its print is undone', () => {
    const p = part('Gahet', {
      copyStates: ['printed', 'pending'],
      history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: 'run' }],
    })
    expect(plateRemoval([p], ['plate'], ['run'], true)).toEqual({ remove: [{ id: 'Gahet', label: 'Gahet' }], keep: [] })
  })
  it('keeps it, and says why, when its print is kept', () => {
    const p = part('Gahet', {
      copyStates: ['printed', 'pending'],
      history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: 'run' }],
    })
    const r = plateRemoval([p], ['plate'], ['run'], false)
    expect(r.remove).toEqual([])
    expect(r.keep[0].why).toMatch(/1 of 2 copies stay marked \(1 printed\) — 1 by a print you are keeping/)
  })
  it('keeps a part with copies marked by hand, and says so', () => {
    const p = part('Falina', {
      copyStates: ['printed', 'pending'],
      history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: null }],
    })
    expect(plateRemoval([p], ['plate'], [], true).keep[0].why).toMatch(/1 marked by hand/)
  })
  it('leaves alone a part another plate still makes', () => {
    const p = part('Lucha', { variants: [{ importId: 'plate' }, { importId: 'other' }] })
    expect(plateRemoval([p], ['plate'], [], true).keep).toEqual([{ id: 'Lucha', label: 'Lucha', why: 'another plate still makes it' }])
  })
  it('does not touch parts the plate never made', () => {
    expect(plateRemoval([part('x', { variants: [{ importId: 'other' }] })], ['plate'], [], true)).toEqual({ remove: [], keep: [] })
  })
  it('reads the latest mark on each copy', () => {
    // Printed by the plate's print, then failed by hand: the hand mark stands.
    const p = part('Diagonal', {
      copyStates: ['reprint', 'pending'],
      history: [
        { kind: 'status', toStatus: 'reprint', copies: [1], runId: null },
        { kind: 'status', toStatus: 'printed', copies: [1], runId: 'run' },
      ],
    })
    expect(plateRemoval([p], ['plate'], ['run'], true).keep[0].why).toMatch(/1 going back/)
  })
})

describe('parts left behind by earlier removals', () => {
  it('lists parts with no plate and nothing marked, and not ones with a record', () => {
    expect(
      strandedParts([
        part('a', { variants: [] }),
        part('b', { variants: [], copyStates: ['printed', 'pending'] }),
        part('c'),
      ]),
    ).toEqual([{ id: 'a', label: 'a' }])
  })
})
