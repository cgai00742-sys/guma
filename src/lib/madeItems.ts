/**
 * What a print made, object by object, and what each piece cost (CG, 21 Oct
 * 2026). Pure, so the arithmetic is tested once and both backends and the
 * screen agree.
 *
 * A print run is a batch that produces units -- the pattern maker inventory
 * tools use (Katana, Craftybase). Each unit carries its share of the run's
 * cost, by grams: the file's grams for an object that came off, what it
 * weighed for one that failed. The shares add up to the run, so nothing is
 * counted twice and nothing goes missing: a failed object's share is lost to
 * failures, a good one's goes with it to the shelf or into an assembly.
 */
import type { MaterialRef, PrinterRef } from './pricing'

/** What one recorded print cost -- the same arithmetic as job_actuals
 *  (0033): material at the spool's cost, electricity when the machine has a
 *  wattage and the shop a $/kWh (else the machine rate), and wear. */
export function runCost(
  run: { hours: number | null; unitsUsed: number | null; materialId: string | null; printerId: string | null },
  materials: MaterialRef[],
  printers: PrinterRef[],
  kwhRate: number | null,
): number {
  const h = Math.max(0, Number(run.hours) || 0)
  const g = Math.max(0, Number(run.unitsUsed) || 0)
  const m = materials.find((x) => x.id === run.materialId)
  const p = printers.find((x) => x.id === run.printerId)
  const material = m ? g * m.costPerUnit : 0
  const machine = !p ? 0 : p.watts && p.watts > 0 && kwhRate && kwhRate > 0 ? h * (p.watts / 1000) * kwhRate : h * p.ratePerHour
  const wear = p ? h * p.wearPerHour : 0
  return round6(material + machine + wear)
}

export interface PlateObject {
  /** The slice_sections row, or null for an object with no file. */
  sectionId: string | null
  label: string
  /** One copy's grams, from the file. Null when the file did not say. */
  grams: number | null
}

/** Every copy of every object on a plate, one line each. */
export function plateObjects(
  sections: { id: string; label: string; qty: number; estGrams: number | null }[],
  plateGrams: number | null,
): PlateObject[] {
  const out: PlateObject[] = []
  const copies = sections.reduce((a, s) => a + Math.max(1, s.qty || 1), 0)
  for (const s of sections) {
    const q = Math.max(1, s.qty || 1)
    const each = s.estGrams != null ? s.estGrams / q : plateGrams != null && copies ? plateGrams / copies : null
    for (let i = 0; i < q; i++) out.push({ sectionId: s.id, label: s.label, grams: each })
  }
  return out
}

export interface ObjectResult extends PlateObject {
  failed: boolean
  /** What a failed object weighed. Null: not weighed -- the file's share. */
  weighed: number | null
}

/** Each object's share of the run's cost, in the order given. */
export function splitCost(objects: ObjectResult[], total: number): { grams: number | null; unitCost: number }[] {
  const basis = objects.map((o) => (o.failed && o.weighed != null ? Math.max(0, o.weighed) : (o.grams ?? 0)))
  const sum = basis.reduce((a, b) => a + b, 0)
  return objects.map((o, i) => ({
    grams: o.failed && o.weighed != null ? o.weighed : o.grams,
    unitCost: round6(objects.length === 0 ? 0 : sum > 0 ? (total * basis[i]) / sum : total / objects.length),
  }))
}

/** What a print with these results takes off the spool: what came off at the
 *  file's grams, what failed at what it weighed. Purge is in the file's
 *  per-object grams already (lib/sliceImport.ts scales sections to the
 *  plate's total). */
export function gramsUsed(objects: ObjectResult[]): number {
  return Math.round(
    objects.reduce((a, o) => a + (o.failed && o.weighed != null ? Math.max(0, o.weighed) : (o.grams ?? 0)), 0) * 10,
  ) / 10
}

export interface Need {
  label: string
  qty: number
}

/** What an assembly has against what it needs, line by line, matched by
 *  name (ignoring case and spacing). Extras -- in it, not on the list -- are
 *  reported so nothing in it goes uncounted. */
export function assemblyStatus(needs: Need[], items: { label: string }[]) {
  const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  const have = new Map<string, number>()
  for (const it of items) have.set(key(it.label), (have.get(key(it.label)) ?? 0) + 1)
  const lines = needs.map((n) => {
    const got = Math.min(n.qty, have.get(key(n.label)) ?? 0)
    have.set(key(n.label), (have.get(key(n.label)) ?? 0) - got)
    return { label: n.label, qty: n.qty, have: got, missing: Math.max(0, n.qty - got) }
  })
  const extras = [...have.entries()].filter(([, n]) => n > 0).map(([k, n]) => ({ label: items.find((i) => key(i.label) === k)!.label, n }))
  const missing = lines.reduce((a, l) => a + l.missing, 0)
  return { lines, extras, missing, complete: needs.length > 0 && missing === 0 }
}

export function parseNeeds(text: string | null | undefined): Need[] {
  try {
    const v = JSON.parse(text || '[]') as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((x): x is Need => !!x && typeof x.label === 'string' && Number(x.qty) > 0)
      .map((x) => ({ label: x.label.trim(), qty: Math.floor(Number(x.qty)) }))
      .filter((x) => x.label)
  } catch {
    return []
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6
