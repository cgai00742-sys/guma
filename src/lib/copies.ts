/**
 * Where each copy of a part has got to (0031_part_copies.sql).
 *
 * CG, 8 Oct 2026: "if a part has 5 to print but we only printed 1 as a test
 * plate then we should be able to mark that per part." Voltage split every
 * copy into its own row; the copies of one part are identical, so Guma
 * counts them instead. Every copy is in exactly one place, and a move takes
 * copies from where they can come from:
 *
 *   printed  <- going back first (the reprint came off), then not printed
 *   passed   <- printed (only something off the machine can pass)
 *   reprint  <- printed, then passed (found wrong later), then not printed
 *               (the print failed on the bed)
 *
 * Pure: both backends move copies with exactly these rules, and the screen
 * uses `movable` to offer only counts that will be accepted.
 */
import type { PartStatus } from './data.types'

export interface Copies {
  pending: number
  printed: number
  passed: number
  reprint: number
}

export function copiesOf(p: { qty: number; printedN: number; passedN: number; reprintN: number }): Copies {
  const printed = Math.max(0, p.printedN)
  const passed = Math.max(0, p.passedN)
  const reprint = Math.max(0, p.reprintN)
  return { pending: Math.max(0, p.qty - printed - passed - reprint), printed, passed, reprint }
}

/** The one-word status the rest of the app reads. Anything going back wins:
 *  it is the row someone has to act on. */
export function statusOf(c: Copies): PartStatus {
  const total = c.pending + c.printed + c.passed + c.reprint
  if (c.reprint > 0) return 'reprint'
  if (total > 0 && c.passed === total) return 'passed'
  if (c.pending === 0 && total > 0) return 'printed'
  return 'pending'
}

const FROM: Record<Exclude<PartStatus, 'pending'>, (keyof Copies)[]> = {
  printed: ['reprint', 'pending'],
  passed: ['printed'],
  reprint: ['printed', 'passed', 'pending'],
}

/** How many copies can be moved to `to` right now. */
export function movable(c: Copies, to: PartStatus): number {
  if (to === 'pending') return 0
  return FROM[to].reduce((a, k) => a + c[k], 0)
}

/** Move n copies to `to`. Throws rather than clamps: a count the screen
 *  offered and the data refused is a bug worth seeing. */
export function moveCopies(c: Copies, to: PartStatus, n: number): Copies {
  const count = Math.floor(n)
  if (to === 'pending') throw new Error('Copies go back to not printed by failing them, not by moving them.')
  if (!Number.isFinite(count) || count < 1) throw new Error('Move at least one copy.')
  const can = movable(c, to)
  if (count > can) {
    throw new Error(can === 0 ? 'There are no copies that can move there.' : `Only ${can} cop${can === 1 ? 'y' : 'ies'} can move there.`)
  }
  const next = { ...c }
  let left = count
  for (const k of FROM[to]) {
    const take = Math.min(left, next[k])
    next[k] -= take
    left -= take
  }
  next[to] += count
  return next
}

/** "1 of 5 printed · 1 going back", for a row and for Activity. */
export function describeCopies(c: Copies): string {
  const total = c.pending + c.printed + c.passed + c.reprint
  const off = c.printed + c.passed
  const bits: string[] = []
  if (c.passed === total && total > 0) return `all ${total} passed`
  bits.push(`${off} of ${total} printed`)
  if (c.passed > 0) bits.push(`${c.passed} passed`)
  if (c.reprint > 0) bits.push(`${c.reprint} going back`)
  return bits.join(' · ')
}

/* ------------------------------------------------------------------ */
/* Per copy (0032_copy_states.sql)                                     */
/* ------------------------------------------------------------------ */

const STATES: PartStatus[] = ['pending', 'printed', 'passed', 'reprint']

/**
 * Each copy's state, in order -- copy 1 is states[0]. A part whose copies
 * were never split out (stored null, or written before a qty change) is
 * read from its counts: passed first, then printed, going back, not
 * printed, so the boxes on the row and the list under it agree.
 */
