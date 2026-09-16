/**
 * When Guma is allowed to speak.
 *
 * Guidance is the easiest thing in an application to get wrong in a way
 * nobody catches, because a modal that fires at the wrong moment still
 * looks correct in a screenshot. These tests are the three rules that make
 * it help rather than nag: once ever, one at a time, and only when the
 * thing it explains is actually true of this shop right now.
 */
import { describe, expect, it } from 'vitest'
import { CHAPTERS, chapterById, nextChapter, type GuideState } from './guide'

const state = (over: Partial<GuideState> = {}): GuideState => ({
  screen: 'projects',
  clientJobs: 0,
  inHouseJobs: 0,
  quotesSent: 0,
  loggedHours: 0,
  machineCostComplete: true,
  ...over,
})

describe('shown once, ever', () => {
  it('does not offer a chapter that has been seen', () => {
    const s = state({ clientJobs: 3 })
    expect(nextChapter(s, [])?.id).toBe('in-house')
    expect(nextChapter(s, ['in-house'])).toBeNull()
  })

  it('stays silent when everything has been seen', () => {
    const all = CHAPTERS.map((c) => c.id)
    for (const screen of ['projects', 'settings', 'project'] as const) {
      expect(nextChapter(state({ screen, clientJobs: 9, quotesSent: 9 }), all)).toBeNull()
    }
  })
})

describe('one at a time', () => {
  it('returns a single chapter even when two qualify', () => {
    // A shop with sent quotes and no machine cost on file qualifies for
    // both 'in-house' and 'machine-cost'. Two modals in a row is how you
    // teach somebody to dismiss modals without reading them.
    const s = state({ clientJobs: 2, quotesSent: 2, machineCostComplete: false })
    const first = nextChapter(s, [])
    expect(first).not.toBeNull()
    expect(first!.id).toBe('in-house')

    // The other one is still waiting for the next visit, not queued behind.
    const second = nextChapter(s, ['in-house'])
    expect(second!.id).toBe('machine-cost')
  })
})

describe('only when it is true', () => {
  it('does not explain in-house work to a shop already doing it', () => {
    expect(nextChapter(state({ clientJobs: 4, inHouseJobs: 1 }), [])?.id).not.toBe('in-house')
  })

  it('does not explain anything to a shop with nothing on file', () => {
    // The moment somebody has never saved a project is the moment they
    // know least about what they need, and a tour fired here is the exact
    // failure this design exists to avoid.
    expect(nextChapter(state(), [])).toBeNull()
  })

  it('only mentions the missing machine cost once a quote has been sent', () => {
    const incomplete = { clientJobs: 1, machineCostComplete: false }
    // Before a quote exists the margin has not misled anybody yet.
    expect(nextChapter(state({ ...incomplete, inHouseJobs: 1 }), [])).toBeNull()
    expect(
      nextChapter(state({ ...incomplete, inHouseJobs: 1, quotesSent: 1 }), [])?.id,
    ).toBe('machine-cost')
  })

  it('keeps each chapter to its own screen', () => {
    const busy = state({ screen: 'settings', clientJobs: 5, quotesSent: 5 })
    // The in-house chapter belongs where the work is listed, not in settings.
    expect(nextChapter(busy, [])?.id).toBe('rates-versioned')
  })

  it('explains logging actuals on a project, once there is a quote to compare against', () => {
    const s = state({ screen: 'project', quotesSent: 1, loggedHours: 0 })
    expect(nextChapter(s, [])?.id).toBe('actuals')
    // Already logging: nothing to say.
    expect(nextChapter({ ...s, loggedHours: 12 }, [])).toBeNull()
  })
})

describe('short enough to be read', () => {
  it('keeps every chapter to three points and a readable body', () => {
    // Every previous version of guidance in this app had to be cut down
    // after somebody looked at it. This time the limit is in the suite.
    for (const c of CHAPTERS) {
      expect(c.points.length, `${c.id} has too many points`).toBeLessThanOrEqual(3)
      expect(c.lede.length, `${c.id} lede is a paragraph`).toBeLessThan(140)
      for (const p of c.points) {
        expect(p.length, `${c.id} point too long: ${p}`).toBeLessThan(120)
      }
      expect(c.title.length, `${c.id} title too long`).toBeLessThan(40)
    }
  })

  it('uses unique ids, since they are the key to what has been seen', () => {
    const ids = CHAPTERS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(chapterById(id)?.id).toBe(id)
    expect(chapterById('not-a-chapter')).toBeNull()
  })
})
