/**
 * Price a stored quote version the way Intake prices it on "send".
 *
 * A revision saved as a draft keeps its inputs but no price: its rates
 * were never frozen onto it. CG's 16" Anson (27 Oct) sat there -- revised,
 * handed over, nothing to agree to. This prices the draft from the shop's
 * rates today, exactly as sending it from Intake would, so the Money
 * section can show the revised quote and agree it in one step.
 *
 * A version that already has frozen rates is priced from them instead, so
 * a sent quote reads the same here as on its printable.
 */
import {
  buildRatesSnapshot,
  priceQuote,
  ratesFromSnapshot,
  type PricedQuote,
  type PrinterRef,
  type QuoteInputs,
  type RateSet,
  type RatesSnapshot,
} from './pricing'
import type { PrinterRow, QuoteInputsRow, ShopContext } from './data.types'
import { addDaysISO } from './dates'

const round2 = (n: number) => Math.round(n * 100) / 100

const toPrinterRef = (p: PrinterRow): PrinterRef => ({
  id: p.id,
  name: p.name,
  model: p.model,
  ratePerHour: Number(p.rate_hourly),
  wearPerHour: Number(p.wear_hourly),
  watts: p.watts == null ? null : Number(p.watts),
})

export interface FrozenPrice {
  rates_snapshot: RatesSnapshot
  total: number
  deposit_due: number
  valid_until: string
}

export function priceStoredQuote(
  qi: QuoteInputsRow,
  assetOrigin: QuoteInputs['assetOrigin'],
  ctx: Pick<ShopContext, 'materials' | 'printers' | 'printerRows' | 'shop'>,
  rates: RateSet,
): { priced: PricedQuote; freeze: FrozenPrice | null } {
  const builds = qi.builds ?? []
  const copies = builds.length ? builds.reduce((a, b) => a + b.qty, 0) : qi.quantity || 1
  const input: QuoteInputs = {
    assetOrigin,
    designBilling: qi.designBilling === 'flat' ? 'flat' : 'hourly',
    designQty: qi.designQty,
    revisions: qi.revisionsIncl,
    quantity: builds.length ? copies : qi.quantity,
    unitsPerPart: qi.unitsPerPart,
    printHrsPerPart: qi.printHrsPart,
    finishingHrs: qi.finishingHrs,
    rush: qi.rush,
    flatEach: qi.flatEach,
    discountPct: qi.discountPct,
    builds: builds.map((b, i) => ({
      key: b.id ?? String(i),
      label: b.label,
      printerId: b.printerId,
      materialId: b.materialId,
      qty: b.qty,
      unitsPerPart: b.unitsPerPart,
      printHrsPerPart: b.printHrsPerPart,
    })),
  }

  if (qi.ratesSnapshot) {
    const snap = qi.ratesSnapshot as RatesSnapshot
    const r = ratesFromSnapshot(snap)
    return {
      priced: priceQuote(input, r.rates, r.material, r.printer, r.fleet ?? { materials: [], printers: [] }),
      freeze: null,
    }
  }

  // Machines it names stay priceable even if retired since, as in Intake.
  const named = new Set([qi.printerId, ...builds.map((b) => b.printerId)].filter(Boolean) as string[])
  const retired = ctx.printerRows.filter((p) => Number(p.archived) && named.has(p.id)).map(toPrinterRef)
  const printers = [...ctx.printers, ...retired]
  const material = ctx.materials.find((m) => m.id === qi.materialId) ?? null
  const printer = printers.find((p) => p.id === qi.printerId) ?? null
  const priced = priceQuote(input, rates, material, printer, { materials: ctx.materials, printers })
  return {
    priced,
    freeze: {
      rates_snapshot: buildRatesSnapshot(
        rates,
        material,
        printer,
        builds.length
          ? {
              materials: ctx.materials.filter((m) => builds.some((b) => b.materialId === m.id)),
              printers: printers.filter((p) => builds.some((b) => b.printerId === p.id)),
            }
          : undefined,
      ),
      total: round2(priced.total),
      deposit_due: round2(priced.deposit),
      valid_until: addDaysISO(ctx.shop.quote_valid_days),
    },
  }
}
