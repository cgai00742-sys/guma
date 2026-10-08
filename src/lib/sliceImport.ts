/**
 * Read a sliced file and say what is on the plate.
 *
 * Ported from Voltage Manufacturing System's `voltage-slice-import.js`
 * (CG's own code, so it lands in the AGPL core cleanly). The parsing rules
 * are Voltage's, unchanged, because they were worked out against real files
 * off real machines -- the Bambu model-code table and the ZIP64 handling in
 * particular are the kind of thing you only learn by having a file fail.
 *
 * Two deliberate changes from the original:
 *
 * 1. No DOMParser. The original ran only in a browser. This runs in the
 *    Tauri webview, in the web build, AND in vitest under plain node, and
 *    node has no DOMParser. The slice_info.config and 3dmodel.model formats
 *    are attribute-only XML -- no text nodes, no mixed content -- so a tag
 *    scanner reads them exactly as correctly and costs no dependency. It is
 *    NOT a general XML parser and is not used as one.
 *
 * 2. Estimates are labelled as estimates all the way through the types.
 *    `estMinutes` and `estGrams`, never `minutes` and `grams`. A slicer
 *    number is a prediction made before the plate ran; naming it like a
 *    measurement is how it ends up added to a total of measurements. See
 *    the note on job_actuals in the migration that lands with this.
 */

export type SliceKind = '3mf' | '3mf-model' | 'gcode'

/** One distinct object on the plate, with how many copies of it. */
export interface SliceSection {
  label: string
  qty: number
  estMinutes: number | null
  estGrams: number | null
  material: string | null
  /** grams per filament type, when the file distinguishes them. */
  materialsBreakdown?: Record<string, number>
}

export interface SliceFile {
  kind: SliceKind
  fileName: string
  /** Printer as the FILE reports it. Never trusted from the filename alone
   *  unless the file itself is silent -- see modelFromFileName. */
  printerModel: string | null
  /** Filename with the printer token, "sliced" and date stamps stripped, so
   *  the same part sliced for two machines suggests one assembly. */
  suggestedGroup: string
  sections: SliceSection[]
  totals: {
    sections: number
    units: number
    estMinutes: number | null
    estGrams: number | null
    material: string | null
  }
  /** Things the reader should know: plates combined, labels missing, and so
   *  on. Shown to the person, not swallowed. */
  notes: string[]
}

/**
 * What the file input accepts.
 *
 * `.bgcode` is in the list even though parseSliceFile REFUSES it, and that
 * is deliberate. Left out, the browser greys the file out in the picker and
 * says nothing: someone with binary G-code on sees their file, cannot select
 * it, and has no idea why. Accepted, they pick it and get a sentence naming
 * the exact PrusaSlicer setting to turn off. A refusal that explains itself
 * beats a file that is merely unselectable.
 */
export const SLICE_ACCEPT = '.3mf,.gcode,.gco,.g,.bgcode'

