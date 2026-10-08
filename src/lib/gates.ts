import { daysBetweenLocal } from './dates'
import type { GateAnswer, JobKind, JobPhase, ProjectFacts } from './data.types'

// The client-kind vocabulary, GateAnswer and ProjectFacts all live in
// data.types.ts rather than here. data.types.ts imports nothing, so putting
// the shared shapes there is what keeps this module free of a cycle: gates
// imports data.types, never the reverse. Re-exported so a screen that wants
// both the vocabulary and the logic has one import to write.
export {
  CLIENT_KINDS,
  CLIENT_KIND_LABEL,
  asClientKind,
  type ClientKind,
  type GateAnswer,
  type ProjectFacts,
} from './data.types'

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export interface GateItem {
  key: string
  label: string
  /** Shown under the item. Says why a shop bothers, not what to click. */
  why: string
  /** Checking this requires a note — a bare tick would be meaningless. */
  needsNote?: boolean
  /**
   * Satisfied by a fact the app already holds rather than by a human tick.
   * Returning a boolean locks the checkbox; returning NULL means the app
   * cannot know, and the item falls back to a manual tick.
   *
   * That fallback is load-bearing for anything optional. The QC item below
   * reads the build sheet — but a shop that never adds parts would then
   * have an item it could never clear, so with no parts on file the answer
   * is null and a person ticks it, exactly as before the build sheet
   * existed. A feature nobody opted into must never become a blocker.
   */
  auto?: (f: ProjectFacts) => boolean | null
  /** Caption for an auto item — where the answer came from. */
  autoFrom?: string
  /**
   * What to DO when an automatic item is not satisfied.
   *
   * Added after a real run through the app got permanently stuck: the
   * intake gate reads the brief, an empty brief could not be edited
   * anywhere, and the item could not be ticked by hand either — so the
   * project could never leave intake. Saying where a fact comes from is
   * not enough; an item that cannot be ticked has to say where to go and
   * change it, and that place has to exist.
   */
  fix?: string
}

/**
 * The checklists. Seven phases, three to five items each, every one of
 * them something a shop that loses money is failing to do.
 *
 * 'delivered' has no gate: it is the end of the line, there is nothing to
 * advance to. Its items would be busywork.
 */
