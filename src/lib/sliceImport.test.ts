/**
 * The parser is ported code, so these tests are written against the file
 * FORMATS rather than against the implementation: real PrusaSlicer footer
 * lines, a real Bambu slice_info.config shape, a real zip built here byte by
 * byte. If the port drifted from Voltage's behaviour, these are what say so.
 *
 * The zip is built with a stored (uncompressed) entry on purpose. It keeps
 * the fixture readable and still exercises the central-directory walk, the
 * per-entry local-header hop and the name lookup -- everything except the
 * inflate branch, which is DecompressionStream's job, not ours.
 */
import { describe, expect, it } from 'vitest'
import {
  matchMaterial,
  matchPrinter,
  parseSliceFile,
  SLICE_ACCEPT,
  type SliceFileLike,
} from './sliceImport'

/** A File-like over a string, which is all parseSliceFile needs. */
function gcodeFile(name: string, body: string): SliceFileLike {
  return {
    name,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  }
}

/** Build a real (stored-entry) zip so the ZIP reader is genuinely exercised. */
function zipFile(name: string, files: Record<string, string>): SliceFileLike {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  // CRC-32, because a zip without one is not a zip.
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  for (const [path, content] of Object.entries(files)) {
    const nameB = enc.encode(path)
    const data = enc.encode(content)
    const crc = crc32(data)

    const lh = new Uint8Array(30 + nameB.length + data.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true) // stored
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    lh.set(nameB, 30)
    lh.set(data, 30 + nameB.length)
    locals.push(lh)

    const ch = new Uint8Array(46 + nameB.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, 0, true) // stored
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    ch.set(nameB, 46)
    centrals.push(ch)

    offset += lh.length
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, p)
    p += b.length
  }
  return {
    name,
    arrayBuffer: async () => out.buffer as ArrayBuffer,
    text: async () => {
      throw new Error('binary')
    },
  }
}

// A PrusaSlicer footer, as PrusaSlicer actually writes it.
const PRUSA_FOOTER = `
; filament used [mm] = 4128.55
; filament used [cm3] = 9.93
; filament used [g] = 12.34
; filament cost = 0.45
; total filament used [g] = 12.34
; estimated printing time (normal mode) = 1h 2m 3s
; filament_type = PETG
; printer_model = XL
`

describe('G-code', () => {
  it('reads grams, time and material out of a PrusaSlicer footer', async () => {
    const f = await parseSliceFile(gcodeFile('bracket.gcode', PRUSA_FOOTER))
    expect(f.kind).toBe('gcode')
    // 12.34, not 24.68. Voltage's parser matched both the per-tool line and
    // the total line and added them, so every single-tool print reported
    // double its grams -- and grams x material cost is money.
    expect(f.totals.estGrams).toBeCloseTo(12.34, 2)
    expect(f.totals.estMinutes).toBe(62) // 1h 2m 3s, rounded
    expect(f.totals.material).toBe('PETG')
    expect(f.printerModel).toBe('Prusa XL') // "XL" is expanded
  })

  it('counts copies from "printing object" lines', async () => {
    const body = `
; printing object Hull A id:0 copy 0
; printing object Hull A id:0 copy 1
; printing object Keel id:1 copy 0
${PRUSA_FOOTER}`
    const f = await parseSliceFile(gcodeFile('proa.gcode', body))
    expect(f.sections.map((s) => [s.label, s.qty])).toEqual([
      ['Hull A', 2],
      ['Keel', 1],
    ])
    expect(f.totals.units).toBe(3)
    // Apportioned by copies, not split evenly between the two labels.
    const hull = f.sections.find((s) => s.label === 'Hull A')!
    const keel = f.sections.find((s) => s.label === 'Keel')!
    expect(hull.estMinutes).toBe(41)
    expect(keel.estMinutes).toBe(21)
  })

  it("says so when the slicer did not label the objects", async () => {
    const f = await parseSliceFile(gcodeFile('reef_marker_v2.gcode', PRUSA_FOOTER))
    expect(f.sections).toHaveLength(1)
    expect(f.sections[0].label).toBe('Reef marker v2') // from the filename
    expect(f.notes.join(' ')).toMatch(/Label objects/)
  })

  it('reads Klipper EXCLUDE_OBJECT names and strips their copy suffixes', async () => {
    const body = `
EXCLUDE_OBJECT_DEFINE NAME=Paddle_blade_id_0_copy_0
EXCLUDE_OBJECT_DEFINE NAME=Paddle_blade_id_0_copy_1
${PRUSA_FOOTER}`
    const f = await parseSliceFile(gcodeFile('paddle.gcode', body))
    expect(f.sections).toEqual([
      expect.objectContaining({ label: 'Paddle blade', qty: 2 }),
    ])
  })
})

