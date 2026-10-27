/**
 * Equipment that is not a printer, and what an hour of it costs (CG, 27
 * Oct: a filament dryer "doesn't truly sit with the number of printing
 * hours"). Pure: the numbers, the suggestions, nothing else.
 *
 * An hour costs power plus wear -- the printers' own rule:
 *   power = average watts / 1000 x the shop's $/kWh
 *   wear  = price / expected life in hours
 * A missing number is zero, never a guess: a dryer with no price on file
 * wears nothing until somebody says what it cost.
 */
import type { EquipmentKind, EquipmentTracking } from './data.types'

export interface EquipmentSuggestion {
  kind: EquipmentKind
  label: string
  /** Average draw, not the label's peak: heaters cycle. */
  watts: number | null
  lifeHours: number | null
  tracking: EquipmentTracking
  why: string
}

/**
 * Starting points by type. Every one is editable on the form; where a
 * figure comes from a maker's page it says so.
 */
export const EQUIPMENT_KINDS: EquipmentSuggestion[] = [
  {
    kind: 'dryer',
    label: 'Filament dryer',
    watts: 150,
    lifeHours: 5000,
    tracking: 'hours',
    why: 'Sunlu S4 Pro is rated 380 W, but its heater cycles once warm — 150 W is a fairer average. A smart plug gives the real figure.',
  },
  {
    kind: 'wash_cure',
    label: 'Wash & cure station (resin)',
    watts: 36,
    lifeHours: 2000,
    tracking: 'hours',
    why: 'Anycubic Wash & Cure 3 Plus is rated 36 W. The UV LEDs are what wear out.',
  },
  {
    kind: 'fume',
    label: 'Fume extractor / air filter',
    watts: 45,
    lifeHours: 8000,
    tracking: 'printers',
    why: 'Runs whenever the printers it serves run. Its filters are a consumable — add them as hardware.',
  },
  {
    kind: 'enclosure',
    label: 'Enclosure heater or fans',
    watts: 60,
    lifeHours: 10000,
    tracking: 'printers',
    why: 'On while the printer inside is printing.',
  },
  {
    kind: 'iron',
    label: 'Heat-set insert iron',
    watts: 60,
    lifeHours: 2000,
    tracking: 'hours',
    why: 'Short sessions, logged as used.',
  },
  {
    kind: 'heat_gun',
    label: 'Heat gun',
    watts: 1500,
    lifeHours: 1000,
    tracking: 'hours',
    why: 'High draw, short bursts — log the minutes it was actually on.',
  },
  {
    kind: 'dehumidifier',
    label: 'Room dehumidifier',
    watts: 400,
    lifeHours: 10000,
    tracking: 'overhead',
    why: 'Keeps the whole room dry, not one job — shop overhead.',
  },
  { kind: 'other', label: 'Something else', watts: null, lifeHours: null, tracking: 'hours', why: '' },
]

export const TRACKING_LABEL: Record<EquipmentTracking, { label: string; sub: string }> = {
  hours: { label: 'Log hours as you use it', sub: 'Add its hours to a project when it runs for that project.' },
  printers: { label: 'Alongside printers', sub: 'Counted for every print hour of the printers it serves.' },
  overhead: { label: 'Shop overhead only', sub: 'Owned and listed, never put on a project.' },
}

export function suggestionFor(kind: EquipmentKind): EquipmentSuggestion {
  return EQUIPMENT_KINDS.find((k) => k.kind === kind) ?? EQUIPMENT_KINDS[EQUIPMENT_KINDS.length - 1]
}

/** What one hour of this equipment costs, and of what. */
export function equipmentHourly(
  e: { watts: number | null; price: number | null; lifeHours: number | null },
  kwhRate: number | null,
): { power: number; wear: number; total: number } {
  const power = Math.max(0, e.watts ?? 0) / 1000 * Math.max(0, kwhRate ?? 0)
  const wear = (e.lifeHours ?? 0) > 0 ? Math.max(0, e.price ?? 0) / (e.lifeHours as number) : 0
  return { power, wear, total: power + wear }
}

/** The price a client pays for hardware: cost plus its markup. */
export function hardwarePrice(unitCost: number, markupPct: number): number {
  return Math.max(0, unitCost) * (1 + Math.max(0, markupPct) / 100)
}
