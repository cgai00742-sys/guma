// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultOpen, readFolds, writeFolds } from './folds'

beforeEach(() => localStorage.clear())

describe('remembering which sections are open', () => {
  it('starts with nothing remembered', () => {
    expect(readFolds('live')).toEqual({})
  })

  it('remembers per scope, so a finished project does not fold a live one', () => {
    writeFolds('done', { build: false })
    expect(readFolds('done')).toEqual({ build: false })
    expect(readFolds('live')).toEqual({})
  })

  it('keeps the other scope when one is written', () => {
    writeFolds('live', { gate: false })
    writeFolds('done', { build: false })
    expect(readFolds('live')).toEqual({ gate: false })
  })

  it('survives junk in storage rather than taking the screen down', () => {
    localStorage.setItem('guma.folds', 'not json')
    expect(readFolds('live')).toEqual({})
  })

  it('survives storage that throws, which is a real state in a private window', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readFolds('live')).toEqual({})
    expect(() => writeFolds('live', { gate: false })).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })
})

describe('what is open before anybody says', () => {
  it('opens everything on a live project', () => {
    for (const id of ['brief', 'gate', 'money', 'build', 'actuals', 'activity']) {
      expect(defaultOpen('live', id)).toBe(true)
    }
  })

  it('opens only the money on a finished one — the rest is a record', () => {
    expect(defaultOpen('done', 'money')).toBe(true)
    expect(defaultOpen('done', 'build')).toBe(false)
    expect(defaultOpen('done', 'gate')).toBe(false)
    expect(defaultOpen('done', 'activity')).toBe(false)
  })

  it('shows a section nobody has classified rather than hiding it', () => {
    expect(defaultOpen('done', 'something-new')).toBe(true)
  })
})
