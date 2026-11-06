import { describe, expect, it } from 'vitest'
import { isLitter, isSliced, planFolder, type FolderRead } from './folderImport'
import type { SliceFile } from './sliceImport'

const file = (fileName: string, grams: number | null, minutes: number | null, printerModel: string | null = 'Prusa XL', group = fileName): SliceFile =>
  ({
    kind: 'gcode',
    fileName,
    printerModel,
    suggestedGroup: group,
    sections: [],
    totals: { sections: 1, units: 1, estMinutes: minutes, estGrams: grams, material: 'PLA' },
    notes: [],
    progress: null,
  }) as unknown as SliceFile
const read = (path: string, parsed: SliceFile | null, error: string | null = null): FolderRead => ({ key: path, path, parsed, error })

describe('planFolder', () => {
  it('keeps the first of a Finder copy and unticks the copy', () => {
    const rows = planFolder([read('job/S1, P9 copy.bgcode', file('S1, P9 copy.bgcode', 115, 323)), read('job/S1, P9.bgcode', file('S1, P9.bgcode', 115, 323))])
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.include]))
    expect(byPath['job/S1, P9.bgcode']).toBe(true)
    expect(byPath['job/S1, P9 copy.bgcode']).toBe(false)
  })

  it('unticks files with no numbers, unreadable files, and ones already on the quote', () => {
    const rows = planFolder(
      [read('a.3mf', file('a.3mf', null, null)), read('b.bgcode', null, 'Broken file'), read('c.gcode', file('c.gcode', 10, 20)), read('d.gcode', file('d.gcode', 5, 6))],
      [{ fileName: 'c.gcode', estGrams: 10, estMinutes: 20 }],
    )
    expect(rows.map((r) => r.include)).toEqual([false, false, false, true])
    expect(rows[0].note).toMatch(/no print time/i)
    expect(rows[1].note).toBe('Broken file')
    expect(rows[2].note).toMatch(/already on this quote/i)
  })

  it('unticks the same plate sliced for a second machine', () => {
    const rows = planFolder([read('mast_XL.bgcode', file('mast_XL.bgcode', 50, 60, 'Prusa XL', 'mast')), read('mast_H2S.gcode.3mf', file('mast_H2S.gcode.3mf', 48, 55, 'Bambu Lab H2S', 'mast'))])
    expect(rows.filter((r) => r.include)).toHaveLength(1)
    expect(rows.find((r) => !r.include)?.note).toMatch(/same plate .* sliced for/i)
  })

  it('knows litter and sliced files by name', () => {
    expect(isLitter('.DS_Store')).toBe(true)
    expect(isLitter('Thumbs.db')).toBe(true)
    expect(isSliced('x.gcode.3mf')).toBe(true)
    expect(isSliced('x.stl')).toBe(false)
  })
})

describe('filesFromDrop', () => {
  const fileEntry = (path: string) => ({
    isFile: true,
    isDirectory: false,
    fullPath: `/${path}`,
    file: (ok: (f: File) => void) => ok(new File(['x'], path.split('/').pop()!)),
  })
  const dirEntry = (path: string, children: unknown[]) => {
    let given = false
    return {
      isFile: false,
      isDirectory: true,
      fullPath: `/${path}`,
      // Hands back one batch, then empty -- as WebKit does.
      createReader: () => ({ readEntries: (ok: (e: unknown[]) => void) => ok(given ? [] : ((given = true), children)) }),
    }
  }

  it('opens a dropped folder all the way down, keeping the folder path', async () => {
    const { filesFromDrop } = await import('./folderImport')
    const tree = dirEntry('Mast', [fileEntry('Mast/S1, P9.bgcode'), dirEntry('Mast/old', [fileEntry('Mast/old/S1, P8.bgcode')])])
    const dt = { items: [{ webkitGetAsEntry: () => tree }], files: [] } as unknown as DataTransfer
    const found = await filesFromDrop(dt)
    expect(found.map((f) => f.path)).toEqual(['Mast/S1, P9.bgcode', 'Mast/old/S1, P8.bgcode'])
  })
})
