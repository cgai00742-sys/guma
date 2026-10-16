import { describe, expect, it } from 'vitest'
import { sameSliceFile } from './data.types'

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
