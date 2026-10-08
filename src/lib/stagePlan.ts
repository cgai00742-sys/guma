/**
 * What a project page shows at each stage -- and nothing else.
 *
 * CG, 7 Oct 2026: "each phase builds upon the last, so the beginning phases
 * only have the minimum questions and inputs, while the last stage is a
 * review of the entire project ... Less is more. Only have what is
 * necessary for the phase to be moved forward, and a dropdown the user can
 * open to refresh their memory of what the project has done so far."
 *
 * So each stage has WORK -- the sections its gate reads, open and editable
 * -- and everything earlier lives, read-only, in "The project so far",
 * filed under the stage it belongs to. Pure, so the rule is tested once
 * and the page only renders what this says.
 */
import type { JobKind, JobPhase } from './data.types'
import { ladderFor, phaseIndex } from './gates'

export type Section =
  | 'brief' // title, what they asked for, contact, needed-by
  | 'money' // the quote and its payments
  | 'window' // the delivery date, committed with the client
  | 'build' // the build sheet and its sliced files
  | 'estimate' // estimated build: what the build sheet will cost, before anything is printed
  | 'took' // what it actually took: hours, and print runs where printing is allowed
  | 'handover' // when and how it changed hands
  | 'made' // in-house: what it produced
  | 'closeout' // the finished summary

/** How much of the money section a stage needs. */
export type MoneyMode = 'price' | 'approve' | 'payments'

const CLIENT_WORK: Record<JobPhase, Section[]> = {
  intake: ['brief', 'money'],
  approval: ['money', 'window'],
  // Nothing is printed and no time is booked against a client job until
  // In build (CG, 8 Oct): before then the cost is an estimate, and the
  // page says so rather than showing an empty "actual" column.
  design: ['build', 'estimate'],
  scheduled: ['build', 'estimate'],
  building: ['build', 'took'],
  review: ['build', 'took', 'handover', 'money'],
  delivered: ['closeout', 'money'],
}

const IN_HOUSE_WORK: Partial<Record<JobPhase, Section[]>> = {
  design: ['brief', 'build', 'took'],
  review: ['build', 'made', 'took'],
  delivered: ['closeout'],
}

/** The stage a section belongs to in the record: where it is first worked on. */
const CLIENT_HOME: Record<Section, JobPhase> = {
  brief: 'intake',
  money: 'approval',
  window: 'approval',
  build: 'design',
  estimate: 'design',
  took: 'building',
  handover: 'review',
  made: 'review',
  closeout: 'delivered',
}

const IN_HOUSE_HOME: Partial<Record<Section, JobPhase>> = {
  brief: 'design',
  build: 'design',
  took: 'design',
  made: 'review',
}

export function workFor(phase: JobPhase, kind: JobKind): Section[] {
  return (kind === 'inhouse' ? IN_HOUSE_WORK[phase] : CLIENT_WORK[phase]) ?? []
}

/**
 * The sections filed under one earlier stage in "The project so far":
 * those that belong to that stage and are not part of today's work.
 */
export function recordFor(stage: JobPhase, current: JobPhase, kind: JobKind): Section[] {
  const home = kind === 'inhouse' ? IN_HOUSE_HOME : CLIENT_HOME
  const work = new Set(workFor(current, kind))
  return (Object.keys(home) as Section[]).filter((s) => home[s] === stage && !work.has(s))
}

/** Earlier stages on this job's own ladder, oldest first. */
export function stagesBehind(current: JobPhase, kind: JobKind): JobPhase[] {
  return ladderFor(kind).slice(0, Math.max(0, phaseIndex(current, kind)))
}

export function moneyMode(phase: JobPhase): MoneyMode {
  if (phase === 'intake') return 'price'
  if (phase === 'approval') return 'approve'
  return 'payments'
}

/**
 * Printing -- recording a print, "already printed" at import, marking a
 * part printed or failed -- belongs to the stages that run the machines
 * (CG: "having the option to state the project was printed at the intake
 * phase should not be available"). Review keeps it for reprints only.
 */
export function canPrint(phase: JobPhase, kind: JobKind): boolean {
  return kind === 'inhouse' ? phase === 'design' || phase === 'review' : phase === 'building' || phase === 'review'
}

/** Sliced files can be read in as estimates while a job is still being
 *  priced, designed or planned, and while it is being built (fixed files). */
export function canImport(phase: JobPhase, kind: JobKind): boolean {
  if (kind === 'inhouse') return phase === 'design' || phase === 'review'
  return phase !== 'review' && phase !== 'delivered'
}

/** Which kind of hours this stage logs by default. */
export function hoursKind(phase: JobPhase, kind: JobKind): 'design' | 'finishing' {
  if (kind === 'inhouse') return phase === 'design' ? 'design' : 'finishing'
  return phase === 'design' ? 'design' : 'finishing'
}
