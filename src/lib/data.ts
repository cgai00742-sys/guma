/**
 * Everything that talks to Supabase. Rows come back as the shapes the pricing
 * module wants, so no screen ever has to know a column name.
 */
import { supabase } from './supabase'
import type { MaterialRef, PrinterRef, RateSet } from './pricing'

export interface Shop {
  id: string
  name: string
  slug: string
  accent: string
  accent_alt: string
  tax_label: string
  tax_pct: number
  currency: string
  locale: string
  legal_name: string | null
  address: string | null
  email: string | null
  phone: string | null
  license_no: string | null
  terms_text: string | null
  revision_policy: string | null
  payment_info: string | null
  quote_valid_days: number
  lead_days: number
  /** $/kWh off the shop's own utility bill. Null until they supply it. */
  electricity_rate_kwh: number | null
}

export interface RateCardRow {
  id: string
  shop_id: string
  effective_from: string
  design_hourly: number
  finishing_hourly: number
  rush_pct: number
  minimum_order: number
  deposit_pct: number
  deposit_when: 'design' | 'print' | 'none'
  deposit_waive_below: number
  material_markup: number
  revisions_incl: number
  revision_hourly: number | null
}

/** The raw printers row — the Machines tab needs the id and tech to edit it,
 *  which PrinterRef (the pricing module's shape) deliberately doesn't carry. */
export interface PrinterRow {
  id: string
  name: string
  model: string
  tech: 'fdm' | 'resin' | 'composite' | 'sls'
  rate_hourly: number
  wear_hourly: number
  watts: number | null
}

export interface Profile {
  id: string
  shop_id: string
  full_name: string
  initials: string | null
  role: 'owner' | 'staff' | 'viewer'
}

/** Bundle every screen needs before it can draw anything. */
export interface ShopContext {
  profile: Profile
  shop: Shop
  rateCard: RateCardRow
  materials: MaterialRef[]
  printers: PrinterRef[]
  printerRows: PrinterRow[]
}

/** The rate card and the shop's tax, in the shape the pricing module wants. */
export function toRateSet(card: RateCardRow, shop: Shop): RateSet {
  return {
    designHourly: Number(card.design_hourly),
    finishingHourly: Number(card.finishing_hourly),
    rushPct: Number(card.rush_pct),
    minimumOrder: Number(card.minimum_order),
    depositPct: Number(card.deposit_pct),
    depositWhen: card.deposit_when,
    depositWaiveBelow: Number(card.deposit_waive_below),
    materialMarkup: Number(card.material_markup),
    revisionsIncl: card.revisions_incl,
    revisionHourly: card.revision_hourly == null ? null : Number(card.revision_hourly),
    taxLabel: shop.tax_label,
    taxPct: Number(shop.tax_pct),
    currency: shop.currency || 'USD',
    locale: shop.locale || 'en-US',
    electricityRateKwh: shop.electricity_rate_kwh == null ? null : Number(shop.electricity_rate_kwh),
  }
}

/** Thrown when the signed-in account has no shop yet — the setup wizard's cue. */
export class NeedsSetup extends Error {
  constructor() {
    super('no shop yet')
    this.name = 'NeedsSetup'
  }
}

export interface SetupPayload {
  shop: Record<string, unknown>
  rates: Record<string, unknown>
  printer: Record<string, unknown> | null
  materials: Record<string, unknown>[]
  fullName: string
}

/**
 * First run. A fresh install has no shop, so the first person to sign in has no
 * profile and RLS denies them everything — `setup_shop` is the SECURITY DEFINER
 * way out of that, and it refuses anyone who already belongs to a shop.
 */
export async function setupShop(p: SetupPayload): Promise<string> {
  const { data, error } = await supabase.rpc('setup_shop', {
    p_shop: p.shop,
    p_rates: p.rates,
    p_printer: p.printer,
    p_materials: p.materials,
    p_full_name: p.fullName,
  })
  if (error) throw error
  return data as string
}

