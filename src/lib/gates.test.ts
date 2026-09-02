/**
 * Gates and flags. Everything here is pure, so these tests need no
 * database, no clock and no React — which is the whole reason the logic
 * was put in its own module rather than inside the project screen.
 *
 * `now` is pinned on every call. A flag test that reads the real clock
 * passes today and fails in a fortnight.
 */
import { describe, expect, it } from 'vitest'
import {
  GATES,
  STALLED_DAYS,
  flagsFor,
  gateStatus,
  nextPhase,
  worstTone,
} from './gates'
import type { GateAnswer, JobPhase, ProjectFacts } from './data.types'

const NOW = new Date('2026-09-02T12:00:00Z')

function facts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    phase: 'design',
    priority: 'medium',
    createdAt: '2026-08-01T00:00:00Z',
    neededBy: null,
    windowFrom: null,
    windowLocked: false,
    atRisk: false,
    deliveryOn: null,
    deliveryHow: null,
    brief: null,
    poc: null,
    quoteStatus: null,
    quoteTotal: null,
    depositDue: 0,
    depositOwed: 0,
    balanceOwed: 0,
    lastActivityAt: '2026-09-01T00:00:00Z',
    minimumOrder: 0,
    ...over,
  }
}

const ticked = (...keys: string[]): Record<string, GateAnswer> =>
  Object.fromEntries(keys.map((k) => [k, { checked: true, note: 'done' } as GateAnswer]))

