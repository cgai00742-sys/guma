/**
 * The build sheet, read back as quote lines.
 *
 * The quote says what was priced; the build sheet says what is being made.
 * Once someone changes a part's copies (CG, 8 Oct: five of every part, not
 * one), the two disagree and the price on screen is a price for something
 * nobody is making any more. This turns the sheet back into build lines so
 * the difference can be priced and, if it stands, put into a revision.
 *
 * Matching, in order:
 *  1. A part whose label matches a quote line takes that line -- its
 *     per-copy grams and hours, its machine and spool, as quoted -- with
 *     the part's copies.
 *  2. A part with no line but with a sliced file (added after quoting)
 *     becomes a new line from the file: per-copy figures are the file's
 *     figures divided by the copies the file had on its plate.
 *  3. A part with neither is named as not priced, never silently zero.
 *
 * A quote line no part matches is KEPT as quoted and named. It may be
 * hand-typed work that never became a part, so dropping it would cut the
 * price behind the shop's back. The revision form is where it is removed.
 *
 * Pure, so the screen and the revision form read the sheet the same way.
 */
import type { PartRow, PartVariant, QuoteBuildInput } from './data.types'

// Four decimals, not two: 48 copies in 5 h is 0.104 h each, and rounding
// to 0.10 lost 4% of the machine time the file said (review fix, 8 Oct).
const r2 = (n: number) => Math.round(n * 10000) / 10000
const norm = (s: string) => s.trim().toLowerCase()

export interface SheetVsQuote {
  /** The quote's lines with the build sheet's copies. */
  builds: QuoteBuildInput[]
  /** Copies for a single-line quote (no build lines). */
  quantity: number
  quotedCopies: number
  sheetCopies: number
  /** True when pricing the sheet would give a different quote. */
  changed: boolean
  /** Parts with no quote line and no sliced numbers: not in the figure. */
  unpriced: string[]
  /** Quote lines no part matches: still in the figure, as quoted. */
  quotedOnly: string[]
  /** Lines that came from a part's file rather than the quote. */
  added: string[]
}

/** The variant a part is printed from: the chosen one, else the newest
 *  with numbers. */
function printedFrom(p: PartRow): PartVariant | null {
  const chosen = p.variants.find((v) => v.sectionId === p.chosenSectionId)
  if (chosen) return chosen
  return p.variants.find((v) => v.estGrams != null || v.estMinutes != null) ?? null
}

export function sheetVsQuote(
  quoted: QuoteBuildInput[],
  quotedQuantity: number,
  parts: PartRow[],
): SheetVsQuote {
  const quotedCopies = quoted.length ? quoted.reduce((a, b) => a + b.qty, 0) : quotedQuantity
  const sheetCopies = parts.reduce((a, p) => a + p.qty, 0)
  const same: SheetVsQuote = {
    builds: quoted,
    quantity: quotedQuantity,
    quotedCopies,
    sheetCopies: parts.length ? sheetCopies : quotedCopies,
    changed: false,
    unpriced: [],
    quotedOnly: [],
    added: [],
  }
  if (parts.length === 0) return same

  // A single-line quote has no lines to match against: the sheet's copies
  // are the quantity.
  if (quoted.length === 0) {
    return { ...same, quantity: sheetCopies, sheetCopies, changed: sheetCopies !== quotedQuantity }
  }

  const used = new Set<number>()
  const out: (QuoteBuildInput | null)[] = quoted.map(() => null)
  const tail: QuoteBuildInput[] = []
  const unpriced: string[] = []
  const added: string[] = []
  let changed = false

  for (const p of [...parts].sort((a, b) => a.sort - b.sort)) {
    const i = quoted.findIndex((b, k) => !used.has(k) && norm(b.label) === norm(p.label))
    if (i >= 0) {
      used.add(i)
      out[i] = { ...quoted[i], qty: p.qty }
      if (quoted[i].qty !== p.qty) changed = true
      continue
    }
    const v = printedFrom(p)
    if (v && (v.estGrams != null || v.estMinutes != null)) {
      const per = Math.max(1, v.sectionQty)
      tail.push({
        label: p.label,
        printerId: v.printerId ?? quoted[0].printerId,
        materialId: v.materialId ?? quoted[0].materialId,
        qty: p.qty,
        unitsPerPart: v.estGrams == null ? 0 : r2(v.estGrams / per),
        printHrsPerPart: v.estMinutes == null ? 0 : r2(v.estMinutes / 60 / per),
        sliceImportId: v.importId,
      })
      added.push(p.label)
      changed = true
    } else {
      unpriced.push(p.label)
    }
  }

  const quotedOnly: string[] = []
  const builds = quoted.map((b, k) => {
    if (out[k]) return out[k] as QuoteBuildInput
    quotedOnly.push(b.label)
    return b
  })

  return {
    builds: [...builds, ...tail],
    quantity: quotedQuantity,
    quotedCopies,
    sheetCopies,
    changed,
    unpriced,
    quotedOnly,
    added,
  }
}
