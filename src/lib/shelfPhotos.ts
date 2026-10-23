/**
 * Which plate picture belongs to which product on the Shelf (CG, 22 Oct:
 * "pull the pictures from the project to the Shelf so they match up").
 *
 * Pure: rows in, an answer out. Both backends gather the same rows and ask
 * this, so the desktop and the hosted app can never pick different pictures.
 *
 * The rule is "most certain link first", and it stops rather than guess:
 *
 *  1. The pieces themselves. A batch made from printed pieces knows which
 *     print each piece came off, and that print knows its file.
 *  2. An assembly. A finished assembly's batch knows the pieces inside it.
 *  3. The name. A plate object called the same as the product, in the same
 *     project ("Kauai" on the Shelf, "Kauai" on a plate).
 *  4. The only plate. A project with exactly one picture has no other
 *     candidate.
 *
 * Anything vaguer -- the newest plate of a ten-plate project, say -- would
 * put the wrong picture on a product, which is worse than none. Those stay
 * empty for the person to fill.
 */

export interface PhotoProduct {
  id: string
  name: string
  /** null = never set (fill it). '' = removed on purpose (leave it). */
  photo: string | null
  design_job_id: string | null
}
export interface PhotoBatch {
  id: string
  product_id: string
  job_id: string | null
}
export interface PhotoItem {
  batch_id: string | null
  assembly_id: string | null
  /** The file the piece came off: its plate's import, else its print's. */
  import_id: string | null
}
export interface PhotoAssembly {
  id: string
  batch_id: string | null
}
export interface PhotoImport {
  id: string
  job_id: string
  thumbnail: string | null
  /** The file itself is kept, so a picture can still be read out of it. */
  has_file: boolean
}
export interface PhotoSection {
  import_id: string
  label: string
}

export interface PhotoMatch {
  /** Products to give a picture. */
  set: { productId: string; thumbnail: string }[]
  /** Files that would answer a product but have not been read for their
   *  picture yet. Read them, store the picture, and ask again. */
  need: string[]
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function matchShelfPhotos(rows: {
  products: PhotoProduct[]
  batches: PhotoBatch[]
  items: PhotoItem[]
  assemblies: PhotoAssembly[]
  imports: PhotoImport[]
  sections: PhotoSection[]
}): PhotoMatch {
  const imports = new Map(rows.imports.map((i) => [i.id, i]))
  const set: PhotoMatch['set'] = []
  const need = new Set<string>()

  for (const p of rows.products) {
    if (p.photo !== null) continue
    const batches = rows.batches.filter((b) => b.product_id === p.id)
    const batchIds = new Set(batches.map((b) => b.id))
    const asmIds = new Set(rows.assemblies.filter((a) => a.batch_id && batchIds.has(a.batch_id)).map((a) => a.id))
    const jobs = new Set(
      [p.design_job_id, ...batches.map((b) => b.job_id)].filter((j): j is string => !!j),
    )

    const tiers: string[][] = []
    // 1 + 2: what the pieces came off.
    tiers.push(
      uniq(
        rows.items
          .filter((i) => (i.batch_id && batchIds.has(i.batch_id)) || (i.assembly_id && asmIds.has(i.assembly_id)))
          .map((i) => i.import_id),
      ),
    )
    const jobImports = rows.imports.filter((i) => jobs.has(i.job_id))
    // 3: a plate object with the product's name.
    const name = norm(p.name)
    tiers.push(
      uniq(
        rows.sections
          .filter((s) => norm(s.label) === name && jobImports.some((i) => i.id === s.import_id))
          .map((s) => s.import_id),
      ),
    )
    // 4: the project's only plate.
    if (jobImports.length === 1) tiers.push([jobImports[0].id])

    let found: string | null = null
    for (const ids of tiers) {
      const known = ids.map((id) => imports.get(id)).filter((i): i is PhotoImport => !!i)
      const pic = known.find((i) => i.thumbnail)
      if (pic) {
        found = pic.thumbnail
        break
      }
      const readable = known.filter((i) => i.has_file)
      if (readable.length) {
        // This tier would answer once its files are read; do not fall
        // through to a vaguer tier in the meantime.
        readable.forEach((i) => need.add(i.id))
        break
      }
    }
    if (found) set.push({ productId: p.id, thumbnail: found })
  }
  return { set, need: [...need] }
}

function uniq(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((x): x is string => !!x))]
}
