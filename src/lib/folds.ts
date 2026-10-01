/**
 * Which sections of a long screen are open, remembered.
 *
 * Voltage's upgrade #3, and the same complaint here: "the Review/In-Build
 * dialogs are long... make each section collapsible and remember
 * open/closed state per user, so the dialog opens showing what you
 * actually work on." CG, on a finished project: "what would help is if
 * things that have been previously completed are a dropdown window that we
 * can click if we want to see more info about it."
 *
 * TWO SCOPES, NOT ONE. A finished project and a live one want different
 * things open -- on a live project the gate and the build sheet are the
 * work, and on a finished one they are history behind a summary. Keeping
 * one remembered state for both would mean collapsing the build sheet on a
 * delivered project and finding it collapsed on the one you are building
 * tomorrow. So the scope is part of the key.
 *
 * localStorage can throw (private windows, cleared site data), and a
 * section that cannot remember its state must still open and close. Every
 * read and write is guarded and failure is silent by design.
 */
const KEY = 'guma.folds'

export type FoldScope = 'live' | 'done'

type Saved = Record<string, Record<string, boolean>>

function readAll(): Saved {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Saved) : {}
  } catch {
    return {}
  }
}

export function readFolds(scope: FoldScope): Record<string, boolean> {
  const all = readAll()
  const one = all[scope]
  return one && typeof one === 'object' ? one : {}
}

export function writeFolds(scope: FoldScope, state: Record<string, boolean>): void {
  try {
    const all = readAll()
    all[scope] = state
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // A preference that cannot be saved is not a reason to fail a click.
  }
}

/**
 * What a section should do when nobody has said otherwise.
 *
 * On a live project, everything the person works on is open. On a
 * finished one, only the summary is -- the rest is a record, one click
 * away. Sections not named here default to open, so a new section is
 * visible rather than accidentally hidden.
 */
const DONE_DEFAULTS: Record<string, boolean> = {
  brief: false,
  gate: false,
  money: true,
  people: false,
  handover: false,
  build: false,
  // What it took is the point of a finished project -- CG opened Maui
  // expecting the file's hours and grams and found this folded shut.
  actuals: true,
  activity: false,
}

export function defaultOpen(scope: FoldScope, id: string): boolean {
  if (scope === 'live') return true
  return DONE_DEFAULTS[id] ?? true
}
