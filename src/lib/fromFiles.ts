/**
 * What the sliced files on a project say it took, and how much of that has
 * been recorded.
 *
 * Reported by CG, more than once: "I've uploaded the G-code to Maui several
 * times and it should have everything needed for what it took." It did --
 * but the numbers sat under the build sheet as an estimate, behind a button
 * nobody saw, while "What it actually took" showed only recorded runs. This
 * is the bridge: every distinct file, its numbers, and whether they are in
 * the project's cost yet. Uploading one file three times is ONE file here.
 */
import { sameSliceFile, type PrintRunRow, type SliceImportRow } from './data.types'

export interface FileGroup {
  /** The first import of this file -- the one runs are recorded against. */
  first: SliceImportRow
  ids: string[]
  uploads: number
  runs: PrintRunRow[]
  recorded: boolean
  usedUnits: number
  usedHours: number
  estHours: number | null
  estGrams: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function groupSliceFiles(slices: SliceImportRow[], runs: PrintRunRow[]): FileGroup[] {
  const ordered = [...slices].sort((a, b) => a.importedAt.localeCompare(b.importedAt))
  const groups: FileGroup[] = []
  for (const s of ordered) {
    const g = groups.find((x) => sameSliceFile(x.first, s))
    if (g) {
      g.ids.push(s.id)
      g.uploads++
    } else {
      groups.push({
        first: s,
        ids: [s.id],
        uploads: 1,
        runs: [],
        recorded: false,
        usedUnits: 0,
        usedHours: 0,
        estHours: s.estMinutes == null ? null : r2(s.estMinutes / 60),
        estGrams: s.estGrams == null ? null : Math.round(s.estGrams),
      })
    }
  }
  for (const g of groups) {
    g.runs = runs.filter((r) => r.sliceImportId && g.ids.includes(r.sliceImportId))
    g.recorded = g.runs.length > 0
    g.usedUnits = Math.round(g.runs.reduce((a, r) => a + (r.unitsUsed ?? 0), 0))
    g.usedHours = r2(g.runs.reduce((a, r) => a + (r.hours ?? 0), 0))
  }
  return groups
}

/**
 * Plates newest first, by when they were printed (CG, 20 Oct: "organize the
 * imported files based on when the part was printed ... the top of the list
 * is the most recent"). A plate not printed yet is the work in hand, so it
 * sits above them all, newest import first. Two prints on one day keep the
 * order they were recorded in -- `runs` arrives newest first.
 */
export function newestFirst(groups: FileGroup[], runs: PrintRunRow[]): FileGroup[] {
  const latest = (g: FileGroup) => {
    let best = -1
    for (const r of g.runs) {
      const i = runs.indexOf(r)
      if (i >= 0 && (best < 0 || i < best)) best = i
    }
    return best
  }
  return [...groups].sort((a, b) => {
    const la = latest(a)
    const lb = latest(b)
    if (la < 0 || lb < 0) {
      if (la < 0 && lb < 0) return b.first.importedAt.localeCompare(a.first.importedAt)
      return la < 0 ? -1 : 1
    }
    const da = runs[la].startedAt ?? ''
    const db = runs[lb].startedAt ?? ''
    return da === db ? la - lb : db.localeCompare(da)
  })
}

/** The machine a file's print goes against without asking: the one the
 *  file matched, or the shop's only machine. Null means someone must pick. */
export function machineFor(group: FileGroup, printers: { id: string }[]): string | null {
  if (group.first.printerId) return group.first.printerId
  return printers.length === 1 ? printers[0].id : null
}
