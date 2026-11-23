/**
 * Who a Shelf piece went to (CG, 22 Nov 2026), and the small rules that
 * turn that into a list of people worth staying in touch with.
 *
 * Deliberately not a CRM with pipelines and stages. A person is a client
 * row -- the same list commissioned work uses -- found again by email,
 * phone or name, so typing "Kai" twice does not make two Kais. Everything
 * here is pure so both backends and the screens share one set of rules.
 */
import type { ClientKind } from './data.types'

export const SALE_KINDS = ['sale', 'donation', 'reserved'] as const
export type SaleKind = (typeof SALE_KINDS)[number]

export const SALE_KIND_LABEL: Record<SaleKind, string> = {
  sale: 'Sold',
  donation: 'Donated',
  reserved: 'Reserved',
}

/** Who, as typed on the Shelf. Only the name is needed. */
export interface PersonInput {
  name: string
  phone?: string | null
  email?: string | null
  kind?: ClientKind
  /** They said yes to hearing about new pieces and offers. Only ever a yes
   *  recorded here: a sale never takes consent away (that is done, on
   *  purpose, on the Clients screen). */
  marketingOk?: boolean
}

export const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
export const cleanEmail = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const cleanName = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Tidy what was typed, or refuse it with a sentence. */
export function cleanPerson(p: PersonInput): Required<Omit<PersonInput, 'kind'>> & { kind: ClientKind } {
  const name = p.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Give them a name — a first name is enough.')
  const email = cleanEmail(p.email)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`“${p.email}” doesn't look like an email address.`)
  const phone = (p.phone ?? '').trim()
  if (phone && digits(phone).length < 7) throw new Error(`“${phone}” is too short for a phone number.`)
  return { name, email, phone, kind: p.kind ?? 'individual', marketingOk: p.marketingOk === true }
}

/**
 * The person already on file, if there is one: same email, else same phone
 * (7+ digits, compared on digits), else the same name exactly. Email and
 * phone outrank the name -- two Kais are common, two Kais with one email
 * are one Kai.
 */
export function findPerson<T extends { id: string; name: string; email: string | null; phone: string | null }>(
  people: T[],
  p: { name: string; email?: string | null; phone?: string | null },
): T | null {
  const email = cleanEmail(p.email)
  if (email) {
    const hit = people.find((x) => cleanEmail(x.email) === email)
    if (hit) return hit
  }
  const phone = digits(p.phone)
  if (phone.length >= 7) {
    const hit = people.find((x) => digits(x.phone).length >= 7 && digits(x.phone).slice(-10) === phone.slice(-10))
    if (hit) return hit
  }
  const name = cleanName(p.name)
  return people.find((x) => cleanName(x.name) === name) ?? null
}

/** Days between two ISO dates (YYYY-MM-DD…), b minus a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000)
}

/**
 * Time to ask how they're enjoying it: a sale or a donation to someone on
 * file, a week to three months ago, not asked yet. Earlier is pushy; later
 * and the moment has passed.
 */
export function checkInDue(
  s: { kind: SaleKind; client_id: string | null; sold_on: string; followed_up_on: string | null },
  today: string,
): boolean {
  if (s.kind === 'reserved' || !s.client_id || s.followed_up_on) return false
  const age = daysBetween(s.sold_on, today)
  return age >= 7 && age <= 90
}
