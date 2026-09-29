/**
 * Programs: a project that holds other projects.
 *
 * CG's shape, and the reason this exists: "BathyTopo be the master program
 * and then I can create sub programs for the Hawaiian Islands, Fiji, French
 * Polynesia, etc." Each of those holds its own prints -- Oʻahu, Maui,
 * Molokaʻi under the Hawaiian Islands -- and the master has to be able to
 * say what the whole thing has cost and made so far.
 *
 * Everything here is PURE and works on the rows listJobs already returns.
 * No backend knows what a program is beyond one column (jobs.related_to);
 * the tree is rebuilt from the list every time, which means both backends
 * get it for free and nothing can go stale. A shop with a few hundred
 * projects walks this in well under a millisecond.
 *
 * ROLLUPS ADD, THEY NEVER COPY. Each project keeps its own runs, material
 * and hours. The program total is the sum over the subtree, computed at
 * read time -- so an hour of design logged on BathyTopo is counted once,
 * on BathyTopo, and every sub-program can see it without paying for it.
 */
import type { JobListRow } from './data.types'

type Row = Pick<JobListRow, 'jobId' | 'ref' | 'title' | 'phase' | 'facts'>

/** Direct members of a program, oldest first -- the order they were started. */
export function childrenOf<T extends Row>(rows: T[], id: string): T[] {
  return rows
    .filter((r) => r.facts.relatedTo === id)
    .sort((a, b) => (a.facts.createdAt < b.facts.createdAt ? -1 : 1))
}

/**
 * The path from the top of the tree down to (not including) this project:
 * [BathyTopo, Hawaiian Islands] for Oʻahu. Bounded, and it stops at the
 * first repeat, so a loop that somehow exists in the data draws a short
 * breadcrumb instead of hanging the screen.
 */
export function ancestorsOf<T extends Row>(rows: T[], id: string): T[] {
  const byId = new Map(rows.map((r) => [r.jobId, r]))
  const out: T[] = []
  const seen = new Set<string>([id])
  let cursor = byId.get(id)?.facts.relatedTo ?? null
  while (cursor && !seen.has(cursor) && out.length < 64) {
    const r = byId.get(cursor)
    if (!r) break
    out.unshift(r)
    seen.add(cursor)
    cursor = r.facts.relatedTo
  }
  return out
}

/** Everything under a program, at any depth. Loop-safe for the same reason. */
export function descendantsOf<T extends Row>(rows: T[], id: string): T[] {
  const out: T[] = []
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length) {
    const next = queue.shift()!
    for (const c of rows) {
      if (c.facts.relatedTo === next && !seen.has(c.jobId)) {
        seen.add(c.jobId)
        out.push(c)
        queue.push(c.jobId)
      }
    }
  }
  return out
}

/** Where a project may be moved to: anywhere except itself and anything
 *  already inside it, which would make a loop. Archived work is left out
 *  of the offer -- it can still be a parent, it just is not suggested. */
export function eligibleParents<T extends Row>(rows: T[], id: string): T[] {
  const inside = new Set(descendantsOf(rows, id).map((r) => r.jobId))
  return rows.filter((r) => r.jobId !== id && !inside.has(r.jobId) && !r.facts.archivedAt)
}

export interface ProgramTotals {
  /** Projects counted, the program itself included. */
  projects: number
  runs: number
  failedUnits: number
  materialUnits: number
  machineHours: number
  /** Human time: design, finishing, admin. */
  hours: number
  cost: number
  unitsMade: number
  parts: number
  partsPassed: number
  /** Projects in the tree that are finished. */
  done: number
}

function add(t: ProgramTotals, r: Row): ProgramTotals {
  const f = r.facts
  return {
    projects: t.projects + 1,
    runs: t.runs + (f.actualRuns ?? 0),
    failedUnits: t.failedUnits + (f.failedUnits ?? 0),
    materialUnits: t.materialUnits + (f.materialUnits ?? 0),
    machineHours: t.machineHours + (f.machineHours ?? 0),
    hours: t.hours + (f.actualHours ?? 0),
    cost: t.cost + (f.actualCost ?? 0),
    unitsMade: t.unitsMade + (f.unitsMade ?? 0),
    parts: t.parts + (f.parts ?? 0),
    partsPassed: t.partsPassed + (f.partsPassed ?? 0),
    done: t.done + (r.phase === 'delivered' ? 1 : 0),
  }
}

const ZERO: ProgramTotals = {
  projects: 0,
  runs: 0,
  failedUnits: 0,
  materialUnits: 0,
  machineHours: 0,
  hours: 0,
  cost: 0,
  unitsMade: 0,
  parts: 0,
  partsPassed: 0,
  done: 0,
}

/** One project on its own. */
export function ownTotals(r: Row): ProgramTotals {
  return add(ZERO, r)
}

/** A project and everything under it. */
export function programTotals<T extends Row>(rows: T[], id: string): ProgramTotals {
  const self = rows.find((r) => r.jobId === id)
  const start = self ? add(ZERO, self) : ZERO
  return descendantsOf(rows, id).reduce(add, start)
}

/** "BathyTopo › Hawaiian Islands" -- for a card or a list row that needs
 *  to say where a project lives without a whole breadcrumb. */
export function pathLabel<T extends Row>(rows: T[], id: string): string | null {
  const a = ancestorsOf(rows, id)
  return a.length ? a.map((r) => r.title).join(' › ') : null
}