export function statesOf(p: {
  qty: number
  printedN: number
  passedN: number
  reprintN: number
  copyStates?: unknown
}): PartStatus[] {
  const raw = p.copyStates
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      arr = null
    }
  }
  if (Array.isArray(arr) && arr.length === p.qty && arr.every((s) => STATES.includes(s as PartStatus))) {
    return arr as PartStatus[]
  }
  const c = copiesOf(p)
  return [
    ...Array<PartStatus>(c.passed).fill('passed'),
    ...Array<PartStatus>(c.printed).fill('printed'),
    ...Array<PartStatus>(c.reprint).fill('reprint'),
    ...Array<PartStatus>(c.pending).fill('pending'),
  ].slice(0, Math.max(0, p.qty))
}

export function countsOf(states: PartStatus[]): Copies {
  const c: Copies = { pending: 0, printed: 0, passed: 0, reprint: 0 }
  for (const s of states) c[s]++
  return c
}

/**
 * Move n copies, the bulk way ("2 came off"): from the same sources as
 * moveCopies, lowest-numbered copy first within each source. Returns the
 * 0-based copies that moved, so the event can name them.
 */
export function moveStates(states: PartStatus[], to: PartStatus, n: number): { states: PartStatus[]; moved: number[] } {
  moveCopies(countsOf(states), to, n) // same checks, same messages
  const next = [...states]
  const moved: number[] = []
  let left = Math.floor(n)
  for (const from of FROM[to as Exclude<PartStatus, 'pending'>]) {
    for (let i = 0; i < next.length && left > 0; i++) {
      if (next[i] === from) {
        next[i] = to
        moved.push(i)
        left--
      }
    }
  }
  return { states: next, moved: moved.sort((a, b) => a - b) }
}

/**
 * Set named copies to a state -- any state, including back to not printed.
 * This is the correction path (CG: "a part that was accidentally marked
 * failed or printed back to neutral"), so it does not police the order
 * a copy normally moves in; the history records every change.
 */
export function setStates(states: PartStatus[], copies: number[], to: PartStatus): PartStatus[] {
  if (copies.length === 0) throw new Error('Pick at least one copy.')
  const next = [...states]
  for (const i of copies) {
    if (!Number.isInteger(i) || i < 0 || i >= next.length) throw new Error(`There is no copy ${i + 1}.`)
    next[i] = to
  }
  return next
}

/**
 * The copies after a change of qty. More copies arrive as not printed;
 * fewer removes not-printed copies from the end. Copies already printed,
 * passed or going back are never removed by editing a number.
 */
export function resizeStates(states: PartStatus[], qty: number): PartStatus[] {
  if (qty >= states.length) return [...states, ...Array<PartStatus>(qty - states.length).fill('pending')]
  const done = states.filter((s) => s !== 'pending').length
  if (qty < done) {
    throw new Error(`${done} copies of this part are already printed, passed or going back — it cannot be fewer than ${done}.`)
  }
  const next = [...states]
  let drop = states.length - qty
  for (let i = next.length - 1; i >= 0 && drop > 0; i--) {
    if (next[i] === 'pending') {
      next.splice(i, 1)
      drop--
    }
  }
  return next
}

/** "2" / "1, 4" -- copies as a person numbers them. */
export function copyList(zeroBased: number[]): string {
  return zeroBased.map((i) => String(i + 1)).join(',')
}

/**
 * The copies of one part waiting to print from one replacement file.
 *
 * `queued` is every "back in the queue, from this file" event on the
 * project, oldest first (part_events.slice_import_id, 0034). A copy belongs
 * to the file it was most recently queued from -- one copy can fail twice
 * and get two files -- and only while it is still not printed. 0-based.
 */
export function queuedCopies(
  queued: { part_id: string; copies: string | null; slice_import_id: string | null }[],
  partId: string,
  sliceImportId: string,
  states: PartStatus[],
): number[] {
  const latest = new Map<number, string | null>()
  for (const e of queued) {
    if (e.part_id !== partId) continue
    for (const c of String(e.copies ?? '').split(',').map(Number)) if (c > 0) latest.set(c - 1, e.slice_import_id)
  }
  return [...latest.entries()]
    .filter(([i, file]) => file === sliceImportId && states[i] === 'pending')
    .map(([i]) => i)
    .sort((a, b) => a - b)
}
