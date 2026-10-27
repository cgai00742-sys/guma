import { describe, expect, it } from 'vitest'
import { plateRemoval, strandedParts, type RemovalPart } from './plateRemoval'

const part = (id: string, over: Partial<RemovalPart> = {}): RemovalPart => ({
  id, label: id, qty: 2, copyStates: ['pending', 'pending'], variants: [{ importId: 'plate', sectionQty: 2 }], history: [], ...over,
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

describe('parts with no plate, and what marked them (CG, 24 Oct)', () => {
  const runs = [
    { id: 'orphan', sliceImportId: null, startedAt: '2026-10-07T10:00:00Z', hours: 25 / 60, unitsUsed: 3 },
  ]
  it('names the plate-less print behind a mark, and every part it marked', async () => {
    const { strandedReport } = await import('./plateRemoval')
    const falina = part('Falina', {
      variants: [], qty: 5, copyStates: ['printed', 'pending', 'pending', 'pending', 'pending'],
      history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: 'orphan' }],
    })
    const lucha = part('Lucha', {
      variants: [], qty: 5, copyStates: ['printed', 'pending', 'pending', 'pending', 'pending'],
      history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: 'orphan' }],
    })
    const lahi = part('Lahi', { variants: [], qty: 1, copyStates: ['pending'] })
    const r = strandedReport([falina, lucha, lahi], runs)
    expect(r.clear).toEqual([{ id: 'Lahi', label: 'Lahi' }])
    expect(r.marked[0].why).toBe('1 of 5 marked — 1 by the print of 2026-10-07, 25m, 3 g, which has no plate.')
    expect(r.prints).toEqual([{ id: 'orphan', said: '2026-10-07, 25m, 3 g', parts: ['Falina', 'Lucha'] }])
  })
  it('says marked by hand when no print did it', async () => {
    const { strandedReport } = await import('./plateRemoval')
    const p = part('Diagonal', { variants: [], copyStates: ['printed', 'pending'], history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: null }] })
    expect(strandedReport([p], runs)).toMatchObject({ marked: [{ why: '1 of 2 marked — 1 marked by hand.' }], prints: [] })
  })
})

describe('the count you need is yours, not the plate\'s (CG, 26 Oct)', () => {
  it('keeps a part you need 5 of when its 1-copy plate goes, and says why', () => {
    const p = part('Gahet', {
      qty: 5,
      copyStates: ['printed', 'pending', 'pending', 'pending', 'pending'],
      variants: [{ importId: 'plate', sectionQty: 1 }],
      history: [{ kind: 'status', toStatus: 'printed', copies: [1], runId: 'run' }],
    })
    const r = plateRemoval([p], ['plate'], ['run'], true)
    expect(r.remove).toEqual([])
    expect(r.keep[0].why).toMatch(/you need 5 and this plate makes 1 — the part stays with its 5 copies, its marks from this plate undone/)
  })
  it('still takes off a part the plate made all of', () => {
    const p = part('Cap', { qty: 2, variants: [{ importId: 'plate', sectionQty: 2 }] })
    expect(plateRemoval([p], ['plate'], [], true).remove).toEqual([{ id: 'Cap', label: 'Cap' }])
  })
})
