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

/** What the file input should accept. `.bgcode` is deliberately absent. */
export const SLICE_ACCEPT = '.3mf,.gcode,.gco,.g'

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

// ---------- 3MF (Bambu / Orca sliced project; plain 3MF fallback) ----------

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
    const totalMinutes = sawTime ? Math.round(minutes) : null
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
    for (const [, n, copy] of src.matchAll(/;\s*printing object\s+(.+?)\s+id:\d+\s+copy\s+(\d+)/g)) {
      if (!seen.has(n)) seen.set(n, new Set())
      seen.get(n)!.add(copy)
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

// ---------- entry point ----------

export async function parseSliceFile(file: SliceFileLike): Promise<SliceFile> {
  const name = file.name || 'sliced-file'
  if (/\.bgcode$/i.test(name))
    throw new Error(
      "Binary G-code (.bgcode) can't be read. In PrusaSlicer, uncheck “Export as binary G-code” " +
        '(Printer Settings → General) and export again.',
    )
  if (/\.3mf$/i.test(name)) {
    if (typeof DecompressionStream === 'undefined')
      throw new Error("This browser can't unpack 3MF files — import the .gcode export instead.")
    return parse3mf(await file.arrayBuffer(), name)
  }
  if (/\.(gcode|gco|g)$/i.test(name)) return parseGcode(await file.text(), name)
  throw new Error(
    'Unsupported file. Import a sliced .gcode.3mf or .3mf (Bambu, Orca) or .gcode (Prusa).',
  )
}
