import type { MaterialRef, PrinterRef, RateSet } from '../pricing'
export const RATES: RateSet = {
  designHourly: 85, finishingHourly: 55, rushPct: 35, minimumOrder: 0, depositPct: 50,
  depositWhen: 'design', depositWaiveBelow: 0, materialMarkup: 2, revisionsIncl: 2, revisionHourly: 85,
  taxLabel: 'Sales tax', taxPct: 0, currency: 'USD', locale: 'en-US', electricityRateKwh: null,
  overheadMonthly: null, productiveHoursMonth: null, failurePct: null,
}
export const PLA: MaterialRef = { id: 'pla', name: 'PLA', unit: 'g', costPerUnit: 0.025, sellOverride: null, swatch: '#fff' }
export const A: PrinterRef = { id: 'a', name: 'Big', model: 'Prusa XL', ratePerHour: 8, wearPerHour: 1, watts: 1000 }
export const B: PrinterRef = { id: 'b', name: 'Small', model: 'MINI', ratePerHour: 4, wearPerHour: 1, watts: 50 }
