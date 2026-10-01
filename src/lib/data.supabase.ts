/**
 * The hosted backend: everything that talks to Supabase. Rows come back as
 * the shapes the pricing module wants, so no screen ever has to know a
 * column name.
 *
 * This file is never imported directly by a screen — data.ts (the runtime
 * dispatcher) dynamically imports it only when NOT running inside Tauri, so
 * importing `supabase` below (which throws if its env vars are missing —
 * see supabase.ts) never happens in the desktop build once that build stops
 * carrying Supabase secrets.
 */
import { describePartEdit, describeProjectEdits, type ProjectBefore } from './edits'
import { supabase } from './supabase'
import { round2, type MaterialRef, type PrinterRef } from './pricing'
import { feeFor } from './selling'
// validateRun/validateHours/runEventBody live in data.types.ts so both
// backends share one definition and cannot drift on what a valid run is.
import type { SeriesRow, SeriesInput } from './data.types'
import { NeedsSetup, asClientKind, validateRun, validateHours, runEventBody, validateRevision, CHANGE_CAUSE_LABEL, sameSliceFile, type ShopContext, type SetupPayload, type Shop, type RateCardRow, type PrinterRow, type PrinterInput, type Profile } from './data.types'
export {
  NeedsSetup,
  toRateSet,
  asClientKind,
  CLIENT_KINDS,
  CLIENT_KIND_LABEL,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
} from './data.types'
export type {
  Shop,
  RateCardRow,
  PrinterRow,
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopCostsInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
  JobListRow,
  JobKind,
  JobPhase,
  JobPriority,
  ProjectDetail,
  ProjectEvent,
  ProjectFacts,
  ProjectFieldsInput,
  GateAnswer,
  ClientRow,
  ClientEditInput,
  PaymentRow,
  PaymentInput,
  MaterialRow,
  MaterialInput,
  MaterialPurchaseRow,
  MaterialPurchaseInput,
  ProjectActuals,
  QuoteInputsRow,
  PrintRunRow,
  PrintRunInput,
  WorkEntryRow,
  WorkEntryInput,
  PartRow,
  PartVariant,
  RelatedProject,
  PartInput,
  SliceImportInput,
  SliceImportResult,
  SliceImportRow,
  SliceSectionRow,
  PartStatus,
  QuoteStatus,
  ChannelRow,
  ChannelInput,
  ProductRow,
  ProductInput,
  BatchRow,
  BatchInput,
  SaleRow,
  SaleInput,
} from './data.types'
import type {
  ChannelRow,
  ChannelInput,
  ProductRow,
  ProductInput,
  BatchInput,
  SaleRow,
  SaleInput,
  ShopIdentityInput,
  ShopCostsInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
  JobListRow,
  JobPhase,
  JobPriority,
  ProjectDetail,
  ProjectEvent,
  ProjectFacts,
  ProjectFieldsInput,
  GateAnswer,
  ClientRow,
  ClientEditInput,
  PaymentRow,
  PaymentInput,
  MaterialRow,
  MaterialInput,
  MaterialPurchaseRow,
  MaterialPurchaseInput,
  ProjectActuals,
  QuoteInputsRow,
  PrintRunRow,
  PrintRunInput,
  WorkEntryRow,
  WorkEntryInput,
  PartRow,
  PartVariant,
  RelatedProject,
  StockCountInput,
  StockEntry,
  SellBranch,
  PartInput,
  PartStatus,
  QuoteStatus,
  SliceImportInput,
  SliceImportResult,
  SliceImportRow,
  SliceSectionRow,
  QuoteBuildRow,
} from './data.types'

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
      // effective_from is a DATE and rates are versioned by insert, so two
      // cards written on the same day tie on it and the winner is whichever
      // one the planner happens to return -- a rate somebody typed, stored
      // and then never read back. created_at breaks the tie the way a person
      // means it. Same bug, same fix as data.local.ts.
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
    // material_costs embeds so a quote is priced against what the shop
    // actually paid. See data.local.ts's loadShopContext for the reasoning.
    supabase
      .from('materials')
      .select('*, material_costs ( avg_cost_per_unit, basis )')
      .eq('shop_id', profile.shop_id)
      .eq('archived', false)
      .order('name'),
    // Retired machines come back too -- Settings has to be able to show
    // you what you retired. They are filtered out of `printers` below, the
    // list that prices work. See 0014_retire_machines.sql.
    supabase
      .from('printers')
      .select('*')
      .eq('shop_id', profile.shop_id)
      .order('archived')
      .order('name'),
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
        costPerUnit: Number(m.material_costs?.[0]?.avg_cost_per_unit ?? m.cost_per_unit),
        costBasis: (m.material_costs?.[0]?.basis as 'purchases' | 'estimate') ?? 'estimate',
        sellOverride: m.sell_override == null ? null : Number(m.sell_override),
        swatch: m.swatch,
      }),
    ),
    printers: (prnRes.data ?? []).filter((p) => !p.archived).map(
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
export async function saveShopIdentity(shopId: string, next: ShopIdentityInput): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      name: next.name.trim() || 'My shop',
      legal_name: next.legal_name.trim() || null,
      address: next.address.trim() || null,
      // `state` is DELIBERATELY OMITTED here. It isn't a column on the
      // hosted schema yet (see the not-yet-applied 0006_shop_state.sql),
      // and unlike a plain SQL update, PostgREST rejects the ENTIRE request
      // with PGRST204 ("could not find the column in the schema cache") if
      // any key doesn't match a real column -- so sending it would break
      // saving every other field on this form too, not just fail quietly.
      // Once 0006 is applied, add `state: next.state.trim() || null,` here.
      email: next.email.trim() || null,
      phone: next.phone.trim() || null,
      license_no: next.license_no.trim() || null,
      electricity_rate_kwh: next.electricity_rate_kwh,
      currency: next.currency.trim() || 'USD',
      locale: next.locale.trim() || 'en-US',
      // `paper` is omitted for the same PostgREST reason as `state` above --
      // the hosted schema has no such column until 0012_paper.sql is applied.
      // The desktop build, which is the supported one, stores it.
    })
    .eq('id', shopId)
    .select()
    .single()
  if (error) throw error
  return data as Shop
}

/**
 * The cost-of-doing-business figures. Three of the four columns arrive with
 * 0013_true_cost.sql, which has not been applied to a live Postgres — see
 * the PostgREST note on saveShopIdentity for why sending an unknown column
 * fails the WHOLE request rather than one field. The desktop build, which
 * is the supported one, stores all four.
 */
export async function saveShopCosts(shopId: string, next: ShopCostsInput): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({ electricity_rate_kwh: next.electricity_rate_kwh })
    .eq('id', shopId)
    .select()
    .single()
  if (error) throw error
  return data as Shop
}

