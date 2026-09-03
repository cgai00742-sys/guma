/**
 * Shared test fixtures. Not shipped in any screen; imported only by tests.
 *
 * Deliberately a shop in Germany, billing euros on A4. Every fixture in this
 * project used to be a US one, which is how "en-US" ended up hard-coded in
 * ten places without a single test noticing: if the fixture agrees with the
 * bug, the bug is invisible. A test that needs a US shop passes one in.
 */
import type {
  MaterialRef,
  PrinterRef,
} from './pricing'
import type { PrinterRow, Profile, RateCardRow, Shop, ShopContext } from './data.types'

export function makeShop(over: Partial<Shop> = {}): Shop {
  return {
    id: 'shop-1',
    name: 'Werkstatt Drei',
    slug: 'werkstatt-drei',
    accent: '#00A6A6',
    accent_alt: '#FF7A45',
    tax_label: 'MwSt.',
    tax_pct: 19,
    currency: 'EUR',
    locale: 'de-DE',
    legal_name: 'Werkstatt Drei GmbH',
    address: 'Kantstraße 12, Berlin',
    state: null,
    email: 'hallo@werkstatt-drei.de',
    phone: '+49 30 123456',
    license_no: null,
    terms_text: null,
    revision_policy: null,
    payment_info: null,
    quote_valid_days: 30,
    lead_days: 10,
    electricity_rate_kwh: 0.32,
    paper: null,
    show_welcome: false,
    ...over,
  }
}

export function makeRateCard(over: Partial<RateCardRow> = {}): RateCardRow {
  return {
    id: 'rate-1',
    shop_id: 'shop-1',
    effective_from: '2026-01-01',
    design_hourly: 85,
    finishing_hourly: 55,
    rush_pct: 35,
    minimum_order: 85,
    deposit_pct: 50,
    deposit_when: 'design',
    deposit_waive_below: 150,
    material_markup: 2,
    revisions_incl: 2,
    revision_hourly: 85,
    ...over,
  }
}

export const MATERIAL: MaterialRef = {
  id: 'mat-1',
  name: 'PLA',
  swatch: '#5A6B7C',
  unit: 'g',
  costPerUnit: 0.095,
  sellOverride: null,
}

export const PRINTER: PrinterRef = {
  id: 'prn-1',
  name: 'Prusa XL',
  model: 'XL 5T',
  ratePerHour: 9,
  wearPerHour: 3,
  watts: 350,
}

export const PRINTER_ROW: PrinterRow = {
  id: 'prn-1',
  name: 'Prusa XL',
  model: 'XL 5T',
  tech: 'fdm',
  rate_hourly: 9,
  wear_hourly: 3,
  watts: 350,
}

export const PROFILE: Profile = {
  id: 'usr-1',
  shop_id: 'shop-1',
  full_name: 'Anke Roth',
  initials: 'AR',
  role: 'owner',
}

export function makeCtx(over: { shop?: Partial<Shop>; rateCard?: Partial<RateCardRow> } = {}): ShopContext {
  return {
    profile: PROFILE,
    shop: makeShop(over.shop),
    rateCard: makeRateCard(over.rateCard),
    materials: [MATERIAL],
    printers: [PRINTER],
    printerRows: [PRINTER_ROW],
  }
}