/** The minimum of a File this module needs, so tests need no File polyfill. */
export interface SliceFileLike {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

// ---------- minimal ZIP reader (native DecompressionStream) ----------

interface ZipEntry {
  method: number
  csize: number
  lho: number
}

async function unzip(buf: ArrayBuffer) {
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  const N = buf.byteLength
  // Bounds-safe readers: -1 rather than a thrown "offset out of bounds",
  // because a truncated file should produce a sentence, not a stack trace.
  const u16 = (o: number) => (o >= 0 && o + 2 <= N ? dv.getUint16(o, true) : -1)
  const u32 = (o: number) => (o >= 0 && o + 4 <= N ? dv.getUint32(o, true) : -1)
  const u64 = (o: number) => (o >= 0 && o + 8 <= N ? Number(dv.getBigUint64(o, true)) : -1)

  let i = N - 22
  const min = Math.max(0, N - 65558) // end-of-central-directory + max comment
  while (i >= min && u32(i) !== 0x06054b50) i--
  if (i < min) throw new Error("That file isn't a valid 3MF (zip) archive.")

  let count = u16(i + 10)
  let off = u32(i + 16)
  // ZIP64. A big slicer 3MF maxes out the 32-bit fields and puts the real
  // values in the ZIP64 record, reached through its locator.
  if (count === 0xffff || off === 0xffffffff) {
    const loc = i - 20
    if (u32(loc) === 0x07064b50) {
      const z64 = u64(loc + 8)
      if (z64 >= 0 && u32(z64) === 0x06064b50) {
        count = u64(z64 + 32)
        off = u64(z64 + 48)
      }
    }
  }

  const entries = new Map<string, ZipEntry>()
  for (let n = 0; n < count && off >= 0; n++) {
    if (off + 46 > N || u32(off) !== 0x02014b50) break
    const method = u16(off + 10)
    const usize0 = u32(off + 24)
    const csize0 = u32(off + 20)
    const lho0 = u32(off + 42)
    const nlen = u16(off + 28)
    const elen = u16(off + 30)
    const clen = u16(off + 32)
    if (nlen < 0 || elen < 0 || clen < 0) break
    const name = new TextDecoder().decode(u8.subarray(off + 46, Math.min(N, off + 46 + nlen)))
    let csize = csize0
    let lho = lho0
    // Per-entry ZIP64 extra field. Only the maxed-out values are present,
    // in order, so each one has to be skipped or read in turn.
    if (usize0 === 0xffffffff || csize0 === 0xffffffff || lho0 === 0xffffffff) {
      let ep = off + 46 + nlen
      const eend = ep + elen
      while (ep + 4 <= eend) {
        const hid = u16(ep)
        const hsz = u16(ep + 2)
        let fp = ep + 4
        if (hid === 0x0001) {
          if (usize0 === 0xffffffff) fp += 8
          if (csize0 === 0xffffffff) {
            csize = u64(fp)
            fp += 8
          }
          if (lho0 === 0xffffffff) lho = u64(fp)
          break
        }
        ep += 4 + hsz
      }
    }
    entries.set(name, { method, csize, lho })
    off += 46 + nlen + elen + clen
  }

  return {
    names: [...entries.keys()],
    async read(name: string): Promise<Uint8Array | null> {
      const e = entries.get(name)
      if (!e || e.lho < 0) return null
      const lnlen = u16(e.lho + 26)
      const lelen = u16(e.lho + 28)
      if (lnlen < 0 || lelen < 0) return null
      const start = e.lho + 30 + lnlen + lelen
      const cdata = u8.subarray(start, Math.min(N, start + e.csize))
      if (e.method === 0) return cdata
      if (e.method === 8) {
        const stream = new Blob([cdata as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
      }
      throw new Error('Unsupported compression inside the 3MF.')
    },
  }
}

const decode = (u8: Uint8Array) => new TextDecoder().decode(u8)

// ---------- attribute-only tag scanning (see the note at the top) ----------

/** Every `<tag ... />` or `<tag ...>` in `src`, as attribute maps. */
function tags(src: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi')
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const attrs: Record<string, string> = {}
    for (const a of m[1].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2]
    out.push(attrs)
  }
  return out
}

/** Split into one chunk per `<tag ...>...</tag>`, for nesting one level deep. */
function chunks(src: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1])
  return out
}

// ---------- printer identity ----------

/** Bambu writes a code, not a name. */
const BBL_MODEL_CODES: Record<string, string> = {
  O1D: 'Bambu Lab H2D',
  O1S: 'Bambu Lab H2S',
  C11: 'Bambu Lab P1P',
  C12: 'Bambu Lab P1S',
  C13: 'Bambu Lab X1E',
  'BL-P001': 'Bambu Lab X1 Carbon',
  'BL-P002': 'Bambu Lab X1',
  N1: 'Bambu Lab A1 mini',
  N2S: 'Bambu Lab A1',
}

/** Filename hints, used ONLY when the file itself does not say. */
const FILENAME_MODEL_HINTS: [RegExp, string][] = [
  [/(^|[^a-z0-9])h2d([^a-z0-9]|$)/i, 'Bambu Lab H2D'],
  [/(^|[^a-z0-9])h2s([^a-z0-9]|$)/i, 'Bambu Lab H2S'],
  [/(^|[^a-z0-9])x1c?([^a-z0-9]|$)/i, 'Bambu Lab X1 Carbon'],
  [/(^|[^a-z0-9])p1[ps]([^a-z0-9]|$)/i, 'Bambu Lab P1S'],
  [/pr?usa.?xl|(^|[^a-z0-9])xl([^a-z0-9]|$)/i, 'Prusa XL'],
  [/(^|[^a-z0-9])mk[34]([^a-z0-9]|$)/i, 'Prusa MK4'],
]

