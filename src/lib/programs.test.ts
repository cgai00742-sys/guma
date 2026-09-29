import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  childrenOf,
  descendantsOf,
  eligibleParents,
  pathLabel,
  programTotals,
} from './programs'
import type { JobListRow } from './data.types'

let n = 0
function row(
  jobId: string,
  title: string,
  relatedTo: string | null,
  over: Partial<JobListRow['facts']> = {},
  phase: JobListRow['phase'] = 'design',
): JobListRow {
  n++
  return {
    jobId,
    ref: `G-${n}`,
    title,
    phase,
    facts: {
      relatedTo,
      createdAt: `2026-09-${String(n).padStart(2, '0')}T00:00:00Z`,
      archivedAt: null,
      actualRuns: 0,
      failedUnits: 0,
      materialUnits: 0,
      machineHours: 0,
      actualHours: 0,
      actualCost: 0,
      unitsMade: 0,
      parts: 0,
      partsPassed: 0,
      ...over,
    },
  } as unknown as JobListRow
}

/** CG's real shape. */
function bathy() {
  n = 0
  return [
    row('bathy', 'BathyTopo', null, { actualHours: 12, actualCost: 300 }),
    row('hi', 'Hawaiian Islands', 'bathy'),
    row('oahu', 'Oʻahu', 'hi', { actualRuns: 2, materialUnits: 410, machineHours: 18, actualCost: 42 }),
    row('maui', 'Maui', 'hi', { actualRuns: 1, materialUnits: 380, machineHours: 16, actualCost: 38 }, 'delivered'),
    row('fiji', 'Fiji', 'bathy'),
    row('fp', 'French Polynesia', 'bathy'),
    row('other', 'Calibration tower', null, { actualCost: 5 }),
  ]
}

describe('what is in a program', () => {
  it('lists the direct members in the order they were started', () => {
    expect(childrenOf(bathy(), 'bathy').map((r) => r.title)).toEqual([
      'Hawaiian Islands',
      'Fiji',
      'French Polynesia',
    ])
  })

  it('reaches every depth — the islands are inside BathyTopo too', () => {
    expect(descendantsOf(bathy(), 'bathy').map((r) => r.jobId).sort()).toEqual(
      ['fiji', 'fp', 'hi', 'maui', 'oahu'].sort(),
    )
  })

  it('draws the path down to a print', () => {
    expect(ancestorsOf(bathy(), 'oahu').map((r) => r.title)).toEqual([
      'BathyTopo',
      'Hawaiian Islands',
    ])
    expect(pathLabel(bathy(), 'oahu')).toBe('BathyTopo › Hawaiian Islands')
    expect(pathLabel(bathy(), 'bathy')).toBeNull()
  })
})

describe('what a program has cost and made', () => {
  it('adds the whole tree once — the master, the regions, the islands', () => {
    const t = programTotals(bathy(), 'bathy')
    expect(t.projects).toBe(6)
    expect(t.runs).toBe(3)
    expect(t.materialUnits).toBe(790)
    expect(t.machineHours).toBe(34)
    // BathyTopo's own design hours are counted once, on BathyTopo.
    expect(t.hours).toBe(12)
    expect(t.cost).toBe(380)
    expect(t.done).toBe(1)
  })

  it('totals a middle layer on its own', () => {
    const t = programTotals(bathy(), 'hi')
    expect(t.projects).toBe(3)
    expect(t.cost).toBe(80)
  })

  it('leaves unrelated work out', () => {
    expect(programTotals(bathy(), 'bathy').cost).not.toBe(385)
  })
})

describe('moving a project', () => {
  it('never offers a parent that would make a loop', () => {
    const ids = eligibleParents(bathy(), 'hi').map((r) => r.jobId)
    expect(ids).not.toContain('hi')
    expect(ids).not.toContain('oahu')
    expect(ids).not.toContain('maui')
    expect(ids).toContain('bathy')
    expect(ids).toContain('fiji')
  })

  it('does not suggest archived work as a home', () => {
    const rows = bathy()
    rows[4].facts.archivedAt = '2026-09-28'
    expect(eligibleParents(rows, 'oahu').map((r) => r.jobId)).not.toContain('fiji')
  })
})

describe('bad data does not hang the screen', () => {
  it('stops at a loop that already exists instead of walking forever', () => {
    n = 0
    const rows = [row('a', 'A', 'b'), row('b', 'B', 'a')]
    expect(ancestorsOf(rows, 'a').map((r) => r.jobId)).toEqual(['b'])
    expect(descendantsOf(rows, 'a').map((r) => r.jobId)).toEqual(['b'])
    expect(programTotals(rows, 'a').projects).toBe(2)
  })
})