export const GATES: Record<JobPhase, GateItem[]> = {
  intake: [
    {
      key: 'brief',
      label: 'What they actually want is written down',
      why: 'A brief you can re-read in three weeks is the difference between one revision and four.',
      auto: (f) => (f.brief ?? '').trim().length >= 20,
      autoFrom: 'from the project brief',
      fix: 'Write two lines in the brief at the top of this page.',
    },
    {
      key: 'poc',
      label: 'A named person to chase',
      why: 'Quotes stall on "waiting to hear back" from an inbox nobody owns.',
      auto: (f) => (f.poc ?? '').trim().length > 0,
      autoFrom: 'from the point of contact',
      fix: 'Add a point of contact in What they want, above.',
    },
    {
      key: 'needed_by',
      label: 'A date they need it by',
      why: 'Without one you cannot tell a rush from a routine job, and you will price it as routine.',
      auto: (f) => f.neededBy !== null,
      autoFrom: 'from the delivery window',
      fix: 'Set a needed-by date in What they want, above.',
    },
    {
      key: 'quote',
      label: 'A quote has been priced',
      why: 'Design work before a price is agreed is work you may never bill.',
      auto: (f) => f.quoteStatus !== null,
      autoFrom: 'from the quote',
      fix: 'Price it from New project — this one has no quote at all.',
    },
  ],
  approval: [
    {
      key: 'sent',
      label: 'Quote sent to the client',
      why: 'A quote sitting in draft is not a quote.',
      auto: (f) => f.quoteStatus === 'sent' || f.quoteStatus === 'accepted',
      autoFrom: 'from the quote status',
      fix: 'Mark the quote sent under Quote and deposit, above.',
    },
    {
      key: 'accepted',
      label: 'They accepted it, in writing',
      why: 'A verbal yes is worth nothing when the invoice is disputed. Say where the yes lives.',
      needsNote: true,
      auto: (f) => f.quoteStatus === 'accepted',
      autoFrom: 'from the quote status',
      fix: 'Mark the quote accepted under Quote and deposit, above, once they have said yes in writing.',
    },
    {
      key: 'deposit',
      label: 'Deposit collected, or waived on purpose',
      why: 'The deposit is what makes a cancellation survivable. Waiving it is a decision, not an oversight.',
      auto: (f) => f.depositDue <= 0 || f.depositOwed <= 0,
      autoFrom: 'from payments received',
      fix: 'Record the deposit above, or set the deposit to zero in Shop settings if you are waiving it.',
    },
    {
      key: 'window',
      label: 'Delivery date committed with the client',
      why: 'Every later stage is measured against this. Until it is committed it is a wish, not a promise.',
      auto: (f) => f.windowLocked,
      autoFrom: 'from the delivery window',
      fix: 'Commit the date under Delivery window, above.',
    },
  ],
  design: [
    {
      key: 'model',
      label: 'Model built, or the supplied file checked for printability',
      why: 'Finding a non-manifold mesh at the printer costs a slot as well as the fix.',
    },
    {
      key: 'signoff',
      label: 'The client signed off the design',
      why: 'Printing a design nobody approved is printing it twice. Say where the yes lives.',
      needsNote: true,
    },
  ],
  scheduled: [
    {
      key: 'printer',
      label: 'A machine picked, and free when this needs it',
      why: 'A booked slot that collides with another job is how a due date is missed a week early.',
      auto: (f) => f.printerId !== null,
      autoFrom: 'from Machine and material',
      fix: 'Pick the machine under Machine and material, above.',
    },
    {
      key: 'material',
      label: 'Enough material on hand for the whole run, plus failures',
      why: 'Running out at 80% costs you the 80% as well as the shipping wait.',
      // Read off the build sheet against stock on hand, on the project
      // page. Null (a plain tick) where that check cannot be made.
      auto: (f) => f.schedule?.materialOk ?? null,
      autoFrom: 'from Machine and material',
      fix: 'Set the material aside under Machine and material, above. If a spool is short, add stock there first, or skip with a reason.',
    },
    {
      key: 'slot',
      label: 'The slot clears the date you promised',
      why: 'Print time plus finishing plus a failure buffer — checked against the window, not guessed.',
      // Ticked only when the start-by date is actually still ahead -- a
      // date merely existing used to tick it (CG's screenshot, 8 Oct).
      auto: (f) => (f.neededBy === null ? false : (f.schedule?.slotOk ?? null)),
      autoFrom: 'from the start-by date',
      fix: 'The start-by date has passed or there is no date: move the delivery date with the client, or skip with a reason.',
    },
  ],
  building: [
    {
      key: 'started',
      label: 'The run has actually started',
      why: 'A project sitting in In build with nothing on a machine is the most expensive kind of lie.',
      auto: (f) => (f.parts === 0 ? null : f.partsPrinted > 0),
      autoFrom: 'from the build sheet',
      fix: 'Mark a part printed on the build sheet.',
    },
    {
      key: 'failures',
      label: 'Failures reprinted or written off',
      why: 'Write-offs are real cost. Recording them is how next quarter is priced better than this one.',
      needsNote: true,
    },
    {
      key: 'spend',
      label: 'What the build actually used is recorded',
      why: 'Estimated grams against spent grams is the only honest read on whether the quote was right — and this is the last moment anyone remembers the numbers.',
      auto: (f) => f.actualRuns > 0,
      autoFrom: 'from the build runs',
      fix: 'Record a build run under What it actually took.',
    },
  ],
  review: [
    {
      key: 'qc',
      label: 'Every part checked against the brief',
      why: 'The client will do this. Better it is you, before it ships — and a part that failed twice for the same reason is a design problem, not bad luck.',
      // Reads the build sheet when there is one, and steps out of the way
      // when there is not.
      auto: (f) => (f.parts === 0 ? null : f.partsPassed === f.parts),
      autoFrom: 'from the build sheet',
      fix: 'Pass every part on the build sheet, or send the failures back.',
    },
    {
      key: 'finishing',
      label: 'Finishing done, or explicitly not needed',
      why: 'Finishing hours quoted but never done means the price was wrong; done but never quoted, worse.',
    },
    {
      // Moved from Design (CG, 8 Oct: no hour logging before anything is
      // built). Checked here, where every hour -- design and finishing --
      // is logged against the job, before the invoice goes out.
      key: 'hours',
      label: 'Hours on the quote match the hours actually spent',
      why: 'The single most common place a small shop quietly loses its margin. Log your hours under What it actually took and this page shows you the gap.',
      needsNote: true,
    },
    {
      key: 'photos',
      label: 'Photographed for the record',
      why: 'The cheapest possible defense against "it arrived broken".',
    },
    {
      key: 'handover',
      label: 'When and how it is being handed over',
      why: 'The date every later argument is measured from — a warranty claim, a late payment, a repeat order.',
      auto: (f) => !!f.deliveryOn && !!f.deliveryHow,
      autoFrom: 'from Handover',
      fix: 'Set the date and how under Handover, above.',
    },
  ],
  delivered: [],
}

