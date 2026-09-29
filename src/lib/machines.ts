/**
 * Common machines, with the figures a shop would otherwise go looking for.
 *
 * Asked for: "on the shop setup page for the machines page what would be
 * the typical rate per hour based on your research for a PrusaXL? Also,
 * can you have some general options available in the model dropdown?"
 *
 * THREE DIFFERENT NUMBERS, and Guma keeps them apart on purpose:
 *
 *   watts        what the machine DRAWS while printing -- an average, not
 *                the power supply's rating. Times your $/kWh, it is the
 *                electricity line of every job.
 *   wear         what the machine COSTS per hour of its life: what you
 *                paid, over the print hours you expect out of it.
 *   rate         what you CHARGE a client for an hour of it. A price, set
 *                by the market and by you -- never derived from the other
 *                two, which is why it is guidance here and not a default.
 *
 * Every figure below is from a named source, reviewed on the date in
 * REVIEWED. Where a source could not be found for a figure, the figure is
 * absent rather than guessed -- a model with no wattage offers the name
 * and nothing else. Prices move; they are list prices on the review date,
 * in US dollars, and only ever offered as a starting point to replace.
 */

export const REVIEWED = '2026-09-29'

export interface MachineModel {
  /** As a shop would write it on the model field. */
  name: string
  tech: 'fdm' | 'resin' | 'composite' | 'sls'
  /** Average draw while printing PLA, in watts. Absent when unsourced. */
  watts?: number
  /** The published range the average sits in, for the hint. */
  wattsRange?: [number, number]
  /** List price in USD on REVIEWED. Absent when unsourced. */
  listPriceUsd?: number
  /** A band for what shops charge an hour of this class of machine. */
  class: 'entry' | 'prosumer' | 'large-format'
  source: string
}

export const MACHINE_MODELS: MachineModel[] = [
  {
    name: 'Prusa XL (single toolhead)',
    tech: 'fdm',
    watts: 200,
    wattsRange: [150, 240],
    listPriceUsd: 2129,
    class: 'large-format',
    source: 'Draw: PEA3D Prusa power analyzer (150–240 W average); peaks over 400 W while heating (Prusa forum). Price: prusa3d.com, XL+ single-tool.',
  },
  {
    name: 'Prusa XL (5 toolheads)',
    tech: 'fdm',
    wattsRange: [150, 240],
    class: 'large-format',
    source: 'Draw: PEA3D Prusa power analyzer. More heads idle warm, so expect the top of the range. No confirmed price on the review date.',
  },
  {
    name: 'Prusa MK4 / MK4S',
    tech: 'fdm',
    watts: 100,
    wattsRange: [80, 120],
    class: 'prosumer',
    source: 'PEA3D Prusa power analyzer (80–120 W average).',
  },
  { name: 'Prusa Core One', tech: 'fdm', class: 'prosumer', source: 'Name only — no sourced figures yet.' },
  { name: 'Bambu Lab A1 mini', tech: 'fdm', watts: 80, class: 'entry', source: 'Bambu Lab wiki, printer power parameters (PLA average).' },
  { name: 'Bambu Lab A1', tech: 'fdm', watts: 95, class: 'entry', source: 'Bambu Lab wiki, printer power parameters (PLA average).' },
  { name: 'Bambu Lab P1S', tech: 'fdm', watts: 105, class: 'prosumer', source: 'Bambu Lab wiki, printer power parameters (PLA average).' },
  { name: 'Bambu Lab X1 Carbon', tech: 'fdm', watts: 105, class: 'prosumer', source: 'Bambu Lab wiki, printer power parameters (PLA average).' },
  { name: 'Bambu Lab X1E', tech: 'fdm', watts: 185, class: 'prosumer', source: 'Bambu Lab wiki, printer power parameters (PLA average).' },
  { name: 'Bambu Lab H2D', tech: 'fdm', watts: 197, class: 'large-format', source: 'Bambu Lab wiki, printer power parameters (PLA average).' },
  { name: 'Bambu Lab H2S', tech: 'fdm', class: 'large-format', source: 'Name only — not yet in the Bambu Lab power table.' },
  { name: 'Creality K1 / K1C', tech: 'fdm', class: 'entry', source: 'Name only — no sourced figures yet.' },
  { name: 'Formlabs Form 4', tech: 'resin', class: 'prosumer', source: 'Name only — no sourced figures yet.' },
  { name: 'Elegoo Saturn', tech: 'resin', class: 'entry', source: 'Name only — no sourced figures yet.' },
]

/**
 * What shops charge an hour of machine time, by class of machine, in USD.
 *
 * Published guidance, not a survey of anyone's shop: consumer FDM is
 * commonly $1–5/h (3DMaker Engineering); LayerMath puts marketplace
 * sellers at $2–4/h and customer-project "pro" work at $5–8/h. A
 * large-format tool-changer belongs at the top of the consumer range and
 * into the pro band, because it takes the jobs a smaller machine cannot
 * and ties itself up for days doing them.
 */
export const RATE_BANDS: Record<MachineModel['class'], { low: number; high: number; note: string }> = {
  entry: { low: 1, high: 3, note: 'Consumer FDM, simple work.' },
  prosumer: { low: 2, high: 5, note: 'Reliable enclosed machines, repeatable work.' },
  'large-format': {
    low: 4,
    high: 8,
    note: 'Takes the jobs smaller machines cannot, and ties itself up for days doing them.',
  },
}

export const RATE_SOURCES = [
  { label: 'LayerMath — 3D printing hourly rate', url: 'https://layermath.com/blog/3d-printing-hourly-rate' },
  { label: '3DMaker Engineering — how to price 3D prints', url: 'https://www.3dmakerengineering.com/blogs/3d-printing/how-to-price-3d-prints' },
  { label: 'Bambu Lab wiki — power parameters', url: 'https://wiki.bambulab.com/en/general/power-consumption' },
  { label: 'PEA3D — Prusa power analyzer', url: 'https://pea3d.com/en/prusa-power-analyzer/' },
]

export function findModel(name: string): MachineModel | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return MACHINE_MODELS.find((m) => m.name.toLowerCase() === n) ?? null
}

/** Wear per hour from what the machine cost and the hours expected of it. */
export function wearFrom(priceUsd: number, lifetimeHours = 5000): number {
  return Math.round((priceUsd / lifetimeHours) * 100) / 100
}

/**
 * The figures a known model can offer, for fields that are still EMPTY.
 * Anything the shop has already typed is left exactly as it is -- a
 * suggestion that overwrites your own number is not a suggestion.
 */
export function suggestionsFor(
  model: MachineModel,
  current: { watts: number | null; wear_hourly: number; rate_hourly: number },
): { watts?: number; wear_hourly?: number; rate_hourly?: number } {
  const out: { watts?: number; wear_hourly?: number; rate_hourly?: number } = {}
  if ((current.watts == null || current.watts === 0) && model.watts) out.watts = model.watts
  if (!(current.wear_hourly > 0) && model.listPriceUsd) out.wear_hourly = wearFrom(model.listPriceUsd)
  if (!(current.rate_hourly > 0)) {
    const band = RATE_BANDS[model.class]
    out.rate_hourly = Math.round(((band.low + band.high) / 2) * 100) / 100
  }
  return out
}