export async function loadShopContext(): Promise<ShopContext> {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) throw new Error('not signed in')

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('id, shop_id, full_name, initials, role')
    .eq('id', auth.user.id)
    .maybeSingle()
  if (pErr) throw pErr
  if (!profile) throw new NeedsSetup()

  const [shopRes, rateRes, matRes, prnRes] = await Promise.all([
    supabase.from('shops').select('*').eq('id', profile.shop_id).single(),
    supabase
      .from('rate_cards')
      .select('*')
      .eq('shop_id', profile.shop_id)
      .order('effective_from', { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from('materials')
      .select('*')
      .eq('shop_id', profile.shop_id)
      .eq('archived', false)
      .order('name'),
    supabase.from('printers').select('*').eq('shop_id', profile.shop_id).order('name'),
  ])
  if (shopRes.error) throw shopRes.error
  if (rateRes.error) throw rateRes.error
  if (matRes.error) throw matRes.error
  if (prnRes.error) throw prnRes.error

  return {
    profile: profile as Profile,
    shop: shopRes.data as Shop,
    rateCard: rateRes.data as RateCardRow,
    materials: (matRes.data ?? []).map(
      (m): MaterialRef => ({
        id: m.id,
        name: m.name,
        unit: m.unit,
        costPerUnit: Number(m.cost_per_unit),
        sellOverride: m.sell_override == null ? null : Number(m.sell_override),
        swatch: m.swatch,
      }),
    ),
    printers: (prnRes.data ?? []).map(
      (p): PrinterRef => ({
        id: p.id,
        name: p.name,
        model: p.model,
        ratePerHour: Number(p.rate_hourly),
        wearPerHour: Number(p.wear_hourly),
        watts: p.watts == null ? null : Number(p.watts),
      }),
    ),
    printerRows: (prnRes.data ?? []) as PrinterRow[],
  }
}

/**
 * Rates are versioned, not edited in place. Saving the Rates tab writes a NEW
 * rate_cards row rather than updating the current one, so a quote that snapshot
 * an older row can still be explained later. Quotes already sent carry their own
 * snapshot and are untouched either way.
 */
export async function saveRateCard(
  shopId: string,
  next: Omit<RateCardRow, 'id' | 'shop_id' | 'effective_from'>,
): Promise<RateCardRow> {
  const { data, error } = await supabase
    .from('rate_cards')
    .insert({
      shop_id: shopId,
      design_hourly: next.design_hourly,
      finishing_hourly: next.finishing_hourly,
      rush_pct: next.rush_pct,
      minimum_order: next.minimum_order,
      deposit_pct: next.deposit_pct,
      deposit_when: next.deposit_when,
      deposit_waive_below: next.deposit_waive_below,
      material_markup: next.material_markup,
      revisions_incl: next.revisions_incl,
      revision_hourly: next.revision_hourly,
    })
    .select()
    .single()
  if (error) throw error
  return data as RateCardRow
}

/**
 * The shop's identity — who it is, where it is, and its own electricity rate.
 * Unlike rates, this is edited in place: it isn't versioned, because a quote
 * already sent freezes its own copy in `rates_snapshot` regardless (currency,
 * electricity rate and all), and a shop's address doesn't need history the
 * way a price does.
 *
 * Every field is optional by design — see Setup.tsx and the Identity tab for
 * why. Passing an empty string clears a field rather than leaving stale data
 * behind.
 */
export interface ShopIdentityInput {
  name: string
  legal_name: string
  address: string
  email: string
  phone: string
  license_no: string
  electricity_rate_kwh: number | null
}

export async function saveShopIdentity(shopId: string, next: ShopIdentityInput): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      name: next.name.trim() || 'My shop',
      legal_name: next.legal_name.trim() || null,
      address: next.address.trim() || null,
      email: next.email.trim() || null,
      phone: next.phone.trim() || null,
      license_no: next.license_no.trim() || null,
      electricity_rate_kwh: next.electricity_rate_kwh,
    })
    .eq('id', shopId)
    .select()
    .single()
  if (error) throw error
  return data as Shop
}

/** Tax, validity windows, and the text printed on every quote's terms block. */
export interface ShopQuoteTermsInput {
  tax_label: string
  tax_pct: number
  quote_valid_days: number
  lead_days: number
  terms_text: string
  revision_policy: string
  payment_info: string
}

export async function saveShopQuoteTerms(shopId: string, next: ShopQuoteTermsInput): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      tax_label: next.tax_label.trim() || 'Tax',
      tax_pct: next.tax_pct,
      quote_valid_days: next.quote_valid_days,
      lead_days: next.lead_days,
      terms_text: next.terms_text.trim() || null,
      revision_policy: next.revision_policy.trim() || null,
      payment_info: next.payment_info.trim() || null,
    })
    .eq('id', shopId)
    .select()
    .single()
  if (error) throw error
  return data as Shop
}

/**
 * Adds a printer when `id` is omitted, otherwise updates the one it names.
 * Printers aren't versioned like rate cards — a sent quote already freezes
 * its own printer snapshot (including watts), so editing one in place cannot
 * move a number on a quote a client already holds.
 */
