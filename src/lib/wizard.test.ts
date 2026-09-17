/**
 * The script Guma reads from.
 *
 * These tests are mostly about restraint rather than correctness. The whole
 * point of the wizard is that it is short and that it asks nothing it
 * cannot act on, and both of those are properties that decay quietly: a
 * question gets added, then another, and six months later the thing that
 * was meant to take five minutes is the reason nobody finishes setup.
 * So the limits are assertions rather than intentions.
 */
import { describe, expect, it } from 'vitest'
import {
  QUESTIONS,
  firstUnanswered,
  partOne,
  partOneDone,
  questionsFor,
  type Answers,
} from './wizard'

/** Every answer part one needs, so tests can take one away at a time. */
const answeredPartOne = (over: Answers = {}): Answers => ({
  name: 'Bay Street',
  address: 'Hilo, HI',
  state: 'HI',
  kwh: '0.4299',
  pName: 'Bay 1',
  pTech: 'fdm',
  pPrice: '1200',
  pLife: '6000',
  mName: 'PLA',
  mPerKg: '28',
  designHourly: '45',
  ...over,
})

describe('part one is short, and is the whole thing for most people', () => {
  it('is seven questions', () => {
    // If this fails somebody added a question. That is allowed, but it
    // should be a decision rather than a drift -- part one is the bit
    // standing between a new shop and its first logged job.
    expect(partOne()).toHaveLength(7)
  })

  it('asks nothing optional, because all of it is load-bearing', () => {
    // Every part-one answer feeds a cost calculation. There is nothing in
    // here to skip; if something can be skipped it belongs in part two.
    for (const q of partOne()) {
      expect(q.optional, `${q.id} is optional and in part one`).toBeFalsy()
    }
  })

  it('never puts two unrelated decisions on one screen', () => {
    for (const q of QUESTIONS) {
      expect(q.fields.length, `${q.id} has too many fields`).toBeLessThanOrEqual(2)
      expect(q.fields.length, `${q.id} has no fields`).toBeGreaterThan(0)
    }
  })

  it('knows when part one is finished', () => {
    expect(partOneDone(answeredPartOne())).toBe(true)
    expect(partOneDone(answeredPartOne({ mPerKg: '' }))).toBe(false)
    expect(partOneDone({})).toBe(false)
  })
})

describe('part two branches, rather than greying things out', () => {
  it('never asks a market seller about deposits, minimums or markup', () => {
    const ids = questionsFor(answeredPartOne({ branch: 'selling' })).map((q) => q.id)
    expect(ids).not.toContain('deposit')
    expect(ids).not.toContain('minimum')
    expect(ids).not.toContain('markup')
    expect(ids).toContain('channels')
  })

  it("never asks a job shop where it sells", () => {
    const ids = questionsFor(answeredPartOne({ branch: 'clients' })).map((q) => q.id)
    expect(ids).not.toContain('channels')
    expect(ids).toContain('deposit')
  })

  it('asks both sets of somebody who does both', () => {
    const ids = questionsFor(answeredPartOne({ branch: 'both' })).map((q) => q.id)
    expect(ids).toContain('channels')
    expect(ids).toContain('deposit')
  })

  it('holds the branch questions back until the branch is known', () => {
    // Before the fork is answered, neither side exists -- otherwise the
    // first thing a new shop sees after part one is every question at once,
    // which is the thing the fork is for.
    const ids = questionsFor(answeredPartOne()).map((q) => q.id)
    expect(ids).not.toContain('deposit')
    expect(ids).not.toContain('channels')
    expect(ids).toContain('branch')
  })

  it('asks everyone about wattage, finishing and tax', () => {
    for (const branch of ['clients', 'selling', 'both']) {
      const ids = questionsFor(answeredPartOne({ branch })).map((q) => q.id)
      expect(ids, `${branch} lost a universal question`).toEqual(
        expect.arrayContaining(['watts', 'finishing', 'tax']),
      )
    }
  })
})

describe('resuming', () => {
  it('returns to the first thing that is genuinely missing', () => {
    expect(firstUnanswered({})?.id).toBe('name')
    expect(firstUnanswered(answeredPartOne({ kwh: '' }))?.id).toBe('power')
    // A half-answered two-field question still counts as unanswered.
    expect(firstUnanswered(answeredPartOne({ pLife: '' }))?.id).toBe('wear')
  })

  it('does not stop on a question that is allowed to be blank', () => {
    // Part two is mostly optional, so a shop that answered part one and
    // picked a branch is not dragged back for a blank tax rate.
    const a = answeredPartOne({ branch: 'clients' })
    expect(firstUnanswered(a)?.id).toBeUndefined()
  })

  it('has nothing left to ask once part one and the branch are in', () => {
    expect(firstUnanswered(answeredPartOne({ branch: 'both' }))).toBeNull()
  })
})

describe('the words themselves', () => {
  it('asks questions rather than labelling fields', () => {
    // The difference between a guide and a form. Every one of these should
    // read as something a person would say out loud.
    for (const q of QUESTIONS) {
      expect(q.ask.endsWith('?'), `${q.id} is not phrased as a question: ${q.ask}`).toBe(true)
      expect(q.why.length, `${q.id} has no reason attached`).toBeGreaterThan(20)
      expect(q.why.length, `${q.id} reason is a paragraph`).toBeLessThan(180)
    }
  })

  it('uses unique ids and keys, since both are how answers are stored', () => {
    const ids = QUESTIONS.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    const keys = QUESTIONS.flatMap((q) => q.fields.map((f) => f.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