/**
 * The shop's own work, checked against the two things that actually go
 * wrong with it.
 *
 * Short on purpose. In-house work is the ten-minute experiment that, forty
 * times over, is where the month went -- and every item added here is a
 * reason not to log the next one. Two items, both about money that
 * otherwise disappears without trace.
 */
const IN_HOUSE_GATES: Partial<Record<JobPhase, GateItem[]>> = {
  design: [
    {
      key: 'spend',
      label: 'What it took is logged',
      why: 'Filament, machine hours and your own time are the whole cost of this. Unlogged, the job reads as free and the month reads as a mystery.',
      auto: (f) => f.hasActuals,
      autoFrom: 'from the runs and hours',
      fix: 'Record a run or some hours under What it actually took.',
    },
  ],
  review: [
    {
      key: 'made',
      label: 'What came out of it is recorded — units on the shelf, or nothing',
      why: 'A trial that made nothing still cost you, and a trial that made forty keychains turned that cost into stock. Both are answers. Leaving it blank is how the money just vanishes.',
      // Units on the shelf answer this item by existing. Returning null
      // rather than false when there are none is the difference between
      // "not yet" and "no": a trial that produced nothing sellable is a
      // real answer, and it stays a tick the person makes by hand.
      auto: (f) => (f.unitsMade > 0 ? true : null),
      autoFrom: 'from the batch on the shelf',
      fix: 'Put the units on the shelf under What this made, or tick this to say it produced nothing sellable.',
    },
  ],
  delivered: [],
}

/** The checklist for one stage of whichever ladder this job is climbing. */
export function gatesFor(phase: JobPhase, kind: JobKind = 'client'): GateItem[] {
  if (kind === 'inhouse') return IN_HOUSE_GATES[phase] ?? []
  return GATES[phase] ?? []
}

export interface ResolvedGateItem extends GateItem {
  checked: boolean
  note: string | null
  /** True when `auto` decided this, so the checkbox is read-only. */
  automatic: boolean
  /** Checked, starred, and still missing its note. */
  noteMissing: boolean
  /** Not done, but skipped on purpose with this reason. Counts as cleared
   *  for advancing; the record keeps the difference. */
  skipped: string | null
}

export interface GateStatus {
  items: ResolvedGateItem[]
  done: number
  total: number
  /** Cannot advance out of this phase yet. */
  blocked: boolean
  /** One sentence saying exactly what is standing in the way. */
  reason: string
  /** The phase advancing would move to, or null at the end of the line. */
  next: JobPhase | null
}

