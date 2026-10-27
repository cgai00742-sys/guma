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

/** "Gahet (Instance 2)", "Gahet (2)", "Gahet_1" -> "gahet": the piece, not the copy. */
export function baseName(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s*\((instance\s*)?\d+\)$/i, '')
    .replace(/[_\s-]+\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Failed copies a part is still owed. */
const owed = (p: PartRow) => (p.copyStates ?? []).filter((s) => s === 'reprint').length

/** A best guess for every object of one file. */
export function guessSort(
  objects: SortObject[],
  fileName: string,
  parts: PartRow[],
  earlier: BatchPart[] = [],
): SortGuess[] {
  const taken = [...parts.map((p) => p.label), ...earlier.map((b) => b.label)]
  const out: SortGuess[] = []
  /** Parts already given to an object of this file. */
  /** Open copies each part still has, as objects of this file take them. */
  const left = new Map(parts.map((p) => [p.id, (p.copyStates ?? []).filter((st) => st === 'pending').length]))
  const take = (id: string, n: number) => left.set(id, (left.get(id) ?? 0) - n)
  for (const o of objects) {
    const size = perCopyOf(o)
    const key = o.label.trim().toLowerCase()
    const same = parts.find((p) => p.label.trim().toLowerCase() === key)
    // A failed copy waiting to go again is what a reprint file is FOR (CG,
    // 26 Oct: "allow a future imported file the chance to fill those failed
    // parts, especially if they have the correct name"). A reprint is often
    // re-sliced -- a fix for the ghosting, other things on the plate -- so
    // its size differs; the name, or the same piece numbered differently,
    // is what says it is that part. Filling a failure beats a new part.
    const failing =
      (same && owed(same) > 0 ? same : null) ??
      parts.find((p) => owed(p) > 0 && baseName(p.label) === baseName(o.label)) ??
      null
    // A part on the sheet with no file yet, still owed copies, is waiting
    // for exactly this: the file that prints it (CG, 26 Oct). Same name, or
    // the same piece numbered -- "Gahet" fills "Gahet (Instance 1)".
    const waiting =
      !failing && !(same && same.variants.length)
        ? parts.find(
            (p) =>
              (left.get(p.id) ?? 0) > 0 &&
              p.variants.length === 0 &&
              (p.copyStates ?? []).includes('pending') &&
              baseName(p.label) === baseName(o.label),
          ) ?? null
        : null
    if (waiting) {
      take(waiting.id, Math.max(1, o.qty || 1))
      out.push({
        choice: { kind: 'part', partId: waiting.id },
        why:
          waiting.label.trim().toLowerCase() === key
            ? null
            : `${waiting.label} is on the sheet with no file yet — this is set to print it. Pick New part if it is a different piece.`,
      })
      continue
    }
    if (failing) {
      take(failing.id, Math.max(1, o.qty || 1))
      const sizes = partSizes(failing)
      const n = owed(failing)
      const fits = !sizes.length || sizes.some((s) => sameSize(s, size))
      out.push({
        choice: { kind: 'part', partId: failing.id },
        why: fits && failing === same
          ? null
          : `${failing.label} has ${n} failed cop${n === 1 ? 'y' : 'ies'} going back, so this is set to fill ${n === 1 ? 'it' : 'them'}` +
            (fits ? '.' : ` — though this one is ${[fmtG(size.grams), fmtM(size.minutes)].filter(Boolean).join(', ')} a copy. Pick New part if it is a different piece.`),
      })
      continue
    }
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