function modelFromFileName(fileName: string): string | null {
  for (const [re, m] of FILENAME_MODEL_HINTS) if (re.test(fileName)) return m
  return null
}

function stemOf(fileName: string): string {
  const s = fileName
    .replace(/\.gcode\.3mf$/i, '')
    .replace(/\.(3mf|gcode|bgcode)$/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? s[0].toUpperCase() + s.slice(1) : 'Imported assembly'
}

/**
 * Strip the printer token, "sliced" and trailing date stamps, so the same
 * part sliced for the H2D and the H2S suggests one assembly rather than two.
 */
function baseGroupOf(fileName: string, printerModel: string | null): string {
  let s = fileName.replace(/\.gcode\.3mf$/i, '').replace(/\.(3mf|gcode|bgcode)$/i, '')
  s = s
    .replace(/\((?:\d{1,4}[.\-/]){2}\d{1,4}\)/g, ' ')
    .replace(/(?:^|[_\-\s])(?:\d{1,4}[.\-/]){2}\d{1,4}(?=[_\-\s]|$)/g, ' ')
  for (const [re] of FILENAME_MODEL_HINTS) s = s.replace(re, ' ')
  // \b is no good here: "_" counts as a word character, so match separators.
  s = s
    .replace(/(^|[_\-\s])sliced(?=[_\-\s]|$)/gi, ' ')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s && printerModel) s = printerModel
  return s ? s[0].toUpperCase() + s.slice(1) : 'Imported assembly'
}

function parseTimeToMin(s: string): number | null {
  let min = 0
  const per: Record<string, number> = { d: 1440, h: 60, m: 1, s: 1 / 60 }
  for (const [, num, unit] of String(s).matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi))
    min += parseFloat(num) * per[unit.toLowerCase()]
  return min ? Math.round(min) : null
}

