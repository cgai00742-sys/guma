/**
 * A re-sliced file for one failed part: kept on the project and linked to
 * that part, so its reprint prints from the fix (CG, 8 Oct: "an immediate
 * way to substitute a new file"). Used by the parts list and by a plate's
 * "Check the pieces" (25 Nov).
 */
import { importSlice } from './data'
import type { PartRow, ShopContext } from './data.types'
import { parseSliceFile, matchMaterial, matchPrinter } from './sliceImport'
import { packFile } from './sliceFile'

export async function importFixedFile(
  ctx: ShopContext,
  jobId: string,
  part: PartRow,
  file: File,
): Promise<{ name: string; importId: string; duplicateOf?: string }> {
    const parsed = await parseSliceFile(file)
  // A re-sliced plate can carry other objects too, but one of them has to
  // be this part -- otherwise the file is not its fix, and importing it
  // would quietly add new parts to the build sheet.
  if (
    parsed.sections.length > 1 &&
    !parsed.sections.some((sec) => sec.label.trim().toLowerCase() === part.label.trim().toLowerCase())
  ) {
    throw new Error(
      `${parsed.fileName} has ${parsed.sections.length} objects on it and none is named “${part.label}”, so it is not this part's fix. Slice the part on its own, or keep its name, and try again.`,
    )
}
  const bytes = new Uint8Array(await file.arrayBuffer())
  const r = await importSlice(ctx.shop.id, jobId, ctx.profile.id, {
    file: await packFile(bytes),
    fileName: parsed.fileName,
    kind: parsed.kind,
    printerModel: parsed.printerModel,
    printerId: matchPrinter(ctx.printerRows, parsed.printerModel)?.id ?? null,
    materialText: parsed.totals.material,
    materialId: matchMaterial(ctx.materials, parsed.totals.material)?.id ?? null,
    estMinutes: parsed.totals.estMinutes,
    estGrams: parsed.totals.estGrams,
    notes: parsed.notes,
    progress: parsed.progress,
    forPartId: part.id,
    sections: parsed.sections.map((sec) => ({
      label: sec.label,
      qty: sec.qty,
      estMinutes: sec.estMinutes,
      estGrams: sec.estGrams,
      material: sec.material,
    })),
  })
  return { name: parsed.fileName, importId: r.importId, duplicateOf: r.duplicateOf ?? undefined }
}
