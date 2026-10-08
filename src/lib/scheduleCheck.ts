/**
 * Scheduled: the machine, and whether the spool on the shelf covers it.
 *
 * CG, 8 Oct 2026: "on the Scheduled phase we need to give them the option
 * to pick the machine and review the material on hand as a check." Two of
 * the three Scheduled gate items were bare ticks -- "a machine picked",
 * "enough material on hand" -- with nothing on the page to pick or check.
 *
 * Material is read off the build sheet (the same lines the Estimated build
 * prices), grouped by spool, then compared with on_hand. Failures are
 * allowed for at the shop's own failure rate when it has one; when it does
 * not, the screen says the figure has no allowance in it rather than
 * inventing one. Other projects drawing on the same spool are NOT netted
 * off -- Guma does not reserve stock -- and the screen says that too.
 *
 * Pure: the project page, the gate and the tests read it the same way.
 */
import type { QuoteBuildInput } from './data.types'

export interface MaterialNeed {
  materialId: string
  name: string
  unit: 'g' | 'ml'
  /** For the build sheet as it stands, before failures. */
  need: number
  /** need plus the failure allowance. */
  needWithFailures: number
  onHand: number
  ok: boolean
}

export interface MaterialCheck {
  lines: MaterialNeed[]
  /** The failure allowance used, as a percent; null when the shop has none. */
  failurePct: number | null
  /** Build lines with no spool: their grams are not in any line above. */
  unassigned: number
  /** true: every spool covers it. false: something is short. null: there
   *  is nothing to check (no build lines with grams). */
  ok: boolean | null
}

export function materialCheck(
  builds: QuoteBuildInput[],
  single: { materialId: string | null; quantity: number; unitsPerPart: number } | null,
  stock: { id: string; name: string; unit: 'g' | 'ml'; onHand: number }[],
  failurePct: number | null,
): MaterialCheck {
  const need = new Map<string, number>()
  let unassigned = 0
  const add = (id: string | null, units: number) => {
    if (units <= 0) return
    if (!id) {
      unassigned += units
      return
    }
    need.set(id, (need.get(id) ?? 0) + units)
  }
  if (builds.length) for (const b of builds) add(b.materialId, b.qty * b.unitsPerPart)
  else if (single) add(single.materialId, single.quantity * single.unitsPerPart)

  const pct = failurePct != null && failurePct > 0 ? failurePct : null
  const lines: MaterialNeed[] = [...need.entries()].map(([id, n]) => {
    const m = stock.find((s) => s.id === id)
    const withF = pct ? n * (1 + pct / 100) : n
    const onHand = m?.onHand ?? 0
    return {
      materialId: id,
      name: m?.name ?? 'A material no longer on file',
      unit: m?.unit ?? 'g',
      need: Math.round(n),
      needWithFailures: Math.ceil(withF),
      onHand,
      ok: onHand >= Math.ceil(withF),
    }
  })
  return {
    lines,
    failurePct: pct,
    unassigned: Math.round(unassigned),
    ok: lines.length === 0 ? null : lines.every((l) => l.ok),
  }
}
