/**
 * Scheduled: the machine, and whether the spool on the shelf covers it.
 *
 * CG, 8 Oct 2026: "on the Scheduled phase we need to give them the option
 * to pick the machine and review the material on hand as a check." Two of
 * the three Scheduled gate items were bare ticks -- "a machine picked",
 * "enough material on hand" -- with nothing on the page to pick or check.
 *
 * Material is read off the build sheet (the same lines the Estimated build
 * prices), grouped by spool, then compared with what is AVAILABLE: on
 * hand less what other live projects have set aside (stock_holds, CG
 * 8 Oct -- "the more accurate stock accounting"). Failures are
 * allowed for at the shop's own failure rate when it has one; when it does
 * not, the screen says the figure has no allowance in it rather than
 * inventing one. Covered is not the same as set aside: until this project
 * holds its share, the next project to look sees the same grams.
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
  /** Still held by OTHER live projects. */
  heldElsewhere: number
  /** onHand less heldElsewhere -- what this project can actually have. */
  available: number
  /** What this project has set aside (less what its runs already used). */
  heldHere: number
  /** available covers needWithFailures. */
  ok: boolean
  /** heldHere covers needWithFailures. */
  setAside: boolean
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
  /** Every spool covered AND set aside for this project. */
  allSetAside: boolean
}

export function materialCheck(
  builds: QuoteBuildInput[],
  single: { materialId: string | null; quantity: number; unitsPerPart: number } | null,
  stock: { id: string; name: string; unit: 'g' | 'ml'; onHand: number }[],
  failurePct: number | null,
  holds: { jobId: string; materialId: string; remaining: number }[] = [],
  jobId: string | null = null,
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
    const mine = holds.filter((h) => h.materialId === id)
    const heldElsewhere = Math.round(mine.filter((h) => h.jobId !== jobId).reduce((a, h) => a + h.remaining, 0))
    const heldHere = Math.round(mine.filter((h) => h.jobId === jobId).reduce((a, h) => a + h.remaining, 0))
    const available = Math.max(0, Math.round(onHand) - heldElsewhere)
    return {
      materialId: id,
      name: m?.name ?? 'A material no longer on file',
      unit: m?.unit ?? 'g',
      need: Math.round(n),
      needWithFailures: Math.ceil(withF),
      onHand,
      heldElsewhere,
      available,
      heldHere,
      ok: available >= Math.ceil(withF),
      setAside: heldHere >= Math.ceil(withF),
    }
  })
  return {
    lines,
    failurePct: pct,
    unassigned: Math.round(unassigned),
    ok: lines.length === 0 ? null : lines.every((l) => l.ok),
    allSetAside: lines.length > 0 && lines.every((l) => l.setAside),
  }
}

/**
 * What this project should still hold once its build sheet needs less (CG,
 * 12 Oct: fewer copies in In build, "release the excess"). Each spool's
 * hold comes down to what the sheet now needs, failure allowance included
 * -- the same figure "Set aside" used -- and never goes UP here: needing
 * more is a decision about stock, made at the spool check, not a side
 * effect of an edit. Spools the sheet no longer prices (a part with no
 * numbers) are left alone. Null when nothing would change.
 */
export function trimHolds(
  lines: Pick<MaterialNeed, 'materialId' | 'name' | 'unit' | 'needWithFailures'>[],
  mine: { materialId: string; held: number }[],
): { holds: { materialId: string; units: number }[]; released: { name: string; unit: string; units: number }[] } | null {
  const released: { name: string; unit: string; units: number }[] = []
  const holds = mine.map((h) => {
    const line = lines.find((l) => l.materialId === h.materialId)
    if (!line) return { materialId: h.materialId, units: h.held }
    const units = Math.min(h.held, line.needWithFailures)
    if (units < h.held) released.push({ name: line.name, unit: line.unit, units: Math.round(h.held - units) })
    return { materialId: h.materialId, units }
  })
  return released.length ? { holds, released } : null
}
