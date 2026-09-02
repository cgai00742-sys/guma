/**
 * Tax NAME help, keyed by US state -- deliberately not a rate database.
 *
 * The "no hard-coded rates" rule that governs pricing.ts applies just as
 * hard here: a specific percentage baked into shipped code goes stale the
 * same way a hard-coded labour rate would, and it's not this project's
 * call to make for someone else's shop. Real small-business tools researched
 * for this feature (Square, Wave, QuickBooks) either stay fully blank with a
 * liability disclaimer or become a live, continuously-maintained service
 * (Avalara/TaxJar) -- none of them ship a static suggested number. So Guma
 * doesn't either.
 *
 * What IS stable enough to ship: what a state actually CALLS this tax.
 * Hawaii's General Excise Tax and New Mexico's Gross Receipts Tax aren't
 * "sales tax" at all -- they're levied on the seller's gross receipts, not
 * the buyer's purchase, and both apply to services (a print shop's
 * design/labour line) as well as goods. Getting that name wrong on a
 * client-facing quote is an easy, avoidable mistake; that's the actual gap
 * this fills. Every suggestion here is a starting point the shop can accept,
 * edit, or ignore -- nothing here is ever written without an explicit click.
 *
 * Sourced August 2026: Hawaii Dept. of Taxation (tax.hawaii.gov/geninfo/get),
 * New Mexico Taxation & Revenue Dept. (tax.newmexico.gov/businesses/gross-receipts-overview),
 * and the Tax Foundation's state sales tax rate survey, for the five states
 * with no general state sales tax. Confirm current details directly with the
 * state -- this file is a pointer, not a source of truth.
 */

export interface TaxHint {
  /** The suggested tax name, offered as a one-click fill -- never applied automatically. */
  label: string
  note: string
  /** Where to go to confirm the current rate. Always a state's own site, or
   *  a directory of them -- never a number this app decided for you. */
  link: string
}

/** The Federation of Tax Administrators keeps a directory of every state's
 *  own revenue agency. Linking here for "ordinary sales-tax" states instead
 *  of 45 individually-sourced URLs keeps this file honest about what's
 *  actually been verified, rather than guessing at a domain pattern. */
const FTA_DIRECTORY = 'https://www.taxadmin.org/state-tax-agencies'

const SPECIAL: Record<string, TaxHint> = {
  HI: {
    label: 'General Excise Tax (GET)',
    note:
      'Hawaii doesn’t have a sales tax. GET is charged on your gross receipts, not the client’s purchase, and it applies to services — your design/labour line — as well as physical parts. Most shops pass it through as a line item, but that’s a choice, not a requirement.',
    link: 'https://tax.hawaii.gov/geninfo/get/',
  },
  NM: {
    label: 'Gross Receipts Tax (GRT)',
    note:
      'New Mexico taxes gross receipts, not sales — the same idea as Hawaii’s GET. It applies to services too, and the combined rate varies by city and county on top of the state rate.',
    link: 'https://www.tax.newmexico.gov/businesses/gross-receipts-overview/',
  },
}

const NO_STATE_SALES_TAX: Record<string, string> = {
  AK: 'https://www.commerce.alaska.gov/web/dcra/OfficeoftheStateAssessor.aspx',
  DE: 'https://revenue.delaware.gov/',
  MT: 'https://mtrevenue.gov/',
  NH: 'https://www.revenue.nh.gov/',
  OR: 'https://www.oregon.gov/dor/Pages/index.aspx',
}

/** null when there's no state on file yet, or the state isn't recognised. */
export function taxHintFor(stateCode: string | null | undefined): TaxHint | null {
  if (!stateCode) return null
  const code = stateCode.trim().toUpperCase()
  if (SPECIAL[code]) return SPECIAL[code]
  if (NO_STATE_SALES_TAX[code]) {
    return {
      label: 'No general state sales tax',
      note:
        'This state has no statewide sales tax — but Alaska in particular allows local (borough/city) sales taxes, so this can still depend on exactly where you operate. Worth checking before assuming there’s nothing to charge.',
      link: NO_STATE_SALES_TAX[code],
    }
  }
  if (US_STATE_NAMES[code]) {
    return {
      label: 'Sales Tax',
      note:
        'Most businesses in this state use this name. Your actual combined rate is state + local, and changes more often than the name does — confirm it with your state’s tax agency before charging it.',
      link: FTA_DIRECTORY,
    }
  }
  return null
}

export const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
  ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
  ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
]

const US_STATE_NAMES: Record<string, string> = Object.fromEntries(US_STATES)