function cleanLabel(n: string): string {
  return (
    String(n)
      .replace(/_id_\d+_copy_\d+$/i, '') // Klipper EXCLUDE_OBJECT suffixes
      .replace(/\.(stl|3mf|step|stp|obj)$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Part'
  )
}

/** ["Hull A","Hull A","Keel"] -> [{label:"Hull A",qty:2},{label:"Keel",qty:1}] */
function aggregate(names: string[]): SliceSection[] {
  const map = new Map<string, number>()
  for (const n of names) {
    const c = cleanLabel(n)
    map.set(c, (map.get(c) ?? 0) + 1)
  }
  return [...map.entries()].map(([label, qty]) => ({
    label,
    qty,
    estMinutes: null,
    estGrams: null,
    material: null,
  }))
}

/**
 * A slicer reports one number for the whole plate. Split it across sections
 * by copy count -- which is an apportionment, not a measurement, and is why
 * the note saying so is attached rather than optional.
 */
function spread(
  rows: SliceSection[],
  totalMinutes: number | null,
  totalGrams: number | null,
  material: string | null,
  typeGrams: Record<string, number>,
) {
  const units = rows.reduce((s, r) => s + r.qty, 0) || 1
  for (const r of rows) {
    if (r.estMinutes == null && totalMinutes != null)
      r.estMinutes = Math.round((totalMinutes * r.qty) / units)
    if (r.estGrams == null && totalGrams != null)
      r.estGrams = Math.round(((totalGrams * r.qty) / units) * 10) / 10
    if (!r.material && material) r.material = material
    if (Object.keys(typeGrams).length) {
      const bd: Record<string, number> = {}
      for (const [ty, g] of Object.entries(typeGrams))
        bd[ty] = Math.round(((g * r.qty) / units) * 10) / 10
      r.materialsBreakdown = bd
    }
  }
}

function pack(
  kind: SliceKind,
  fileName: string,
  sections: SliceSection[],
  estMinutes: number | null,
  estGrams: number | null,
  material: string | null,
  notes: string[],
  printerModel?: string | null,
): SliceFile {
  const model = printerModel || modelFromFileName(fileName) || null
  return {
    kind,
    fileName,
    printerModel: model,
    suggestedGroup: baseGroupOf(fileName, model),
    sections,
    totals: {
      sections: sections.length,
      units: sections.reduce((s, r) => s + r.qty, 0),
      estMinutes,
      estGrams,
      material,
    },
    notes,
  }
}

/**
 * Time and grams from a G-code header -- Bambu Studio, Orca and PrusaSlicer
 * all write them, in slightly different words:
 *
 *   ; model printing time: 2h 51m 29s; total estimated time: 2h 58m 13s  (Bambu)
 *   ; total filament weight [g] : 88.20                                    (Bambu)
 *   ; estimated printing time (normal mode) = 2h 3m 5s                     (Orca, Prusa)
 *   ; total filament used [g] = 88.20                                      (Orca, Prusa)
 *
 * Used when a 3MF's slice_info summary is missing or empty but the plate's
 * G-code is inside it -- which is the case for some saved project files.
 */
export function gcodeHeaderTotals(src: string): { minutes: number | null; grams: number | null } {
  const t =
    src.match(/total estimated time\s*[:=]\s*([^;\n]+)/i) ??
    src.match(/estimated printing time[^=\n]*=\s*([^;\n]+)/i) ??
    src.match(/model printing time\s*[:=]\s*([^;\n]+)/i)
  const g =
    src.match(/total filament weight \[g\]\s*[:=]\s*([\d.]+)/i) ??
    src.match(/total filament used \[g\]\s*[:=]\s*([\d.]+)/i)
  let grams = g ? parseFloat(g[1]) : null
  if (grams == null) {
    const per = src.match(/;[ \t]*filament used \[g\][ \t]*[:=][ \t]*([\d.,\s]+)/i)
    if (per) {
      const sum = per[1].split(',').map((n) => parseFloat(n)).filter(Number.isFinite).reduce((a, b) => a + b, 0)
      grams = sum || null
    }
  }
  return { minutes: t ? parseTimeToMin(t[1]) : null, grams: grams && Number.isFinite(grams) ? grams : null }
}

/** Sum the totals of every plate G-code inside a 3MF. Headers sit at the
 *  top of the file (Bambu) or the bottom (Prusa/Orca), so only those ends
 *  are searched -- a plate G-code can be tens of megabytes. */
async function plateGcodeTotals(z: { names: string[]; read: (n: string) => Promise<Uint8Array | null> }) {
  const names = z.names.filter((n) => /plate_\d+\.gcode$/i.test(n) || /\.gcode$/i.test(n))
  let minutes: number | null = null
  let grams: number | null = null
  for (const n of names) {
    const raw = await z.read(n)
    if (!raw) continue
    const text = decode(raw)
    const ends = text.length > 400_000 ? text.slice(0, 200_000) + '\n' + text.slice(-200_000) : text
    const t = gcodeHeaderTotals(ends)
    if (t.minutes != null) minutes = (minutes ?? 0) + t.minutes
    if (t.grams != null) grams = (grams ?? 0) + t.grams
  }
  return { minutes, grams, found: names.length }
}

// ---------- 3MF (Bambu / Orca sliced project; plain 3MF fallback) ----------

const NO_NUMBERS_NOTE =
  'This file has no print time or filament in it — it was saved before slicing, or as a ' +
  'project. In Bambu Studio or Orca: slice, then File → Export → Export plate sliced file ' +
  '(.gcode.3mf), and import that.'

async function parse3mf(buf: ArrayBuffer, fileName: string): Promise<SliceFile> {
  const z = await unzip(buf)
  const notes: string[] = []

  // The machine is recorded inside the file. project_settings.config is
  // authoritative; slice_info's printer_model_id code is the fallback.
  let printerModel: string | null = null
  const psName = z.names.find((n) => /project_settings\.config$/i.test(n))
  if (psName) {
    const raw = await z.read(psName)
    const m = raw && decode(raw).match(/"printer_model"\s*:\s*"([^"]+)"/)
    if (m) printerModel = m[1].trim()
  }

  const sliceName = z.names.find((n) => /slice_info\.config$/i.test(n))
  if (sliceName) {
    const raw = await z.read(sliceName)
    const src = raw ? decode(raw) : ''
    const plates = chunks(src, 'plate')
    const names: string[] = []
    const mats = new Set<string>()
    const typeGrams: Record<string, number> = {}
    let minutes = 0
    let grams = 0
    let sawTime = false
    let sawWeight = false

    for (const plate of plates) {
      for (const o of tags(plate, 'object')) {
        if ((o.skipped ?? 'false') === 'true') continue
        names.push(o.name || o.object_name || 'Part')
      }
      for (const md of tags(plate, 'metadata')) {
        const { key, value } = md
        if (!value) continue
        if (key === 'prediction') {
          minutes += Number(value) / 60
          sawTime = true
        }
        if (key === 'weight') {
          grams += Number(value)
          sawWeight = true
        }
        if (key === 'printer_model_id' && !printerModel)
          printerModel = BBL_MODEL_CODES[value.trim()] ?? value.trim()
      }
      for (const f of tags(plate, 'filament')) {
        if (f.type) mats.add(f.type)
        if (f.used_g) {
          // The plate weight already counted these; only fall back to the
          // per-filament figures when no weight was given.
          if (!sawWeight) grams += Number(f.used_g)
          if (f.type) typeGrams[f.type] = (typeGrams[f.type] ?? 0) + Number(f.used_g)
        }
      }
    }

    if (!names.length)
      throw new Error('The 3MF has slice info but no objects — was anything on the plate?')
    if (plates.length > 1)
      notes.push(`${plates.length} plates found — sections combined into one assembly.`)

    const sections = aggregate(names)
    const material = [...mats].join(', ') || null
    if (!Object.keys(typeGrams).length && grams && material) typeGrams[material] = grams
    let totalMinutes = sawTime && minutes > 0 ? Math.round(minutes) : null
    if (totalMinutes == null || !grams) {
      // The summary is missing or zero. The plate G-code, when it is in the
      // file, says the same thing in its header.
      const g = await plateGcodeTotals(z)
      if (totalMinutes == null && g.minutes != null) totalMinutes = g.minutes
      if (!grams && g.grams != null) {
        grams = g.grams
        if (material) typeGrams[material] = grams
      }
    }
    if (totalMinutes == null && !grams)
      notes.push(NO_NUMBERS_NOTE)
    spread(sections, totalMinutes, grams || null, material, typeGrams)
    notes.push(
      'Time and filament are slicer estimates' +
        (sections.length > 1 ? ', split across sections by quantity.' : '.'),
    )
    return pack(
      '3mf',
      fileName,
      sections,
      totalMinutes,
      grams || null,
      material,
      notes,
      printerModel,
    )
  }

  // A plain 3MF is model plus settings, never sliced: no grams, no time.
  // Read the objects anyway so the build sheet at least fills in.
  const modelName = z.names.find((n) => /3dmodel\.model$/i.test(n))
  if (!modelName) throw new Error('No slice info or model found in this 3MF.')
  const raw = await z.read(modelName)
  const src = raw ? decode(raw) : ''
  const nameById: Record<string, string | undefined> = {}
  for (const o of tags(src, 'object')) if (o.id) nameById[o.id] = o.name
  const build = chunks(src, 'build').join('')
  const names = tags(build, 'item').map((it, i) => nameById[it.objectid ?? ''] || `Part ${i + 1}`)
  if (!names.length) throw new Error('This 3MF contains no buildable objects.')
  // No summary, but the plate G-code may still be in here.
  const g = await plateGcodeTotals(z)
  if (g.minutes != null || g.grams != null) {
    const sections = aggregate(names)
    spread(sections, g.minutes, g.grams, null, {})
    return pack('3mf', fileName, sections, g.minutes, g.grams, null, [
      'Time and filament read from the G-code inside this 3MF — slicer estimates.',
    ], null)
  }
  return pack('3mf-model', fileName, aggregate(names), null, null, null, [
    "This 3MF isn't sliced — section names imported, but no time or filament estimates. " +
      'Export the sliced project (.gcode.3mf) or G-code to get those.',
  ])
}