describe('gate definitions', () => {
  it('covers every phase, and only delivered is empty', () => {
    const phases: JobPhase[] = [
      'intake',
      'design',
      'approval',
      'scheduled',
      'building',
      'review',
      'delivered',
    ]
    for (const p of phases) expect(GATES[p]).toBeDefined()
    expect(GATES.delivered).toHaveLength(0)
    for (const p of phases.filter((p) => p !== 'delivered')) {
      expect(GATES[p].length).toBeGreaterThan(0)
    }
  })

  it('has unique item keys within each phase', () => {
    for (const items of Object.values(GATES)) {
      const keys = items.map((i) => i.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('gives every item a reason a shop owner would recognise', () => {
    for (const items of Object.values(GATES)) {
      for (const i of items) expect(i.why.length).toBeGreaterThan(20)
    }
  })
})

describe('gateStatus', () => {
  it('auto items read the facts and cannot be ticked by hand', () => {
    const g = gateStatus('approval', {}, facts({ quoteStatus: 'sent' }))
    const sent = g.items.find((i) => i.key === 'sent')!
    expect(sent.automatic).toBe(true)
    expect(sent.checked).toBe(true)

    const accepted = g.items.find((i) => i.key === 'accepted')!
    expect(accepted.automatic).toBe(true)
    expect(accepted.checked).toBe(false)
  })

  it('an auto item ignores a stored tick that contradicts the facts', () => {
    // Someone ticked "quote sent" by hand before the auto rule existed.
    // The quote is still a draft, so the gate must still say no.
    const g = gateStatus('approval', ticked('sent'), facts({ quoteStatus: 'draft' }))
    expect(g.items.find((i) => i.key === 'sent')!.checked).toBe(false)
    expect(g.blocked).toBe(true)
  })

  it('blocks while manual items are outstanding, and names the next phase', () => {
    const g = gateStatus('design', {}, facts())
    expect(g.blocked).toBe(true)
    expect(g.done).toBe(0)
    expect(g.total).toBe(GATES.design.length)
    expect(g.next).toBe('approval')
    expect(g.reason).toContain('Client approval')
  })

  it('clears once every item is answered', () => {
    const answers = ticked(...GATES.design.map((i) => i.key))
    const g = gateStatus('design', answers, facts())
    expect(g.blocked).toBe(false)
    expect(g.done).toBe(g.total)
    expect(g.reason).toContain('Ready for')
  })

  it('a starred item ticked without a note blocks, and says so', () => {
    const answers: Record<string, GateAnswer> = {
      ...ticked(...GATES.design.map((i) => i.key)),
      hours: { checked: true, note: '   ' },
    }
    const g = gateStatus('design', answers, facts())
    expect(g.items.find((i) => i.key === 'hours')!.noteMissing).toBe(true)
    expect(g.blocked).toBe(true)
    expect(g.reason).toContain('note')
  })

  it('delivered has no gate and nothing to advance to', () => {
    const g = gateStatus('delivered', {}, facts({ phase: 'delivered' }))
    expect(g.total).toBe(0)
    expect(g.next).toBeNull()
    expect(g.blocked).toBe(false)
  })

  it('nextPhase walks the seven stages and stops', () => {
    expect(nextPhase('intake')).toBe('design')
    expect(nextPhase('review')).toBe('delivered')
    expect(nextPhase('delivered')).toBeNull()
  })
})

describe('flagsFor', () => {
  it('a clean project raises nothing', () => {
    expect(flagsFor(facts({ quoteStatus: 'accepted', quoteTotal: 500 }), NOW)).toEqual([])
  })

  it('overdue counts the actual days and says what to do', () => {
    const [f] = flagsFor(facts({ neededBy: '2026-08-28' }), NOW)
    expect(f.key).toBe('overdue')
    expect(f.tone).toBe('crit')
    expect(f.cause).toContain('5 days')
    expect(f.action.length).toBeGreaterThan(20)
  })

  it('a due date today is not yet overdue', () => {
    expect(flagsFor(facts({ neededBy: '2026-09-02' }), NOW).map((f) => f.key)).not.toContain('overdue')
  })

  it('a delivered project is never overdue, however late it was', () => {
    const keys = flagsFor(facts({ phase: 'delivered', neededBy: '2026-01-01' }), NOW).map((f) => f.key)
    expect(keys).not.toContain('overdue')
  })

  it('stalls exactly at the threshold, not before', () => {
    const at = new Date(NOW)
    const dayBefore = new Date(Date.UTC(2026, 8, 2 - (STALLED_DAYS - 1)))
    const dayOf = new Date(Date.UTC(2026, 8, 2 - STALLED_DAYS))
    expect(
      flagsFor(facts({ lastActivityAt: dayBefore.toISOString() }), at).map((f) => f.key),
    ).not.toContain('stalled')
    expect(
      flagsFor(facts({ lastActivityAt: dayOf.toISOString() }), at).map((f) => f.key),
    ).toContain('stalled')
  })

  it('an unpaid deposit only flags once work has actually started', () => {
    const owing = { depositDue: 200, depositOwed: 200 }
    expect(flagsFor(facts({ phase: 'intake', ...owing }), NOW).map((f) => f.key)).not.toContain('deposit')
    expect(flagsFor(facts({ phase: 'building', ...owing }), NOW).map((f) => f.key)).toContain('deposit')
  })

  it('an unpaid balance flags only once it has been delivered', () => {
    expect(flagsFor(facts({ phase: 'review', balanceOwed: 900 }), NOW).map((f) => f.key)).not.toContain(
      'balance',
    )
    const [f] = flagsFor(facts({ phase: 'delivered', balanceOwed: 900 }), NOW)
    expect(f.key).toBe('balance')
    expect(f.cause).toContain('900')
  })

  it('work past intake with no quote is the loudest kind of flag', () => {
    const keys = flagsFor(facts({ phase: 'building', quoteStatus: null }), NOW).map((f) => f.key)
    expect(keys).toContain('unquoted')
    // ...and intake itself is not yet a problem: that is what intake is for.
    expect(flagsFor(facts({ phase: 'intake' }), NOW).map((f) => f.key)).not.toContain('unquoted')
  })

  it('a priced quote that was never agreed is its own, quieter failure', () => {
    // Priced but never sent, and already on a machine.
    const building = flagsFor(facts({ phase: 'building', quoteStatus: 'draft' }), NOW)
    const f = building.find((x) => x.key === 'unagreed')!
    expect(f.tone).toBe('crit')
    expect(f.cause).toContain('never sent')
    // Not yet a problem at the stage whose whole job is getting the yes.
    expect(
      flagsFor(facts({ phase: 'approval', quoteStatus: 'draft' }), NOW).map((x) => x.key),
    ).not.toContain('unagreed')
    // An accepted quote is the point of the whole exercise.
    expect(
      flagsFor(facts({ phase: 'building', quoteStatus: 'accepted' }), NOW).map((x) => x.key),
    ).not.toContain('unagreed')
  })

  it('a quote under the shop minimum is worth knowing, not panicking about', () => {
    const [f] = flagsFor(facts({ quoteTotal: 40, minimumOrder: 150, quoteStatus: 'sent' }), NOW)
    expect(f.key).toBe('under-minimum')
    expect(f.tone).toBe('info')
    expect(f.cause).toContain('150')
  })

  it('a committed window at risk reads differently from a loose one', () => {
    const loose = flagsFor(facts({ atRisk: true }), NOW).find((f) => f.key === 'window')!
    const committed = flagsFor(facts({ atRisk: true, windowLocked: true }), NOW).find(
      (f) => f.key === 'window',
    )!
    expect(loose.action).not.toBe(committed.action)
    expect(committed.cause).toContain('promised')
  })

  it('worstTone picks the loudest thing on the card', () => {
    const many = flagsFor(
      facts({ phase: 'building', neededBy: '2026-01-01', atRisk: true }),
      NOW,
    )
    expect(worstTone(many)).toBe('crit')
    // A quoted, accepted project whose only problem is a wobbly window.
    expect(
      worstTone(flagsFor(facts({ atRisk: true, quoteStatus: 'accepted', quoteTotal: 500 }), NOW)),
    ).toBe('warn')
    expect(worstTone([])).toBeNull()
  })
})
