import { describe, expect, it } from 'vitest'
import { pieceName, piecesSummary, plateRows } from './PlateCheck'
import type { PartRow, SliceSectionRow } from '../lib/data.types'

let id = 0
const ev = (runId: string, copies: number[], at: string, toStatus: 'printed' | 'reprint' | 'passed' = 'printed') =>
  ({ id: ++id, kind: 'status', toStatus, fromStatus: null, copies, runId, at, n: null, note: null, actor: null, sliceImportId: null }) as never
const part = (pid: string, qty: number, copyStates: string[], history: unknown[]): PartRow =>
  ({ id: pid, label: pid, qty, status: 'printed', note: null, sort: 0, history, variants: [], chosenSectionId: null, printedN: 0, passedN: 0, reprintN: 0, copyStates, spareN: 0 }) as never
const sec = (partId: string, qty = 1): SliceSectionRow => ({ id: `s-${partId}-${++id}`, partId, label: partId, qty, estMinutes: null, estGrams: null, material: null })
const where = (r: string) => (r === 'nov1' ? '2026-11-01 · PETG 31m' : r)

describe('the parts on a plate (CG, 25 Nov)', () => {
  it('reads slicer instances as copies of one piece, for titles', () => {
    expect(pieceName("Gu'ut lucha (Instance 3)")).toBe("Gu'ut lucha")
    expect(piecesSummary([{ label: 'A', qty: 1 }, { label: 'B', qty: 2 }, { label: 'C', qty: 1 }, { label: 'D', qty: 1 }, { label: 'E', qty: 1 }])).toBe('A, 2 × B, C and 2 more')
  })

  it('lists every part the plate file holds, one row each -- even ones another plate already counted', () => {
    // The Nov 12 PETG plate printed the same 14 pieces the Nov 1 plate had;
    // each part needs 1, so its print marked nothing. Before, it showed none.
    const parts = [part('lucha (Instance 1)', 1, ['printed'], [ev('nov1', [1], '2026-11-01T10:00')]), part('lucha (Instance 2)', 1, ['passed'], [ev('nov1', [1], '2026-11-01T10:00')])]
    const rows = plateRows([sec('lucha (Instance 1)'), sec('lucha (Instance 2)')], parts, new Set(['nov12']), where)
    expect(rows.map((r) => [r.part.label, r.kind, r.where, r.copies.map((c) => c.state)])).toEqual([
      ['lucha (Instance 1)', 'elsewhere', '2026-11-01 · PETG 31m', ['printed']],
      ['lucha (Instance 2)', 'elsewhere', '2026-11-01 · PETG 31m', ['passed']],
    ])
  })

  it("acts on this plate's own copies, and a piece failed here and reprinted elsewhere is checked there", () => {
    const parts = [
      part('Body1', 1, ['printed'], [ev('a', [1], '2026-11-09T10:00'), ev('a', [1], '2026-11-09T11:00', 'reprint'), ev('b', [1], '2026-11-11T10:00')]),
      part('torus', 2, ['printed', 'printed'], [ev('a', [1, 2], '2026-11-09T10:00')]),
    ]
    const onA = plateRows([sec('Body1'), sec('torus', 2)], parts, new Set(['a']), (r) => r)
    expect(onA.map((r) => [r.part.label, r.kind, r.onPlate, r.copies.length])).toEqual([
      ['Body1', 'reprinted', 1, 0],
      ['torus', 'mine', 2, 2],
    ])
    const onB = plateRows([sec('Body1')], parts, new Set(['b']), (r) => r)
    expect(onB.map((r) => [r.kind, r.copies.length])).toEqual([['mine', 1]])
  })

  it('keeps each copy its own row, and an undone check stays on its plate (CG, 26 Nov)', () => {
    // Two shells: copy 1 failed, copy 2 passed by mistake and undone on the same print.
    const parts = [
      part('shell', 2, ['reprint', 'printed'], [ev('a', [1, 2], '2026-11-09T10:00'), ev('a', [1], '2026-11-09T11:00', 'reprint'), ev('a', [2], '2026-11-09T11:01', 'passed'), ev('a', [2], '2026-11-09T11:02')]),
    ]
    const [row] = plateRows([sec('shell', 2)], parts, new Set(['a']), (r) => r)
    expect([row.kind, row.copies.map((c) => [c.copy, c.state, c.runId])]).toEqual(['mine', [[1, 'reprint', 'a'], [2, 'printed', 'a']]])
  })
})
