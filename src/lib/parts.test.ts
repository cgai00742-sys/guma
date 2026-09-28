import { describe, expect, it } from 'vitest'
import { allowedStatuses, reprintCount, reprintReason, shouldReturnToBuilding } from './parts'
import type { PartRow } from './data.types'

function part(status: PartRow['status'], history: PartRow['history'] = []): PartRow {
  return { id: 'p1', label: 'Buoy shell', qty: 2, status, note: null, sort: 0, history }
}

function ev(toStatus: PartRow['status'], note: string | null, id = 1): PartRow['history'][number] {
  return { id, kind: 'status', fromStatus: null, toStatus, note, actor: 'CG', at: '2026-09-27' }
}

describe('what a stage lets you do', () => {
  it('offers nothing before building: a part is still a plan', () => {
    for (const p of ['intake', 'design', 'approval', 'scheduled'] as const) {
      expect(allowedStatuses(p)).toEqual([])
    }
  })

  it('offers printed or back while building, and never a QC pass', () => {
    expect(allowedStatuses('building')).toEqual(['printed', 'reprint'])
  })

  it('offers pass or back in review, and never "printed" again', () => {
    expect(allowedStatuses('review')).toEqual(['passed', 'reprint'])
  })

  it('offers nothing once delivered', () => {
    expect(allowedStatuses('delivered')).toEqual([])
  })
})

describe('the reason travels with the part', () => {
  it('reads the live reprint reason off the history', () => {
    expect(reprintReason(part('reprint', [ev('reprint', 'Layer shift at 40mm')]))).toBe(
      'Layer shift at 40mm',
    )
  })

  it('takes the newest one when a part has been back twice', () => {
    const p = part('reprint', [ev('reprint', 'Warped corner', 2), ev('reprint', 'Clog', 1)])
    expect(reprintReason(p)).toBe('Warped corner')
  })

  it('says nothing once the part is no longer going back', () => {
    expect(reprintReason(part('passed', [ev('reprint', 'Clog')]))).toBeNull()
  })

  it('counts every time it was sent back, including the ones it survived', () => {
    const p = part('passed', [ev('passed', null, 3), ev('reprint', 'Clog', 2), ev('reprint', 'Warp', 1)])
    expect(reprintCount(p)).toBe(2)
  })
})

describe('a QC failure is not still review', () => {
  it('asks to go back to building when a part in review was sent back', () => {
    expect(shouldReturnToBuilding('review', [part('passed'), part('reprint')])).toBe(true)
  })

  it('does not ask while everything is still passing', () => {
    expect(shouldReturnToBuilding('review', [part('passed')])).toBe(false)
  })

  it('does not ask in a stage that is already building', () => {
    expect(shouldReturnToBuilding('building', [part('reprint')])).toBe(false)
  })
})
