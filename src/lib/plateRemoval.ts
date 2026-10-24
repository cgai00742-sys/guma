/**
 * What removing a plate does to the build sheet (CG, 23 Oct: "when I remove
 * a plate ... it doesn't automatically update the part section. It should
 * match so that accurate records are kept, and if not an explanation as to
 * why those parts are kept should be given").
 *
 * Pure: the parts as the screen has them, the plates going, the prints
 * going. Out comes, for every part those plates touched, whether it comes
 * off the sheet or stays -- and when it stays, the reason in words. The
 * confirm box shows this, and the removal does exactly this, so what was
 * promised is what happens.
 *
 * The rule:
 *  - A part another plate still makes stays: that plate is its source now.
 *  - A part only these plates made comes off -- unless a copy of it will
 *    still be marked once these plates' prints are undone. Then it stays,
 *    and says which copies and what marked them (by hand, or a print being
 *    kept), because removing it would throw away a real record.
 */
import type { PartStatus } from './data.types'

export interface RemovalPart {
  id: string
  label: string
  qty: number
  copyStates: PartStatus[]
  variants: { importId: string }[]
  history: {
    kind: 'status' | 'note'
    toStatus: PartStatus | null
    copies: number[] | null
    runId: string | null
  }[]
}

export interface PlateRemoval {
  /** Off the sheet: nothing else makes them and nothing marked will be left. */
  remove: { id: string; label: string }[]
  /** On the sheet, with why. */
  keep: { id: string; label: string; why: string }[]
}

const WORD: Partial<Record<PartStatus, string>> = {
  printed: 'printed',
  passed: 'passed',
  reprint: 'going back',
}

export function plateRemoval(
  parts: RemovalPart[],
  importIds: string[],
  runIds: string[],
  removePrints: boolean,
): PlateRemoval {
  const going = new Set(importIds)
  const runs = new Set(removePrints ? runIds : [])
  const kept = new Set(removePrints ? [] : runIds)
  const out: PlateRemoval = { remove: [], keep: [] }

  for (const p of parts) {
    if (!p.variants.some((v) => going.has(v.importId))) continue
    const others = [...new Set(p.variants.filter((v) => !going.has(v.importId)).map((v) => v.importId))]
    if (others.length) {
      out.keep.push({ id: p.id, label: p.label, why: 'another plate still makes it' })
      continue
    }
    // Which copies stay marked once these prints are undone, and by what.
    let byHand = 0
    let byKeptPrint = 0
    let byOtherPrint = 0
    const states = new Map<string, number>()
    p.copyStates.forEach((st, i) => {
      if (st === 'pending') return
      const c = i + 1
      // History is newest first: the latest status event naming this copy.
      const ev = p.history.find(
        (h) => h.kind === 'status' && h.toStatus && (h.copies == null || h.copies.includes(c)),
      )
      if (ev?.runId && runs.has(ev.runId)) return // undone with its print
      if (!ev?.runId) byHand++
      else if (kept.has(ev.runId)) byKeptPrint++
      else byOtherPrint++
      const w = WORD[st] ?? st
      states.set(w, (states.get(w) ?? 0) + 1)
    })
    const left = byHand + byKeptPrint + byOtherPrint
    if (!left) {
      out.remove.push({ id: p.id, label: p.label })
      continue
    }
    const what = [...states].map(([w, n]) => `${n} ${w}`).join(', ')
    const how = [
      byHand ? `${byHand} marked by hand` : null,
      byKeptPrint ? `${byKeptPrint} by ${byKeptPrint === 1 ? 'a print' : 'prints'} you are keeping` : null,
      byOtherPrint ? `${byOtherPrint} by another plate's print` : null,
    ]
      .filter(Boolean)
      .join(', ')
    out.keep.push({
      id: p.id,
      label: p.label,
      why: `${left} of ${p.qty} cop${p.qty === 1 ? 'y stays' : 'ies stay'} marked (${what}) — ${how}. Removing the part would lose that record; change or remove it on the sheet if it is wrong.`,
    })
  }
  return out
}

/**
 * Parts with no plate behind them and nothing marked -- what earlier plate
 * removals left on the sheet (the "no file — marked by hand, 0 of 5" rows).
 * Offered for removal, never removed by themselves: a part typed in by hand
 * on purpose looks the same.
 */
export function strandedParts(parts: RemovalPart[]): { id: string; label: string }[] {
  return parts
    .filter((p) => p.variants.length === 0 && p.copyStates.every((s) => s === 'pending'))
    .map((p) => ({ id: p.id, label: p.label }))
}
