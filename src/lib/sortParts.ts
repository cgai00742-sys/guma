/**
 * Which part each object in a sliced file belongs to -- asked, not assumed
 * (CG, 16 Oct: "a plate can have the same name due to how it is saved in
 * Prusa Slicer but have completely different parts ... identify the parts
 * from the imported files and ask the user to sort them").
 *
 * Guma used to match an object to a part by name alone. PrusaSlicer names an
 * object after the model it was loaded from, so two different prints of
 * "Maui BATHY 3x" -- one 355 g, one 117 g -- became one part, and an object
 * whose name was reused landed on a part it was not. So: a name match is
 * only guessed when the size agrees too; otherwise it is a new part, and the
 * screen says why. The person has the last word on every row.
 */
import type { PartRow, SectionAssign } from './data.types'
import { uniqueLabel } from './data.types'

export type SortChoice =
  | { kind: 'new'; label: string }
  | { kind: 'part'; partId: string }
  /** The new part an earlier file of the same batch is making. */
  | { kind: 'join'; label: string }

export interface SortGuess {
  choice: SortChoice
  /** Why it was not simply matched by name, when that is worth saying. */
  why: string | null
}

export interface SortObject {
  label: string
  qty: number
  estGrams: number | null
  estMinutes: number | null
}

/** A new part already chosen by an earlier file in the batch. */
export interface BatchPart {
  label: string
  objectLabel: string
  grams: number | null
  minutes: number | null
  fileName: string
}

/** "Sliced_Outer Islands_Maui_BATHY_3x_0.4n_0.1mm_PLA_XLIS_29m (1).bgcode" -> "Outer Islands Maui BATHY 3x" */
export function nameFromFile(fileName: string): string {
  let n = fileName.replace(/\.(gcode\.3mf|bgcode|gcode|3mf)$/i, '')
  n = n.replace(/\s\(\d+\)$/, '')
  n = n.replace(/^sliced[_\s-]+/i, '')
  // PrusaSlicer's default output name: <model>_<nozzle>n_<layer>mm_<material>_<printer>_<time>
  n = n.replace(/_\d+(\.\d+)?n_.*$/i, '')
  return n.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || fileName
}

/** One copy's grams and minutes, from what an object's file said. */
export function perCopyOf(o: { qty: number; estGrams: number | null; estMinutes: number | null }) {
  const q = Math.max(1, o.qty || 1)
  return {
    grams: o.estGrams == null ? null : o.estGrams / q,
    minutes: o.estMinutes == null ? null : o.estMinutes / q,
  }
}

/** Within 15% on grams -- or on time when there are no grams. Unknown agrees. */
export function sameSize(
  a: { grams: number | null; minutes: number | null },
  b: { grams: number | null; minutes: number | null },
  tol = 0.15,
): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= tol * Math.max(x, y, 0.0001)
  if (a.grams != null && b.grams != null) return near(a.grams, b.grams)
  if (a.minutes != null && b.minutes != null) return near(a.minutes, b.minutes)
  return true
}

/** The sizes a part is already known at, from its files. Empty: none known. */
export function partSizes(p: PartRow): { grams: number | null; minutes: number | null }[] {
  return p.variants.map((v) => perCopyOf({ qty: v.sectionQty, estGrams: v.estGrams, estMinutes: v.estMinutes }))
}

const fmtG = (g: number | null) => (g == null ? null : `${Math.round(g)} g`)
const fmtM = (m: number | null) =>
  m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`

/** A best guess for every object of one file. */
export function guessSort(
  objects: SortObject[],
  fileName: string,
  parts: PartRow[],
  earlier: BatchPart[] = [],
): SortGuess[] {
  const taken = [...parts.map((p) => p.label), ...earlier.map((b) => b.label)]
  const out: SortGuess[] = []
  for (const o of objects) {
    const size = perCopyOf(o)
    const key = o.label.trim().toLowerCase()
    const same = parts.find((p) => p.label.trim().toLowerCase() === key)
    if (same) {
      const sizes = partSizes(same)
      if (!sizes.length || sizes.some((s) => sameSize(s, size))) {
        out.push({ choice: { kind: 'part', partId: same.id }, why: null })
        continue
      }
      const label = uniqueLabel(objects.length === 1 ? nameFromFile(fileName) : o.label, taken)
      taken.push(label)
      const known = sizes[0]
      out.push({
        choice: { kind: 'new', label },
        why:
          `Same name as ${same.label} (${[fmtG(known.grams), fmtM(known.minutes)].filter(Boolean).join(', ') || 'size unknown'} a copy), ` +
          `but this is ${[fmtG(size.grams), fmtM(size.minutes)].filter(Boolean).join(', ')} — so it is set as a new part. ` +
          `Pick ${same.label} if it really is the same piece.`,
      })
      continue
    }
    const mate = earlier.find((b) => b.objectLabel.trim().toLowerCase() === key && sameSize(b, size))
    if (mate) {
      out.push({ choice: { kind: 'join', label: mate.label }, why: `Same object as ${mate.fileName} above.` })
      continue
    }
    // A file with no object labels names its one object after the whole file
    // name, slicer settings and all; the cleaned name is what was meant.
    const fromFile = nameFromFile(fileName)
    const bare =
      objects.length === 1 &&
      fromFile.length < o.label.length &&
      fileName.replace(/[_\s]+/g, ' ').toLowerCase().includes(o.label.trim().toLowerCase())
    const label = uniqueLabel(bare ? fromFile : o.label, taken)
    taken.push(label)
    out.push({ choice: { kind: 'new', label }, why: null })
  }
  return out
}

export function toAssign(c: SortChoice): SectionAssign {
  return c.kind === 'part' ? { partId: c.partId } : c.kind === 'join' ? { label: c.label } : { newLabel: c.label }
}

/** The select's value for a choice, and back. */
export function choiceValue(c: SortChoice): string {
  return c.kind === 'part' ? `part:${c.partId}` : c.kind === 'join' ? `join:${c.label}` : 'new'
}
export function choiceFrom(v: string, newLabel: string): SortChoice {
  if (v.startsWith('part:')) return { kind: 'part', partId: v.slice(5) }
  if (v.startsWith('join:')) return { kind: 'join', label: v.slice(5) }
  return { kind: 'new', label: newLabel }
}
