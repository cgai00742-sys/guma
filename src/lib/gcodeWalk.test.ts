/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { bgcodeText, meatpackDecode, progressAt, walkGcode } from './gcodeWalk'

const here = dirname(fileURLToPath(import.meta.url))
const inflate = async (d: Uint8Array) => new Uint8Array(inflateSync(d))

describe('binary G-code moves, decoded (CG, 13 Oct)', () => {
  // The header and first G-code block of CG's Maui plate (PrusaSlicer 2.9.6,
  // heatshrink 12/4 + MeatPack with comments): real bytes, not a re-encode.
  const mini = new Uint8Array(Buffer.from(readFileSync(join(here, 'fixtures/maui-first-block.bgcode.b64'), 'utf8'), 'base64'))

  it('reads the first block back to the slicer’s own G-code', async () => {
    const parts: string[] = []
    for await (const t of bgcodeText(mini, inflate)) parts.push(t)
    const text = parts.join('')
    // Same length and ending as an independent Python decoder of this block.
    expect(text.length).toBe(61544)
    expect(text.endsWith('G1X180Y128.934E1.93798\n\n')).toBe(true)
    expect(text.startsWith('; \nM73 P0 R985\nM73 C899\n')).toBe(true)
    expect(text).toContain('M486 AMaui_BATHY_3x.stl')
    expect(text).toContain('M862.3 P "XL"')
  })

  it('MeatPack: packed pairs, full bytes, and the no-spaces E', () => {
    // FF FF FB starts packing. Low nibble first: 0xFD is 'G' then a full
    // byte ('1'); 0xC1 is '1' then newline.
    const g1 = new Uint8Array([0xff, 0xff, 0xfb, 0xfd, 0x31, 0xc1])
    expect(meatpackDecode(g1)).toBe('G11\n')
    const noSpace = new Uint8Array([0xff, 0xff, 0xf7, 0xff, 0xff, 0xfb, 0xb1])
    expect(meatpackDecode(noSpace)).toBe('1E')
  })
})

describe('walking the moves', () => {
  // Two objects, Prusa-style labels, relative extrusion, progress marks.
  const plate = [
    'M83',
    'M486 S0',
    'M486 AHull.stl',
    'M486 S1',
    'M486 ALid.stl',
    'M486 S-1',
    'M73 P0 R10',
    'G1 Z0.2 F600',
    'G1 E2 F300 ; prime, outside any object',
    'M486 S0',
    'G1 X10 Y10 E30',
    'G1 E-1 ; retract',
    'M486 S-1',
    'M486 S1',
    'G1 X20 Y20 E1',
    'G1 X21 Y20 E10',
    'M486 S-1',
    'M73 P50 R5',
    'G1 Z0.4',
    'M486 S0',
    'G1 X10 Y11 E20',
    'M486 S-1',
    'M73 P100 R0',
    'G1 Z40 ; park',
  ].join('\n')

  it('measures each object and keeps the progress with the layer reached', async () => {
    const w = await walkGcode([plate.slice(0, 57), plate.slice(57)], 1.75, 1.24)
    const g = (mm: number) => (mm * Math.PI * 0.875 ** 2 * 1.24) / 1000
    expect(w.totalMinutes).toBe(10)
    expect(w.measuredGrams).toBeCloseTo(g(62), 6)
    expect(w.objects['Hull.stl'].grams).toBeCloseTo(g(49), 6)
    expect(w.objects['Lid.stl'].grams).toBeCloseTo(g(11), 6)
    // First five minutes shared by filament (29 : 11), the next five all Hull.
    expect(w.objects['Hull.stl'].minutes).toBeCloseTo((5 * 29) / 40 + 5, 6)
    expect(w.objects['Lid.stl'].minutes).toBeCloseTo((5 * 11) / 40, 6)
    expect(w.progress.map((p) => [p.min, p.pct, p.z])).toEqual([
      [0, 0, 0],
      [5, 50, 0.2],
      [10, 100, 0.4],
    ])
  })

  it('PrusaSlicer comments and Klipper EXCLUDE_OBJECT name objects too', async () => {
    const a = await walkGcode(['M83\n; printing object Peg id:0 copy 0\nG1 X1 E5\n; stop printing object Peg id:0 copy 0\nG1 X2 E1\n'])
    expect(Object.keys(a.objects)).toEqual(['Peg id:0 copy 0'])
    const b = await walkGcode(['M83\nEXCLUDE_OBJECT_START NAME=Peg_1\nG1 X1 E5\nEXCLUDE_OBJECT_END NAME=Peg_1\n'])
    expect(Object.keys(b.objects)).toEqual(['Peg_1'])
  })

  it('absolute extrusion and G92 resets', async () => {
    const w = await walkGcode(['M82\nG92 E0\nG1 X1 E5\nG1 X2 E8\nG92 E0\nG1 X3 E2\n'], 1.75, 1.24)
    expect(w.measuredGrams).toBeCloseTo((10 * Math.PI * 0.875 ** 2 * 1.24) / 1000, 6)
  })
})

describe('where a stopped print stood', () => {
  const pts = [
    { min: 0, pct: 0, grams: 0, z: 0 },
    { min: 60, pct: 6, grams: 36, z: 0.8 },
    { min: 900, pct: 91, grams: 330, z: 39.6 },
    { min: 985, pct: 100, grams: 350, z: 40.3 },
  ]
  it('interpolates grams between marks and scales to the slicer total', () => {
    const r = progressAt(pts, 480, 350)!
    expect(r.grams).toBeCloseTo(36 + (294 * 420) / 840, 6)
    expect(r.z).toBe(0.8)
    expect(progressAt(pts, 985, 354.92)!.grams).toBeCloseTo(354.92, 6)
    expect(progressAt(pts, 5000)!.pct).toBe(100)
    expect(progressAt([], 10)).toBeNull()
  })
})

describe('reading a duration the way people type it', async () => {
  const { parseDuration, fmtMinutes } = await import('./gcodeWalk')
  it('hours, decimals, h/m, colons', () => {
    expect(parseDuration('15')).toBe(900)
    expect(parseDuration('15.5')).toBe(930)
    expect(parseDuration('15h 30m')).toBe(930)
    expect(parseDuration('15h')).toBe(900)
    expect(parseDuration('15:05')).toBe(905)
    expect(parseDuration('45m')).toBe(45)
    expect(parseDuration('soon')).toBeNull()
    expect(fmtMinutes(986)).toBe('16h 26m')
  })
})