export async function savePrinter(
  shopId: string,
  next: Omit<PrinterRow, 'id'> & { id?: string },
): Promise<PrinterRow> {
  const row = {
    shop_id: shopId,
    name: next.name.trim(),
    model: next.model.trim() || '—',
    tech: next.tech,
    rate_hourly: next.rate_hourly,
    wear_hourly: next.wear_hourly,
    watts: next.watts,
  }
  const query = next.id
    ? supabase.from('printers').update(row).eq('id', next.id)
    : supabase.from('printers').insert(row)
  const { data, error } = await query.select().single()
  if (error) throw error
  return data as PrinterRow
}

/** GUMA-2026-0184 — sequential within the year, per shop. */
export async function nextJobRef(shopId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `GUMA-${year}-`
  const { data, error } = await supabase
    .from('jobs')
    .select('ref')
    .eq('shop_id', shopId)
    .like('ref', `${prefix}%`)
    .order('ref', { ascending: false })
    .limit(1)
  if (error) throw error
  const last = data?.[0]?.ref
  const n = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1
  return prefix + String(n).padStart(4, '0')
}

export interface SaveQuoteArgs {
  shopId: string
  ref: string
  client: { name: string; contact: string; email: string; phone: string; source: string }
  job: { title: string; brief: string; neededBy: string | null; assetOrigin: string }
  quote: {
    design_billing: 'hourly' | 'flat' | 'none'
    design_qty: number
    revisions_incl: number
    quantity: number
    material_id: string | null
    printer_id: string | null
    units_per_part: number
    print_hrs_part: number
    finishing_hrs: number
    rush: boolean
    flat_each: number
    discount_pct: number
  }
  /** set only when sending — a draft carries no snapshot and no frozen total */
  send?: {
    rates_snapshot: unknown
    total: number
    deposit_due: number
    valid_until: string
  }
}

export interface SavedQuote {
  jobId: string
  clientId: string
  quoteId: string
  ref: string
}

/**
 * Writes the client, the job and the quote. Re-uses a client of the same name
 * in this shop rather than creating a duplicate every time a repeat customer
 * walks in.
 */
export async function saveQuote(args: SaveQuoteArgs): Promise<SavedQuote> {
  const { data: existing } = await supabase
    .from('clients')
    .select('id')
    .eq('shop_id', args.shopId)
    .ilike('name', args.client.name)
    .limit(1)

  let clientId = existing?.[0]?.id as string | undefined
  if (!clientId) {
    const { data, error } = await supabase
      .from('clients')
      .insert({
        shop_id: args.shopId,
        name: args.client.name,
        contact: args.client.contact || null,
        email: args.client.email || null,
        phone: args.client.phone || null,
        source: args.client.source || null,
      })
      .select('id')
      .single()
    if (error) throw error
    clientId = data.id
  } else {
    await supabase
      .from('clients')
      .update({
        contact: args.client.contact || null,
        email: args.client.email || null,
        phone: args.client.phone || null,
      })
      .eq('id', clientId)
  }

  const { data: job, error: jErr } = await supabase
    .from('jobs')
    .insert({
      shop_id: args.shopId,
      ref: args.ref,
      client_id: clientId,
      title: args.job.title,
      brief: args.job.brief || null,
      asset_origin: args.job.assetOrigin,
      needed_by: args.job.neededBy,
      phase: 'intake',
    })
    .select('id')
    .single()
  if (jErr) throw jErr

  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .insert({
      shop_id: args.shopId,
      job_id: job.id,
      version: 1,
      status: args.send ? 'sent' : 'draft',
      ...args.quote,
      rates_snapshot: args.send?.rates_snapshot ?? null,
      total: args.send?.total ?? null,
      deposit_due: args.send?.deposit_due ?? null,
      valid_until: args.send?.valid_until ?? null,
      sent_at: args.send ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (qErr) throw qErr

  if (args.send) {
    await supabase.from('job_events').insert({
      job_id: job.id,
      kind: 'quote_sent',
      body: `Quote ${args.ref} sent · ${args.send.total.toFixed(2)}`,
    })
  }

  return { jobId: job.id, clientId: clientId!, quoteId: quote.id, ref: args.ref }
}

/** A sent quote, re-read for printing. Priced from its OWN snapshot. */
export async function loadQuoteForPrint(quoteId: string) {
  const { data, error } = await supabase
    .from('quotes')
    .select(
      `*, jobs!inner ( id, ref, title, brief, asset_origin, needed_by,
                       clients!inner ( name, contact, email, phone ) ),
          shops!inner ( * )`,
    )
    .eq('id', quoteId)
    .single()
  if (error) throw error
  return data
}