/**
 * TWO LADDERS, ONE COLUMN.
 *
 * Client work moves through seven stages ending in a handover. The shop's
 * own work does not: there is nobody to approve it, nothing to schedule
 * against a promise, and nobody to hand it to. Walking a trial print past
 * "Client approval" is theatre, and a checklist that is theatre teaches
 * people to tick boxes without reading them -- which costs the gates their
 * only real power.
 *
 * So in-house work climbs three stages of its own: Working, Made, Done.
 *
 * WHY THEY REUSE THE SAME STORED VALUES rather than getting three of their
 * own. jobs.phase carries a CHECK constraint in SQLite, and SQLite cannot
 * alter a constraint in place -- changing it means rebuilding the jobs
 * table, which nine tables cascade off. That is the single riskiest
 * migration this project could ship, and it would buy three strings. So
 * in-house work borrows design/review/delivered, which already mean
 * "being worked on", "look at what came out" and "end of the line", and
 * the LABEL is what differs. One stored fact, two vocabularies, no
 * migration, and a phase always means the same position in whichever
 * ladder its job is climbing.
 */
/**
 * Approval comes BEFORE design (CG, 7 Oct 2026): the quote is accepted and
 * the deposit is in before any design hours are spent. The old order put
 * Design first, straight after a gate item that warned "design work before
 * a price is agreed is work you may never bill".
 */
const CLIENT_LADDER: JobPhase[] = [
  'intake',
  'approval',
  'design',
  'scheduled',
  'building',
  'review',
  'delivered',
]

/** Working on it, it made something, it is finished. */
const IN_HOUSE_LADDER: JobPhase[] = ['design', 'review', 'delivered']

export function ladderFor(kind: JobKind = 'client'): JobPhase[] {
  return kind === 'inhouse' ? IN_HOUSE_LADDER : CLIENT_LADDER
}

const CLIENT_LABEL: Record<JobPhase, string> = {
  intake: 'Intake',
  design: 'Design',
  approval: 'Client approval',
  scheduled: 'Scheduled',
  building: 'In build',
  review: 'Review',
  delivered: 'Delivered',
}

const IN_HOUSE_LABEL: Partial<Record<JobPhase, string>> = {
  design: 'Working',
  review: 'Made',
  delivered: 'Done',
}

/**
 * What to call a stage, to the person whose job it is.
 *
 * Kept as a function rather than a second lookup table so a caller has to
 * say which kind of work it is showing -- the old PHASE_LABEL record could
 * be read without that thought, and every place that did would call an
 * in-house trial print "Client approval".
 */
export function phaseLabel(phase: JobPhase, kind: JobKind = 'client'): string {
  if (kind === 'inhouse') return IN_HOUSE_LABEL[phase] ?? CLIENT_LABEL[phase]
  return CLIENT_LABEL[phase]
}

/**
 * The old record, still exported because a dozen call sites show client
 * work and are correct as they stand.
 *
 * @deprecated Prefer phaseLabel(phase, kind) anywhere a job's kind is in
 * scope. This one cannot know, so it answers for client work.
 */
export const PHASE_LABEL: Record<JobPhase, string> = CLIENT_LABEL

export function nextPhase(phase: JobPhase, kind: JobKind = 'client'): JobPhase | null {
  const ladder = ladderFor(kind)
  const i = ladder.indexOf(phase)
  return i >= 0 && i < ladder.length - 1 ? ladder[i + 1] : null
}

export function phaseIndex(phase: JobPhase, kind: JobKind = 'client'): number {
  return ladderFor(kind).indexOf(phase)
}

/**
 * Resolve one phase's checklist against what has been ticked and what the
 * app already knows. `answers` is keyed by item key.
 */
