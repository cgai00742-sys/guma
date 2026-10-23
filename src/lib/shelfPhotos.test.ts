import { describe, expect, it } from 'vitest'
import { matchShelfPhotos, type PhotoImport } from './shelfPhotos'

const imp = (id: string, job: string, thumbnail: string | null, has_file = true): PhotoImport => ({ id, job_id: job, thumbnail, has_file })
const base = {
  products: [{ id: 'p', name: 'Kauai', design_job_id: 'j' }],
  have: [] as { product_id: string; import_id: string | null }[],
  batches: [{ id: 'b', product_id: 'p', job_id: 'j' }],
  items: [] as { batch_id: string | null; assembly_id: string | null; import_id: string | null }[],
  assemblies: [] as { id: string; batch_id: string | null }[],
  imports: [imp('i1', 'j', 'pic-maui'), imp('i2', 'j', 'pic-kauai'), imp('i3', 'j', 'pic-bathy')],
  sections: [{ import_id: 'i1', label: 'Maui' }, { import_id: 'i2', label: 'Kauai' }],
}
const pics = (r: ReturnType<typeof matchShelfPhotos>) => r.add.map((a) => a.thumbnail)

describe('which plate pictures a Shelf product gets', () => {
  it('takes the plate its pieces came off, before anything else', () => {
    const r = matchShelfPhotos({ ...base, items: [{ batch_id: 'b', assembly_id: null, import_id: 'i1' }] })
    expect(r.add).toEqual([{ productId: 'p', importId: 'i1', thumbnail: 'pic-maui' }])
  })
  it('gives a piece made from several plates every one of them', () => {
    // The Maui BathyTopo 3X 12" piece: parts off three plates, one assembly.
    const r = matchShelfPhotos({
      ...base,
      assemblies: [{ id: 'a', batch_id: 'b' }],
      items: [
        { batch_id: null, assembly_id: 'a', import_id: 'i3' },
        { batch_id: null, assembly_id: 'a', import_id: 'i1' },
        { batch_id: null, assembly_id: 'a', import_id: 'i3' },
      ],
    })
    expect(pics(r)).toEqual(['pic-bathy', 'pic-maui'])
  })
  it('adds a new plate, and leaves alone the ones already there or taken off', () => {
    const r = matchShelfPhotos({
      ...base,
      have: [{ product_id: 'p', import_id: 'i1' }, { product_id: 'p', import_id: 'i2' }],
      items: ['i1', 'i2', 'i3'].map((i) => ({ batch_id: 'b', assembly_id: null, import_id: i })),
    })
    expect(pics(r)).toEqual(['pic-bathy'])
  })
  it('matches by name in the same project when no pieces link it', () => {
    expect(pics(matchShelfPhotos(base))).toEqual(['pic-kauai'])
  })
  it('uses the only plate of a one-plate project', () => {
    const r = matchShelfPhotos({ ...base, imports: [imp('i1', 'j', 'pic-maui')], sections: [], products: [{ ...base.products[0], name: 'Something' }] })
    expect(pics(r)).toEqual(['pic-maui'])
  })
  it('does not guess between several plates', () => {
    expect(matchShelfPhotos({ ...base, products: [{ ...base.products[0], name: 'Hawaii set' }] }).add).toEqual([])
  })
  it('does not guess for a product that already has a picture of its own', () => {
    expect(matchShelfPhotos({ ...base, have: [{ product_id: 'p', import_id: null }] }).add).toEqual([])
  })
  it('asks for files to be read when the right plates have no picture yet', () => {
    const r = matchShelfPhotos({
      ...base,
      imports: [imp('i1', 'j', 'pic-maui'), imp('i2', 'j', null)],
      items: ['i1', 'i2'].map((i) => ({ batch_id: 'b', assembly_id: null, import_id: i })),
    })
    expect(r).toEqual({ add: [{ productId: 'p', importId: 'i1', thumbnail: 'pic-maui' }], need: ['i2'] })
  })
  it('never reaches into another project', () => {
    expect(matchShelfPhotos({ ...base, imports: [imp('i2', 'other', 'pic-kauai')] }).add).toEqual([])
  })
})
