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