// ---------- G-code (PrusaSlicer and friends) ----------

function parseGcode(src: string, fileName: string): SliceFile {
  const notes: string[] = []
  const names: string[] = []

  for (const [, n] of src.matchAll(/EXCLUDE_OBJECT_DEFINE\s+NAME=([^\s\\]+)/g)) names.push(n)
  if (!names.length) {
    const seen = new Map<string, Set<string>>()
    // One object per id:copy pair, not per copy number: two pasted
    // objects both named "Hull" are id:0 copy 0 and id:1 copy 0, and
    // counting copy numbers per name read them as one hull.
    for (const [, n, id, copy] of src.matchAll(/;\s*printing object\s+(.+?)\s+id:(\d+)\s+copy\s+(\d+)/g)) {
      if (!seen.has(n)) seen.set(n, new Set())
      seen.get(n)!.add(`${id}:${copy}`)
    }
    for (const [n, copies] of seen) for (let i = 0; i < copies.size; i++) names.push(n)
  }

  let sections: SliceSection[]
  if (names.length) sections = aggregate(names)
  else {
    sections = [
      { label: stemOf(fileName), qty: 1, estMinutes: null, estGrams: null, material: null },
    ]
    notes.push(
      'No object labels in this G-code — imported as a single section. Turn on “Label objects” ' +
        '(Print Settings → Output options) to get per-section names.',
    )
  }

  /**
   * PrusaSlicer writes the grams TWICE, and the two lines mean different
   * things:
   *
   *   ; filament used [g] = 3.09,2.50     <- per extruder, comma separated
   *   ; total filament used [g] = 5.59    <- the authoritative total
   *
   * Voltage's parser matched `(?:total )?filament used [g]` and added every
   * hit, so a single-tool print counted its one figure twice and reported
   * double -- 12.34 g became 24.68 g. On a multi-material print it was wrong
   * differently: `([\d.]+)` stops at the comma, so it took the first
   * extruder's grams and then added the real total to it.
   *
   * Both are fixed the same way: read the two lines separately, trust the
   * total when the slicer gives one, and fall back to summing the per-tool
   * figures when it does not. Note the `[ \t]*` after the semicolon rather
   * than `\s*` -- the per-tool pattern must not match across the newline
   * into the "total" line.
   *
   * This changes reported grams for every G-code import, and material cost
   * is grams x weighted purchase cost, so it changes money. That is the
   * point: the old number was wrong, in the flattering direction for
   * single-tool prints, which is most of them.
   */
  const perToolLine = src.match(/;[ \t]*filament used \[g\][ \t]*=[ \t]*([\d.,\s]+)/)
  const gramsPerTool = perToolLine
    ? perToolLine[1]
        .split(',')
        .map((n) => parseFloat(n.trim()))
        .filter((n) => Number.isFinite(n))
    : []
  const totalLine = src.match(/;[ \t]*total filament used \[g\][ \t]*=[ \t]*([\d.]+)/)
  const grams = totalLine
    ? parseFloat(totalLine[1])
    : gramsPerTool.reduce((a, b) => a + b, 0)
  const tm = src.match(/;\s*estimated printing time.*?=\s*(.+)/)
  const estMinutes = tm ? parseTimeToMin(tm[1]) : null

  const mt = src.match(/;\s*filament_type\s*=\s*(.+)/)
  const types = mt
    ? mt[1]
        .trim()
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  const material = [...new Set(types)].join(', ') || null

  const typeGrams: Record<string, number> = {}
  if (types.length && gramsPerTool.length === types.length) {
    types.forEach((ty, i) => {
      if (gramsPerTool[i] > 0) typeGrams[ty] = (typeGrams[ty] ?? 0) + gramsPerTool[i]
    })
  } else if (grams && material) typeGrams[material] = grams

  spread(sections, estMinutes, grams || null, material, typeGrams)
  if (sections.length > 1)
    notes.push('Time and filament are slicer estimates, split across sections by quantity.')

  const pm =
    src.match(/;\s*printer_model\s*=\s*(.+)/) ?? src.match(/;\s*printer_settings_id\s*=\s*(.+)/)
  let model = pm ? pm[1].trim() : null
  if (model && /^(mk|xl|mini)/i.test(model)) model = `Prusa ${model}` // MK4 -> Prusa MK4
  return pack('gcode', fileName, sections, estMinutes, grams || null, material, notes, model)
}

