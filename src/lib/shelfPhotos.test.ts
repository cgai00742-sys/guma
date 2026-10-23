import { describe, expect, it } from 'vitest'
import { matchShelfPhotos, type PhotoImport } from './shelfPhotos'

const imp = (id: string, job: string, thumbnail: string | null, has_file = true): PhotoImport => ({ id, job_id: job, thumbnail, has_file })
const base = {
  products: [{ id: 'p', name: 'Kauai', photo: null as string | null, design_job_id: 'j' }],
  batches: [{ id: 'b', product_id: 'p', job_id: 'j' }],
  items: [] as { batch_id: string | null; assembly_id: string | null; import_id: string | null }[],
  assemblies: [] as { id: string; batch_id: string | null }[],
  imports: [imp('i1', 'j', 'pic-maui'), imp('i2', 'j', 'pic-kauai')],
  sections: [{ import_id: 'i1', label: 'Maui' }, { import_id: 'i2', label: 'Kauai' }],
}

describe('which plate picture a Shelf product gets', () => {
  it('takes the plate its pieces came off, before anything else', () => {
    const r = matchShelfPhotos({ ...base, items: [{ batch_id: 'b', assembly_id: null, import_id: 'i1' }] })
    expect(r.set).toEqual([{ productId: 'p', thumbnail: 'pic-maui' }])
  })
  it('follows a finished assembly to its pieces', () => {
    const r = matchShelfPhotos({
      ...base,
      assemblies: [{ id: 'a', batch_id: 'b' }],
      items: [{ batch_id: null, assembly_id: 'a', import_id: 'i2' }],
    })
    expect(r.set[0].thumbnail).toBe('pic-kauai')
  })
  it('matches by name in the same project when no pieces link it', () => {
    expect(matchShelfPhotos(base).set[0].thumbnail).toBe('pic-kauai')
  })
  it('uses the only plate of a one-plate project', () => {
    const r = matchShelfPhotos({ ...base, imports: [imp('i1', 'j', 'pic-maui')], sections: [] , products: [{ ...base.products[0], name: 'Something' }] })
    expect(r.set[0].thumbnail).toBe('pic-maui')
  })
  it('does not guess between several plates', () => {
    const r = matchShelfPhotos({ ...base, products: [{ ...base.products[0], name: 'Hawaii set' }] })
    expect(r.set).toEqual([])
  })
  it('asks for the file to be read when the right plate has no picture yet', () => {
    const r = matchShelfPhotos({ ...base, imports: [imp('i1', 'j', 'pic-maui'), imp('i2', 'j', null)] })
    expect(r).toEqual({ set: [], need: ['i2'] })
  })
  it('leaves a picture alone, and a removed one removed', () => {
    expect(matchShelfPhotos({ ...base, products: [{ ...base.products[0], photo: 'mine' }] }).set).toEqual([])
    expect(matchShelfPhotos({ ...base, products: [{ ...base.products[0], photo: '' }] }).set).toEqual([])
  })
  it('never reaches into another project', () => {
    const r = matchShelfPhotos({ ...base, imports: [imp('i2', 'other', 'pic-kauai')] })
    expect(r.set).toEqual([])
  })
})