export function gateStatus(
  phase: JobPhase,
  answers: Record<string, GateAnswer>,
  facts: ProjectFacts,
): GateStatus {
  // The job's own kind decides which checklist applies and what comes
  // next. Reading it off the facts rather than taking it as an argument
  // means no caller can accidentally ask for a client gate on a trial
  // print, which is the failure this whole split exists to prevent.
  const kind = facts.kind
  const items: ResolvedGateItem[] = gatesFor(phase, kind).map((item) => {
    const answer = answers[item.key]
    // An auto item that returns null is not automatic today — the app has
    // no way to know, so the human answer stands.
    const derived = typeof item.auto === 'function' ? item.auto(facts) : null
    const automatic = derived !== null
    const done = automatic ? derived : (answer?.checked ?? false)
    const note = answer?.note ?? null
    const skipped = !done && answer?.skipped ? answer.skipped : null
    return {
      ...item,
      checked: done || skipped !== null,
      note,
      automatic,
      skipped,
      noteMissing:
        !automatic && done && item.needsNote === true && (note ?? '').trim().length === 0,
    }
  })

  const done = items.filter((i) => i.checked).length
  const total = items.length
  const outstanding = items.filter((i) => !i.checked)
  const missingNotes = items.filter((i) => i.noteMissing)
  const next = nextPhase(phase, kind)

  let blocked = false
  let reason: string

  if (next === null) {
    reason = 'Delivered — this is the end of the line.'
  } else if (missingNotes.length > 0) {
    blocked = true
    reason =
      missingNotes.length === 1
        ? `“${missingNotes[0].label}” is ticked but still needs a note.`
        : `${missingNotes.length} ticked items still need a note.`
  } else if (outstanding.length > 0) {
    blocked = true
    const auto = outstanding.filter((i) => i.automatic)
    const manual = outstanding.filter((i) => !i.automatic)
    const parts: string[] = []
    if (manual.length > 0) {
      parts.push(`${manual.length} item${manual.length > 1 ? 's' : ''} left to tick`)
    }
    if (auto.length > 0) {
      parts.push(
        `${auto.length} that clear${auto.length > 1 ? '' : 's'} on their own once the work is done`,
      )
    }
    reason = `${parts.join(', and ')}. Nothing advances to ${phaseLabel(next, kind)} until they are done or skipped with a reason.`
  } else {
    reason = `All ${total} cleared. Ready for ${phaseLabel(next, kind)}.`
  }

  return { items, done, total, blocked, reason, next }
}

/* ------------------------------------------------------------------ */
/* Flags                                                               */
/* ------------------------------------------------------------------ */

export type FlagKey =
  | 'overdue'
  | 'stalled'
  | 'window'
  | 'unquoted'
  | 'unagreed'
  | 'deposit'
  | 'balance'
  | 'under-minimum'
  | 'over-budget'
  | 'over-ceiling'

export interface Flag {
  key: FlagKey
  /** crit = costing money now, warn = will cost money, info = worth knowing. */
  tone: 'crit' | 'warn' | 'info'
  /** Two or three words, for a card chip. */
  label: string
  /** What is true, with the real numbers in it. */
  cause: string
  /** What the shop should do next. Imperative, specific. */
  action: string
}

/** No activity for this long and a project is drifting, not progressing. */
export const STALLED_DAYS = 14



