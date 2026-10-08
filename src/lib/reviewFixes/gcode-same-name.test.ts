import { expect, it } from 'vitest'
import { parseSliceFile } from '../sliceImport'

it('two separate objects sharing a name (pasted copies) count as two', async () => {
  const src = ['; printing object Hull.stl id:0 copy 0', '; printing object Hull.stl id:1 copy 0',
    '; printing object Cap.stl id:2 copy 0', '; total filament used [g] = 90',
    '; estimated printing time (normal mode) = 3h 0m 0s'].join('\n')
  const f = await parseSliceFile({ name: 'x.gcode', text: async () => src, arrayBuffer: async () => new ArrayBuffer(0) })
  expect(f.sections.find((s) => s.label === 'Hull')!.qty).toBe(2) // two hulls on the bed
  expect(f.totals.units).toBe(3)
})
