/**
 * Where Guma's regional defaults come from.
 *
 * Guma is downloaded and run by whoever wants it, anywhere. So nothing in
 * this file is a preselection. Every value is either read from the operating
 * system through the JavaScript runtime's own CLDR data, or left blank for
 * the shop to fill in. There is deliberately no "fall back to the United
 * States" anywhere: a blank field is honest, a wrong field that looks filled
 * in is not.
 *
 * TIMEZONE IS NOT HERE, ON PURPOSE. Guma never stores or asks for one. Dates
 * are built from the OS clock's local calendar fields (see dates.ts), so
 * "today" is whatever the machine says today is — nothing to configure,
 * nothing to keep in sync when a laptop crosses a border, and no way for a
 * saved setting to disagree with the clock in the corner of the screen. That
 * is the same choice QGIS and Blender make: take it from the platform, don't
 * ask the user.
 *
 * The one table below (region -> currency) is data, not a default: it turns
 * an OS region the user already set into a first guess they can change in one
 * click. A region that isn't in it gets no guess rather than a wrong one.
 */

/* eslint-disable no-restricted-globals */

/** ISO 3166 region -> ISO 4217 currency. A starting guess only; every screen
 *  that uses it lets the shop pick something else, and an unlisted region
 *  yields '' rather than someone else's money. */
const REGION_CURRENCY: Record<string, string> = Object.fromEntries(
  (
    'AD:EUR AE:AED AF:AFN AL:ALL AM:AMD AO:AOA AR:ARS AT:EUR AU:AUD AZ:AZN ' +
    'BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:BGN BH:BHD BI:BIF BJ:XOF BN:BND ' +
    'BO:BOB BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CD:CDF CF:XAF ' +
    'CG:XAF CH:CHF CI:XOF CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE ' +
    'CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DO:DOP DZ:DZD EC:USD EE:EUR EG:EGP ' +
    'ER:ERN ES:EUR ET:ETB FI:EUR FJ:FJD FO:DKK FR:EUR GA:XAF GB:GBP GE:GEL ' +
    'GH:GHS GI:GIP GM:GMD GN:GNF GQ:XAF GR:EUR GT:GTQ GW:XOF GY:GYD HK:HKD ' +
    'HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IN:INR IQ:IQD IR:IRR ' +
    'IS:ISK IT:EUR JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KM:KMF KR:KRW ' +
    'KW:KWD KZ:KZT LA:LAK LB:LBP LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR ' +
    'LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL ME:EUR MG:MGA MK:MKD ML:XOF MM:MMK ' +
    'MN:MNT MO:MOP MR:MRU MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN ' +
    'NA:NAD NC:XPF NE:XOF NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NZ:NZD OM:OMR ' +
    'PA:PAB PE:PEN PF:XPF PG:PGK PH:PHP PK:PKR PL:PLN PR:USD PT:EUR PY:PYG ' +
    'QA:QAR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK ' +
    'SG:SGD SI:EUR SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN ' +
    'SV:USD SY:SYP SZ:SZL TD:XAF TG:XOF TH:THB TJ:TJS TM:TMT TN:TND TO:TOP ' +
    'TR:TRY TT:TTD TW:TWD TZ:TZS UA:UAH UG:UGX US:USD UY:UYU UZ:UZS VA:EUR ' +
    'VE:VES VN:VND VU:VUV WS:WST XK:EUR YE:YER ZA:ZAR ZM:ZMW ZW:ZWG'
  )
    .split(' ')
    .map((pair) => pair.split(':') as [string, string]),
)

/** Where Letter is the ordinary office paper. Everywhere else is A4 — which
 *  is why A4 is what an unknown region gets, rather than the other way round. */
const LETTER_REGIONS = new Set([
  'US', 'CA', 'MX', 'CL', 'CO', 'CR', 'DO', 'GT', 'NI', 'PA', 'PH', 'PR', 'SV', 'VE',
])

export type Paper = 'letter' | 'a4' | 'legal'

/**
 * The BCP 47 tag the OS is set to, e.g. 'en-GB', 'de-DE', 'ja-JP'.
 * '' when there's no runtime to ask (tests, SSR) — callers must cope with ''
 * rather than being handed a made-up tag.
 */
export function osLocale(): string {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const tag = nav?.languages?.[0] || nav?.language || ''
  if (!tag) return ''
  try {
    return new Intl.Locale(tag).toString()
  } catch {
    return ''
  }
}

/**
 * The two-letter region for a tag, maximised so a bare language still
 * answers: 'de' -> 'DE', 'pt' -> 'BR'. '' when the tag is unusable.
 */
export function regionOf(tag: string | null | undefined): string {
  if (!tag) return ''
  try {
    const loc = new Intl.Locale(tag)
    const max = typeof loc.maximize === 'function' ? loc.maximize() : loc
    return (max.region ?? '').toUpperCase()
  } catch {
    return ''
  }
}

/** A first-guess currency for a region, or '' if we genuinely don't know. */
export function currencyForRegion(region: string): string {
  return REGION_CURRENCY[region.toUpperCase()] ?? ''
}

/** A first-guess currency for wherever this machine is set up. May be ''. */
export function osCurrency(): string {
  return currencyForRegion(regionOf(osLocale()))
}

/** Letter or A4 for a region. Unknown regions get A4: it is the ISO standard
 *  and the paper in the great majority of the world's printers. */
export function paperForRegion(region: string): Paper {
  return LETTER_REGIONS.has(region.toUpperCase()) ? 'letter' : 'a4'
}

/** The paper a shop's documents print on: its own setting if it has one,
 *  otherwise derived from its locale. Never from the machine printing it —
 *  a quote reprinted on a laptop abroad keeps its original page size. */
export function paperFor(shop: { paper?: string | null; locale?: string | null }): Paper {
  const set = (shop.paper ?? '').toLowerCase()
  if (set === 'letter' || set === 'a4' || set === 'legal') return set
  return paperForRegion(regionOf(shop.locale || osLocale()))
}

export interface CurrencyOption {
  code: string
  /** The runtime's own name for it in the given display locale. */
  label: string
}

/**
 * Every currency this runtime knows about, named in the user's own language.
 * Read from Intl rather than typed out here — a hand-kept list of ten
 * currencies is a statement about whose money matters, and gets stale.
 */
export function currencyOptions(displayLocale?: string): CurrencyOption[] {
  let codes: string[]
  try {
    codes = Intl.supportedValuesOf('currency')
  } catch {
    codes = []
  }
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames([displayLocale || osLocale() || 'en'], { type: 'currency' })
  } catch {
    names = null
  }
  return codes.map((code) => {
    let label = code
    try {
      label = names?.of(code) || code
    } catch {
      label = code
    }
    return { code, label }
  })
}

/**
 * The short symbol a currency prints as ('$', '€', 'kr', 'R$'), for use in
 * unit labels like "per kWh" where a full formatted amount would be noise.
 * Falls back to the ISO code, which is never wrong, only longer.
 */
export function currencySymbol(currency: string, locale?: string): string {
  if (!currency) return ''
  try {
    const parts = new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    return parts.find((p) => p.type === 'currency')?.value || currency
  } catch {
    return currency
  }
}
