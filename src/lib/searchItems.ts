/**
 * How each kind of row reads as something findable.
 *
 * One file, so that a client who can be found by phone number in the top
 * bar can also be found by phone number on the Clients screen. Every search
 * field in Guma runs the same matcher (search.ts) over the shapes made
 * here, which is the only way to make "it is not in the list" mean the same
 * thing in both places.
 *
 * What goes in `terms` is the interesting judgement: things nobody can see
 * but everybody searches by. A shop looking at a missed call types the
 * phone number. A shop reading an email from a client types the address. A
 * shop holding a printed quote types the reference off the top of it. None
 * of those are shown in a result row, and all of them have to match.
 */
import type { ClientRow, JobListRow, MaterialRow, PrinterRow } from './data.types'
import { CLIENT_KIND_LABEL } from './data.types'
import { PHASE_LABEL } from './gates'
import type { SearchItem } from './search'

const TECH_LABEL: Record<PrinterRow['tech'], string> = {
  fdm: 'FDM filament',
  resin: 'Resin MSLA SLA',
  composite: 'Composite continuous fibre',
  sls: 'SLS powder',
}

export function machineItem(p: PrinterRow): SearchItem {
  return {
    kind: 'machine',
    id: p.id,
    title: p.name,
    subtitle: p.model,
    // Technology in words, so "resin" finds the resin printers even though
    // the row stores the code and shows the model.
    terms: [TECH_LABEL[p.tech], Number(p.archived) ? 'retired archived' : 'in service'],
    badge: Number(p.archived) ? 'retired' : null,
    to: '/settings?tab=machines',
  }
}

export function clientItem(c: ClientRow, money?: (n: number) => string): SearchItem {
  return {
    kind: 'client',
    id: c.id,
    title: c.name,
    subtitle: [c.contact, c.email].filter(Boolean).join(' · ') || CLIENT_KIND_LABEL[c.kind],
    terms: [c.contact, c.email, c.phone, CLIENT_KIND_LABEL[c.kind]],
    badge:
      c.owed > 0 && money
        ? `${money(c.owed)} owed`
        : c.active > 0
          ? `${c.active} active`
          : null,
    to: `/clients?open=${c.id}`,
  }
}

export function projectItem(j: JobListRow, money?: (n: number) => string): SearchItem {
  return {
    kind: 'project',
    id: j.jobId,
    title: j.title,
    subtitle: `${j.clientName} · ${PHASE_LABEL[j.phase]}`,
    // The reference is the thing printed on the paperwork, so it is the
    // thing someone types when they are holding the paperwork.
    terms: [j.ref, j.clientName, PHASE_LABEL[j.phase], j.quoteStatus],
    badge: j.total != null && money ? money(j.total) : null,
    to: `/project/${j.jobId}`,
  }
}

export function materialItem(m: MaterialRow): SearchItem {
  return {
    kind: 'material',
    id: m.id,
    title: m.name,
    subtitle: m.kind,
    terms: [m.kind, m.unit === 'g' ? 'grams filament' : 'millilitres resin'],
    badge: m.onHand <= m.reorderAt ? 'low' : null,
    to: '/settings?tab=materials',
  }
}

/** The same four, keyed by kind — convenient for filterBy(). */
export const asSearchItem = {
  machine: machineItem,
  client: (c: ClientRow) => clientItem(c),
  project: (j: JobListRow) => projectItem(j),
  material: materialItem,
}
