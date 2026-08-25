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
      }),
    ),
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
