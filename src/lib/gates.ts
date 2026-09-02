import type { GateAnswer, JobPhase, ProjectFacts } from './data.types'

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
   * Returning null means "this fact isn't knowable yet" and the item falls
   * back to a manual tick; returning a boolean locks the checkbox.
   */
  auto?: (f: ProjectFacts) => boolean
  /** Caption for an auto item — where the answer came from. */
  autoFrom?: string
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
    },
    {
      key: 'poc',
      label: 'A named person to chase',
      why: 'Quotes stall on "waiting to hear back" from an inbox nobody owns.',
      auto: (f) => (f.poc ?? '').trim().length > 0,
      autoFrom: 'from the point of contact',
    },
    {
      key: 'needed_by',
      label: 'A date they need it by',
      why: 'Without one you cannot tell a rush from a routine job, and you will price it as routine.',
      auto: (f) => f.neededBy !== null,
      autoFrom: 'from the delivery window',
    },
    {
      key: 'origin',
      label: 'Who owns the model, and what state it is in',
      why: 'Print-ready, needs fixing, or built from nothing — this is most of the design hours.',
    },
    {
      key: 'quote',
      label: 'A quote has been priced',
      why: 'Design work before a price is agreed is work you may never bill.',
      auto: (f) => f.quoteStatus !== null,
      autoFrom: 'from the quote',
    },
  ],
  design: [
    {
      key: 'model',
      label: 'Model built, or the supplied file checked for printability',
      why: 'Finding a non-manifold mesh at the printer costs a slot as well as the fix.',
    },
    {
      key: 'hours',
      label: 'Design hours on the quote match the hours actually spent',
      why: 'The single most common place a small shop quietly loses its margin. Log your hours below and the project page shows you the gap rather than asking you to remember it.',
      needsNote: true,
    },
    {
      key: 'revisions',
      label: 'Revision allowance agreed in writing',
      why: 'Unbounded revisions are the other place the margin goes.',
    },
  ],
  approval: [
    {
      key: 'sent',
      label: 'Quote sent to the client',
      why: 'A quote sitting in draft is not a quote.',
      auto: (f) => f.quoteStatus === 'sent' || f.quoteStatus === 'accepted',
      autoFrom: 'from the quote status',
    },
    {
      key: 'accepted',
      label: 'They accepted it, in writing',
      why: 'A verbal yes is worth nothing when the invoice is disputed. Say where the yes lives.',
      needsNote: true,
      auto: (f) => f.quoteStatus === 'accepted',
      autoFrom: 'from the quote status',
    },
    {
      key: 'deposit',
      label: 'Deposit collected, or waived on purpose',
      why: 'The deposit is what makes a cancellation survivable. Waiving it is a decision, not an oversight.',
      auto: (f) => f.depositDue <= 0 || f.depositOwed <= 0,
      autoFrom: 'from payments received',
    },
  ],
  scheduled: [
    {
      key: 'printer',
      label: 'A machine picked, and free when this needs it',
      why: 'A booked slot that collides with another job is how a due date is missed a week early.',
    },
    {
      key: 'material',
      label: 'Enough material on hand for the whole run, plus failures',
      why: 'Running out at 80% costs you the 80% as well as the shipping wait.',
    },
    {
      key: 'slot',
      label: 'The slot clears the date you promised',
      why: 'Print time plus finishing plus a failure buffer — checked against the window, not guessed.',
      auto: (f) => f.neededBy !== null,
      autoFrom: 'needs a date to check against',
    },
  ],
  building: [
    {
      key: 'started',
      label: 'The run has actually started',
      why: 'A project sitting in In build with nothing on a machine is the most expensive kind of lie.',
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
    },
  ],
  review: [
    {
      key: 'qc',
      label: 'Every part checked against the brief',
      why: 'The client will do this. Better it is you, before it ships.',
    },
    {
      key: 'finishing',
      label: 'Finishing done, or explicitly not needed',
      why: 'Finishing hours quoted but never done means the price was wrong; done but never quoted, worse.',
    },
    {
      key: 'photos',
      label: 'Photographed for the record',
      why: 'The cheapest possible defence against "it arrived broken".',
    },
  ],
  delivered: [],
}

