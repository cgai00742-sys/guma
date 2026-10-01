/**
 * The series tree, rebuilt from two flat lists every time: the series and
 * the project list. Nothing is cached, so nothing goes stale.
 *
 * A series is a container (0026_series.sql). Its pieces are ordinary
 * projects with their own stages. Totals ADD over the series, every series
 * inside it, and every piece in any of them -- a figure logged on Maui is
 * counted once, on Maui, and shows up in Hawaiian Islands and BathyTopo.
 */
import type { JobListRow, SeriesRow } from './data.types'
import { ownTotals, type ProgramTotals } from './programs'

type Row = Pick<JobListRow, 'jobId' | 'ref' | 'title' | 'phase' | 'facts'>

export function seriesChildren(all: SeriesRow[], id: string | null): SeriesRow[] {
  return all.filter((s) => s.parentId === id).sort((a, b) => a.name.localeCompare(b.name))
}

/** Root first, the series itself excluded. */
export function seriesAncestors(all: SeriesRow[], id: string): SeriesRow[] {
  const byId = new Map(all.map((s) => [s.id, s]))
  const out: SeriesRow[] = []
  const seen = new Set([id])
  let cursor = byId.get(id)?.parentId ?? null
  while (cursor && !seen.has(cursor) && out.length < 64) {
    const s = byId.get(cursor)
    if (!s) break
    out.unshift(s)
    seen.add(cursor)
    cursor = s.parentId
  }
  return out
}

export function seriesDescendants(all: SeriesRow[], id: string): SeriesRow[] {
  const out: SeriesRow[] = []
  const seen = new Set([id])
  const queue = [id]
  while (queue.length) {
    const next = queue.shift()!
    for (const s of all) {
      if (s.parentId === next && !seen.has(s.id)) {
        seen.add(s.id)
        out.push(s)
        queue.push(s.id)
      }
    }
  }
  return out
}

/** "BathyTopo › Hawaiian Islands" -- the full name of a series. */
export function seriesPath(all: SeriesRow[], id: string | null): string | null {
  if (!id) return null
  const self = all.find((s) => s.id === id)
  if (!self) return null
  return [...seriesAncestors(all, id), self].map((s) => s.name).join(' › ')
}

/** Pieces filed directly in this series. */
export function piecesOf<T extends Row>(rows: T[], id: string): T[] {
  return rows
    .filter((r) => r.facts.seriesId === id)
    .sort((a, b) => (a.facts.createdAt < b.facts.createdAt ? -1 : 1))
}

/** Pieces in this series or anywhere inside it. */
export function allPiecesOf<T extends Row>(rows: T[], all: SeriesRow[], id: string): T[] {
  const ids = new Set([id, ...seriesDescendants(all, id).map((s) => s.id)])
  return rows.filter((r) => r.facts.seriesId && ids.has(r.facts.seriesId))
}

export function seriesTotals<T extends Row>(rows: T[], all: SeriesRow[], id: string): ProgramTotals {
  const pieces = allPiecesOf(rows, all, id)
  if (!pieces.length) {
    return {
      projects: 0, runs: 0, failedUnits: 0, materialUnits: 0, machineHours: 0,
      hours: 0, cost: 0, unitsMade: 0, parts: 0, partsPassed: 0, done: 0,
    }
  }
  return pieces.slice(1).reduce((t, r) => {
    const o = ownTotals(r)
    return {
      projects: t.projects + o.projects,
      runs: t.runs + o.runs,
      failedUnits: t.failedUnits + o.failedUnits,
      materialUnits: t.materialUnits + o.materialUnits,
      machineHours: t.machineHours + o.machineHours,
      hours: t.hours + o.hours,
      cost: t.cost + o.cost,
      unitsMade: t.unitsMade + o.unitsMade,
      parts: t.parts + o.parts,
      partsPassed: t.partsPassed + o.partsPassed,
      done: t.done + o.done,
    }
  }, ownTotals(pieces[0]))
}

/** Where this series may be moved: not itself, not anything inside it. */
export function eligibleSeriesParents(all: SeriesRow[], id: string): SeriesRow[] {
  const inside = new Set(seriesDescendants(all, id).map((s) => s.id))
  return all.filter((s) => s.id !== id && !inside.has(s.id) && !s.archivedAt)
}
