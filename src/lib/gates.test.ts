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
  gatesFor,
  ladderFor,
  nextPhase,
  phaseLabel,
  worstTone,
} from './gates'
import type { GateAnswer, JobPhase, ProjectFacts } from './data.types'

/**
 * Midday on 2 September 2026, in whatever timezone this runs in.
 *
 * Deliberately NOT `new Date('2026-09-02T12:00:00Z')`. That is one fixed
 * instant, and every shop reads it as a different calendar day: at +12:45 it
 * is already the 3rd, at -10 it is 2am on the 2nd. Flags are counted in
 * whole local days (see daysBetweenLocal), so a fixture pinned to a UTC
 * instant makes "due today" mean "one day overdue" for a third of the world
 * — and the test then passes or fails depending on where the machine is,
 * which is worse than either.
 *
 * A local construction says what these tests actually mean: it is lunchtime
 * on the 2nd at this shop, wherever that is.
 */
const NOW = new Date(2026, 8, 2, 12, 0, 0)

/** An instant that fell on the shop's OWN calendar day `n` days ago, at 9am
 *  local — far enough from either midnight that no DST shift moves it. */
function localDaysAgo(n: number, from: Date = NOW): string {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() - n, 9, 0, 0).toISOString()
}

function facts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    phase: 'design',
    kind: 'client',
    priority: 'medium',
    createdAt: '2026-08-01T00:00:00Z',
    takenInAt: '2026-08-01T00:00:00Z',
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
    actualCost: 0,
    hasActuals: false,
    actualRuns: 0,
    actualHours: 0,
    machineHours: 0,
    materialUnits: 0,
    failedUnits: 0,
    parts: 0,
    partsPrinted: 0,
    partsPassed: 0,
    partsReprint: 0,
    reprintsEver: 0,
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
    expect(
      flagsFor(facts({ lastActivityAt: localDaysAgo(STALLED_DAYS - 1) }), at).map((f) => f.key),
    ).not.toContain('stalled')
    expect(
      flagsFor(facts({ lastActivityAt: localDaysAgo(STALLED_DAYS) }), at).map((f) => f.key),
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

describe('the shop’s own work climbs a ladder of its own', () => {
  const inHouse = (over: Partial<ProjectFacts> = {}): ProjectFacts =>
    facts({ kind: 'inhouse', ...over })

  it('is never asked to get client approval for a trial print', () => {
    // Walking your own experiment past "Client approval" is theatre, and a
    // checklist that is theatre teaches people to tick without reading --
    // which costs the gates the only power they have.
    expect(ladderFor('inhouse')).toEqual(['design', 'review', 'delivered'])
    expect(ladderFor('inhouse')).not.toContain('approval')
    expect(ladderFor('inhouse')).not.toContain('scheduled')
  })

  it('calls the stages what they are', () => {
    expect(phaseLabel('design', 'inhouse')).toBe('Working')
    expect(phaseLabel('review', 'inhouse')).toBe('Made')
    expect(phaseLabel('delivered', 'inhouse')).toBe('Done')
    // The same stored values still read correctly for client work.
    expect(phaseLabel('design', 'client')).toBe('Design')
    expect(phaseLabel('review', 'client')).toBe('Review')
  })

  it('steps Working to Made, not Working to Client approval', () => {
    expect(nextPhase('design', 'inhouse')).toBe('review')
    expect(nextPhase('review', 'inhouse')).toBe('delivered')
    expect(nextPhase('delivered', 'inhouse')).toBeNull()
    // Client work is untouched.
    expect(nextPhase('design', 'client')).toBe('approval')
  })

  it('asks two questions, both about money that otherwise disappears', () => {
    // Every extra item here is a reason not to log the next ten-minute
    // experiment, and those experiments are where the month goes.
    expect(gatesFor('design', 'inhouse')).toHaveLength(1)
    expect(gatesFor('review', 'inhouse')).toHaveLength(1)
    expect(gatesFor('delivered', 'inhouse')).toHaveLength(0)
  })

  it('clears the first gate off the runs and hours, with no ticking', () => {
    const blank = gateStatus('design', {}, inHouse({ hasActuals: false }))
    expect(blank.items[0].checked).toBe(false)
    expect(blank.items[0].automatic).toBe(true)
    expect(blank.blocked).toBe(true)

    const logged = gateStatus('design', {}, inHouse({ hasActuals: true }))
    expect(logged.items[0].checked).toBe(true)
    expect(logged.blocked).toBe(false)
    expect(logged.next).toBe('review')
  })

  it('picks the checklist off the job rather than off the caller', () => {
    // gateStatus reads kind from the facts, so no screen can ask for a
    // client gate on an in-house job by passing the wrong argument.
    const client = gateStatus('design', {}, facts())
    const mine = gateStatus('design', {}, inHouse())
    expect(client.items.length).toBeGreaterThan(mine.items.length)
    expect(mine.items.map((i) => i.key)).toEqual(['spend'])
  })

  it('ends at Done with nothing left to tick', () => {
    const done = gateStatus('delivered', {}, inHouse({ hasActuals: true }))
    expect(done.total).toBe(0)
    expect(done.next).toBeNull()
  })
})

describe('flags that belong to a client, on work that has none', () => {
  const mine = (over: Partial<ProjectFacts> = {}) =>
    facts({ kind: 'inhouse', phase: 'design', ...over })

  it('does not tell you a trial print has no quote', () => {
    /**
     * This fired on EVERY in-house job, permanently. An in-house job starts
     * at design, design is past intake, and the rule was "past intake with
     * no quote". So the board carried a red "No quote" on work that will
     * never have one and could never clear it -- which is how a shop learns
     * to ignore the flags that do matter.
     */
    const flags = flagsFor(mine(), NOW).map((f) => f.key)
    expect(flags).not.toContain('unquoted')

    // Still fires where it means something.
    const client = flagsFor(facts({ phase: 'design', quoteStatus: null }), NOW).map((f) => f.key)
    expect(client).toContain('unquoted')
  })

  it('never says unpaid, deposit unpaid or not agreed', () => {
    const flags = flagsFor(
      mine({ phase: 'delivered', balanceOwed: 500, depositDue: 200, depositOwed: 200 }),
      NOW,
    ).map((f) => f.key)
    expect(flags).not.toContain('balance')
    expect(flags).not.toContain('deposit')
    expect(flags).not.toContain('unagreed')
  })

  it('still tells you when your own work has gone quiet', () => {
    // This one earns its place on in-house work: a trial abandoned halfway
    // is money spent with no conclusion drawn from it.
    const flags = flagsFor(mine({ lastActivityAt: localDaysAgo(STALLED_DAYS + 1) }), NOW).map(
      (f) => f.key,
    )
    expect(flags).toContain('stalled')
  })
})
