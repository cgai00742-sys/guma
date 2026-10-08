/**
 * A sliced file, turned into quote build lines.
 *
 * One line per distinct object on the plate: its copies, and grams and
 * print hours for ONE copy, so `qty × per-part` gives back exactly what the
 * slicer said for the plate. Changing qty afterwards scales linearly, which
 * is an estimate -- a fuller plate is usually a little faster per copy --
 * and the screen says so.
 *
 * Pure, so the arithmetic is tested once and both the intake screen and
 * anything later (re-quoting from a project's files) read files the same way.
 */
import type { QuoteBuild } from './pricing'
import type { SliceFile } from './sliceImport'

// Four decimals, not two: 48 copies in 5 h is 0.104 h each, and rounding
// to 0.10 lost 4% of the machine time the file said (review fix, 8 Oct).
const r2 = (n: number) => Math.round(n * 10000) / 10000

export function buildsFromFile(
  file: SliceFile,
  fileKey: string,
  printerId: string | null,
  materialId: string | null,
): QuoteBuild[] {
  return file.sections.map((sec, i) => {
    const qty = Math.max(1, sec.qty || 1)
    return {
      key: `${fileKey}:${i}`,
      label: sec.label,
      printerId,
      materialId,
      qty,
      unitsPerPart: sec.estGrams == null ? 0 : r2(sec.estGrams / qty),
      printHrsPerPart: sec.estMinutes == null ? 0 : r2(sec.estMinutes / 60 / qty),
    }
  })
}
