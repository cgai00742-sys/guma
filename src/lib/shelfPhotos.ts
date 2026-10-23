/**
 * Which plate pictures belong to which product on the Shelf (CG, 22 Oct:
 * "pull the pictures from the project to the Shelf so they match up", then
 * "multiple pictures, especially when multiple parts are assigned").
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
 * 1 and 2 add EVERY plate behind the product -- a 12" piece assembled from
 * three plates gets three pictures. 3 and 4 are fallbacks and add one, and
 * only to a product that has no pictures at all yet.
 *
 * A plate picture is added once. One taken off stays as a row with an
 * empty image, so asking again never puts it back.
 *
 * Anything vaguer -- the newest plate of a ten-plate project, say -- would
 * put the wrong picture on a product, which is worse than none. Those stay
 * empty for the person to fill.
 */

export interface PhotoProduct {
  id: string
  name: string
  design_job_id: string | null
}
/** A picture a product already has -- or had, and had taken off (''). */
export interface PhotoHave {
  product_id: string
  import_id: string | null
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
  /** Plate pictures to add. */
  add: { productId: string; importId: string; thumbnail: string }[]
  /** Files that would answer a product but have not been read for their
   *  picture yet. Read them, store the picture, and ask again. */
  need: string[]
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function matchShelfPhotos(rows: {
  products: PhotoProduct[]
  have: PhotoHave[]
  batches: PhotoBatch[]
  items: PhotoItem[]
  assemblies: PhotoAssembly[]
  imports: PhotoImport[]
  sections: PhotoSection[]
}): PhotoMatch {
  const imports = new Map(rows.imports.map((i) => [i.id, i]))
  const add: PhotoMatch['add'] = []
  const need = new Set<string>()

  for (const p of rows.products) {
    const mine = rows.have.filter((h) => h.product_id === p.id)
    const done = new Set(mine.map((h) => h.import_id).filter(Boolean))
    const batches = rows.batches.filter((b) => b.product_id === p.id)
    const batchIds = new Set(batches.map((b) => b.id))
    const asmIds = new Set(rows.assemblies.filter((a) => a.batch_id && batchIds.has(a.batch_id)).map((a) => a.id))

    // 1 + 2: every plate the pieces came off, in the order they were made.
    const linked = uniq(
      rows.items
        .filter((i) => (i.batch_id && batchIds.has(i.batch_id)) || (i.assembly_id && asmIds.has(i.assembly_id)))
        .map((i) => i.import_id),
    )
      .map((id) => imports.get(id))
      .filter((i): i is PhotoImport => !!i)
    if (linked.length) {
      for (const i of linked) {
        if (done.has(i.id)) continue
        if (i.thumbnail) add.push({ productId: p.id, importId: i.id, thumbnail: i.thumbnail })
        else if (i.has_file) need.add(i.id)
      }
      continue
    }

    // 3 + 4: one best guess, only for a product with no pictures at all.
    if (mine.length) continue
    const jobs = new Set([p.design_job_id, ...batches.map((b) => b.job_id)].filter((j): j is string => !!j))
    const jobImports = rows.imports.filter((i) => jobs.has(i.job_id))
    const name = norm(p.name)
    const tiers: PhotoImport[][] = [
      uniq(rows.sections.filter((s) => norm(s.label) === name).map((s) => s.import_id))
        .map((id) => jobImports.find((i) => i.id === id))
        .filter((i): i is PhotoImport => !!i),
      jobImports.length === 1 ? jobImports : [],
    ]
    for (const t of tiers) {
      const pic = t.find((i) => i.thumbnail)
      if (pic) {
        add.push({ productId: p.id, importId: pic.id, thumbnail: pic.thumbnail! })
        break
      }
      const readable = t.filter((i) => i.has_file)
      if (readable.length) {
        // This tier answers once its files are read; do not fall through
        // to a vaguer one in the meantime.
        readable.forEach((i) => need.add(i.id))
        break
      }
    }
  }
  return { add, need: [...need] }
}

function uniq(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((x): x is string => !!x))]
}
