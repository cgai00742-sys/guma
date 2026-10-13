/**
 * What a build sheet lets you do, and what it has to tell you, at each
 * stage of a project.
 *
 * Both rules come straight from how Voltage ran: a part's options are
 * stage-aware, and a reprint carries its reason.
 *
 * STAGE-AWARE OPTIONS. Offering every status at every stage looks
 * flexible and is actually noise: "Pass QC" on a part nobody has printed
 * yet is not a shortcut, it is a way to mark a project delivered that was
 * never made. Voltage narrowed the options per stage and the build sheet
 * became readable. Same here.
 *
 * A REPRINT CARRIES ITS REASON. setPartStatus already refuses a reprint
 * without a note -- but the note then lived only inside the part's history
 * drawer, one click away, which is the same as not existing while you are
 * standing at the machine deciding what to do differently. The reason
 * belongs on the row, in front of whoever prints it next. Nothing is
 * stored twice for this: it is read back out of the part's own history.
 */
import type { JobKind, JobPhase, PartRow, PartStatus, PartVariant, PrintRunRow } from './data.types'

/**
 * The statuses a part may be moved to at this stage, in the order they
 * should be offered.
 *
 * Before building, a part is a plan: it has no status to change. While
 * building it comes off the machine or goes back on. In review it passes
 * QC or goes back. Once delivered the sheet is history and nothing moves.
 *
 * THE KIND MATTERS, and forgetting it broke the shop's own work. In-house
 * jobs climb a three-stage ladder -- Working, Made, Done -- stored as
 * design/review/delivered, and they never pass through 'building' at all.
 * Reading the phase alone therefore offered NOTHING on a trial print: the
 * parts could be imported and never marked printed, so the build sheet
 * could not be finished on the work most likely to be sliced and
 * re-sliced. Found by walking the whole ladder (inHouseWalkthrough.test).
 *
 * For in-house work 'design' IS the machine stage and 'review' is where
 * the thing gets looked at, so they map onto the same two answers.
 */
export function allowedStatuses(phase: JobPhase, kind: JobKind = 'client'): PartStatus[] {
  if (kind === 'inhouse') {
    switch (phase) {
      case 'design':
        return ['printed', 'reprint']
      case 'review':
        return ['passed', 'reprint']
      default:
        return []
    }
  }
  switch (phase) {
    case 'building':
      return ['printed', 'reprint']
    case 'review':
      return ['passed', 'reprint']
    default:
      return []
  }
}

/**
 * What a part can be moved to next, from where IT is -- at any stage.
 *
 * CG printed and checked plates while the project still sat at Intake, and
 * the stage-based rule above offered nothing there: the plate was recorded
 * and every part on it still read "Not printed", with no way to pass or
 * fail them. A part's next step follows from the part, not the project:
 *
 *   not printed -> printed, or failed (the print failed)
 *   printed     -> passed, or failed (failed QC)
 *   failed      -> printed (the reprint came off)
 *   passed      -> failed (found wrong later)
 */
export function nextStatuses(status: PartStatus): PartStatus[] {
  switch (status) {
    case 'pending':
      return ['printed', 'reprint']
    case 'printed':
      return ['passed', 'reprint']
    case 'reprint':
      return ['printed']
    case 'passed':
      return ['reprint']
  }
}

/** A part that a successful print of its file turns into "printed": one
 *  not printed yet, or one waiting on its reprint. */
export function awaitingPrint(status: PartStatus): boolean {
  return status === 'pending' || status === 'reprint'
}

/** Where a part goes back TO when it fails QC: the stage that runs the
 *  machines on this job's own ladder. */
export function buildingPhase(kind: JobKind = 'client'): JobPhase {
  return kind === 'inhouse' ? 'design' : 'building'
}

/** Why this part is going back, if it is. Null in every other case --
 *  including a part that has since been reprinted and passed, because the
 *  point of the line is to tell the person at the machine what to do now. */
export function reprintReason(part: PartRow): string | null {
  if (part.status !== 'reprint') return null
  // history arrives newest first from both backends. The newest reprint
  // event is the live one; older ones stay in the drawer where the pattern
  // ("same reason three times") is the interesting thing.
  const ev = part.history.find((h) => h.kind === 'status' && h.toStatus === 'reprint')
  return ev?.note?.trim() || null
}

/** How many times this part has been sent back, ever. Two is bad luck;
 *  four is a design problem, and the number is the only way to see that
 *  without reading the whole drawer. */
export function reprintCount(part: PartRow): number {
  return part.history.filter((h) => h.kind === 'status' && h.toStatus === 'reprint').length
}