describe('the two ways PrusaSlicer writes grams', () => {
  it('trusts the total line over the per-extruder line, and never adds them', async () => {
    const f = await parseSliceFile(
      gcodeFile(
        'single.gcode',
        `; filament used [g] = 12.34
; total filament used [g] = 12.34
; estimated printing time (normal mode) = 30m
; filament_type = PLA`,
      ),
    )
    expect(f.totals.estGrams).toBeCloseTo(12.34, 2)
  })

  it('reads a multi-material line without stopping at the first comma', async () => {
    const f = await parseSliceFile(
      gcodeFile(
        'mmu.gcode',
        `; filament used [g] = 3.09,2.50
; total filament used [g] = 5.59
; estimated printing time (normal mode) = 1h
; filament_type = PLA;PETG`,
      ),
    )
    // The old parser took 3.09 (stopped at the comma) and added 5.59 = 8.68.
    expect(f.totals.estGrams).toBeCloseTo(5.59, 2)
    // Per-extruder grams line up with per-extruder types, so the breakdown
    // is real rather than the whole plate attributed to one material. The
    // breakdown is apportioned across sections and so rounds to 0.1 g
    // (3.09 -> 3.1); the TOTAL above is not rounded. At filament prices
    // 0.01 g is a hundredth of a cent, and the totals are what cost money.
    expect(f.sections[0].materialsBreakdown).toEqual({ PLA: 3.1, PETG: 2.5 })
    expect(f.totals.material).toBe('PLA, PETG')
  })

  it('falls back to summing the extruders when there is no total line', async () => {
    const f = await parseSliceFile(
      gcodeFile(
        'nototal.gcode',
        `; filament used [g] = 4.0,6.0
; estimated printing time (normal mode) = 20m
; filament_type = PLA;PETG`,
      ),
    )
    expect(f.totals.estGrams).toBeCloseTo(10, 2)
  })
})

