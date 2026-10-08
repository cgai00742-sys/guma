import { describe, expect, it } from 'vitest'
import { allowedStatuses, buildingPhase, reprintCount, reprintReason, shouldReturnToBuilding } from './parts'
import type { PartRow } from './data.types'

function part(status: PartRow['status'], history: PartRow['history'] = []): PartRow {
  return {
    id: 'p1',
    label: 'Buoy shell',
    qty: 2,
    status,
    note: null,
    sort: 0,
    history,
    variants: [],
    chosenSectionId: null,
  }
}

function ev(toStatus: PartRow['status'], note: string | null, id = 1): PartRow['history'][number] {
  return { id, kind: 'status', fromStatus: null, toStatus, note, actor: 'CG', at: '2026-09-27' }
}

describe('what a stage lets you do', () => {
  it('offers nothing before building: a part is still a plan', () => {
    for (const p of ['intake', 'approval', 'design', 'scheduled'] as const) {
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

  /** The shop's own work climbs Working → Made → Done, stored as
   *  design/review/delivered, and never passes through 'building'. Reading
   *  the phase without the kind offered nothing at all on a trial print,
   *  so an imported build sheet could never be finished. */
  it('treats Working as the machine stage on the shop\'s own work', () => {
    expect(allowedStatuses('design', 'inhouse')).toEqual(['printed', 'reprint'])
    expect(allowedStatuses('review', 'inhouse')).toEqual(['passed', 'reprint'])
    expect(allowedStatuses('delivered', 'inhouse')).toEqual([])
  })

  it('still offers nothing in Working on CLIENT work, where design is design', () => {
    expect(allowedStatuses('design')).toEqual([])
  })

  it('sends a failed part back to the stage that runs the machines', () => {
    expect(buildingPhase()).toBe('building')
    expect(buildingPhase('inhouse')).toBe('design')
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

import { chosenVariant, isOnSharedPlate, timeSpreadPct } from './parts'
import type { PartVariant } from './data.types'

function variant(over: Partial<PartVariant> = {}): PartVariant {
  return {
    sectionId: 's1',
    importId: 'i1',
    fileName: 'H2S_Buoy.gcode.3mf',
    printerModel: 'Bambu Lab H2S',
    printerId: null,
    printerName: null,
    estMinutes: 371,
    estGrams: 99,
    material: 'PETG',
    importedAt: '2026-09-27',
    plateParts: 1,
    sectionQty: 1,
    materialId: null,
    ...over,
  }
}

function withVariants(vs: PartVariant[], chosen: string | null = null): PartRow {
  return { ...part('pending'), variants: vs, chosenSectionId: chosen }
}

describe('which file a part is actually printed from', () => {
  it('has nothing to say about a part typed in by hand', () => {
    expect(chosenVariant(part('pending'))).toEqual({ variant: null, picked: false })
  })

  it('assumes the fastest variant until somebody chooses, and says it assumed', () => {
    const slow = variant({ sectionId: 'slow', estMinutes: 371 })
    const fast = variant({ sectionId: 'fast', estMinutes: 309, printerModel: 'Bambu Lab H2D' })
    const got = chosenVariant(withVariants([slow, fast]))
    expect(got.variant?.sectionId).toBe('fast')
    expect(got.picked).toBe(false)
  })

  it('uses the chosen one even when it is the slower machine', () => {
    const slow = variant({ sectionId: 'slow', estMinutes: 371 })
    const fast = variant({ sectionId: 'fast', estMinutes: 309 })
    const got = chosenVariant(withVariants([slow, fast], 'slow'))
    expect(got.variant?.sectionId).toBe('slow')
    expect(got.picked).toBe(true)
  })

  it('falls back to the first variant when no file carried a time', () => {
    const a = variant({ sectionId: 'a', estMinutes: null })
    const b = variant({ sectionId: 'b', estMinutes: null })
    expect(chosenVariant(withVariants([a, b])).variant?.sectionId).toBe('a')
  })
})

describe('the spread that makes choosing matter', () => {
  it('reports the real Voltage figure: 309.5 vs 371.8 minutes is 20%', () => {
    const p = withVariants([
      variant({ sectionId: 'h2d', estMinutes: 309.5 }),
      variant({ sectionId: 'h2s', estMinutes: 371.8 }),
    ])
    expect(timeSpreadPct(p)).toBe(20)
  })

  it('says nothing when there is only one file to go on', () => {
    expect(timeSpreadPct(withVariants([variant()]))).toBeNull()
  })
})

describe('a plate is one print', () => {
  it('flags a variant that shared its plate with other objects', () => {
    expect(isOnSharedPlate(variant({ plateParts: 2 }))).toBe(true)
    expect(isOnSharedPlate(variant({ plateParts: 1 }))).toBe(false)
    expect(isOnSharedPlate(null)).toBe(false)
  })
})

describe('failureTally', () => {
  const ev = (note: string) => ({
    id: note, kind: 'status' as const, fromStatus: 'printed' as const, toStatus: 'reprint' as const,
    note, actor: null, at: '2026-09-01',
  })
  it('is null when nothing failed', async () => {
    const { failureTally } = await import('./parts')
    expect(failureTally([], [])).toBeNull()
  })
  it('counts send-backs, failed plates, what they burned, and a repeated reason', async () => {
    const { failureTally, reprintNote } = await import('./parts')
    const parts = [
      { id: 'a', status: 'reprint', history: [ev(reprintNote('Warped', 'Brim', null)), ev('warped')] },
      { id: 'b', status: 'passed', history: [] },
    ] as never
    const runs = [
      { outcome: 'failed', unitsUsed: 40, hours: 1.5, failureReason: 'Spaghetti' },
      { outcome: 'success', unitsUsed: 90, hours: 3, failureReason: null },
    ] as never
    expect(failureTally(parts, runs)).toEqual({
      sentBack: 2, partsAffected: 1, failedRuns: 1, unitsLost: 40, hoursLost: 1.5, repeatReason: 'warped',
    })
  })
})
