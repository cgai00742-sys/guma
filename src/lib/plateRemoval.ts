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
  /** sectionQty: copies of this part one print of that plate makes. */
  variants: { importId: string; sectionQty?: number }[]
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
    // You need more than this plate makes (CG, 26 Oct: "the needed 5 parts"
    // were cleared with the plate): the count is a requirement, not the
    // plate's. The part stays, waiting for its next file.
    const makes = Math.max(1, ...p.variants.filter((v) => going.has(v.importId)).map((v) => Number(v.sectionQty) || 1))
    if (!left && p.qty > makes) {
      out.keep.push({
        id: p.id,
        label: p.label,
        why: `you need ${p.qty} and this plate makes ${makes} — the part stays with its ${p.qty} copies${removePrints ? ', its marks from this plate undone' : ''}; the next file for it fills them.`,
      })
      continue
    }
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

export interface StrandedRun {
  id: string
  sliceImportId: string | null
  startedAt: string | null
  hours: number | null
  unitsUsed: number | null
}

export interface StrandedReport {
  /** No plate, nothing marked: safe to clear. */
  clear: { id: string; label: string }[]
  /** No plate, but copies marked -- each with what marked them. */
  marked: { id: string; label: string; why: string }[]
  /** Prints with no plate that marked those copies -- the trail an earlier
   *  plate removal left (CG, 24 Oct). Each with every part it marked. */
  prints: { id: string; said: string; parts: string[] }[]
}

/**
 * Every part with no plate behind it, and the truth about its marks (CG, 24
 * Oct: "things stated as printed when the only plate imported doesn't have
 * those pieces"). Before 23 Oct removing a plate left its prints behind,
 * with no plate, still marking copies printed. This says so per part, and
 * names those prints so they can be undone -- never undone by itself, since
 * a print typed in by hand looks the same and may be real.
 */
export function strandedReport(parts: RemovalPart[], runs: StrandedRun[]): StrandedReport {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const out: StrandedReport = { clear: [], marked: [], prints: [] }
  const printParts = new Map<string, Set<string>>()
  for (const p of parts) {
    if (p.variants.length) continue
    let hand = 0
    const viaRun = new Map<string, number>()
    p.copyStates.forEach((st, i) => {
      if (st === 'pending') return
      const c = i + 1
      const ev = p.history.find((h) => h.kind === 'status' && h.toStatus && (h.copies == null || h.copies.includes(c)))
      const run = ev?.runId ? byId.get(ev.runId) : undefined
      if (!run) hand++
      else viaRun.set(run.id, (viaRun.get(run.id) ?? 0) + 1)
    })
    const n = hand + [...viaRun.values()].reduce((a, b) => a + b, 0)
    if (!n) {
      out.clear.push({ id: p.id, label: p.label })
      continue
    }
    const bits: string[] = []
    for (const [rid, k] of viaRun) {
      const r = byId.get(rid)!
      bits.push(`${k} by ${r.sliceImportId ? 'a print from another plate' : `the print of ${describeRun(r)}, which has no plate`}`)
      if (!r.sliceImportId) {
        if (!printParts.has(rid)) printParts.set(rid, new Set())
        printParts.get(rid)!.add(p.label)
      }
    }
    if (hand) bits.push(`${hand} marked by hand`)
    out.marked.push({
      id: p.id,
      label: p.label,
      why: `${n} of ${p.qty} marked — ${bits.join(', ')}.`,
    })
  }
  for (const [rid, labels] of printParts)
    out.prints.push({ id: rid, said: describeRun(byId.get(rid)!), parts: [...labels] })
  return out
}

function describeRun(r: StrandedRun): string {
  const h = r.hours ?? 0
  const t = h >= 1 ? `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m` : `${Math.round(h * 60)}m`
  return [r.startedAt?.slice(0, 10) ?? 'an unknown day', h ? t : null, r.unitsUsed ? `${Math.round(r.unitsUsed)} g` : null]
    .filter(Boolean)
    .join(', ')
}