describe('Bambu / Orca .gcode.3mf', () => {
  const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="7380"/>
    <metadata key="weight" value="86.5"/>
    <metadata key="printer_model_id" value="O1S"/>
    <object identify_id="1" name="Buoy_shell.stl" skipped="false"/>
    <object identify_id="2" name="Buoy_shell.stl" skipped="false"/>
    <object identify_id="3" name="Cap" skipped="true"/>
    <filament id="1" type="PETG" used_g="70.0"/>
    <filament id="2" type="PLA" used_g="16.5"/>
  </plate>
</config>`

  it('reads plate weight, prediction, printer and objects', async () => {
    const f = await parseSliceFile(zipFile('buoy.gcode.3mf', { 'Metadata/slice_info.config': sliceInfo }))
    expect(f.kind).toBe('3mf')
    expect(f.totals.estMinutes).toBe(123) // 7380s
    expect(f.totals.estGrams).toBe(86.5)
    expect(f.printerModel).toBe('Bambu Lab H2S') // O1S decoded
    expect(f.totals.material).toBe('PETG, PLA')
  })

  it('skips objects marked skipped, and cleans .stl off the labels', async () => {
    const f = await parseSliceFile(zipFile('buoy.gcode.3mf', { 'Metadata/slice_info.config': sliceInfo }))
    expect(f.sections).toEqual([expect.objectContaining({ label: 'Buoy shell', qty: 2 })])
    expect(f.sections[0].materialsBreakdown).toEqual({ PETG: 70, PLA: 16.5 })
  })

  it('does not double-count filament when the plate already gave a weight', async () => {
    const f = await parseSliceFile(zipFile('buoy.gcode.3mf', { 'Metadata/slice_info.config': sliceInfo }))
    // 86.5 from the plate, NOT 86.5 + 70 + 16.5.
    expect(f.totals.estGrams).toBe(86.5)
  })

  it('prefers project_settings.config over the slice_info code', async () => {
    const f = await parseSliceFile(
      zipFile('buoy.gcode.3mf', {
        'Metadata/slice_info.config': sliceInfo,
        'Metadata/project_settings.config': '{"printer_model": "Bambu Lab H2D"}',
      }),
    )
    expect(f.printerModel).toBe('Bambu Lab H2D')
  })

  it('combines plates and says it did', async () => {
    const two = sliceInfo.replace(
      '</config>',
      `<plate>
         <metadata key="prediction" value="600"/>
         <metadata key="weight" value="10"/>
         <object identify_id="9" name="Keel" skipped="false"/>
       </plate></config>`,
    )
    const f = await parseSliceFile(zipFile('proa.gcode.3mf', { 'Metadata/slice_info.config': two }))
    expect(f.totals.estGrams).toBe(96.5)
    expect(f.totals.estMinutes).toBe(133)
    expect(f.notes.join(' ')).toMatch(/2 plates found/)
  })

  it('imports section names from an unsliced 3MF, with no estimates', async () => {
    const model = `<model><resources>
        <object id="1" name="Hull"/><object id="2" name="Ama"/>
      </resources><build><item objectid="1"/><item objectid="2"/></build></model>`
    const f = await parseSliceFile(zipFile('sakman.3mf', { '3D/3dmodel.model': model }))
    expect(f.kind).toBe('3mf-model')
    expect(f.sections.map((s) => s.label)).toEqual(['Hull', 'Ama'])
    expect(f.totals.estGrams).toBeNull()
    expect(f.notes.join(' ')).toMatch(/isn't sliced/)
  })
})

describe('the same part sliced for two machines', () => {
  it('suggests one assembly from both filenames', async () => {
    const a = await parseSliceFile(gcodeFile('H2D_Wing L 1_sliced.gcode', PRUSA_FOOTER))
    const b = await parseSliceFile(gcodeFile('H2S_Wing L 1_sliced.gcode', PRUSA_FOOTER))
    expect(a.suggestedGroup).toBe(b.suggestedGroup)
    expect(a.suggestedGroup).toBe('Wing L 1')
  })

  it('strips a trailing date stamp too', async () => {
    const f = await parseSliceFile(gcodeFile('Reef buoy (09.24.2026).gcode', PRUSA_FOOTER))
    expect(f.suggestedGroup).toBe('Reef buoy')
  })
})

describe('files it refuses', () => {
  it('refuses something called .bgcode that is not binary G-code, by name', async () => {
    await expect(parseSliceFile(gcodeFile('part.bgcode', ''))).rejects.toThrow(/binary G-code/i)
  })

  it('refuses an unknown extension with a list of what it takes', async () => {
    await expect(parseSliceFile(gcodeFile('part.stl', ''))).rejects.toThrow(/\.gcode/)
  })

  it('does not pretend a truncated 3MF is empty', async () => {
    const junk: SliceFileLike = {
      name: 'broken.3mf',
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer,
      text: async () => '',
    }
    await expect(parseSliceFile(junk)).rejects.toThrow(/valid 3MF/)
  })
})

describe("PrusaSlicer binary G-code (.bgcode) — CG's real Maui file", () => {
  /**
   * samples/maui-top_prusa-xl.bgcode is the head of CG's own export
   * (PrusaSlicer 2.9.6, Prusa XL with two tools, second idle): every
   * metadata block and the thumbnails, cut just after the first G-code
   * block header -- which is exactly as far as the reader goes. The full
   * file is 22 MB; the numbers below are what PrusaSlicer wrote into it.
   */
  async function maui() {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = fileURLToPath(new URL('../../samples/maui-top_prusa-xl.bgcode', import.meta.url))
    const bytes = readFileSync(path)
    return parseSliceFile({
      name: 'Maui_Top_2mm Base.bgcode',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => {
        throw new Error('binary')
      },
    })
  }

  it('reads the filament, the time, the machine and the object', async () => {
    const f = await maui()
    expect(f.kind).toBe('gcode')
    expect(f.totals.estGrams).toBeCloseTo(73.13, 2)
    expect(f.totals.estMinutes).toBe(454) // 7h 34m 10s
    expect(f.printerModel).toBe('Prusa XL') // XL2IS
    expect(f.totals.material).toBe('PLA') // the idle second tool is not counted
    expect(f.sections.map((s) => s.label)).toEqual(['Maui LAND STANDALONE 3x'])
  })

  it('matches the shop\'s Prusa XL', async () => {
    const f = await maui()
    const shop = [
      { id: 'h', name: 'Hatsa', model: 'Prusa XL' },
      { id: 's', name: 'Sakman', model: 'Bambu Lab H2D' },
    ]
    expect(matchPrinter(shop, f.printerModel)?.id).toBe('h')
  })
})

it('the file input accepts .bgcode', () => {
  expect(SLICE_ACCEPT).toContain('.gcode')
  expect(SLICE_ACCEPT).toContain('.3mf')
  // Left out of accept, the browser greys it out and says nothing. In it,
  // the person gets told which PrusaSlicer setting to change.
  expect(SLICE_ACCEPT).toContain('.bgcode')
})

describe('matching the file to what the shop owns', () => {
  const printers = [
    { id: 'p1', name: 'Sakman', model: 'Prusa XL' },
    { id: 'p2', name: 'Big Blue', model: 'Bambu Lab H2S' },
    { id: 'p3', name: 'H2D', model: '' },
  ]

  it('matches a model the shop typed the same way', () => {
    expect(matchPrinter(printers, 'Bambu Lab H2S')?.id).toBe('p2')
  })

  it('matches a short model against a longer one, and the reverse', () => {
    expect(matchPrinter(printers, 'H2S')?.id).toBe('p2')
    expect(matchPrinter(printers, 'Prusa XL 2T')?.id).toBe('p1')
  })

  it('falls back to the machine name when the shop left model blank', () => {
    expect(matchPrinter(printers, 'Bambu Lab H2D')?.id).toBe('p3')
  })

  it('ignores punctuation and case', () => {
    expect(matchPrinter(printers, 'prusa-xl')?.id).toBe('p1')
  })

  it('returns null rather than guessing between two machines', () => {
    const twins = [
      { id: 'a', name: 'Left', model: 'Bambu Lab H2S' },
      { id: 'b', name: 'Right', model: 'Bambu Lab H2S' },
    ]
    // Costing a run against the wrong machine's rate is invisible once
    // saved, so no match beats a coin flip.
    expect(matchPrinter(twins, 'Bambu Lab H2S')).toBeNull()
  })

  it('returns null when the file said nothing, or nothing matches', () => {
    expect(matchPrinter(printers, null)).toBeNull()
    expect(matchPrinter(printers, 'Creality K1')).toBeNull()
  })

  const materials = [
    { id: 'm1', name: 'PETG black' },
    { id: 'm2', name: 'PLA matte white' },
    { id: 'm3', name: 'PA-CF black' },
  ]

  it('matches a filament type to the one spool of that type', () => {
    expect(matchMaterial(materials, 'PETG')?.id).toBe('m1')
  })

  it('will not choose between two spools of the same type', () => {
    const two = [
      { id: 'a', name: 'PETG black' },
      { id: 'b', name: 'PETG translucent' },
    ]
    expect(matchMaterial(two, 'PETG')).toBeNull()
  })

  it('tries only the first type of a multi-material file', () => {
    // One material_id cannot hold two spools; the full string is still
    // recorded on the import.
    expect(matchMaterial(materials, 'PETG, PLA')?.id).toBe('m1')
  })

  it('returns null on no detection', () => {
    expect(matchMaterial(materials, null)).toBeNull()
    expect(matchMaterial(materials, 'ABS')).toBeNull()
  })
})

describe('a saved project .3mf whose summary has no numbers (CG, Maui)', () => {
  const emptyInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="O1D"/>
    <object identify_id="1" name="Maui_Top" skipped="false"/>
    <filament id="1" type="PLA"/>
  </plate>
</config>`
  const bambuHeader = `; HEADER_BLOCK_START
; BambuStudio 02.02.00.85
; model printing time: 6h 51m 29s; total estimated time: 7h 2m 13s
; total layer number: 410
; total filament weight [g] : 212.45
; HEADER_BLOCK_END
G28
`
  it('reads time and grams from the plate G-code inside it', async () => {
    const f = await parseSliceFile(
      zipFile('Sliced_Maui_Top.3mf', {
        'Metadata/slice_info.config': emptyInfo,
        'Metadata/plate_1.gcode': bambuHeader,
      }),
    )
    expect(f.totals.estMinutes).toBe(422) // 7h 2m 13s
    expect(f.totals.estGrams).toBeCloseTo(212.45, 2)
    expect(f.totals.material).toBe('PLA')
  })

  it('reads an Orca header too', async () => {
    const f = await parseSliceFile(
      zipFile('orca.3mf', {
        'Metadata/slice_info.config': emptyInfo,
        'Metadata/plate_1.gcode': '; estimated printing time (normal mode) = 2h 3m\n; total filament used [g] = 86.5\n',
      }),
    )
    expect(f.totals.estMinutes).toBe(123)
    expect(f.totals.estGrams).toBe(86.5)
  })

  it('says plainly when there are no numbers anywhere in it', async () => {
    const f = await parseSliceFile(zipFile('unsliced.3mf', { 'Metadata/slice_info.config': emptyInfo }))
    expect(f.totals.estMinutes).toBeNull()
    expect(f.totals.estGrams).toBeNull()
    expect(f.notes.join(' ')).toMatch(/no print time or filament/i)
  })
})

