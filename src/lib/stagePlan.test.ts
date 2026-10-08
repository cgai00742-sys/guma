import { describe, expect, it } from 'vitest'
import { canImport, canPrint, recordFor, stagesBehind, workFor } from './stagePlan'

describe('each stage shows only what moves it forward', () => {
  it('starts small and ends with the whole project to review', () => {
    expect(workFor('intake', 'client')).toEqual(['brief', 'money'])
    expect(workFor('approval', 'client')).toEqual(['money', 'window'])
    expect(workFor('delivered', 'client')).toEqual(['closeout', 'money'])
  })

  it('files earlier work under the stage it belongs to, never twice', () => {
    // At Design the brief, quote and window are history.
    expect(stagesBehind('design', 'client')).toEqual(['intake', 'approval'])
    expect(recordFor('intake', 'design', 'client')).toEqual(['brief'])
    expect(recordFor('approval', 'design', 'client')).toEqual(['money', 'window'])
    // At Review the money is work again, so it is not also in the record.
    expect(recordFor('approval', 'review', 'client')).toEqual(['window'])
  })

  it('never offers printing before In build (CG, 7 Oct)', () => {
    for (const p of ['intake', 'approval', 'design', 'scheduled'] as const) {
      expect(canPrint(p, 'client')).toBe(false)
    }
    expect(canPrint('building', 'client')).toBe(true)
    expect(canPrint('delivered', 'client')).toBe(false)
    // Sliced files can still be read in to price and plan.
    expect(canImport('intake', 'client')).toBe(true)
    expect(canImport('review', 'client')).toBe(false)
  })

  it('gives the shop\'s own work its three stages', () => {
    expect(workFor('design', 'inhouse')).toEqual(['brief', 'build', 'took'])
    expect(canPrint('design', 'inhouse')).toBe(true)
    expect(recordFor('design', 'review', 'inhouse')).toEqual(['brief'])
  })
})
