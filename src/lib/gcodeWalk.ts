/**
 * Reading the moves inside a sliced file, not just its header.
 *
 * CG, 13 Oct 2026: a 16h 26m Maui plate was stopped at 15 hours, after a run
 * of "ghost prints" -- the printer moving, nothing coming out. The header
 * says 16h 26m and 354.9 g for the whole plate; it cannot say what 15 hours
 * of it used, and prorating by time is badly wrong: by the file, five hours
 * into that plate is 190 g, not the 108 g a straight line gives, because
 * first layers and dense sections use filament far faster than the clock.
 *
 * So the moves are walked once, at import, and two things kept:
 *
 *   PROGRESS -- the slicer's own progress marks (M73 P<percent> R<minutes
 *   left>, written by PrusaSlicer, Orca and Bambu alike), each with the
 *   filament pushed and the layer height reached by then. A few hundred
 *   points; "how far did 15 hours get" is a lookup.
 *
 *   PER OBJECT -- grams and minutes for each object on the plate, measured
 *   from the extrusion inside each object's own section (M486 on Prusa,
 *   EXCLUDE_OBJECT on Klipper/Orca, "printing object" comments), instead of
 *   the plate total split evenly by copies.
 *
 * Filament is MEASURED from the extrusion moves and scaled to the slicer's
 * own total (they agree to about 1%: the slicer also counts purge and
 * wipe). Time comes only from the slicer's progress marks; nothing here
 * estimates time itself.
 *
 * What a file cannot know is what happened on the printer. A file walked to
 * 15 hours says what the printer PUSHED by then -- for a ghost print, more
 * than ever left the spool. That is why the screen asks for when filament
 * stopped flowing separately from how long the machine ran.
 *
 * Binary G-code (.bgcode) stores the moves heatshrink-compressed and
 * MeatPack-encoded; both decoders are here, small and dependency-free.
 */

/** One progress mark: minutes in, percent done, grams pushed, layer reached. */
export interface ProgressPoint {
  min: number
  pct: number
  grams: number
  z: number
  /** Of `grams`, what went outside every object by then -- purge line,
   *  skirt, wipe tower. Only when the file names its objects. */
  waste?: number
}

export interface GcodeWalk {
  /** Minutes the slicer expects the whole plate to take. */
  totalMinutes: number | null
  /** Grams the moves extrude, before scaling to the slicer's total. */
  measuredGrams: number
  /** Progress marks, thinned to at most ~400 points, first and last kept. */
  progress: ProgressPoint[]
  /** Per object, by the name the file gives it (uncleaned). */
  objects: Record<string, { grams: number; minutes: number }>
}

/* ------------------------------------------------------------------ */
/* Decoders for binary G-code                                           */
/* ------------------------------------------------------------------ */

/** heatshrink, window 2^w, lookahead 2^l -- bgcode uses 12/4 (type 3) and 11/4 (type 2). */
export function heatshrinkDecode(data: Uint8Array, w: number, l: number, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let o = 0
  let bit = 0
  const nbits = data.length * 8
  const read = (k: number): number => {
    if (bit + k > nbits) return -1
    let v = 0
    for (let i = 0; i < k; i++) {
      v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1)
      bit++
    }
    return v
  }
  while (o < size) {
    const tag = read(1)
    if (tag < 0) break
    if (tag === 1) {
      const c = read(8)
      if (c < 0) break
      out[o++] = c
    } else {
      const idx = read(w)
      if (idx < 0) break
      const cnt = read(l)
      if (cnt < 0) break
      const back = idx + 1
      for (let i = 0; i <= cnt && o < size; i++) {
        out[o] = out[o - back]
        o++
      }
    }
  }
  return o === size ? out : out.subarray(0, o)
}

const MP = '0123456789. \nGX'

