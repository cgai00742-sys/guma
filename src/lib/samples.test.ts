/// <reference types="node" />
/**
 * The files in samples/ are what a person reaches for when they want to see
 * whether slicer import works before trusting it with real work. A sample
 * that does not parse is worse than none: it teaches that the feature is
 * broken. So they are parsed here, and their documented expectations are
 * the assertions.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSliceFile, type SliceFileLike } from './sliceImport'

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../samples')
const asFile = (name: string): SliceFileLike => {
  const buf = readFileSync(join(SAMPLES, name))
  return {
    name,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }
}

describe('the sample files parse, and say what their comments promise', () => {
  it('reef-buoy_prusa.gcode', async () => {
    const f = await parseSliceFile(asFile('reef-buoy_prusa.gcode'))
    expect(f.sections.map((s) => [s.label, s.qty])).toEqual([
      ['Hull shell', 2],
      ['Cap', 1],
    ])
    expect(f.totals.estGrams).toBe(86.5)
    expect(f.totals.estMinutes).toBe(123)
    expect(f.totals.material).toBe('PETG')
    expect(f.printerModel).toBe('Prusa XL')
  })

  it('calibration_no-labels.gcode', async () => {
    const f = await parseSliceFile(asFile('calibration_no-labels.gcode'))
    expect(f.sections).toHaveLength(1)
    // Hyphens and underscores become spaces -- the filename is being turned
    // into a human label, not echoed.
    expect(f.sections[0].label).toBe('Calibration no labels')
    expect(f.totals.estGrams).toBe(14.2)
    expect(f.totals.estMinutes).toBe(41)
    expect(f.notes.join(' ')).toMatch(/Label objects/)
  })

  it('H2S_Sakman ama_sliced.gcode.3mf', async () => {
    const f = await parseSliceFile(asFile('H2S_Sakman ama_sliced.gcode.3mf'))
    // A real deflate-compressed zip, so this also proves the inflate branch
    // the unit tests deliberately skip (they use stored entries).
    expect(f.kind).toBe('3mf')
    expect(f.sections.map((s) => [s.label, s.qty])).toEqual([
      ['Sakman ama', 2],
      ['Sakman iako', 1],
    ])
    expect(f.totals.estGrams).toBe(142.8)
    expect(f.totals.estMinutes).toBe(153)
    expect(f.printerModel).toBe('Bambu Lab H2S')
    expect(f.suggestedGroup).toBe('Sakman ama')
  })
})