// ---------- binary G-code (PrusaSlicer .bgcode) ----------

/** zlib inflate without Blob.stream or Response, which not every runtime has. */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  void writer.write(data as unknown as BufferSource).then(() => writer.close())
  const reader = ds.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** Prusa model codes as the printer writes them: XL2IS is a two-tool XL
 *  with input shaping, MK4S an MK4S. The shop calls it a Prusa XL. */
function prusaModel(code: string | undefined): string | null {
  if (!code) return null
  const c = code.trim().toUpperCase()
  if (/^XL\d?(IS)?$/.test(c)) return 'Prusa XL'
  if (/^MK4S/.test(c)) return 'Prusa MK4S'
  if (/^MK4/.test(c)) return 'Prusa MK4'
  if (/^MK3\.?9/.test(c)) return 'Prusa MK3.9'
  if (/^MK3/.test(c)) return 'Prusa MK3'
  if (/^MINI/.test(c)) return 'Prusa MINI'
  if (/^COREONE/.test(c)) return 'Prusa CORE One'
  return `Prusa ${code.trim()}`
}

/**
 * PrusaSlicer's binary G-code (the default for Prusa printers since 2.7).
 *
 * Format (libbgcode, v1): "GCDE", version u32, checksum type u16, then
 * blocks. Each block: type u16, compression u16, uncompressed size u32,
 * compressed size u32 when compressed, parameters (2 bytes; 6 for a
 * thumbnail), data, and a 4-byte CRC when the checksum type is 1.
 *
 * Everything Guma needs is in the METADATA blocks, which come before the
 * G-code and are plain key=value text, stored or zlib-deflated:
 *   printer metadata (3): printer_model, filament_type, objects_info (names)
 *   print metadata (4):   filament used [g], estimated printing time
 * So the moves themselves (heatshrink + meatpack) are never decoded --
 * reading stops at the first G-code block.
 */