/** MeatPack (bgcode encodings 1 and 2): two 4-bit codes a byte, 0xF = a full byte follows. */
export function meatpackDecode(data: Uint8Array): string {
  const out: string[] = []
  let packing = false
  let noSpace = false
  const code = (c: number) => (c === 11 && noSpace ? 'E' : MP[c])
  let i = 0
  const n = data.length
  while (i < n) {
    const b = data[i]
    if (b === 0xff && i + 1 < n && data[i + 1] === 0xff) {
      const cmd = data[i + 2]
      i += 3
      if (cmd === 0xfb) packing = true
      else if (cmd === 0xfa) packing = false
      else if (cmd === 0xf7) noSpace = true
      else if (cmd === 0xf6) noSpace = false
      else if (cmd === 0xf9) {
        packing = false
        noSpace = false
      }
      continue
    }
    i++
    if (!packing) {
      out.push(String.fromCharCode(b))
      continue
    }
    const lo = b & 0xf
    const hi = b >> 4
    if (lo === 0xf && hi === 0xf) {
      out.push(String.fromCharCode(data[i]), String.fromCharCode(data[i + 1]))
      i += 2
    } else if (lo === 0xf) {
      out.push(String.fromCharCode(data[i]), code(hi))
      i += 1
    } else if (hi === 0xf) {
      out.push(code(lo), String.fromCharCode(data[i]))
      i += 1
    } else out.push(code(lo), code(hi))
  }
  return out.join('')
}

/** The G-code text of a .bgcode, block by block. Inflate is passed in (zlib blocks). */
export async function* bgcodeText(
  u8: Uint8Array,
  inflate: (d: Uint8Array) => Promise<Uint8Array>,
): AsyncGenerator<string> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const N = u8.length
  const checksum = dv.getUint16(8, true)
  let off = 10
  const dec = new TextDecoder()
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
    const paramsAt = off
    off += type === 5 ? 6 : 2
    const data = u8.subarray(off, Math.min(N, off + csize))
    off += csize + (checksum === 1 ? 4 : 0)
    if (type !== 1) continue
    const encoding = dv.getUint16(paramsAt, true)
    let raw: Uint8Array
    if (comp === 0) raw = data
    else if (comp === 1) raw = await inflate(data)
    else if (comp === 2) raw = heatshrinkDecode(data, 11, 4, usize)
    else if (comp === 3) raw = heatshrinkDecode(data, 12, 4, usize)
    else throw new Error('Unknown compression in this binary G-code.')
    yield encoding === 0 ? dec.decode(raw) : meatpackDecode(raw)
  }
}

/* ------------------------------------------------------------------ */
/* The walk                                                             */
/* ------------------------------------------------------------------ */

const NUM = /[-+]?\d*\.?\d+/

/**
 * Walk G-code text, chunk by chunk. Lines can split across chunks, so the
 * tail of each chunk is carried into the next.
 */