/** A project in review with a part sent back is not in review any more --
 *  someone has to print it again. Voltage offered the move rather than
 *  making it, and that is the right call: the shop may have three other
 *  parts still being checked. */
export function shouldReturnToBuilding(phase: JobPhase, parts: PartRow[]): boolean {
  return phase === 'review' && parts.some((p) => p.status === 'reprint')
}

/**
 * Which variant this part is being printed from, and whether anybody
 * actually said so.
 *
 * Voltage's decision, kept: until someone picks, use the FASTEST variant
 * and label it as an assumption. Fastest rather than first-imported
 * because the first file imported is an accident of order, while fastest
 * is at least a defensible default -- and because the screen says it is a
 * default, nobody mistakes it for a decision.
 */
export function chosenVariant(part: PartRow): { variant: PartVariant | null; picked: boolean } {
  if (!part.variants.length) return { variant: null, picked: false }
  const picked = part.variants.find((v) => v.sectionId === part.chosenSectionId)
  if (picked) return { variant: picked, picked: true }
  const timed = part.variants.filter((v) => v.estMinutes != null)
  if (!timed.length) return { variant: part.variants[0], picked: false }
  const fastest = timed.reduce((a, b) => ((b.estMinutes ?? 0) < (a.estMinutes ?? 0) ? b : a))
  return { variant: fastest, picked: false }
}

/**
 * The spread in print time between this part's variants, as a percentage
 * of the fastest. Null when there is nothing to compare.
 *
 * Worth showing because it is the number that justifies the feature: on
 * Voltage's own files the same part ran 20% longer on one machine than
 * another while weighing the same. A shop that averages them, or quotes
 * from whichever file was imported first, is wrong by that much on every
 * schedule -- and cannot see it.
 */
export function timeSpreadPct(part: PartRow): number | null {
  const mins = part.variants.map((v) => v.estMinutes).filter((m): m is number => m != null && m > 0)
  if (mins.length < 2) return null
  const lo = Math.min(...mins)
  const hi = Math.max(...mins)
  return Math.round(((hi - lo) / lo) * 100)
}

/** True when this part came off a plate holding other objects, so its
 *  print cannot be started or costed on its own. */
export function isOnSharedPlate(v: PartVariant | null): boolean {
  return !!v && v.plateParts > 1
}

/** What failure has cost a project so far -- Voltage's reprint tally, plus
 *  the material and machine time a failed plate burned. Null when nothing
 *  has failed, so the screen can say nothing. */
export interface FailureTally {
  sentBack: number
  partsAffected: number
  failedRuns: number
  unitsLost: number
  hoursLost: number
  /** The reason given most often, when one has come up more than once. */
  repeatReason: string | null
}

export function failureTally(parts: PartRow[], runs: PrintRunRow[]): FailureTally | null {
  const sentBack = parts.reduce((a, p) => a + reprintCount(p), 0)
  const partsAffected = parts.filter((p) => reprintCount(p) > 0).length
  // A plate stopped part way burned its filament and its hours just the same
  // (CG, 13 Oct: a ghost print cancelled at 15 hours).
  const failed = runs.filter((r) => r.outcome === 'failed' || r.outcome === 'cancelled')
  if (sentBack === 0 && failed.length === 0) return null
  const counts = new Map<string, number>()
  const reasons = [
    ...parts.flatMap((p) =>
      p.history.filter((h) => h.kind === 'status' && h.toStatus === 'reprint').map((h) => h.note),
    ),
    ...failed.map((r) => r.failureReason),
  ]
  for (const raw of reasons) {
    const key = (raw ?? '').split(' · Fix:')[0].trim().toLowerCase()
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let repeatReason: string | null = null
  let best = 1
  for (const [k, n] of counts) if (n > best) ((best = n), (repeatReason = k))
  return {
    sentBack,
    partsAffected,
    failedRuns: failed.length,
    unitsLost: Math.round(failed.reduce((a, r) => a + (r.unitsUsed ?? 0), 0)),
    hoursLost: Math.round(failed.reduce((a, r) => a + (r.hours ?? 0), 0) * 100) / 100,
    repeatReason,
  }
}

/** Voltage asked two things of every reprint: why it failed, and what to do
 *  so the next attempt works. Both live in the one note the history keeps. */
export function reprintNote(why: string, fix: string, fixedFile: string | null): string {
  let note = why.trim()
  if (fix.trim()) note += ` · Fix: ${fix.trim()}`
  if (fixedFile) note += ` · Fixed file: ${fixedFile}`
  return note
}