/** Add a client directly, rather than only as a side effect of a quote. */
export async function createClient(shopId: string, input: ClientEditInput): Promise<string> {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('A client needs a name.')
  const { data: dupes, error: dupeErr } = await supabase
    .from('clients')
    .select('id')
    .eq('shop_id', shopId)
    .eq('system', false)
    .ilike('name', name)
  if (dupeErr) throw dupeErr
  if (dupes && dupes.length > 0) {
    throw new Error(
      `You already have a client called "${name}". Open that one rather than making a second — ` +
        'two clients with one name is how a balance owed goes missing.',
    )
  }
  const { data, error } = await supabase
    .from('clients')
    .insert({
      shop_id: shopId,
      name,
      contact: input.contact?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

/** Delete a client with nothing recorded against them. Same refusal as the
 *  local backend: jobs.client_id does not cascade, on purpose. */
export async function deleteClient(shopId: string, clientId: string): Promise<void> {
  const { count, error: countErr } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
  if (countErr) throw countErr
  const n = count ?? 0
  if (n > 0) {
    throw new Error(
      `That client has ${n} project${n === 1 ? '' : 's'}. Deleting them would take those projects, ` +
        'their payments and their build history with them. Delete the projects first if you mean ' +
        'to, or rename the client instead.',
    )
  }
  const { error } = await supabase.from('clients').delete().eq('id', clientId).eq('shop_id', shopId)
  if (error) throw error
}

/** Tax, validity windows, and the text printed on every quote's terms block. */
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
/** Type-parity stub for the desktop-only welcome dialog (data.local.ts).
 *  The hosted schema doesn't have `show_welcome` yet -- see the mirrored,
 *  not-yet-applied migration in cloud/supabase/migrations/0005_show_welcome.sql
 *  -- so `ctx.shop.show_welcome` reads back undefined/falsy here and this
 *  never actually gets called on the hosted build until that's applied. */
export async function dismissWelcome(shopId: string): Promise<void> {
  const { error } = await supabase.from('shops').update({ show_welcome: false }).eq('id', shopId)
  if (error) throw error
}

/** Guide chapters this shop has been shown. Mirrors data.local's pair; the
 *  hosted table follows the same shape as 0013_guide.sql. A rejection is
 *  treated by callers as "show nothing" rather than surfaced -- guidance is
 *  the first thing to give up when something is wrong. */
export async function listGuideSeen(shopId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('guide_seen')
    .select('chapter')
    .eq('shop_id', shopId)
  if (error) throw error
  return (data ?? []).map((r: { chapter: string }) => r.chapter)
}

export async function markGuideSeen(shopId: string, chapter: string): Promise<void> {
  const { error } = await supabase
    .from('guide_seen')
    .upsert({ shop_id: shopId, chapter }, { onConflict: 'shop_id,chapter' })
  if (error) throw error
}

/** The hidden client an in-house job hangs off. Mirrors data.local's; see
 *  0012_in_house.sql for why in-house work is a job kind rather than a
 *  client, and why the storage still needs a row. */
async function systemClientId(shopId: string): Promise<string> {
  const found = await supabase
    .from('clients')
    .select('id')
    .eq('shop_id', shopId)
    .eq('system', true)
    .limit(1)
  if (found.error) throw found.error
  if (found.data?.[0]) return found.data[0].id

  const made = await supabase
    .from('clients')
    .insert({ shop_id: shopId, name: 'In-house', system: true })
    .select('id')
    .single()
  if (made.error) throw made.error
  return made.data.id
}

/** Work with no client: R&D, test prints, calibration, samples, and the
 *  shop's own product designs. Lands in 'design' rather than 'intake' --
 *  intake is where a client brief becomes a quote, and neither applies. */
export async function createInHouseJob(
  shopId: string,
  input: { title: string; brief?: string | null; relatedTo?: string | null; seriesId?: string | null },
): Promise<string> {
  const title = input.title.trim()
  if (!title) throw new Error('An in-house job needs a title — what are you working on?')

  const clientId = await systemClientId(shopId)
  const ref = await nextJobRef(shopId)
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      shop_id: shopId,
      ref,
      client_id: clientId,
      title,
      brief: input.brief?.trim() || null,
      kind: 'inhouse',
      phase: 'design',
      asset_origin: 'model',
      // Live at birth -- see data.local.ts's createInHouseJob.
      taken_in_at: new Date().toISOString(),
      series_id: input.seriesId ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  if (input.relatedTo) await setRelatedProject(shopId, data.id, input.relatedTo)
  return data.id
}

export async function savePrinter(
  shopId: string,
  next: PrinterInput,
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

/** Retire a machine, or bring it back. See data.local.ts for why this
 *  exists and why it is not a checkbox on the edit form. */
export async function setPrinterRetired(
  shopId: string,
  printerId: string,
  retired: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('printers')
    .update({ archived: retired })
    .eq('id', printerId)
    .eq('shop_id', shopId)
  if (error) throw error
}

/** Delete a machine nothing points at. Refuses, with the counts, for one
 *  that carries build runs or sits on a quote -- same rule and same wording
 *  as the local backend, so the two cannot drift into different answers. */
export async function deletePrinter(shopId: string, printerId: string): Promise<void> {
  const { data: meta, error: metaErr } = await supabase
    .from('printers')
    .select('name')
    .eq('id', printerId)
    .eq('shop_id', shopId)
    .maybeSingle()
  if (metaErr) throw metaErr
  if (!meta) throw new Error('That machine no longer exists.')

  const [runsRes, quotesRes] = await Promise.all([
    supabase.from('print_runs').select('id', { count: 'exact', head: true }).eq('printer_id', printerId),
    supabase.from('quotes').select('id', { count: 'exact', head: true }).eq('printer_id', printerId),
  ])
  if (runsRes.error) throw runsRes.error
  if (quotesRes.error) throw quotesRes.error
  const runs = runsRes.count ?? 0
  const quotes = quotesRes.count ?? 0
  if (runs > 0 || quotes > 0) {
    const held = [
      runs > 0 ? `${runs} build run${runs === 1 ? '' : 's'}` : null,
      quotes > 0 ? `${quotes} quote${quotes === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' and ')
    throw new Error(
      `${meta.name} has ${held} behind it. Deleting it would change what those ` +
        'projects cost after the fact. Retire it instead: it keeps the history and ' +
        'stops appearing when you price new work.',
    )
  }
  const { error } = await supabase
    .from('printers')
    .delete()
    .eq('id', printerId)
    .eq('shop_id', shopId)
  if (error) throw error
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

/**
 * Every project, newest first, with the same attached facts data.local.ts's
 * listJobs returns — see that function for why the flags and the gate are
 * computed on the client from one row rather than by a query per card.
 *
 * `quotes` embeds as an array because PostgREST cannot know from the schema
 * alone that it is 1:1 in practice; take the first. job_money is a view, so
 * it embeds the same way but keyed on job_id.
 */
export async function listJobs(shopId: string): Promise<JobListRow[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_SELECT)
    .eq('shop_id', shopId)
    // See data.local.ts's listJobs: created_at is not a total order.
    .order('created_at', { ascending: false })
    .order('ref', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as any[]
  const [gates, rates] = await Promise.all([
    loadGateAnswers(rows.map((r) => r.id)),
    currentRates(shopId),
  ])
  return rows.map((r) => ({
    ...toJobListRow(r, rates.minimumOrder, rates),
    gateAnswers: gates[r.id]?.[r.phase] ?? {},
  }))
}

const JOB_SELECT = `id, ref, title, brief, kind, created_at, updated_at, taken_in_at, phase, priority,
   asset_origin, poc, needed_by, window_from, window_locked, at_risk, over_ceiling, archived_at, related_to, series_id,
   delivery_on, delivery_how,
   clients!inner ( id, name, kind, contact, email, phone ),
   quotes ( id, status, total, design_billing, design_qty, revisions_incl, quantity,
            material_id, printer_id, units_per_part, print_hrs_part, finishing_hrs,
            rush, flat_each, discount_pct, rates_snapshot ),
   job_money ( deposit_due, deposit_owed, balance_owed ),
   job_parts_summary ( parts, printed, passed, reprint, reprints_ever ),
   batches ( units_made ),
   job_actuals ( material_cost, machine_cost, power_cost, wear_cost, runs,
                 design_hours, finishing_hours, admin_hours, material_units,
                 failed_units, machine_hours, failed_runs ),
   job_events ( at )`

/** The job_actuals embed, folded to the shared shape. */
function actualsFrom(r: any): ProjectActuals {
  const a = r.job_actuals?.[0] ?? {}
  return {
    materialUnits: Number(a.material_units ?? 0),
    failedUnits: Number(a.failed_units ?? 0),
    materialCost: Number(a.material_cost ?? 0),
    machineHours: Number(a.machine_hours ?? 0),
    machineCost: Number(a.machine_cost ?? 0),
    wearCost: Number(a.wear_cost ?? 0),
    powerCost: Number(a.power_cost ?? 0),
    runs: Number(a.runs ?? 0),
    failedRuns: Number(a.failed_runs ?? 0),
    designHours: Number(a.design_hours ?? 0),
    finishingHours: Number(a.finishing_hours ?? 0),
    adminHours: Number(a.admin_hours ?? 0),
  }
}

/** Same arithmetic as data.local.ts's actual_cost column, in TypeScript
 *  because PostgREST cannot express it in an embed. */
function actualCostOf(a: ProjectActuals, designHourly: number, finishingHourly: number): number {
  return (
    a.materialCost +
    (a.powerCost > 0 ? a.powerCost : a.machineCost) +
    a.wearCost +
    a.designHours * designHourly +
    (a.finishingHours + a.adminHours) * finishingHourly
  )
}

function factsFrom(
  r: any,
  minimumOrder: number,
  labour: { designHourly: number; finishingHourly: number } = { designHourly: 0, finishingHourly: 0 },
): ProjectFacts {
  const acts = actualsFrom(r)
  const quote = r.quotes?.[0] ?? null
  // See data.local.ts's factsFrom for why poc falls back to the client's
  // named contact.
  const money = r.job_money?.[0] ?? null
  // Postgres already hands these back as real booleans and real timestamps;
  // the only normalising needed is picking the newest event date.
  const events: string[] = (r.job_events ?? []).map((e: any) => e.at)
  return {
    phase: r.phase,
    kind: r.kind === 'inhouse' ? 'inhouse' : 'client',
    priority: r.priority,
    createdAt: r.created_at,
    takenInAt: r.taken_in_at ?? null,
    neededBy: r.needed_by ?? null,
    windowFrom: r.window_from ?? null,
    windowLocked: r.window_locked === true,
    atRisk: r.at_risk === true,
    overCeiling: (r.over_ceiling as string | null) ?? null,
    deliveryOn: r.delivery_on ?? null,
    deliveryHow: r.delivery_how ?? null,
    brief: r.brief ?? null,
    poc: r.poc ?? r.clients?.contact ?? null,
    quoteStatus: (quote?.status as QuoteStatus | undefined) ?? null,
    quoteTotal: quote?.total == null ? null : Number(quote.total),
    depositDue: Number(money?.deposit_due ?? 0),
    depositOwed: Number(money?.deposit_owed ?? 0),
    balanceOwed: Number(money?.balance_owed ?? 0),
    lastActivityAt: events.length ? events.reduce((a, b) => (a > b ? a : b)) : null,
    minimumOrder,
    actualCost: actualCostOf(acts, labour.designHourly, labour.finishingHourly),
    hasActuals:
      acts.runs > 0 || acts.designHours + acts.finishingHours + acts.adminHours > 0,
    actualRuns: acts.runs,
    actualHours: acts.designHours + acts.finishingHours + acts.adminHours,
    machineHours: acts.machineHours,
    materialUnits: acts.materialUnits,
    failedUnits: acts.failedUnits,
    parts: Number(r.job_parts_summary?.[0]?.parts ?? 0),
    partsPrinted: Number(r.job_parts_summary?.[0]?.printed ?? 0),
    partsPassed: Number(r.job_parts_summary?.[0]?.passed ?? 0),
    partsReprint: Number(r.job_parts_summary?.[0]?.reprint ?? 0),
    reprintsEver: Number(r.job_parts_summary?.[0]?.reprints_ever ?? 0),
    archivedAt: r.archived_at ?? null,
    relatedTo: r.related_to ?? null,
    seriesId: (r.series_id as string | null) ?? null,
    unitsMade: ((r.batches ?? []) as { units_made: number }[]).reduce(
      (a, b) => a + Number(b.units_made ?? 0),
      0,
    ),
  }
}

function toJobListRow(
  r: any,
  minimumOrder = 0,
  labour: { designHourly: number; finishingHourly: number } = { designHourly: 0, finishingHourly: 0 },
): Omit<JobListRow, 'gateAnswers'> {
  const quote = r.quotes?.[0] ?? null
  return {
    jobId: r.id,
    ref: r.ref,
    title: r.title,
    clientId: r.clients.id,
    clientName: r.clients.name,
    clientKind: asClientKind(r.clients.kind),
    createdAt: r.created_at,
    phase: r.phase,
    priority: r.priority,
    quoteId: quote?.id ?? null,
    quoteStatus: quote?.status ?? null,
    total: quote?.total == null ? null : Number(quote.total),
    facts: factsFrom(r, minimumOrder, labour),
  }
}

/** job_id -> phase -> item key -> answer, in one round trip. */
async function loadGateAnswers(
  jobIds: string[],
): Promise<Record<string, Record<string, Record<string, GateAnswer>>>> {
  const out: Record<string, Record<string, Record<string, GateAnswer>>> = {}
  if (jobIds.length === 0) return out
  const { data, error } = await supabase
    .from('job_gates')
    .select('job_id, phase, item_key, checked, note')
    .in('job_id', jobIds)
  if (error) throw error
  for (const r of (data ?? []) as any[]) {
    const byPhase = (out[r.job_id] ??= {})
    const byKey = (byPhase[r.phase] ??= {})
    byKey[r.item_key] = { checked: r.checked === true, note: r.note ?? null }
  }
  return out
}

/** See data.local.ts's updateJobPhase — same contract, Postgres-side. */
export async function updateJobPhase(
  shopId: string,
  jobId: string,
  actorId: string,
  toPhase: JobPhase,
  note: string | null = null,
): Promise<void> {
  const { data: job, error: readErr } = await supabase
    .from('jobs')
    .select('phase')
    .eq('id', jobId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  const fromPhase = job?.phase as JobPhase | undefined
  if (!fromPhase || fromPhase === toPhase) return

  const { error: updErr } = await supabase
    .from('jobs')
    .update({
      phase: toPhase,
      updated_at: new Date().toISOString(),
      ...(toPhase === 'delivered' ? {} : { archived_at: null }),
    })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (updErr) throw updErr

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'phase_change',
    from_phase: fromPhase,
    to_phase: toPhase,
    body: note?.trim() || null,
  })
  if (evErr) throw evErr
}

/** See data.local.ts's updateJobPriority — no event log, same reasoning. */
export async function updateJobPriority(
  shopId: string,
  jobId: string,
  priority: JobPriority,
): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({ priority })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (error) throw error
}

/**
 * Writes the client, the job and the quote. Re-uses a client of the same name
 * in this shop rather than creating a duplicate every time a repeat customer
 * walks in.
 */
/** The build lines of one quote. Shared by a first quote and a revision,
 *  so the two cannot write them differently. */
async function writeQuoteBuilds(quoteId: string, builds: SaveQuoteArgs['builds']): Promise<void> {
  if (!builds?.length) return
  const rows = builds
    .map((b, i) => ({ b, label: b.label.trim(), i }))
    .filter(({ label }) => !!label)
    .map(({ b, label, i }) => ({
      quote_id: quoteId,
      kind: b.kind ?? 'print',
      label,
      printer_id: b.printerId,
      material_id: b.materialId,
      qty: Math.max(1, Math.floor(Number(b.qty) || 1)),
      units_per_part: Number(b.unitsPerPart) || 0,
      print_hrs_part: Number(b.printHrsPerPart) || 0,
      slice_import_id: b.sliceImportId ?? null,
      sort: i,
    }))
  if (!rows.length) return
  const { error } = await supabase.from('quote_builds').insert(rows)
  if (error) throw error
}

/** See data.local.ts's reviseQuote. */
async function reviseQuote(args: SaveQuoteArgs, jobId: string): Promise<SavedQuote> {
  const { data: job, error: jErr } = await supabase
    .from('jobs')
    .select('id, ref, client_id')
    .eq('id', jobId)
    .eq('shop_id', args.shopId)
    .single()
  if (jErr) throw jErr
  if (!job) throw new Error('That project no longer exists.')

  const { data: accepted } = await supabase
    .from('quotes')
    .select('total')
    .eq('job_id', jobId)
    .eq('status', 'accepted')
    .order('version', { ascending: false })
    .limit(1)
  const change = validateRevision(
    accepted?.[0]?.total == null ? null : Number(accepted[0].total),
    args.send?.total ?? null,
    args.change,
  )

  const { data: top } = await supabase
    .from('quotes')
    .select('version')
    .eq('job_id', jobId)
    .order('version', { ascending: false })
    .limit(1)
  const version = Number(top?.[0]?.version ?? 0) + 1

  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .insert({
      shop_id: args.shopId,
      job_id: jobId,
      version,
      status: args.send ? 'sent' : 'draft',
      design_billing: args.quote.design_billing,
      design_qty: args.quote.design_qty,
      revisions_incl: args.quote.revisions_incl,
      quantity: args.quote.quantity,
      material_id: args.quote.material_id,
      printer_id: args.quote.printer_id,
      units_per_part: args.quote.units_per_part,
      print_hrs_part: args.quote.print_hrs_part,
      finishing_hrs: args.quote.finishing_hrs,
      rush: args.quote.rush,
      flat_each: args.quote.flat_each,
      discount_pct: args.quote.discount_pct,
      rates_snapshot: args.send ? args.send.rates_snapshot : null,
      total: args.send?.total ?? null,
      deposit_due: args.send?.deposit_due ?? null,
      valid_until: args.send?.valid_until ?? null,
      sent_at: args.send ? new Date().toISOString() : null,
      change_cause: change?.cause ?? null,
      change_reason: change?.reason ?? null,
    })
    .select('id')
    .single()
  if (qErr) throw qErr

  await writeQuoteBuilds(quote.id as string, args.builds)

  const { error: upErr } = await supabase
    .from('jobs')
    .update({
      title: args.job.title,
      brief: args.job.brief || null,
      needed_by: args.job.neededBy,
      asset_origin: args.job.assetOrigin,
      // See data.local.ts: a change order above the accepted price flags
      // the project until someone clears it.
      ...(change
        ? {
            over_ceiling: `Quote v${version} is ${(args.send?.total ?? 0).toFixed(2)}, above the price the client accepted — ${CHANGE_CAUSE_LABEL[change.cause]}: ${change.reason}`,
          }
        : {}),
    })
    .eq('id', jobId)
    .eq('shop_id', args.shopId)
  if (upErr) throw upErr

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    kind: 'quote_sent',
    body: change
      ? `Quote revised to v${version} · ${(args.send?.total ?? 0).toFixed(2)} — above the accepted price: ${CHANGE_CAUSE_LABEL[change.cause]} (${change.reason})`
      : `Quote revised to v${version}${args.send ? ` · ${args.send.total.toFixed(2)}` : ' (draft)'}`,
  })
  if (evErr) throw evErr

  return {
    jobId,
    clientId: job.client_id as string,
    quoteId: quote.id as string,
    ref: job.ref as string,
  }
}

export async function saveQuote(args: SaveQuoteArgs): Promise<SavedQuote> {
  // See data.local.ts's reviseQuote: same project, same client, next
  // version, and the accepted row left exactly as the client saw it.
  if (args.reviseJobId) return reviseQuote(args, args.reviseJobId)

  const { data: existing } = await supabase
    .from('clients')
    .select('id')
    .eq('shop_id', args.shopId)
    // A client typed as "In-house" must get a real client row, never the
    // hidden one in-house jobs hang off. Same filter as data.local.ts.
    .eq('system', false)
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

  // Build lines, when the quote has them. See 0020_quote_builds.sql -- a
  // quote with rows here is described BY them, and the single-machine
  // columns on it are ignored rather than mirrored.
  await writeQuoteBuilds(quote.id as string, args.builds)

  return { jobId: job.id, clientId: clientId!, quoteId: quote.id, ref: args.ref }
}

export async function listQuoteBuilds(quoteId: string): Promise<QuoteBuildRow[]> {
  const { data, error } = await supabase
    .from('quote_builds')
    .select(
      'id, kind, label, printer_id, material_id, qty, units_per_part, print_hrs_part, slice_import_id, sort',
    )
    .eq('quote_id', quoteId)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as 'print',
    label: r.label as string,
    printerId: r.printer_id as string | null,
    materialId: r.material_id as string | null,
    qty: Number(r.qty),
    unitsPerPart: Number(r.units_per_part),
    printHrsPerPart: Number(r.print_hrs_part),
    sliceImportId: r.slice_import_id as string | null,
    sort: Number(r.sort),
  }))
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

/* ------------------------------------------------------------------ */
/* Project detail, stage gates, clients                                */
/* ------------------------------------------------------------------ */

/** The live rate card's minimum_order, for the under-minimum flag. Its own
 *  query because it is one number per shop, not per project. */
async function currentRates(
  shopId: string,
): Promise<{ minimumOrder: number; designHourly: number; finishingHourly: number }> {
  const { data, error } = await supabase
    .from('rate_cards')
    .select('minimum_order, design_hourly, finishing_hourly')
    .eq('shop_id', shopId)
    // Same-day tie-break as loadShopContext above.
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const r = data?.[0]
  return {
    minimumOrder: Number(r?.minimum_order ?? 0),
    designHourly: Number(r?.design_hourly ?? 0),
    finishingHourly: Number(r?.finishing_hourly ?? 0),
  }
}

/** See data.local.ts's loadProjectDetail — same contract, Postgres-side. */
export async function loadProjectDetail(shopId: string, jobId: string): Promise<ProjectDetail> {
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_SELECT)
    .eq('shop_id', shopId)
    .eq('id', jobId)
    .single()
  if (error) throw error
  const r = data as any
  if (!r) throw new Error('That project no longer exists.')

  const [gates, rates, events, payments, runs, work, parts, partHistory, slices, family, variantRows] =
    await Promise.all([
    loadGateAnswers([jobId]),
    currentRates(shopId),
    supabase
      .from('job_events')
      .select('id, kind, body, from_phase, to_phase, at, profiles ( full_name )')
      .eq('job_id', jobId)
      .order('at', { ascending: false }),
    supabase
      .from('payments')
      .select('id, kind, amount, method, received_on, note, profiles ( full_name )')
      .eq('job_id', jobId)
      .order('received_on', { ascending: false }),
    supabase
      .from('print_runs')
      .select(
        `id, units_used, hours, outcome, failure_reason, note, started_at, ended_at,
         slice_import_id,
         printers ( id, name ), materials ( id, name, unit ), profiles ( full_name )`,
      )
      .eq('job_id', jobId)
      .order('started_at', { ascending: false }),
    supabase
      .from('work_log')
      .select('id, kind, hours, worked_on, note, profiles ( full_name )')
      .eq('job_id', jobId)
      .order('worked_on', { ascending: false }),
    supabase
      .from('job_parts')
      .select('id, label, qty, status, note, sort, chosen_section_id')
      .eq('job_id', jobId)
      .order('sort'),
    supabase
      .from('part_events')
      .select('id, part_id, kind, from_status, to_status, note, at, profiles ( full_name )')
      .eq('job_id', jobId)
      .order('at', { ascending: false }),
    listSliceImports(shopId, jobId),
    supabase
      .from('jobs')
      .select('id, ref, title, phase, kind, archived_at, related_to, job_actuals ( design_hours )')
      .eq('shop_id', shopId)
      .or(`related_to.eq.${jobId},id.eq.${jobId}`),
    supabase
      .from('slice_sections')
      .select(
        `id, part_id, est_minutes, est_grams, material,
         slice_imports!inner ( id, job_id, file_name, printer_model, printer_id, imported_at,
                               printers ( name ) )`,
      )
      .eq('slice_imports.job_id', jobId)
      .order('id'),
  ])
  if (events.error) throw events.error
  if (payments.error) throw payments.error
  if (runs.error) throw runs.error
  if (work.error) throw work.error
  if (parts.error) throw parts.error
  if (partHistory.error) throw partHistory.error
  if (variantRows.error) throw variantRows.error
  if (family.error) throw family.error

  const toRelated = (x: any): RelatedProject => ({
    jobId: x.id,
    ref: x.ref,
    title: x.title,
    phase: x.phase,
    kind: x.kind,
    designHours: Number(x.job_actuals?.[0]?.design_hours ?? 0),
    archivedAt: x.archived_at ?? null,
  })
  const kin = (family.data ?? []) as any[]
  // The parent needs its own fetch only when it is not already in hand --
  // which it is not, since the or() above reaches children and self.
  let parent: RelatedProject | null = null
  if (r.related_to) {
    const { data: p, error: pErr } = await supabase
      .from('jobs')
      .select('id, ref, title, phase, kind, archived_at, job_actuals ( design_hours )')
      .eq('shop_id', shopId)
      .eq('id', r.related_to)
      .maybeSingle()
    if (pErr) throw pErr
    parent = p ? toRelated(p) : null
  }

  // plate size: how many objects came off the same file. Counted here
  // rather than in SQL because the rows are already in hand.
  const plateOf = new Map<string, number>()
  for (const v of (variantRows.data ?? []) as any[]) {
    const id = v.slice_imports?.id
    if (id) plateOf.set(id, (plateOf.get(id) ?? 0) + 1)
  }

  const quote = r.quotes?.[0] ?? null
  return {
    jobId: r.id,
    ref: r.ref,
    title: r.title,
    brief: r.brief ?? null,
    phase: r.phase,
    priority: r.priority,
    assetOrigin: r.asset_origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    client: {
      id: r.clients.id,
      name: r.clients.name,
      kind: asClientKind(r.clients.kind),
      contact: r.clients.contact ?? null,
      email: r.clients.email ?? null,
      phone: r.clients.phone ?? null,
    },
    quote: quote ? { id: quote.id, status: quote.status, total: quote.total ?? null } : null,
    facts: factsFrom(r, rates.minimumOrder, rates),
    actuals: actualsFrom(r),
    quoteInputs: quote ? quoteInputsFrom(quote) : null,
    runs: ((runs.data ?? []) as any[]).map(
      (x): PrintRunRow => ({
        id: x.id,
        printerId: x.printers?.id ?? null,
        printerName: x.printers?.name ?? null,
        materialId: x.materials?.id ?? null,
        materialName: x.materials?.name ?? null,
        unit: x.materials?.unit ?? null,
        unitsUsed: x.units_used == null ? null : Number(x.units_used),
        hours: x.hours == null ? null : Number(x.hours),
        outcome: x.outcome ?? null,
        failureReason: x.failure_reason ?? null,
        note: x.note ?? null,
        startedAt: x.started_at ?? null,
        endedAt: x.ended_at ?? null,
        operator: x.profiles?.full_name ?? null,
        sliceImportId: x.slice_import_id ?? null,
      }),
    ),
    slices,
    relatedTo: parent,
    related: kin.filter((x) => x.id !== jobId).map(toRelated),
    work: ((work.data ?? []) as any[]).map(
      (x): WorkEntryRow => ({
        id: x.id,
        kind: x.kind,
        hours: Number(x.hours),
        workedOn: x.worked_on,
        note: x.note ?? null,
        actor: x.profiles?.full_name ?? null,
      }),
    ),
    parts: ((parts.data ?? []) as any[]).map(
      (x): PartRow => ({
        id: x.id,
        label: x.label,
        qty: Number(x.qty),
        status: x.status,
        note: x.note ?? null,
        sort: Number(x.sort ?? 0),
        chosenSectionId: x.chosen_section_id ?? null,
        variants: ((variantRows.data ?? []) as any[])
          .filter((v) => v.part_id === x.id)
          .map((v): PartVariant => ({
            sectionId: v.id,
            importId: v.slice_imports?.id,
            fileName: v.slice_imports?.file_name ?? '',
            printerModel: v.slice_imports?.printer_model ?? null,
            printerId: v.slice_imports?.printer_id ?? null,
            printerName: v.slice_imports?.printers?.name ?? null,
            estMinutes: v.est_minutes == null ? null : Number(v.est_minutes),
            estGrams: v.est_grams == null ? null : Number(v.est_grams),
            material: v.material ?? null,
            importedAt: v.slice_imports?.imported_at ?? '',
            plateParts: plateOf.get(v.slice_imports?.id) ?? 1,
          }))
          .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1)),
        history: ((partHistory.data ?? []) as any[])
          .filter((e) => e.part_id === x.id)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            fromStatus: e.from_status ?? null,
            toStatus: e.to_status ?? null,
            note: e.note ?? null,
            actor: e.profiles?.full_name ?? null,
            at: e.at,
          })),
      }),
    ),
    gates: gates[jobId] ?? {},
    payments: ((payments.data ?? []) as any[]).map(
      (p): PaymentRow => ({
        id: p.id,
        kind: p.kind,
        amount: Number(p.amount),
        method: p.method,
        receivedOn: p.received_on,
        note: p.note ?? null,
        recordedBy: p.profiles?.full_name ?? null,
      }),
    ),
    events: ((events.data ?? []) as any[]).map(
      (e): ProjectEvent => ({
        id: e.id,
        kind: e.kind,
        body: e.body ?? null,
        fromPhase: e.from_phase ?? null,
        toPhase: e.to_phase ?? null,
        at: e.at,
        actorName: e.profiles?.full_name ?? null,
      }),
    ),
  }
}

/** See data.local.ts's setGateItem — same upsert, same reasoning about why
 *  the item key is never validated against gates.ts. */
export async function setGateItem(
  _shopId: string,
  jobId: string,
  actorId: string,
  phase: JobPhase,
  itemKey: string,
  checked: boolean,
  note: string | null,
): Promise<void> {
  const { error } = await supabase.from('job_gates').upsert(
    {
      job_id: jobId,
      phase,
      item_key: itemKey,
      checked,
      note,
      actor_id: actorId,
      at: new Date().toISOString(),
    },
    { onConflict: 'job_id,phase,item_key' },
  )
  if (error) throw error
}

/** See data.local.ts's addProjectNote. */
export async function addProjectNote(jobId: string, actorId: string, body: string): Promise<void> {
  const text = body.trim()
  if (!text) return
  const { error } = await supabase
    .from('job_events')
    .insert({ job_id: jobId, actor_id: actorId, kind: 'note', body: text })
  if (error) throw error
  const { error: updErr } = await supabase
    .from('jobs')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', jobId)
  if (updErr) throw updErr
}

/** See data.local.ts's updateProjectFields — present keys only. */
export async function updateProjectFields(
  shopId: string,
  jobId: string,
  fields: ProjectFieldsInput,
  actorId: string | null = null,
): Promise<void> {
  const map: Record<string, string> = {
    brief: 'brief',
    title: 'title',
    poc: 'poc',
    neededBy: 'needed_by',
    windowFrom: 'window_from',
    windowLocked: 'window_locked',
    atRisk: 'at_risk',
    deliveryOn: 'delivery_on',
    deliveryHow: 'delivery_how',
    priority: 'priority',
    overCeiling: 'over_ceiling',
  }
  const row: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) row[column] = (fields as Record<string, unknown>)[key] ?? null
  }
  if (Object.keys(row).length === 0) return
  row.updated_at = new Date().toISOString()
  const { data: before, error: readErr } = await supabase
    .from('jobs')
    .select('title, brief, poc, needed_by, window_from, window_locked, at_risk, delivery_on, delivery_how, priority, over_ceiling')
    .eq('id', jobId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  const { error } = await supabase.from('jobs').update(row).eq('id', jobId).eq('shop_id', shopId)
  if (error) throw error
  const said = describeProjectEdits(before as ProjectBefore, fields)
  if (said.length > 0) {
    const { error: evErr } = await supabase
      .from('job_events')
      .insert({ job_id: jobId, actor_id: actorId, kind: 'edit', body: said.join(' ') })
    if (evErr) throw evErr
  }
}

/**
 * See data.local.ts's listClients for what `value` counts and why.
 *
 * PostgREST has no GROUP BY, so the rollups are done here over an embed
 * rather than in SQL. A shop's client list is tens of rows, not thousands;
 * the alternative is a database view that would then need its own migration
 * and its own RLS policy to say the same thing.
 */
export async function listClients(shopId: string): Promise<ClientRow[]> {
  const { data, error } = await supabase
    .from('clients')
    .select(
      `id, name, kind, contact, email, phone,
       jobs ( id, phase, quotes ( status, total ), job_money ( balance_owed ), job_events ( at ) )`,
    )
    .eq('shop_id', shopId)
    // The in-house row is a storage detail, not a client. See 0017_in_house.sql.
    .eq('system', false)
    .order('name')
  if (error) throw error
  return ((data ?? []) as any[]).map((c) => {
    const jobs: any[] = c.jobs ?? []
    let value = 0
    let owed = 0
    let last: string | null = null
    for (const j of jobs) {
      const q = j.quotes?.[0]
      if (q && (q.status === 'sent' || q.status === 'accepted')) value += Number(q.total ?? 0)
      owed += Number(j.job_money?.[0]?.balance_owed ?? 0)
      for (const e of j.job_events ?? []) if (!last || e.at > last) last = e.at
    }
    return {
      id: c.id,
      name: c.name,
      kind: asClientKind(c.kind),
      contact: c.contact ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      projects: jobs.length,
      active: jobs.filter((j) => j.phase !== 'delivered').length,
      value,
      owed,
      lastActivity: last,
    }
  })
}

/** See data.local.ts's updateClientRecord — present keys only. */
export async function updateClientRecord(
  shopId: string,
  clientId: string,
  input: ClientEditInput,
): Promise<void> {
  const allowed = ['name', 'kind', 'contact', 'email', 'phone'] as const
  const row: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in input) row[key] = (input as Record<string, unknown>)[key] ?? null
  }
  if (Object.keys(row).length === 0) return
  const { error } = await supabase
    .from('clients')
    .update(row)
    .eq('id', clientId)
    .eq('shop_id', shopId)
  if (error) throw error
}

/** See data.local.ts's recordPayment — append-only, same reasoning. */
export async function recordPayment(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PaymentInput,
): Promise<string> {
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('A payment needs an amount greater than zero.')
  }
  const { data, error } = await supabase
    .from('payments')
    .insert({
      shop_id: shopId,
      job_id: jobId,
      quote_id: input.quoteId,
      kind: input.kind,
      amount,
      method: input.method,
      received_on: input.receivedOn,
      note: input.note,
      recorded_by: actorId,
    })
    .select('id')
    .single()
  if (error) throw error

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'payment',
    body: `${input.kind} of ${amount.toFixed(2)} by ${input.method}${input.note ? ` — ${input.note}` : ''}`,
  })
  if (evErr) throw evErr
  return data.id as string
}

/* ------------------------------------------------------------------ */
/* Materials and what they actually cost                               */
/* ------------------------------------------------------------------ */

const MATERIAL_SELECT = `id, name, kind, swatch, unit, cost_per_unit, sell_override,
   on_hand, reorder_at, archived,
   material_costs ( avg_cost_per_unit, basis, purchases, purchased_qty,
                    purchased_spend, last_cost_per_unit, last_purchased_on )`

function toMaterialRow(m: any): MaterialRow {
  const c = m.material_costs?.[0] ?? {}
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    swatch: m.swatch,
    unit: m.unit,
    costPerUnit: Number(m.cost_per_unit),
    sellOverride: m.sell_override == null ? null : Number(m.sell_override),
    onHand: Number(m.on_hand ?? 0),
    reorderAt: Number(m.reorder_at ?? 0),
    archived: m.archived === true,
    avgCostPerUnit: Number(c.avg_cost_per_unit ?? m.cost_per_unit),
    costBasis: (c.basis as 'purchases' | 'estimate') ?? 'estimate',
    purchases: Number(c.purchases ?? 0),
    purchasedQty: Number(c.purchased_qty ?? 0),
    purchasedSpend: Number(c.purchased_spend ?? 0),
    lastCostPerUnit: c.last_cost_per_unit == null ? null : Number(c.last_cost_per_unit),
    lastPurchasedOn: c.last_purchased_on ?? null,
  }
}

/** See data.local.ts's listMaterials — archived rows included on purpose. */
export async function listMaterials(shopId: string): Promise<MaterialRow[]> {
  const { data, error } = await supabase
    .from('materials')
    .select(MATERIAL_SELECT)
    .eq('shop_id', shopId)
    .order('archived')
    .order('name')
  if (error) throw error
  return ((data ?? []) as any[]).map(toMaterialRow)
}

/** See data.local.ts's saveSellBranch. */
export async function saveSellBranch(shopId: string, branch: SellBranch | null): Promise<void> {
  const { error } = await supabase.from('shops').update({ sell_branch: branch }).eq('id', shopId)
  if (error) throw error
}

/** See data.local.ts's saveMaterial, including why on_hand is writable. */
export async function saveMaterial(shopId: string, next: MaterialInput): Promise<MaterialRow> {
  const name = next.name.trim()
  if (!name) throw new Error('A material needs a name.')
  const row: Record<string, unknown> = {
    shop_id: shopId,
    name,
    kind: next.kind,
    swatch: next.swatch,
    unit: next.unit,
    cost_per_unit: next.costPerUnit,
    sell_override: next.sellOverride,
    archived: next.archived === true,
  }
  // Null on an update leaves the stock alone -- see MaterialInput.onHand.
  if (next.onHand != null || !next.id) row.on_hand = next.onHand ?? 0
  if (next.reorderAt != null || !next.id) row.reorder_at = next.reorderAt ?? 0
  const query = next.id
    ? supabase.from('materials').update(row).eq('id', next.id).eq('shop_id', shopId)
    : supabase.from('materials').insert(row)
  const { data, error } = await query.select(MATERIAL_SELECT).single()
  if (error) throw error
  return toMaterialRow(data)
}

/** See data.local.ts's recordStockCount. */
export async function recordStockCount(
  shopId: string,
  materialId: string,
  actorId: string,
  input: StockCountInput,
): Promise<{ id: string; delta: number }> {
  const counted = Number(input.counted)
  if (!Number.isFinite(counted) || counted < 0) {
    throw new Error('A count is zero or more — weigh what is actually there.')
  }
  const { data: m, error: mErr } = await supabase
    .from('materials')
    .select('on_hand')
    .eq('id', materialId)
    .eq('shop_id', shopId)
    .single()
  if (mErr) throw mErr
  const delta = Math.round((counted - Number(m.on_hand ?? 0)) * 1000) / 1000
  const { data, error } = await supabase
    .from('material_counts')
    .insert({
      shop_id: shopId,
      material_id: materialId,
      counted_on: input.countedOn,
      counted_qty: counted,
      delta,
      note: input.note,
      recorded_by: actorId,
    })
    .select('id')
    .single()
  if (error) throw error
  return { id: data.id as string, delta }
}

/** See data.local.ts's listMaterialLedger. */
export async function listMaterialLedger(
  shopId: string,
  materialId: string,
): Promise<StockEntry[]> {
  const [p, r, c] = await Promise.all([
    supabase
      .from('material_purchases')
      .select('id, purchased_on, qty, total_cost, note, supplier')
      .eq('shop_id', shopId)
      .eq('material_id', materialId),
    supabase
      .from('print_runs')
      .select('id, started_at, consumed_at, units_used, outcome, failure_reason, jobs ( id, ref, title )')
      .eq('shop_id', shopId)
      .eq('material_id', materialId)
      .gt('units_used', 0),
    supabase
      .from('material_counts')
      .select('id, counted_on, counted_qty, delta, note')
      .eq('shop_id', shopId)
      .eq('material_id', materialId),
  ])
  if (p.error) throw p.error
  if (r.error) throw r.error
  if (c.error) throw c.error
  const out: StockEntry[] = [
    ...((p.data ?? []) as any[]).map(
      (x): StockEntry => ({
        id: x.id,
        kind: 'purchase',
        on: String(x.purchased_on).slice(0, 10),
        qty: Number(x.qty),
        cost: Number(x.total_cost),
        jobId: null,
        jobRef: null,
        jobTitle: null,
        outcome: null,
        counted: null,
        note: [x.supplier, x.note].filter(Boolean).join(' · ') || null,
      }),
    ),
    ...((r.data ?? []) as any[]).map(
      (x): StockEntry => ({
        id: x.id,
        kind: 'print',
        on: String(x.started_at ?? x.consumed_at ?? '').slice(0, 10),
        qty: -Number(x.units_used),
        cost: null,
        jobId: x.jobs?.id ?? null,
        jobRef: x.jobs?.ref ?? null,
        jobTitle: x.jobs?.title ?? null,
        outcome: x.outcome ?? null,
        counted: null,
        note: x.failure_reason ?? null,
      }),
    ),
    ...((c.data ?? []) as any[]).map(
      (x): StockEntry => ({
        id: x.id,
        kind: 'count',
        on: String(x.counted_on).slice(0, 10),
        qty: Number(x.delta),
        cost: null,
        jobId: null,
        jobRef: null,
        jobTitle: null,
        outcome: null,
        counted: Number(x.counted_qty),
        note: x.note ?? null,
      }),
    ),
  ]
  return out.sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0))
}

/** See data.local.ts's recordMaterialPurchase. */
export async function recordMaterialPurchase(
  shopId: string,
  materialId: string,
  actorId: string,
  input: MaterialPurchaseInput,
): Promise<string> {
  const qty = Number(input.qty)
  const cost = Number(input.totalCost)
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('A purchase needs a quantity greater than zero.')
  }
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error('A purchase needs a cost of zero or more.')
  }
  const { data, error } = await supabase
    .from('material_purchases')
    .insert({
      shop_id: shopId,
      material_id: materialId,
      purchased_on: input.purchasedOn,
      qty,
      total_cost: cost,
      supplier: input.supplier,
      note: input.note,
      recorded_by: actorId,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function listMaterialPurchases(
  shopId: string,
  materialId: string,
): Promise<MaterialPurchaseRow[]> {
  const { data, error } = await supabase
    .from('material_purchases')
    .select('id, material_id, purchased_on, qty, total_cost, supplier, note, profiles ( full_name )')
    .eq('shop_id', shopId)
    .eq('material_id', materialId)
    .order('purchased_on', { ascending: false })
  if (error) throw error
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    materialId: r.material_id,
    purchasedOn: r.purchased_on,
    qty: Number(r.qty),
    totalCost: Number(r.total_cost),
    costPerUnit: Number(r.qty) > 0 ? Number(r.total_cost) / Number(r.qty) : 0,
    supplier: r.supplier ?? null,
    note: r.note ?? null,
    recordedBy: r.profiles?.full_name ?? null,
  }))
}

/** See data.local.ts's deleteMaterialPurchase for why this one deletes
 *  where payments refund. */
export async function deleteMaterialPurchase(shopId: string, purchaseId: string): Promise<void> {
  const { error } = await supabase
    .from('material_purchases')
    .delete()
    .eq('id', purchaseId)
    .eq('shop_id', shopId)
  if (error) throw error
}

/** The quote row's pricing inputs, in the shape the project page needs to
 *  reprice it from its own frozen snapshot. */
function quoteInputsFrom(q: any): QuoteInputsRow {
  return {
    designBilling: q.design_billing,
    designQty: Number(q.design_qty ?? 0),
    revisionsIncl: Number(q.revisions_incl ?? 0),
    quantity: Number(q.quantity ?? 1),
    materialId: q.material_id ?? null,
    printerId: q.printer_id ?? null,
    unitsPerPart: Number(q.units_per_part ?? 0),
    printHrsPart: Number(q.print_hrs_part ?? 0),
    finishingHrs: Number(q.finishing_hrs ?? 0),
    rush: q.rush === true,
    flatEach: Number(q.flat_each ?? 0),
    discountPct: Number(q.discount_pct ?? 0),
    // jsonb comes back parsed already, unlike SQLite's TEXT column.
    ratesSnapshot: q.rates_snapshot ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* Build runs and work hours                                           */
/* ------------------------------------------------------------------ */

/** See data.local.ts's recordPrintRun. */
export async function recordPrintRun(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PrintRunInput,
): Promise<string> {
  const { hours, unitsUsed } = validateRun(input)
  const { data, error } = await supabase
    .from('print_runs')
    .insert({
      shop_id: shopId,
      job_id: jobId,
      printer_id: input.printerId,
      material_id: input.materialId,
      units_used: unitsUsed,
      hours,
      outcome: input.outcome,
      failure_reason: input.failureReason,
      note: input.note,
      started_at: input.startedAt,
      operator_id: actorId,
      slice_import_id: input.sliceImportId ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'run',
    body: runEventBody(input),
  })
  if (evErr) throw evErr
  return data.id as string
}

export async function deletePrintRun(shopId: string, runId: string): Promise<void> {
  const { error } = await supabase.from('print_runs').delete().eq('id', runId).eq('shop_id', shopId)
  if (error) throw error
}

/** See data.local.ts's logWork. */
export async function logWork(
  shopId: string,
  jobId: string,
  actorId: string,
  input: WorkEntryInput,
): Promise<string> {
  const hours = validateHours(input.hours)
  const { data, error } = await supabase
    .from('work_log')
    .insert({
      shop_id: shopId,
      job_id: jobId,
      kind: input.kind,
      hours,
      worked_on: input.workedOn,
      note: input.note,
      actor_id: actorId,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function deleteWorkEntry(shopId: string, entryId: string): Promise<void> {
  const { error } = await supabase.from('work_log').delete().eq('id', entryId).eq('shop_id', shopId)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* The build sheet                                                     */
/* ------------------------------------------------------------------ */

/** See data.local.ts's addPart. */
export async function addPart(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PartInput,
): Promise<string> {
  const label = input.label.trim()
  if (!label) throw new Error('A part needs a name.')
  const qty = Math.floor(Number(input.qty))
  if (!Number.isFinite(qty) || qty < 1) throw new Error('A part needs at least one copy.')

  const { data: last } = await supabase
    .from('job_parts')
    .select('sort')
    .eq('job_id', jobId)
    .order('sort', { ascending: false })
    .limit(1)

  const { data, error } = await supabase
    .from('job_parts')
    .insert({
      shop_id: shopId,
      job_id: jobId,
      label,
      qty,
      note: input.note ?? null,
      sort: input.sort ?? Number(last?.[0]?.sort ?? -1) + 1,
    })
    .select('id')
    .single()
  if (error) throw error

  const { error: evErr } = await supabase.from('part_events').insert({
    part_id: data.id,
    job_id: jobId,
    kind: 'status',
    to_status: 'pending',
    note: input.reason?.trim() ? `Added after checking: ${input.reason.trim()}` : 'Added to the build sheet',
    actor_id: actorId,
  })
  if (evErr) throw evErr
  if (input.reason?.trim()) {
    const { error: jErr } = await supabase.from('job_events').insert({
      job_id: jobId,
      actor_id: actorId,
      kind: 'edit',
      body: `Added a part, "${label}" ×${qty}. Why: ${input.reason.trim()}`,
    })
    if (jErr) throw jErr
  }
  return data.id as string
}

/** See data.local.ts's setPartStatus, including why a reprint needs a note. */
export async function setPartStatus(
  shopId: string,
  partId: string,
  actorId: string,
  status: PartStatus,
  note: string | null,
): Promise<void> {
  const { data: part, error: readErr } = await supabase
    .from('job_parts')
    .select('job_id, status')
    .eq('id', partId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  if (!part) throw new Error('That part no longer exists.')
  if (status === 'reprint' && !(note ?? '').trim()) {
    throw new Error('Say what went wrong before sending a part back.')
  }
  if (part.status === status) return

  const { error } = await supabase
    .from('job_parts')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error

  const { error: evErr } = await supabase.from('part_events').insert({
    part_id: partId,
    job_id: part.job_id,
    kind: 'status',
    from_status: part.status,
    to_status: status,
    note: note?.trim() || null,
    actor_id: actorId,
  })
  if (evErr) throw evErr
}

/** See data.local.ts's choosePartVariant. */
export async function choosePartVariant(
  shopId: string,
  partId: string,
  sectionId: string | null,
): Promise<void> {
  if (sectionId) {
    const { count, error } = await supabase
      .from('slice_sections')
      .select('id', { count: 'exact', head: true })
      .eq('id', sectionId)
      .eq('part_id', partId)
    if (error) throw error
    if (!count) throw new Error('That sliced file is not a version of this part.')
  }
  const { error } = await supabase
    .from('job_parts')
    .update({ chosen_section_id: sectionId })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error
}

export async function updatePart(
  shopId: string,
  partId: string,
  input: PartInput,
  actorId: string | null = null,
): Promise<void> {
  const label = input.label.trim()
  if (!label) throw new Error('A part needs a name.')
  const qty = Math.floor(Number(input.qty))
  if (!Number.isFinite(qty) || qty < 1) throw new Error('A part needs at least one copy.')
  const note = input.note?.trim() || null
  const { data: before, error: readErr } = await supabase
    .from('job_parts')
    .select('job_id, label, qty, note')
    .eq('id', partId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  const { error } = await supabase
    .from('job_parts')
    .update({ label, qty, note, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error
  const said = describePartEdit(before, { label, qty, note })
  if (said.length > 0) {
    const body = said.join(' ')
    const { error: pErr } = await supabase
      .from('part_events')
      .insert({ part_id: partId, job_id: before.job_id, kind: 'note', note: body, actor_id: actorId })
    if (pErr) throw pErr
    const { error: jErr } = await supabase
      .from('job_events')
      .insert({ job_id: before.job_id, actor_id: actorId, kind: 'edit', body })
    if (jErr) throw jErr
  }
}

export async function deletePart(shopId: string, partId: string): Promise<void> {
  const { error } = await supabase.from('job_parts').delete().eq('id', partId).eq('shop_id', shopId)
  if (error) throw error
}

/** See data.local.ts's setQuoteStatus, and the rule its absence cost us. */
export async function setQuoteStatus(
  shopId: string,
  quoteId: string,
  actorId: string,
  status: QuoteStatus,
): Promise<void> {
  const { data: quote, error: readErr } = await supabase
    .from('quotes')
    .select('job_id, status, sent_at')
    .eq('id', quoteId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  if (!quote) throw new Error('That quote no longer exists.')
  if (quote.status === status) return

  const now = new Date().toISOString()
  const row: Record<string, unknown> = { status }
  if (status === 'sent') row.sent_at = quote.sent_at ?? now
  if (status === 'accepted' || status === 'declined') row.decided_at = now

  const { error } = await supabase.from('quotes').update(row).eq('id', quoteId).eq('shop_id', shopId)
  if (error) throw error

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: quote.job_id,
    actor_id: actorId,
    kind: 'quote',
    body: `Quote marked ${status}.`,
  })
  if (evErr) throw evErr
}

/** See data.local.ts's takeProjectIn. */
export async function takeProjectIn(shopId: string, jobId: string, actorId: string): Promise<void> {
  const { data: job, error: readErr } = await supabase
    .from('jobs')
    .select('taken_in_at')
    .eq('id', jobId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  if (!job) throw new Error('That project no longer exists.')
  if (job.taken_in_at) return

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('jobs')
    .update({ taken_in_at: now, updated_at: now })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (error) throw error

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'taken_in',
    body: 'Taken in from a draft — now on the board at Intake.',
  })
  if (evErr) throw evErr
}

/** See data.local.ts's deleteProject. Postgres cascades unconditionally,
 *  so there is no pragma to set here. */
export async function deleteProject(shopId: string, jobId: string): Promise<void> {
  const { error } = await supabase.from('jobs').delete().eq('id', jobId).eq('shop_id', shopId)
  if (error) throw error
}

/* ---- the selling side ------------------------------------------------- */
/** The hosted half of what data.local.ts does over the same four tables.
 *  See 0016_selling.sql, and data.local.ts for the reasoning. */

export async function listChannels(shopId: string): Promise<ChannelRow[]> {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name, fee_pct, fee_flat, archived')
    .eq('shop_id', shopId)
    .order('archived')
    .order('name')
  if (error) throw error
  return (data ?? []).map((c) => ({
    id: String(c.id),
    name: String(c.name),
    fee_pct: Number(c.fee_pct),
    fee_flat: Number(c.fee_flat),
    archived: c.archived ? 1 : 0,
  }))
}

export async function saveChannel(shopId: string, next: ChannelInput): Promise<ChannelRow> {
  const name = next.name.trim()
  if (!name) throw new Error('A place you sell needs a name.')
  if (next.feePct < 0 || next.feePct > 100) throw new Error('A fee is a percentage between 0 and 100.')
  if (next.feeFlat < 0) throw new Error('A flat fee cannot be negative.')

  const row = {
    shop_id: shopId,
    name,
    fee_pct: next.feePct,
    fee_flat: next.feeFlat,
    archived: next.archived === true,
  }
  const query = next.id
    ? supabase.from('channels').update(row).eq('id', next.id).eq('shop_id', shopId)
    : supabase.from('channels').insert(row)
  const { data, error } = await query.select('id, name, fee_pct, fee_flat, archived').single()
  if (error) throw error
  return {
    id: String(data.id),
    name: String(data.name),
    fee_pct: Number(data.fee_pct),
    fee_flat: Number(data.fee_flat),
    archived: data.archived ? 1 : 0,
  }
}

export async function listShelf(shopId: string): Promise<ProductRow[]> {
  const [products, stock] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, design_job_id, design_cost, design_hours, archived')
      .eq('shop_id', shopId)
      .order('archived')
      .order('name'),
    supabase
      .from('batch_stock')
      .select('*, batches!inner ( job_id, note, created_at )')
      .eq('shop_id', shopId)
      .order('made_on', { ascending: false }),
  ])
  if (products.error) throw products.error
  if (stock.error) throw stock.error

  const batches = (stock.data ?? []).map((b) => {
    const parent = (b as { batches: { job_id: string | null; note: string | null } }).batches
    return {
      id: String(b.batch_id),
      product_id: String(b.product_id),
      job_id: parent?.job_id ?? null,
      units_made: Number(b.units_made),
      unit_cost: Number(b.unit_cost),
      made_on: String(b.made_on),
      note: parent?.note ?? null,
      units_sold: Number(b.units_sold),
      units_left: Number(b.units_left),
      revenue: Number(b.revenue),
      fees: Number(b.fees),
      cost_of_sold: Number(b.cost_of_sold),
      estimated: (parent?.job_id ?? null) === null,
    }
  })

  return (products.data ?? []).map((p) => ({
    id: String(p.id),
    name: String(p.name),
    design_job_id: p.design_job_id ? String(p.design_job_id) : null,
    design_cost: p.design_cost === null ? null : Number(p.design_cost),
    design_hours: p.design_hours === null ? null : Number(p.design_hours),
    archived: p.archived ? 1 : 0,
    batches: batches.filter((b) => b.product_id === String(p.id)),
  }))
}

export async function saveProduct(shopId: string, next: ProductInput): Promise<string> {
  const name = next.name.trim()
  if (!name) throw new Error('A product needs a name.')
  const row = {
    shop_id: shopId,
    name,
    design_job_id: next.designJobId ?? null,
    design_cost: next.designCost ?? null,
    design_hours: next.designHours ?? null,
    archived: next.archived === true,
  }
  const query = next.id
    ? supabase.from('products').update(row).eq('id', next.id).eq('shop_id', shopId)
    : supabase.from('products').insert(row)
  const { data, error } = await query.select('id').single()
  if (error) throw error
  return String(data.id)
}

export async function saveBatch(shopId: string, next: BatchInput): Promise<string> {
  if (!Number.isFinite(next.unitsMade) || next.unitsMade < 1) {
    throw new Error('A batch is at least one unit.')
  }
  if (!Number.isFinite(next.unitCost) || next.unitCost < 0) {
    throw new Error('A unit cost cannot be negative.')
  }

  if (next.id) {
    const { data: stock, error: stockErr } = await supabase
      .from('batch_stock')
      .select('units_sold')
      .eq('batch_id', next.id)
      .single()
    if (stockErr) throw stockErr
    if (next.unitsMade < Number(stock.units_sold)) {
      throw new Error(
        `${stock.units_sold} of these have already sold, so the batch cannot be fewer than that.`,
      )
    }
    const { error } = await supabase
      .from('batches')
      .update({ units_made: next.unitsMade, note: next.note ?? null })
      .eq('id', next.id)
      .eq('shop_id', shopId)
    if (error) throw error
    return next.id
  }

  const { data, error } = await supabase
    .from('batches')
    .insert({
      shop_id: shopId,
      product_id: next.productId,
      job_id: next.jobId ?? null,
      units_made: next.unitsMade,
      unit_cost: next.unitCost,
      made_on: next.madeOn,
      note: next.note ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  return String(data.id)
}

export async function listSales(shopId: string, batchId?: string): Promise<SaleRow[]> {
  let query = supabase
    .from('sales')
    .select('id, batch_id, channel_id, units, unit_price, fee_total, sold_on, note, channels ( name )')
    .eq('shop_id', shopId)
  if (batchId) query = query.eq('batch_id', batchId)
  const { data, error } = await query
    .order('sold_on', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((s) => ({
    id: String(s.id),
    batch_id: String(s.batch_id),
    channel_id: s.channel_id ? String(s.channel_id) : null,
    // PostgREST types a to-one embed as an array even though channel_id is
    // a single foreign key, so this reads the first rather than asserting
    // the shape it wishes it had.
    channel_name: (() => {
      const c = (s as unknown as { channels?: { name: string } | { name: string }[] | null }).channels
      if (!c) return null
      return Array.isArray(c) ? (c[0]?.name ?? null) : c.name
    })(),
    units: Number(s.units),
    unit_price: Number(s.unit_price),
    fee_total: Number(s.fee_total),
    sold_on: String(s.sold_on),
    note: s.note ?? null,
  }))
}

export async function recordSale(shopId: string, next: SaleInput): Promise<string> {
  if (!Number.isFinite(next.units) || next.units < 1) throw new Error('A sale is at least one unit.')
  if (!Number.isFinite(next.unitPrice) || next.unitPrice < 0) {
    throw new Error('A price cannot be negative.')
  }

  const { data: stock, error: stockErr } = await supabase
    .from('batch_stock')
    .select('units_left')
    .eq('batch_id', next.batchId)
    .eq('shop_id', shopId)
    .maybeSingle()
  if (stockErr) throw stockErr
  if (!stock) throw new Error('That batch does not exist.')
  if (next.units > Number(stock.units_left)) {
    throw new Error(
      `Only ${stock.units_left} of those are left. Record another batch if you made more.`,
    )
  }

  let fee = 0
  if (next.channelId) {
    const { data: channel, error: chErr } = await supabase
      .from('channels')
      .select('id, name, fee_pct, fee_flat')
      .eq('id', next.channelId)
      .eq('shop_id', shopId)
      .maybeSingle()
    if (chErr) throw chErr
    if (channel) {
      fee = feeFor(
        {
          id: String(channel.id),
          name: String(channel.name),
          feePct: Number(channel.fee_pct),
          feeFlat: Number(channel.fee_flat),
        },
        next.units,
        next.unitPrice,
      )
    }
  }

  const { data, error } = await supabase
    .from('sales')
    .insert({
      shop_id: shopId,
      batch_id: next.batchId,
      channel_id: next.channelId,
      units: next.units,
      unit_price: next.unitPrice,
      fee_total: round2(fee),
      sold_on: next.soldOn,
      note: next.note ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  return String(data.id)
}

export async function deleteSale(shopId: string, saleId: string): Promise<void> {
  const { error } = await supabase.from('sales').delete().eq('id', saleId).eq('shop_id', shopId)
  if (error) throw error
}

/* ---- slicer imports ---------------------------------------------------- */
/**
 * The hosted twin of data.local.ts's slice import functions. Read that file
 * for the reasoning; the rules are identical and deliberately so.
 *
 * Written alongside the desktop implementation and not yet exercised: the
 * offline edition is being proven first, and 0019_slice_imports.sql has not
 * been applied to the live hosted project. It exists now because
 * backends.test.ts fails the build the moment a function is on one backend
 * and not the other -- the guard that exists because the web build once
 * threw "is not a function" on a stranger's first day.
 */

export async function importSlice(
  shopId: string,
  jobId: string,
  actorId: string,
  input: SliceImportInput,
): Promise<SliceImportResult> {
  if (!input.sections.length) throw new Error('That file had nothing on the plate.')

  // See data.local.ts: the same file again is not a second import.
  const { data: prior, error: priorErr } = await supabase
    .from('slice_imports')
    .select('id, file_name, est_minutes, est_grams, imported_at, slice_files ( import_id )')
    .eq('job_id', jobId)
    .eq('shop_id', shopId)
    .order('imported_at')
  if (priorErr) throw priorErr
  const dup = (prior ?? []).find((r) =>
    sameSliceFile(
      { fileName: r.file_name as string, estMinutes: r.est_minutes as number | null, estGrams: r.est_grams as number | null },
      input,
    ),
  )
  if (dup) {
    const kept = Array.isArray(dup.slice_files) ? dup.slice_files.length > 0 : !!dup.slice_files
    if (input.file && !kept) {
      const { error } = await supabase.from('slice_files').insert({
        import_id: dup.id,
        byte_size: input.file.byteSize,
        stored_size: input.file.storedSize,
        encoding: input.file.encoding,
        content: input.file.content,
      })
      if (error) throw error
    }
    return { importId: dup.id as string, partsAdded: 0, partsMatched: 0, duplicateOf: dup.imported_at as string }
  }

  const { data: head, error: headErr } = await supabase
    .from('slice_imports')
    .insert({
      shop_id: shopId,
      job_id: jobId,
      file_name: input.fileName,
      kind: input.kind,
      printer_model: input.printerModel,
      printer_id: input.printerId,
      material_text: input.materialText,
      material_id: input.materialId,
      est_minutes: input.estMinutes,
      est_grams: input.estGrams,
      // jsonb would be the native choice, but the desktop stores JSON text
      // and both backends must mean the same thing on the way back out.
      notes: JSON.stringify(input.notes ?? []),
    })
    .select('id')
    .single()
  if (headErr) throw headErr
  const importId = head.id as string

  // The bytes, when the caller kept them. See 0020_slice_files.sql for why
  // they live apart from the row that names the file.
  if (input.file) {
    const { error } = await supabase.from('slice_files').insert({
      import_id: importId,
      byte_size: input.file.byteSize,
      stored_size: input.file.storedSize,
      encoding: input.file.encoding,
      content: input.file.content,
    })
    if (error) throw error
  }

  const { data: existing, error: exErr } = await supabase
    .from('job_parts')
    .select('id, label, sort')
    .eq('job_id', jobId)
  if (exErr) throw exErr

  const byLabel = new Map(
    (existing ?? []).map((r) => [String(r.label).trim().toLowerCase(), r.id as string]),
  )
  let sort = Math.max(-1, ...(existing ?? []).map((r) => Number(r.sort ?? -1))) + 1

  let partsAdded = 0
  let partsMatched = 0

  for (const sec of input.sections) {
    const label = sec.label.trim()
    if (!label) continue
    const qty = Math.max(1, Math.floor(Number(sec.qty) || 1))
    let partId = byLabel.get(label.toLowerCase()) ?? null

    if (partId) partsMatched++
    else {
      const { data: part, error: partErr } = await supabase
        .from('job_parts')
        .insert({ shop_id: shopId, job_id: jobId, label, qty, sort: sort++ })
        .select('id')
        .single()
      if (partErr) throw partErr
      partId = part.id as string
      const { error: evErr } = await supabase.from('part_events').insert({
        part_id: partId,
        job_id: jobId,
        kind: 'status',
        to_status: 'pending',
        note: `Imported from ${input.fileName}`,
        actor_id: actorId,
      })
      if (evErr) throw evErr
      byLabel.set(label.toLowerCase(), partId)
      partsAdded++
    }

    const { error: secErr } = await supabase.from('slice_sections').insert({
      import_id: importId,
      part_id: partId,
      label,
      qty,
      est_minutes: sec.estMinutes,
      est_grams: sec.estGrams,
      material: sec.material,
    })
    if (secErr) throw secErr
  }

  return { importId, partsAdded, partsMatched }
}

export async function listSliceImports(
  shopId: string,
  jobId: string,
): Promise<SliceImportRow[]> {
  const { data, error } = await supabase
    .from('slice_imports')
    .select(
      `id, file_name, kind, printer_model, printer_id, material_text, material_id,
       est_minutes, est_grams, notes, imported_at,
       printers ( name ), materials ( name ),
       slice_files ( byte_size ),
       slice_sections ( id, part_id, label, qty, est_minutes, est_grams, material )`,
    )
    .eq('shop_id', shopId)
    .eq('job_id', jobId)
    .order('imported_at', { ascending: false })
    // Deterministic tie-break, same reason as the desktop's rowid: several
    // files imported in one go can share a timestamp, and an unordered tie
    // lists the newest last.
    .order('id', { ascending: false })
  if (error) throw error

  return (data ?? []).map((r) => {
    const printer = r.printers as { name?: string } | null
    const material = r.materials as { name?: string } | null
    const sections = (r.slice_sections ?? []) as {
      id: string
      part_id: string | null
      label: string
      qty: number
      est_minutes: number | null
      est_grams: number | null
      material: string | null
    }[]
    return {
      id: r.id as string,
      fileName: r.file_name as string,
      kind: r.kind as SliceImportRow['kind'],
      printerModel: r.printer_model as string | null,
      printerId: r.printer_id as string | null,
      printerName: printer?.name ?? null,
      materialText: r.material_text as string | null,
      materialId: r.material_id as string | null,
      materialName: material?.name ?? null,
      estMinutes: r.est_minutes == null ? null : Number(r.est_minutes),
      estGrams: r.est_grams == null ? null : Number(r.est_grams),
      notes: parseNotes(r.notes as string | null),
      importedAt: r.imported_at as string,
      keptBytes:
        (r.slice_files as { byte_size: number }[] | null)?.[0]?.byte_size == null
          ? null
          : Number((r.slice_files as { byte_size: number }[])[0].byte_size),
      sections: sections.map(
        (s): SliceSectionRow => ({
          id: s.id,
          partId: s.part_id,
          label: s.label,
          qty: Number(s.qty),
          estMinutes: s.est_minutes == null ? null : Number(s.est_minutes),
          estGrams: s.est_grams == null ? null : Number(s.est_grams),
          material: s.material,
        }),
      ),
    }
  })
}

function parseNotes(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** See data.local.ts's sliceFileContent. */
export async function sliceFileContent(
  shopId: string,
  importId: string,
): Promise<{ content: string; byteSize: number } | null> {
  const { data, error } = await supabase
    .from('slice_files')
    .select('content, byte_size, slice_imports!inner ( shop_id )')
    .eq('import_id', importId)
    .eq('slice_imports.shop_id', shopId)
    .maybeSingle()
  if (error) throw error
  return data ? { content: data.content as string, byteSize: Number(data.byte_size) } : null
}

/** See data.local.ts's archiveProject. */
export async function archiveProject(
  shopId: string,
  jobId: string,
  actorId: string,
  archived: boolean,
): Promise<void> {
  const { data: job, error } = await supabase
    .from('jobs')
    .select('phase, archived_at')
    .eq('id', jobId)
    .eq('shop_id', shopId)
    .single()
  if (error) throw error
  if (archived && job.phase !== 'delivered') {
    throw new Error('Only a finished project can be archived — this one is still live.')
  }
  if (!!job.archived_at === archived) return

  const { error: upErr } = await supabase
    .from('jobs')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (upErr) throw upErr

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'note',
    body: archived
      ? 'Archived — filed off the board. Every figure it contributes still counts.'
      : 'Unarchived — back on the board.',
  })
  if (evErr) throw evErr
}

/** See data.local.ts's setRelatedProject: programs nest, loops are refused. */
export async function setRelatedProject(
  shopId: string,
  jobId: string,
  relatedTo: string | null,
): Promise<void> {
  if (relatedTo === jobId) throw new Error('A project cannot sit under itself.')
  if (relatedTo) {
    let cursor: string | null = relatedTo
    for (let hops = 0; cursor && hops < 64; hops++) {
      const res: { data: { id: string; related_to: string | null } | null; error: unknown } =
        await supabase
          .from('jobs')
          .select('id, related_to')
          .eq('id', cursor)
          .eq('shop_id', shopId)
          .maybeSingle()
      const { data, error } = res
      if (error) throw error
      if (!data) throw new Error('That project no longer exists.')
      if (data.related_to === jobId) {
        throw new Error(
          'That project is already inside this one — putting this under it would make a loop.',
        )
      }
      cursor = data.related_to ?? null
    }
  }
  const { error } = await supabase
    .from('jobs')
    .update({ related_to: relatedTo })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (error) throw error
}

export async function deleteSliceImport(shopId: string, importId: string): Promise<void> {
  const { error } = await supabase
    .from('slice_imports')
    .delete()
    .eq('id', importId)
    .eq('shop_id', shopId)
  if (error) throw error
}

/**
 * There is no workspace to reset on the hosted build.
 *
 * Exists only so backends.test.ts passes: every function on one backend
 * must exist on the other, or the web build throws "is not a function" on
 * somebody's first day. A hosted shop's data lives in a shared Postgres
 * behind row-level security -- "empty everything" is not a thing a tenant
 * gets to do to itself from a settings screen, and the demo workspace is a
 * desktop idea (a second SQLite file beside the first).
 */
export async function resetWorkspace(): Promise<void> {
  throw new Error('The demo workspace is only available in the desktop app.')
}

// ---------------------------------------------------------------------------
// Series -- see data.local.ts and 0030_series.sql.
// ---------------------------------------------------------------------------

export async function listSeries(shopId: string): Promise<SeriesRow[]> {
  const { data, error } = await supabase
    .from('series')
    .select('id, name, brief, parent_id, created_at, archived_at')
    .eq('shop_id', shopId)
    .order('name')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    brief: (r.brief as string | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    createdAt: r.created_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
  }))
}

async function checkSeriesParent(shopId: string, id: string | null, parentId: string | null) {
  if (!parentId) return
  if (parentId === id) throw new Error('A series cannot sit inside itself.')
  let cursor: string | null = parentId
  for (let hops = 0; cursor && hops < 64; hops++) {
    const res: { data: { parent_id: string | null } | null; error: unknown } = await supabase
      .from('series')
      .select('parent_id')
      .eq('id', cursor)
      .eq('shop_id', shopId)
      .maybeSingle()
    if (res.error) throw res.error
    if (!res.data) throw new Error('That series no longer exists.')
    if (id && res.data.parent_id === id) {
      throw new Error('That series is already inside this one — that would make a loop.')
    }
    cursor = res.data.parent_id ?? null
  }
}

export async function createSeries(
  shopId: string,
  input: { name: string; brief?: string | null; parentId?: string | null },
): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error('A series needs a name.')
  await checkSeriesParent(shopId, null, input.parentId ?? null)
  const { data, error } = await supabase
    .from('series')
    .insert({ shop_id: shopId, name, brief: input.brief?.trim() || null, parent_id: input.parentId ?? null })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function updateSeries(shopId: string, id: string, input: SeriesInput): Promise<void> {
  const row: Record<string, unknown> = {}
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('A series needs a name.')
    row.name = name
  }
  if (input.brief !== undefined) row.brief = input.brief?.trim() || null
  if (input.parentId !== undefined) {
    await checkSeriesParent(shopId, id, input.parentId)
    row.parent_id = input.parentId
  }
  if (input.archived !== undefined) row.archived_at = input.archived ? new Date().toISOString() : null
  if (!Object.keys(row).length) return
  const { error } = await supabase.from('series').update(row).eq('id', id).eq('shop_id', shopId)
  if (error) throw error
}

export async function setJobSeries(
  shopId: string,
  jobId: string,
  seriesId: string | null,
  actorId: string | null = null,
): Promise<void> {
  const { data: job, error: jErr } = await supabase
    .from('jobs')
    .select('series_id')
    .eq('id', jobId)
    .eq('shop_id', shopId)
    .single()
  if (jErr) throw jErr
  if ((job.series_id ?? null) === seriesId) return
  const name = async (id: string | null) => {
    if (!id) return null
    const { data, error } = await supabase.from('series').select('name').eq('id', id).eq('shop_id', shopId).maybeSingle()
    if (error) throw error
    return (data?.name as string | undefined) ?? null
  }
  const to = await name(seriesId)
  if (seriesId && !to) throw new Error('That series no longer exists.')
  const from = await name(job.series_id as string | null)
  const { error } = await supabase
    .from('jobs')
    .update({ series_id: seriesId, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (error) throw error
  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'edit',
    body: to
      ? from
        ? `Moved from the ${from} series to ${to}.`
        : `Filed in the ${to} series.`
      : `Taken out of the ${from} series.`,
  })
  if (evErr) throw evErr
}