export async function walkGcode(
  chunks: AsyncIterable<string> | Iterable<string>,
  filamentDiameterMm = 1.75,
  densityGcm3 = 1.24,
): Promise<GcodeWalk> {
  const mmToG = (Math.PI * (filamentDiameterMm / 2) ** 2 * densityGcm3) / 1000
  let relative = true
  let lastAbsE = 0
  let e = 0 // mm pushed, cumulative
  let z = 0
  // The layer is where filament last went down -- not where the head
  // happens to be: the end G-code lifts Z far above the print.
  let layer = 0
  let total: number | null = null
  let elapsed = 0
  const marks: ProgressPoint[] = []
  // Object attribution: names by id (M486), the object printing now.
  const names = new Map<string, string>()
  let current: string | null = null
  const perE = new Map<string, number>()
  // Extrusion per object within the current progress interval, for time.
  let intervalE = new Map<string, number>()
  const perMin = new Map<string, number>()
  let overheadMin = 0
  let carry = ''
  // Filament pushed while no object was printing: purge, skirt, wipe.
  let outside = 0
  const outsideAt: number[] = []

  // Net filament -- pushes less retractions -- so an object's grams are
  // what stayed in it, and the objects add up to the plate.
  const addE = (mm: number) => {
    e += mm
    if (!current) outside += mm
    if (current) {
      perE.set(current, (perE.get(current) ?? 0) + mm)
      intervalE.set(current, (intervalE.get(current) ?? 0) + mm)
    }
  }

  const closeInterval = (minutes: number) => {
    if (minutes <= 0) return
    let sum = 0
    for (const v of intervalE.values()) sum += v
    if (sum <= 0) overheadMin += minutes
    else for (const [k, v] of intervalE) perMin.set(k, (perMin.get(k) ?? 0) + (minutes * v) / sum)
    intervalE = new Map()
  }

  const line = (raw: string) => {
    const semi = raw.indexOf(';')
    const comment = semi >= 0 ? raw.slice(semi + 1).trim() : ''
    const s = (semi >= 0 ? raw.slice(0, semi) : raw).trim()
    if (comment) {
      // PrusaSlicer/Orca plain G-code: "; printing object Hull id:0 copy 0"
      if (comment.startsWith('printing object ')) current = comment.slice(16).trim()
      else if (comment.startsWith('stop printing object')) current = null
    }
    if (!s) return
    const c0 = s.charCodeAt(0)
    if (c0 === 71 /* G */) {
      if (!(s.startsWith('G1') || s.startsWith('G0') || s.startsWith('G2') || s.startsWith('G3'))) {
        if (s.startsWith('G92')) {
          const m = /E\s*([-+]?\d*\.?\d+)/.exec(s)
          if (m) lastAbsE = parseFloat(m[1])
        }
        return
      }
      const ze = /Z\s*([-+]?\d*\.?\d+)/.exec(s)
      if (ze) z = parseFloat(ze[1])
      const m = /E\s*([-+]?\d*\.?\d+)/.exec(s)
      if (m) {
        const v = parseFloat(m[1])
        const d = relative ? v : v - lastAbsE
        if (!relative) lastAbsE = v
        addE(d)
        if (d > 0 && /[XY]/.test(s)) layer = z
      }
      return
    }
    if (c0 !== 77 /* M */) {
      if (s.startsWith('EXCLUDE_OBJECT_START')) {
        const m = /NAME=(\S+)/.exec(s)
        current = m ? m[1] : null
      } else if (s.startsWith('EXCLUDE_OBJECT_END')) current = null
      return
    }
    if (s.startsWith('M83')) relative = true
    else if (s.startsWith('M82')) relative = false
    else if (s.startsWith('M486')) {
      const rest = s.slice(4).trim()
      if (rest[0] === 'A') {
        // M486 A<name> names the id set by the M486 S before it.
        if (pendingId != null) names.set(pendingId, rest.slice(1).trim())
      } else if (rest[0] === 'S') {
        const id = (NUM.exec(rest.slice(1)) ?? ['-1'])[0]
        pendingId = id
        current = id === '-1' ? null : (names.get(id) ?? `object ${id}`)
      }
    } else if (s.startsWith('M73')) {
      const p = /P\s*(\d+)/.exec(s)
      const r = /R\s*(\d+)/.exec(s)
      if (p && r) {
        const left = parseInt(r[1], 10)
        if (total == null) total = left
        const now = Math.max(0, total - left)
        closeInterval(now - elapsed)
        elapsed = Math.max(elapsed, now)
        marks.push({ min: now, pct: parseInt(p[1], 10), grams: e * mmToG, z: layer })
        outsideAt.push(outside * mmToG)
      }
    }
  }
  let pendingId: string | null = null

  for await (const chunk of chunks as AsyncIterable<string>) {
    const text = carry + chunk
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl < 0) break
      line(text.slice(start, nl))
      start = nl + 1
    }
    carry = text.slice(start)
  }
  if (carry) line(carry)

  // Time no object extruded in (heating, homing, travel between) is shared
  // out by each object's share of the filament, so the parts add up to the
  // plate.
  let sumE = 0
  for (const v of perE.values()) sumE += v
  const objects: GcodeWalk['objects'] = {}
  for (const [k, v] of perE) {
    const share = sumE > 0 ? v / sumE : 0
    objects[k] = { grams: v * mmToG, minutes: (perMin.get(k) ?? 0) + overheadMin * share }
  }

  // What went outside the objects means something only when the file names
  // its objects; otherwise every move is "outside".
  if (perE.size) marks.forEach((m, i) => (m.waste = Math.max(0, outsideAt[i])))
  return { totalMinutes: total, measuredGrams: e * mmToG, progress: thin(marks, 400), objects }
}