async function parseBgcode(buf: ArrayBuffer, fileName: string): Promise<SliceFile> {
  const u8 = new Uint8Array(buf)
  const dv = new DataView(buf)
  const N = u8.length
  if (N < 10 || decode(u8.subarray(0, 4)) !== 'GCDE')
    throw new Error("That file isn't binary G-code — export it again from PrusaSlicer.")
  const checksumType = dv.getUint16(8, true)
  const meta: Record<number, string> = {}
  let off = 10
  while (off + 8 <= N) {
    const type = dv.getUint16(off, true)
    const comp = dv.getUint16(off + 2, true)
    const usize = dv.getUint32(off + 4, true)
    off += 8
    let csize = usize
    if (comp !== 0) {
      csize = dv.getUint32(off, true)
      off += 4
    }
    if (type === 1) break // G-code from here on; the metadata is done.
    off += type === 5 ? 6 : 2
    const data = u8.subarray(off, Math.min(N, off + csize))
    off += csize + (checksumType === 1 ? 4 : 0)
    if (type === 0 || type === 2 || type === 3 || type === 4) {
      if (comp === 0) meta[type] = decode(data)
      else if (comp === 1) meta[type] = decode(await inflateZlib(data))
      // heatshrink is only ever used on G-code blocks; skip anything else.
    }
  }
  const kv = (src: string | undefined) => {
    const out: Record<string, string> = {}
    for (const line of (src ?? '').split(/\r?\n/)) {
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  }
  const printer = kv(meta[3])
  const print = { ...kv(meta[2]), ...kv(meta[3]), ...kv(meta[4]) }
  if (!meta[3] && !meta[4]) throw new Error('No print information found in this binary G-code.')

  const notes: string[] = []
  // Object names, from the list the printer uses to cancel objects.
  let names: string[] = []
  try {
    const info = JSON.parse(printer.objects_info ?? '{}') as { objects?: { name?: string }[] }
    names = (info.objects ?? []).map((o) => o.name ?? '').filter(Boolean)
  } catch {
    /* fall through to a single section */
  }
  let sections: SliceSection[]
  if (names.length) sections = aggregate(names)
  else {
    sections = [{ label: stemOf(fileName), qty: 1, estMinutes: null, estGrams: null, material: null }]
    notes.push('No object names in this file — imported as a single section.')
  }

  const perTool = (print['filament used [g]'] ?? '')
    .split(',')
    .map((n) => parseFloat(n))
    .filter((n) => Number.isFinite(n))
  const total = parseFloat(print['total filament used [g]'] ?? '')
  const grams = Number.isFinite(total) ? total : perTool.reduce((a, b) => a + b, 0) || null
  const estMinutes = parseTimeToMin(print['estimated printing time (normal mode)'] ?? '')

  // Only the tools that actually printed: a two-tool XL with the second
  // tool idle writes "PLA;PLA" and "73.13, 0.00".
  const types = (print.filament_type ?? '').split(';').map((x) => x.trim())
  const typeGrams: Record<string, number> = {}
  types.forEach((ty, i) => {
    const g = perTool[i] ?? (types.length === 1 ? grams ?? 0 : 0)
    if (ty && g > 0) typeGrams[ty] = (typeGrams[ty] ?? 0) + g
  })
  const material = Object.keys(typeGrams).join(', ') || types.filter(Boolean)[0] || null

  spread(sections, estMinutes, grams, material, typeGrams)
  notes.push(
    'Time and filament are slicer estimates' +
      (sections.length > 1 ? ', split across sections by quantity.' : '.'),
  )
  return pack('gcode', fileName, sections, estMinutes, grams, material, notes, prusaModel(printer.printer_model))
}

// ---------- entry point ----------

export async function parseSliceFile(file: SliceFileLike): Promise<SliceFile> {
  const name = file.name || 'sliced-file'
  if (/\.bgcode$/i.test(name)) {
    if (typeof DecompressionStream === 'undefined')
      throw new Error("This browser can't unpack binary G-code — export plain .gcode instead.")
    return parseBgcode(await file.arrayBuffer(), name)
  }
  if (/\.3mf$/i.test(name)) {
    if (typeof DecompressionStream === 'undefined')
      throw new Error("This browser can't unpack 3MF files — import the .gcode export instead.")
    return parse3mf(await file.arrayBuffer(), name)
  }
  if (/\.(gcode|gco|g)$/i.test(name)) return parseGcode(await file.text(), name)
  throw new Error(
    'Unsupported file. Import a sliced .gcode.3mf or .3mf (Bambu, Orca), or .gcode or .bgcode (Prusa).',
  )
}

// ---------- matching what the file said to what the shop owns ----------

/**
 * A slicer names a MODEL ("Bambu Lab H2S"); a shop names a MACHINE
 * ("Sakman"). Matching one to the other is a suggestion, never a decision:
 * every caller shows what was matched and lets it be changed, because
 * Voltage already learned what silent matching costs -- a typo ("Pursa XL")
 * broke slice-variant matching there and nothing said so.
 *
 * Exported separately from the parser so it can be tested without a file.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Best machine for a detected model string, or null.
 *
 * Tried in order: the shop's model field matching exactly, then either
 * string containing the other (so "H2S" finds "Bambu Lab H2S" and the
 * reverse), then the same two against the machine's NAME, since a shop that
 * calls its printer "H2D" has effectively named the model.
 *
 * Null when nothing matches or when two machines match equally well. A
 * wrong guess costs more than no guess: the run would be costed at another
 * machine's hourly rate and wear, and nothing on the screen would look odd.
 */
export function matchPrinter<T extends { id: string; name: string; model: string }>(
  printers: readonly T[],
  detected: string | null,
): T | null {
  if (!detected) return null
  const d = norm(detected)
  if (!d) return null

  // Every tier reads ONE field, and skips a printer whose field is empty.
  // The empty string is a substring of everything, so a machine with no
  // model set otherwise matches every query -- which it did, and which is
  // why "Creality K1" found a Prusa in the test before this comment.
  const overlap = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a))
  const tiers: ((p: T) => boolean)[] = [
    (p) => !!norm(p.model) && norm(p.model) === d,
    (p) => overlap(norm(p.model), d),
    (p) => !!norm(p.name) && norm(p.name) === d,
    (p) => overlap(norm(p.name), d),
  ]
  for (const test of tiers) {
    const hits = printers.filter(test)
    if (hits.length === 1) return hits[0]
    // Two machines matching equally is exactly when a guess is worth least.
    if (hits.length > 1) return null
  }
  return null
}

/**
 * Best material for a detected filament type, or null.
 *
 * The file says a TYPE ("PETG"); a shop stocks a spool ("PETG black",
 * "PETG translucent"). A type that matches two spools returns null on
 * purpose -- which black is a question only the person at the printer can
 * answer, and guessing puts a wrong purchase cost into the job.
 *
 * A multi-material file gives "PETG, PLA"; only the first type is tried,
 * because a single material_id cannot represent two spools. The import
 * still records the full string, so nothing is lost.
 */
export function matchMaterial<T extends { id: string; name: string }>(
  materials: readonly T[],
  detected: string | null,
): T | null {
  if (!detected) return null
  const first = detected.split(',')[0]?.trim()
  const d = norm(first ?? '')
  if (!d) return null

  const exact = materials.filter((m) => norm(m.name) === d)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  const partial = materials.filter((m) => norm(m.name).includes(d))
  return partial.length === 1 ? partial[0] : null
}