describe('each object measured from the moves, not split by copies (CG, 13 Oct)', () => {
  // A big hull and a small lid on one plate. Split by copies they would be
  // 50 g each; the moves say 40 g of extrusion went into the hull.
  const plate = [
    'M83',
    'M73 P0 R60',
    'G1 Z0.2',
    '; printing object Hull id:0 copy 0',
    'G1 X1 Y1 E400',
    '; stop printing object Hull id:0 copy 0',
    '; printing object Lid id:1 copy 0',
    'G1 X2 Y2 E100',
    '; stop printing object Lid id:1 copy 0',
    'M73 P50 R30',
    '; printing object Hull id:0 copy 0',
    'G1 X3 Y3 E300',
    '; stop printing object Hull id:0 copy 0',
    'M73 P100 R0',
    '; filament used [g] = 100.00',
    '; total filament used [g] = 100.00',
    '; estimated printing time (normal mode) = 1h 0m 0s',
    '; filament_type = PLA',
  ].join('\n')

  it('gives each object its own grams and minutes, adding up to the plate', async () => {
    const f = await parseSliceFile(gcodeFile('hull and lid.gcode', plate))
    const by = Object.fromEntries(f.sections.map((s) => [s.label, s]))
    // 700 : 100 mm of filament -> 87.5 g and 12.5 g of the slicer's 100 g.
    expect(by.Hull.estGrams).toBe(87.5)
    expect(by.Lid.estGrams).toBe(12.5)
    // First 30 minutes shared 400 : 100, the last 30 all hull.
    expect(by.Hull.estMinutes).toBe(54)
    expect(by.Lid.estMinutes).toBe(6)
    expect(f.notes).toContain('Time and filament for each object measured from the moves in the file.')
    expect(f.progress?.map((p) => p.pct)).toEqual([0, 50, 100])
  })

  it('falls back to the split, and says so, when the moves do not name every object', async () => {
    const f = await parseSliceFile(gcodeFile('unlabelled.gcode', plate.replace(/; (stop )?printing object.*\n/g, '')))
    expect(f.notes.some((n) => /measured from the moves/.test(n))).toBe(false)
    expect(f.progress).not.toBeNull()
  })
})
