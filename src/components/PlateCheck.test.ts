import { describe, expect, it } from 'vitest'
import { pieceName, piecesSummary, plateCopies } from './PlateCheck'
import type { PartRow } from '../lib/data.types'

let id = 0
const ev = (runId: string, copies: number[], at: string, toStatus: 'printed' | 'reprint' | 'passed' = 'printed') =>
  ({ id: ++id, kind: 'status', toStatus, fromStatus: null, copies, runId, at, n: null, note: null, actor: null, sliceImportId: null }) as never
const part = (label: string, qty: number, copyStates: string[], history: unknown[]): PartRow =>
  ({ id: label, label, qty, status: 'printed', note: null, sort: 0, history, variants: [], chosenSectionId: null, printedN: 0, passedN: 0, reprintN: 0, copyStates, spareN: 0 }) as never

describe('pieces on a plate (CG, 25 Nov)', () => {
  it('reads slicer instances as copies of one piece', () => {
    expect(pieceName("Gu'ut lucha (Instance 3)")).toBe("Gu'ut lucha")
    expect(pieceName('M-RS850-Keel-Section.stl (Instance 2)')).toBe('M-RS850-Keel-Section')
    expect(pieceName('Body1')).toBe('Body1')
  })

  it('titles a long plate by its first few pieces and how many more', () => {
    const labels = [
      ...Array.from({ length: 7 }, (_, i) => ({ label: `wedge pin (Instance ${i + 1})`, qty: 1 })),
      ...Array.from({ length: 7 }, (_, i) => ({ label: `Gu'ut lucha (Instance ${i + 1})`, qty: 1 })),
    ]
    expect(piecesSummary(labels)).toBe("7 × wedge pin, 7 × Gu'ut lucha")
    expect(piecesSummary([{ label: 'A', qty: 1 }, { label: 'B', qty: 2 }, { label: 'C', qty: 1 }, { label: 'D', qty: 1 }, { label: 'E', qty: 1 }])).toBe('A, 2 × B, C and 2 more')
  })

  it('groups the copies a plate printed, and a reprinted copy belongs to the plate that reprinted it', () => {
    const parts = [
      part('Body1', 1, ['printed'], [ev('run-a', [1], '2026-11-09T10:00'), ev('run-a', [1], '2026-11-09T11:00', 'reprint'), ev('run-b', [1], '2026-11-11T10:00')]),
      part('torus (Instance 1)', 1, ['passed'], [ev('run-a', [1], '2026-11-09T10:00')]),
      part('torus (Instance 2)', 1, ['printed'], [ev('run-a', [1], '2026-11-09T10:00')]),
    ]
    const a = plateCopies(parts, new Set(['run-a']))
    expect(a.map((g) => [g.name, g.copies.map((c) => c.state)])).toEqual([['torus', ['passed', 'printed']]])
    const b = plateCopies(parts, new Set(['run-b']))
    expect(b.map((g) => [g.name, g.copies.length])).toEqual([['Body1', 1]])
  })
})