function money(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Everything wrong with one project, worst first. Recomputed on every
 * render — nothing here is stored, so a flag disappears the moment the
 * thing that caused it is fixed.
 */
export function flagsFor(f: ProjectFacts, now: Date = new Date()): Flag[] {
  const out: Flag[] = []
  const delivered = f.phase === 'delivered'
  /**
   * Work nobody is paying for cannot be unpaid, unquoted, unagreed or
   * late against a promise. Half the flags below are about a client, and
   * on an in-house job they are not merely quiet -- `unquoted` fired on
   * EVERY one of them, permanently, because an in-house job starts at
   * design and design is past intake. A board covered in a warning that
   * can never be acted on is how a shop learns to ignore warnings.
   */
  const mine = f.kind === 'inhouse'
  const at = (p: JobPhase) => phaseIndex(p, f.kind)
  const started = at(f.phase) >= at('design')

  if (!delivered && f.neededBy) {
    const late = daysBetweenLocal(f.neededBy, now)
    if (late > 0) {
      out.push({
        key: 'overdue',
        tone: 'crit',
        label: 'Overdue',
        cause: `Due ${f.neededBy} — ${late} day${late === 1 ? '' : 's'} past.`,
        action:
          'Move it on if it is actually done. If it is not, tell the client today and set a date you can hit — a silent slip costs more than a late one.',
      })
    }
  }

  if (!mine && !delivered && f.depositDue > 0 && f.depositOwed > 0 && started && f.wentAheadWithout.deposit) {
    // Decided, not forgotten. Still on the board -- the money is still
    // owed -- but as a choice someone made and gave a reason for.
    out.push({
      key: 'deposit',
      tone: 'warn',
      label: 'No deposit — by decision',
      cause: `${money(f.depositOwed)} deposit outstanding. Went ahead anyway: ${f.wentAheadWithout.deposit}`,
      action: 'Collect it when you can, or record it as waived. The reason above is what you agreed to carry.',
    })
  } else if (!mine && !delivered && f.depositDue > 0 && f.depositOwed > 0 && started) {
    out.push({
      key: 'deposit',
      tone: 'crit',
      label: 'Deposit unpaid',
      cause: `${money(f.depositOwed)} of a ${money(f.depositDue)} deposit is still outstanding, and the project has already left intake.`,
      action:
        'Stop work or collect the deposit. Every hour past this point is unsecured, and a cancellation now lands entirely on you.',
    })
  }

  if (!mine && delivered && f.balanceOwed > 0) {
    out.push({
      key: 'balance',
      tone: 'crit',
      label: 'Unpaid',
      cause: `Delivered with ${money(f.balanceOwed)} still owing.`,
      action: 'Invoice or chase it. Delivered-and-unpaid is the balance most likely to be written off.',
    })
  }

  if (!mine && !delivered && at(f.phase) > at('intake') && f.quoteStatus === null) {
    out.push({
      key: 'unquoted',
      tone: 'crit',
      label: 'No quote',
      cause: 'Past intake with no priced quote at all.',
      action: 'Price it before another hour goes into it. Work without a number attached is work you cannot bill for.',
    })
  }

  // A priced quote is not an agreed one. This is the quieter, more common
  // version of the same failure: the shop typed a number, never sent it,
  // and started building anyway. It is only a problem once the project is
  // past the stage whose entire job is getting a yes.
  if (
    !delivered &&
    at(f.phase) > at('approval') &&
    f.quoteStatus !== null &&
    f.quoteStatus !== 'accepted' &&
    f.wentAheadWithout.accepted
  ) {
    out.push({
      key: 'unagreed',
      tone: 'warn',
      label: 'Not accepted — by decision',
      cause: `Went ahead without acceptance: ${f.wentAheadWithout.accepted}`,
      action: 'Get the yes in writing when you can and mark the quote accepted. Until then the price and scope rest on the reason above.',
    })
  } else if (
    !delivered &&
    at(f.phase) > at('approval') &&
    f.quoteStatus !== null &&
    f.quoteStatus !== 'accepted'
  ) {
    const wording: Record<string, string> = {
      draft: 'still a draft — it was never sent',
      sent: 'sent, but never accepted',
      declined: 'declined by the client',
      expired: 'expired',
    }
    out.push({
      key: 'unagreed',
      tone: 'crit',
      label: 'Not agreed',
      cause: `Past client approval with a quote that is ${wording[f.quoteStatus] ?? f.quoteStatus}.`,
      action:
        'Get it in writing before you build any more of it. An unaccepted quote is a price you cannot enforce and a scope you cannot defend.',
    })
  }

  if (!delivered && f.lastActivityAt) {
    const quiet = daysBetweenLocal(f.lastActivityAt, now)
    if (quiet >= STALLED_DAYS) {
      out.push({
        key: 'stalled',
        tone: 'warn',
        label: 'Stalled',
        cause: `No activity in ${quiet} days.`,
        action:
          'Post an update saying where this actually stands — even "waiting on the client" is information the next person needs.',
      })
    }
  }

  if (!mine && f.overCeiling) {
    out.push({
      key: 'over-ceiling',
      tone: 'warn',
      label: 'Above agreed price',
      cause: f.overCeiling,
      action:
        'Make sure the client has seen and agreed the new price in writing, then clear this flag on the project page.',
    })
  }

  if (!delivered && f.atRisk) {
    out.push({
      key: 'window',
      tone: 'warn',
      label: 'Window at risk',
      cause: f.windowLocked
        ? 'Marked at risk against a window that has already been promised to the client.'
        : 'Marked at risk — the promised window may not hold.',
      action: f.windowLocked
        ? 'The date is committed, so this is a conversation, not a reschedule. Call them before they call you.'
        : 'Renegotiate the window now, while it is still an option rather than an apology.',
    })
  }

  // The bluntest question in the tool: is this job costing more than it
  // earns? It needs no quote breakdown and no forecasting — just what has
  // actually been spent against what the client agreed to pay. The 80%
  // warning exists because a shop can still act at 80%; at 100% the only
  // thing left is to learn from it.
  // Against what the shop EARNS: tax is collected for someone else, and
  // counting it as revenue let a job $10 underwater read as 92% spent.
  const earns = f.quotePreTax ?? f.quoteTotal
  if (f.hasActuals && earns !== null && earns > 0) {
    const share = f.actualCost / earns
    if (share >= 1) {
      out.push({
        key: 'over-budget',
        tone: 'crit',
        label: 'Underwater',
        cause: `Has cost ${money(f.actualCost)} against ${money(earns)} it earns before tax — ${Math.round(share * 100)}%.`,
        action: delivered
          ? 'Too late to fix this one. Open it and see which line ran over, so the next quote of this shape is right.'
          : 'Stop and look at what is left to do. Finishing it as planned means finishing it at a loss; a scope conversation now is cheaper than the write-off.',
      })
    } else if (share >= 0.8 && !delivered) {
      out.push({
        key: 'over-budget',
        tone: 'warn',
        label: 'Eating its margin',
        cause: `${Math.round(share * 100)}% of the quote already spent, with the project still in ${phaseLabel(f.phase, f.kind).toLowerCase()}.`,
        action:
          'Check what is left against what is gone. This is the last point where a reprint or an extra revision is still a decision rather than a loss.',
      })
    }
  }

  if (
    f.quoteTotal !== null &&
    f.minimumOrder > 0 &&
    // The minimum applies before discount and tax, so a job priced AT the
    // minimum and then discounted is not under it.
    (f.quoteListPrice ?? f.quoteTotal) < f.minimumOrder - 0.005 &&
    f.quoteStatus !== 'declined'
  ) {
    out.push({
      key: 'under-minimum',
      tone: 'info',
      label: 'Under minimum',
      cause: `Quoted at ${money(f.quoteTotal)}, below the shop minimum of ${money(f.minimumOrder)}.`,
      action:
        'Either it should have been priced at the minimum, or the minimum is wrong. Both are worth five minutes in Shop settings.',
    })
  }

  return out
}

/** Worst tone present, for a single-colour summary on a card or a row. */
export function worstTone(flags: Flag[]): 'crit' | 'warn' | 'info' | null {
  if (flags.some((f) => f.tone === 'crit')) return 'crit'
  if (flags.some((f) => f.tone === 'warn')) return 'warn'
  if (flags.some((f) => f.tone === 'info')) return 'info'
  return null
}
