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
import { supabase } from './supabase'
import type { MaterialRef, PrinterRef } from './pricing'
// validateRun/validateHours/runEventBody live in data.types.ts so both
// backends share one definition and cannot drift on what a valid run is.
import { NeedsSetup, asClientKind, validateRun, validateHours, runEventBody, type ShopContext, type SetupPayload, type Shop, type RateCardRow, type PrinterRow, type Profile } from './data.types'
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
  PartInput,
  PartStatus,
  QuoteStatus,
} from './data.types'
import type {
  ShopIdentityInput,
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
  PartInput,
  PartStatus,
  QuoteStatus,
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
      .order('effective_from', { ascending: false })
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
        costPerUnit: Number(m.material_costs?.[0]?.avg_cost_per_unit ?? m.cost_per_unit),
        costBasis: (m.material_costs?.[0]?.basis as 'purchases' | 'estimate') ?? 'estimate',
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
    })
    .eq('id', shopId)
    .select()
    .single()
  if (error) throw error
  return data as Shop
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
 *  not-yet-applied migration in supabase/migrations/0005_show_welcome.sql
 *  -- so `ctx.shop.show_welcome` reads back undefined/falsy here and this
 *  never actually gets called on the hosted build until that's applied. */
export async function dismissWelcome(shopId: string): Promise<void> {
  const { error } = await supabase.from('shops').update({ show_welcome: false }).eq('id', shopId)
  if (error) throw error
}

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

const JOB_SELECT = `id, ref, title, brief, created_at, updated_at, phase, priority,
   asset_origin, poc, needed_by, window_from, window_locked, at_risk,
   delivery_on, delivery_how,
   clients!inner ( id, name, kind, contact, email, phone ),
   quotes ( id, status, total, design_billing, design_qty, revisions_incl, quantity,
            material_id, printer_id, units_per_part, print_hrs_part, finishing_hrs,
            rush, flat_each, discount_pct, rates_snapshot ),
   job_money ( deposit_due, deposit_owed, balance_owed ),
   job_parts_summary ( parts, printed, passed, reprint, reprints_ever ),
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
    priority: r.priority,
    createdAt: r.created_at,
    neededBy: r.needed_by ?? null,
    windowFrom: r.window_from ?? null,
    windowLocked: r.window_locked === true,
    atRisk: r.at_risk === true,
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
    parts: Number(r.job_parts_summary?.[0]?.parts ?? 0),
    partsPrinted: Number(r.job_parts_summary?.[0]?.printed ?? 0),
    partsPassed: Number(r.job_parts_summary?.[0]?.passed ?? 0),
    partsReprint: Number(r.job_parts_summary?.[0]?.reprint ?? 0),
    reprintsEver: Number(r.job_parts_summary?.[0]?.reprints_ever ?? 0),
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
    .update({ phase: toPhase, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('shop_id', shopId)
  if (updErr) throw updErr

  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'phase_change',
    from_phase: fromPhase,
    to_phase: toPhase,
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
    .order('effective_from', { ascending: false })
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

  const [gates, rates, events, payments, runs, work, parts, partHistory] = await Promise.all([
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
      .select('id, label, qty, status, note, sort')
      .eq('job_id', jobId)
      .order('sort'),
    supabase
      .from('part_events')
      .select('id, part_id, kind, from_status, to_status, note, at, profiles ( full_name )')
      .eq('job_id', jobId)
      .order('at', { ascending: false }),
  ])
  if (events.error) throw events.error
  if (payments.error) throw payments.error
  if (runs.error) throw runs.error
  if (work.error) throw work.error
  if (parts.error) throw parts.error
  if (partHistory.error) throw partHistory.error

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
      }),
    ),
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
  }
  const row: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) row[column] = (fields as Record<string, unknown>)[key] ?? null
  }
  if (Object.keys(row).length === 0) return
  row.updated_at = new Date().toISOString()
  const { error } = await supabase.from('jobs').update(row).eq('id', jobId).eq('shop_id', shopId)
  if (error) throw error
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

/** See data.local.ts's saveMaterial, including why on_hand is writable. */
export async function saveMaterial(shopId: string, next: MaterialInput): Promise<MaterialRow> {
  const name = next.name.trim()
  if (!name) throw new Error('A material needs a name.')
  const row = {
    shop_id: shopId,
    name,
    kind: next.kind,
    swatch: next.swatch,
    unit: next.unit,
    cost_per_unit: next.costPerUnit,
    sell_override: next.sellOverride,
    on_hand: next.onHand,
    reorder_at: next.reorderAt,
    archived: next.archived === true,
  }
  const query = next.id
    ? supabase.from('materials').update(row).eq('id', next.id).eq('shop_id', shopId)
    : supabase.from('materials').insert(row)
  const { data, error } = await query.select(MATERIAL_SELECT).single()
  if (error) throw error
  return toMaterialRow(data)
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
    note: 'Added to the build sheet',
    actor_id: actorId,
  })
  if (evErr) throw evErr
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

export async function updatePart(shopId: string, partId: string, input: PartInput): Promise<void> {
  const label = input.label.trim()
  if (!label) throw new Error('A part needs a name.')
  const qty = Math.floor(Number(input.qty))
  if (!Number.isFinite(qty) || qty < 1) throw new Error('A part needs at least one copy.')
  const { error } = await supabase
    .from('job_parts')
    .update({ label, qty, note: input.note ?? null, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error
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
