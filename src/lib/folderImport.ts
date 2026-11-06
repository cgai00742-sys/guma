/**
 * A whole folder of sliced files onto a quote (CG, 5 Nov).
 *
 * A job is usually a folder: one file per plate, often with a stray copy
 * ("S1, P9 copy.bgcode"), the same plate sliced for a second machine, the
 * STLs it came from, and a .DS_Store. Pricing every file in it would count
 * plates twice, so nothing goes on the quote until a checklist has been
 * seen: likely duplicates and files with no slicer numbers start unticked,
 * each with the reason, and files that are not sliced at all are skipped.
 *
 * Two halves. Reading what was dropped (a folder dropped, a folder picked,
 * or loose files) needs the browser; deciding what to tick is pure, so it
 * is tested on its own.
 */
import { sameSliceFile } from './data.types'
import type { SliceFile } from './sliceImport'

/** Extensions parseSliceFile reads. Anything else is listed as skipped. */
const SLICED = /\.(gcode\.3mf|3mf|gcode|gco|g|bgcode)$/i

/** One file found in what was dropped or picked, with where it sat. */
export interface FoundFile {
  file: File
  /** "Mast brackets/S1, P9.bgcode" -- the folder path, for the checklist. */
  path: string
}

/** Finder and Explorer litter: never shown, never counted. */
export const isLitter = (name: string) => name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name)
export const isSliced = (name: string) => SLICED.test(name)

/**
 * Everything in a drop, folders opened all the way down. The entries must be
 * taken from the DataTransfer before the first await -- the browser empties
 * it once the drop handler returns.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<FoundFile[]> {
  const entries = [...(dt.items ?? [])]
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return [...(dt.files ?? [])].map((file) => ({ file, path: file.name }))
  const out: FoundFile[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      out.push({ file, path: entry.fullPath.replace(/^\//, '') || file.name })
      return
    }
    if (!entry.isDirectory) return
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries hands back a batch at a time; empty means done.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const e of batch) await walk(e)
    }
  }
  for (const e of entries) await walk(e)
  return out
}

/** Files from an <input>, folder-picked ones carrying their folder path. */
export function filesFromInput(list: FileList | File[] | null | undefined): FoundFile[] {
  return [...(list ?? [])].map((file) => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }))
}

/** One sliced file once read: its numbers, or why it could not be. */
export interface FolderRead<K = unknown> {
  key: string
  path: string
  parsed: SliceFile | null
  error: string | null
  /** Whatever the caller keeps alongside (the packed file). */
  extra?: K
}

export interface FolderRow<K = unknown> extends FolderRead<K> {
  include: boolean
  /** Why it starts unticked, in a sentence. Null when it is ticked. */
  note: string | null
}

const ident = (p: SliceFile) => ({ fileName: p.fileName, estMinutes: p.totals.estMinutes, estGrams: p.totals.estGrams })

/**
 * What to tick. In path order, so the first of a pair is the one kept --
 * "x.bgcode" before "x copy.bgcode".
 */
export function planFolder<K>(
  reads: FolderRead<K>[],
  already: { fileName: string; estMinutes: number | null; estGrams: number | null }[] = [],
): FolderRow<K>[] {
  // Originals before their copies: "x.bgcode" ahead of "x copy.bgcode" and
  // "x (1).bgcode", which a plain sort puts first (a space sorts before a dot).
  const COPY = /\s(\(\d+\)|\d+|copy(\s\d+)?)(?=\.[a-z0-9.]+$|$)/i
  const order = (r: FolderRead<K>) => [r.path.replace(COPY, ''), COPY.test(r.path) ? 1 : 0] as const
  const sorted = [...reads].sort((a, b) => {
    const [an, ac] = order(a)
    const [bn, bc] = order(b)
    return an.localeCompare(bn, undefined, { numeric: true }) || ac - bc || a.path.localeCompare(b.path)
  })
  const kept: FolderRow<K>[] = []
  const rows: FolderRow<K>[] = []
  for (const r of sorted) {
    const row = (include: boolean, note: string | null): FolderRow<K> => ({ ...r, include, note })
    if (!r.parsed) {
      rows.push(row(false, r.error ?? 'Could not be read.'))
      continue
    }
    const p = r.parsed
    if (p.totals.estGrams == null && p.totals.estMinutes == null) {
      rows.push(row(false, 'No print time or filament in it — saved before slicing, or not a sliced file.'))
      continue
    }
    if (already.some((a) => sameSliceFile(a, ident(p)))) {
      rows.push(row(false, 'Already on this quote.'))
      continue
    }
    const twin = kept.find((k) => sameSliceFile(ident(k.parsed!), ident(p)))
    if (twin) {
      rows.push(row(false, `Same file as ${twin.parsed!.fileName}.`))
      continue
    }
    const otherMachine = kept.find(
      (k) =>
        k.parsed!.suggestedGroup &&
        k.parsed!.suggestedGroup === p.suggestedGroup &&
        (k.parsed!.printerModel ?? '') !== (p.printerModel ?? ''),
    )
    if (otherMachine) {
      rows.push(
        row(
          false,
          `The same plate as ${otherMachine.parsed!.fileName}, sliced for ${p.printerModel ?? 'another machine'}. Tick the one you will print.`,
        ),
      )
      continue
    }
    const ok = row(true, null)
    kept.push(ok)
    rows.push(ok)
  }
  return rows
}
