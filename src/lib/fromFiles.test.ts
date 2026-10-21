import { describe, expect, it } from 'vitest'
import { sameSliceFile, type PrintRunRow, type SliceImportRow } from './data.types'
import { groupSliceFiles, newestFirst } from './fromFiles'

describe('the same sliced file, however the browser named it', () => {
  const f = (fileName: string, estMinutes = 986, estGrams = 354.9) => ({ fileName, estMinutes, estGrams })
  it('treats "x (1).bgcode" as x.bgcode when the slicer numbers agree (CG, 15 Oct)', () => {
    expect(sameSliceFile(f('Sliced_Maui_BATHY_16h26m.bgcode'), f('Sliced_Maui_BATHY_16h26m (1).bgcode'))).toBe(true)
    expect(sameSliceFile(f('Maui (2)'), f('maui'))).toBe(true)
  })
  it('keeps them apart when the numbers differ, or the name really differs', () => {
    expect(sameSliceFile(f('Maui.bgcode'), f('Maui (1).bgcode', 434))).toBe(false)
    expect(sameSliceFile(f('Maui (draft).bgcode'), f('Maui.bgcode'))).toBe(false)
  })
})

describe('plates, newest print first (CG, 20 Oct)', () => {
  const slice = (id: string, importedAt: string) =>
    ({ id, fileName: `${id}.gcode`, estMinutes: 60, estGrams: 10, importedAt, sections: [] }) as unknown as SliceImportRow
  const run = (id: string, sliceImportId: string, startedAt: string) => ({ id, sliceImportId, startedAt }) as unknown as PrintRunRow
  it('puts the latest print at the top, plates still to print above them, same-day prints in recorded order', () => {
    const slices = [slice('old', '2026-09-01'), slice('mid', '2026-09-02'), slice('new', '2026-10-15'), slice('todo', '2026-10-01'), slice('sameday', '2026-09-03')]
    // As the database returns them: newest first, same day newest recorded first.
    const runs = [run('r4', 'sameday', '2026-10-15'), run('r3', 'new', '2026-10-15'), run('r2', 'mid', '2026-09-16'), run('r1', 'old', '2026-09-11')]
    const order = newestFirst(groupSliceFiles(slices, runs), runs).map((g) => g.first.id)
    expect(order).toEqual(['todo', 'sameday', 'new', 'mid', 'old'])
  })
  it('a plate printed twice sorts by its latest print', () => {
    const slices = [slice('a', '2026-09-01'), slice('b', '2026-09-02')]
    const runs = [run('r3', 'a', '2026-10-10'), run('r2', 'b', '2026-10-01'), run('r1', 'a', '2026-09-05')]
    expect(newestFirst(groupSliceFiles(slices, runs), runs).map((g) => g.first.id)).toEqual(['a', 'b'])
  })
})
