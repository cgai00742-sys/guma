/**
 * What an edit to a project changed, in words a person reads in Activity.
 *
 * Both backends call this with the row as it was and the fields being
 * written, and log the result as one `edit` event. Kept pure so the wording
 * is tested once and the two backends cannot drift.
 */
import type { ProjectFieldsInput } from './data.types'

export interface ProjectBefore {
  title: string
  brief: string | null
  poc: string | null
  needed_by: string | null
  window_from: string | null
  window_locked: boolean | number | null
  at_risk: boolean | number | null
  delivery_on: string | null
  delivery_how: string | null
  priority: string | null
  over_ceiling?: string | null
  printer_id?: string | null
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const norm = (v: unknown) =>
  v === undefined || v === null || v === '' ? null : typeof v === 'number' ? !!v : v
const shown = (v: unknown) => (v === null ? 'nothing' : String(v))

export function describeProjectEdits(
  before: ProjectBefore,
  fields: ProjectFieldsInput,
  printerName: string | null = null,
): string[] {
  const out: string[] = []
  const changed = (key: keyof ProjectFieldsInput, col: keyof ProjectBefore) =>
    key in fields && norm((fields as Record<string, unknown>)[key]) !== norm(before[col])
  if (changed('title', 'title')) out.push(`Renamed from "${before.title}" to "${fields.title}".`)
  if (changed('brief', 'brief'))
    out.push(fields.brief ? `Brief edited: "${clip(fields.brief)}".` : 'Brief cleared.')
  if (changed('poc', 'poc')) out.push(`Point of contact: ${shown(before.poc)} → ${shown(norm(fields.poc))}.`)
  if (changed('neededBy', 'needed_by'))
    out.push(`Needed by: ${shown(before.needed_by)} → ${shown(norm(fields.neededBy))}.`)
  if (changed('windowFrom', 'window_from'))
    out.push(`Window opens: ${shown(before.window_from)} → ${shown(norm(fields.windowFrom))}.`)
  if (changed('windowLocked', 'window_locked'))
    out.push(fields.windowLocked ? 'Delivery window locked.' : 'Delivery window unlocked.')
  if (changed('atRisk', 'at_risk'))
    out.push(fields.atRisk ? 'Flagged at risk.' : 'At-risk flag cleared.')
  if (changed('deliveryOn', 'delivery_on'))
    out.push(`Delivery date: ${shown(before.delivery_on)} → ${shown(norm(fields.deliveryOn))}.`)
  if (changed('deliveryHow', 'delivery_how'))
    out.push(`Delivery: ${shown(before.delivery_how)} → ${shown(norm(fields.deliveryHow))}.`)
  if (changed('priority', 'priority'))
    out.push(`Priority: ${shown(before.priority)} → ${shown(fields.priority ?? null)}.`)
  if (changed('overCeiling', 'over_ceiling'))
    out.push(fields.overCeiling ? `Over-the-agreed-price flag set.` : 'Over-the-agreed-price flag cleared.')
  // The screen says which machine; the log line only needs that it moved,
  // and printerName (when the caller has it) says to what.
  if (changed('printerId', 'printer_id'))
    out.push(fields.printerId ? `Booked on ${printerName ?? 'a machine'}.` : 'Machine booking cleared.')
  return out
}

export function describePartEdit(
  before: { label: string; qty: number; note: string | null },
  after: { label: string; qty: number; note: string | null },
): string[] {
  const out: string[] = []
  if (before.label !== after.label) out.push(`Part renamed from "${before.label}" to "${after.label}".`)
  if (before.qty !== after.qty) out.push(`"${after.label}" copies: ${before.qty} → ${after.qty}.`)
  if ((before.note ?? null) !== (after.note ?? null))
    out.push(after.note ? `"${after.label}" note: "${clip(after.note)}".` : `"${after.label}" note cleared.`)
  return out
}