/** Keep at most n points, evenly by index, always the first and the last. */
function thin(points: ProgressPoint[], n: number): ProgressPoint[] {
  if (points.length <= n) return points
  const out: ProgressPoint[] = []
  const step = (points.length - 1) / (n - 1)
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)])
  return out
}

/**
 * Where a print stood after `minutes`: percent done, grams pushed (scaled
 * to the slicer's own total when given), layer height. Interpolated between
 * the two marks either side. Null without progress marks.
 */
export function progressAt(
  progress: ProgressPoint[],
  minutes: number,
  slicerGrams?: number | null,
): { pct: number; grams: number; z: number; waste: number | null } | null {
  if (!progress.length) return null
  const last = progress[progress.length - 1]
  const scale = slicerGrams && last.grams > 0 ? slicerGrams / last.grams : 1
  const w = (p: ProgressPoint) => (p.waste == null ? null : p.waste * scale)
  if (minutes <= progress[0].min) return { pct: progress[0].pct, grams: progress[0].grams * scale, z: progress[0].z, waste: w(progress[0]) }
  if (minutes >= last.min) return { pct: last.pct, grams: last.grams * scale, z: last.z, waste: w(last) }
  let lo = 0
  let hi = progress.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (progress[mid].min <= minutes) lo = mid
    else hi = mid
  }
  const a = progress[lo]
  const b = progress[hi]
  const t = b.min === a.min ? 0 : (minutes - a.min) / (b.min - a.min)
  return {
    pct: Math.round(a.pct + (b.pct - a.pct) * t),
    grams: (a.grams + (b.grams - a.grams) * t) * scale,
    // The layer is a step, not a slope: the one reached by the earlier mark.
    z: a.z,
    waste: a.waste == null || b.waste == null ? null : (a.waste + (b.waste - a.waste) * t) * scale,
  }
}

/** Stored as [[minutes, percent, grams, layer], ...] -- a few KB a plate. */
export function encodeProgress(points: ProgressPoint[] | null | undefined): string | null {
  if (!points || !points.length) return null
  return JSON.stringify(
    points.map((p) => {
      const row = [p.min, p.pct, Math.round(p.grams * 100) / 100, Math.round(p.z * 1000) / 1000]
      if (p.waste != null) row.push(Math.round(p.waste * 100) / 100)
      return row
    }),
  )
}

export function decodeProgress(text: string | null | undefined): ProgressPoint[] | null {
  if (!text) return null
  try {
    const rows = JSON.parse(text) as unknown
    if (!Array.isArray(rows)) return null
    const out = rows
      .filter((r): r is number[] => Array.isArray(r) && r.length >= 4 && r.every((x) => typeof x === 'number'))
      .map(([min, pct, grams, z, waste]) => (waste == null ? { min, pct, grams, z } : { min, pct, grams, z, waste }))
    return out.length ? out : null
  } catch {
    return null
  }
}

/** "15", "15.5", "15h 30m", "15:30", "930m" -> minutes. Null when unreadable. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  const colon = /^(\d+):(\d{1,2})$/.exec(t)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60)
  let min = 0
  let any = false
  for (const [, n, u] of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m)/g)) {
    any = true
    min += Number(n) * (u === 'd' ? 1440 : u === 'h' ? 60 : 1)
  }
  return any ? Math.round(min) : null
}

/** 925 -> "15h 25m". */
export function fmtMinutes(m: number): string {
  const r = Math.round(m)
  return r >= 60 ? `${Math.floor(r / 60)}h ${r % 60}m` : `${r}m`
}