export interface ResolvedGateItem extends GateItem {
  checked: boolean
  note: string | null
  /** True when `auto` decided this, so the checkbox is read-only. */
  automatic: boolean
  /** Checked, starred, and still missing its note. */
  noteMissing: boolean
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

const PHASE_ORDER: JobPhase[] = [
  'intake',
  'design',
  'approval',
  'scheduled',
  'building',
  'review',
  'delivered',
]

export const PHASE_LABEL: Record<JobPhase, string> = {
  intake: 'Intake',
  design: 'Design',
  approval: 'Client approval',
  scheduled: 'Scheduled',
  building: 'In build',
  review: 'Review',
  delivered: 'Delivered',
}

export function nextPhase(phase: JobPhase): JobPhase | null {
  const i = PHASE_ORDER.indexOf(phase)
  return i >= 0 && i < PHASE_ORDER.length - 1 ? PHASE_ORDER[i + 1] : null
}

export function phaseIndex(phase: JobPhase): number {
  return PHASE_ORDER.indexOf(phase)
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
  const items: ResolvedGateItem[] = GATES[phase].map((item) => {
    const answer = answers[item.key]
    const automatic = typeof item.auto === 'function'
    const checked = automatic ? item.auto!(facts) : (answer?.checked ?? false)
    const note = answer?.note ?? null
    return {
      ...item,
      checked,
      note,
      automatic,
      noteMissing: !automatic && checked && item.needsNote === true && (note ?? '').trim().length === 0,
    }
  })

  const done = items.filter((i) => i.checked).length
  const total = items.length
  const outstanding = items.filter((i) => !i.checked)
  const missingNotes = items.filter((i) => i.noteMissing)
  const next = nextPhase(phase)

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
    reason = `${parts.join(', and ')}. Nothing advances to ${PHASE_LABEL[next]} until they do.`
  } else {
    reason = `All ${total} cleared. Ready for ${PHASE_LABEL[next]}.`
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

function daysBetween(from: string, to: Date): number {
  const a = Date.parse(from.length <= 10 ? `${from}T00:00:00Z` : from)
  if (Number.isNaN(a)) return 0
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  return Math.floor((b - a) / 86_400_000)
}

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
  const started = phaseIndex(f.phase) >= phaseIndex('design')

  if (!delivered && f.neededBy) {
    const late = daysBetween(f.neededBy, now)
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

  if (!delivered && f.depositDue > 0 && f.depositOwed > 0 && started) {
    out.push({
      key: 'deposit',
      tone: 'crit',
      label: 'Deposit unpaid',
      cause: `${money(f.depositOwed)} of a ${money(f.depositDue)} deposit is still outstanding, and the project has already left intake.`,
      action:
        'Stop work or collect the deposit. Every hour past this point is unsecured, and a cancellation now lands entirely on you.',
    })
  }

  if (delivered && f.balanceOwed > 0) {
    out.push({
      key: 'balance',
      tone: 'crit',
      label: 'Unpaid',
      cause: `Delivered with ${money(f.balanceOwed)} still owing.`,
      action: 'Invoice or chase it. Delivered-and-unpaid is the balance most likely to be written off.',
    })
  }

  if (!delivered && phaseIndex(f.phase) > phaseIndex('intake') && f.quoteStatus === null) {
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
    phaseIndex(f.phase) > phaseIndex('approval') &&
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
    const quiet = daysBetween(f.lastActivityAt, now)
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
  if (f.hasActuals && f.quoteTotal !== null && f.quoteTotal > 0) {
    const share = f.actualCost / f.quoteTotal
    if (share >= 1) {
      out.push({
        key: 'over-budget',
        tone: 'crit',
        label: 'Underwater',
        cause: `Has cost ${money(f.actualCost)} against a quote of ${money(f.quoteTotal)} — ${Math.round(share * 100)}% of what it earns.`,
        action: delivered
          ? 'Too late to fix this one. Open it and see which line ran over, so the next quote of this shape is right.'
          : 'Stop and look at what is left to do. Finishing it as planned means finishing it at a loss; a scope conversation now is cheaper than the write-off.',
      })
    } else if (share >= 0.8 && !delivered) {
      out.push({
        key: 'over-budget',
        tone: 'warn',
        label: 'Eating its margin',
        cause: `${Math.round(share * 100)}% of the quote already spent, with the project still in ${PHASE_LABEL[f.phase].toLowerCase()}.`,
        action:
          'Check what is left against what is gone. This is the last point where a reprint or an extra revision is still a decision rather than a loss.',
      })
    }
  }

  if (
    f.quoteTotal !== null &&
    f.minimumOrder > 0 &&
    f.quoteTotal < f.minimumOrder &&
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
