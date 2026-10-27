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
import type { EquipmentInput, EquipmentRow, EquipmentUseInput, HardwareInput, HardwareRow, HardwareUseInput, HardwareUseRow, JobExtras } from './data.types'
import { validateEquipment, validateHardware } from './data.types'
import { matchShelfPhotos as pickShelfPhotos } from './shelfPhotos'
import { changeCopies, copyList, countsOf, describeCopiesChange, movable, moveStates, plateCopies, queuedCopies, movedCopies, planMerge, renumberCopies, setStates, statesOf, statusOf } from './copies'
import { decodeProgress, encodeProgress, type ProgressPoint } from './gcodeWalk'
// validateRun/validateHours/runEventBody live in data.types.ts so both
// backends share one definition and cannot drift on what a valid run is.
import type { SeriesRow, SeriesInput, StockHoldRow, StockHoldInput } from './data.types'
import { describeHolds, quoteBases, uniqueLabel, validateMadeItems, shelfNote, type SectionAssign, type SectionMoveResult, type MadeItemRow, type MadeItemInput, type AssemblyRow, type AssemblyInput, type ItemPlace, type MadeStatus, type ProductPatch } from './data.types'
import { NeedsSetup, asClientKind, validateRun, validateHours, runEventBody, describeRunCorrection, validateRevision, CHANGE_CAUSE_LABEL, sameSliceFile, type ShopContext, type SetupPayload, type Shop, type RateCardRow, type PrinterRow, type PrinterInput, type Profile } from './data.types'
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
  PartCopiesChange,
  PartCopiesResult,
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
  PartCopiesChange,
  PartCopiesResult,
  RunCorrection,
  RunOutcome,
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
  input: { title: string; brief?: string | null; relatedTo?: string | null; seriesId?: string | null; neededBy?: string | null },
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
      needed_by: input.neededBy || null,
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
   asset_origin, poc, needed_by, window_from, window_locked, at_risk, over_ceiling, printer_id, archived_at, related_to, series_id,
   delivery_on, delivery_how,
   clients!inner ( id, name, kind, contact, email, phone ),
   quotes ( id, version, status, total, design_billing, design_qty, revisions_incl, quantity,
            material_id, printer_id, units_per_part, print_hrs_part, finishing_hrs,
            rush, flat_each, discount_pct, rates_snapshot ),
   job_money ( deposit_due, deposit_owed, balance_owed ),
   job_parts_summary ( parts, copies, copies_done, printed, passed, reprint, reprints_ever ),
   batches ( units_made ),
   job_actuals ( material_cost, machine_cost, power_cost, wear_cost, runs,
                 design_hours, finishing_hours, admin_hours, material_units,
                 failed_units, machine_hours, failed_runs,
                 equipment_hours, equipment_cost, hardware_cost ),
   job_events ( at ),
   job_gates ( phase, item_key, skipped )`

/** The newest version of a job's quote. A revision is another quotes row
 *  for the same job, and PostgREST returns an embed in no promised order --
 *  see data.local.ts's JOB_LIST_SQL for what taking the first one cost. */
function latestQuote(qs: any[] | null | undefined): any | null {
  if (!qs?.length) return null
  return [...qs].sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0]
}

/** The version that COUNTS, for the facts, flags, history and client value:
 *  newest accepted, else newest sent (job_money's pick), else the newest of
 *  any status. Same as data.local.ts's COUNTED_QUOTE_SQL. The printable is
 *  still latestQuote. */
function countedQuote(qs: any[] | null | undefined): any | null {
  if (!qs?.length) return null
  const rank = (s: unknown) => (s === 'accepted' ? 2 : s === 'sent' ? 1 : 0)
  return [...qs].sort(
    (a, b) => rank(b.status) - rank(a.status) || Number(b.version ?? 0) - Number(a.version ?? 0),
  )[0]
}

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
    equipmentHours: Number(a.equipment_hours ?? 0),
    equipmentCost: Number(a.equipment_cost ?? 0),
    hardwareCost: Number(a.hardware_cost ?? 0),
  }
}

/** Same arithmetic as data.local.ts's actual_cost column, in TypeScript
 *  because PostgREST cannot express it in an embed. power_cost is the
 *  per-run mix (0037_actuals_per_run_power.sql): electricity for metered
 *  runs, the machine rate for the rest, and 0 when no run is metered -- so
 *  this one-or-the-other is correct on a mixed fleet too. */
function actualCostOf(a: ProjectActuals, designHourly: number, finishingHourly: number): number {
  return (
    a.materialCost +
    (a.powerCost > 0 ? a.powerCost : a.machineCost) +
    a.wearCost +
    (a.equipmentCost ?? 0) +
    (a.hardwareCost ?? 0) +
    a.designHours * designHourly +
    (a.finishingHours + a.adminHours) * finishingHourly
  )
}

/** The reason an approval item was skipped, from the job_gates embed. */
function approvalSkip(r: any, key: 'accepted' | 'deposit'): string | null {
  const g = (r.job_gates ?? []).find((x: any) => x.phase === 'approval' && x.item_key === key)
  return (g?.skipped as string | null) ?? null
}

function factsFrom(
  r: any,
  minimumOrder: number,
  labour: { designHourly: number; finishingHourly: number } = { designHourly: 0, finishingHourly: 0 },
): ProjectFacts {
  const acts = actualsFrom(r)
  const quote = countedQuote(r.quotes)
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
    printerId: (r.printer_id as string | null) ?? null,
    wentAheadWithout: {
      accepted: approvalSkip(r, 'accepted'),
      deposit: approvalSkip(r, 'deposit'),
    },
    deliveryOn: r.delivery_on ?? null,
    deliveryHow: r.delivery_how ?? null,
    brief: r.brief ?? null,
    poc: r.poc ?? r.clients?.contact ?? null,
    quoteStatus: (quote?.status as QuoteStatus | undefined) ?? null,
    quoteTotal: quote?.total == null ? null : Number(quote.total),
    quotePreTax: quoteBases(quote?.total ?? null, quote?.rates_snapshot, quote?.discount_pct).preTax,
    quoteListPrice: quoteBases(quote?.total ?? null, quote?.rates_snapshot, quote?.discount_pct).listPrice,
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
    copies: Number(r.job_parts_summary?.[0]?.copies ?? 0),
    copiesDone: Number(r.job_parts_summary?.[0]?.copies_done ?? 0),
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
  const quote = latestQuote(r.quotes)
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
    .select('job_id, phase, item_key, checked, note, skipped')
    .in('job_id', jobIds)
  if (error) throw error
  for (const r of (data ?? []) as any[]) {
    const byPhase = (out[r.job_id] ??= {})
    const byKey = (byPhase[r.phase] ??= {})
    byKey[r.item_key] = { checked: r.checked === true, note: r.note ?? null, skipped: r.skipped ?? null }
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
      .order('started_at', { ascending: false })
      // Two prints on one day: the later-recorded one first.
      .order('consumed_at', { ascending: false, nullsFirst: false }),
    supabase
      .from('work_log')
      .select('id, kind, hours, worked_on, note, profiles ( full_name )')
      .eq('job_id', jobId)
      .order('worked_on', { ascending: false }),
    supabase
      .from('job_parts')
      .select('id, label, qty, status, note, sort, chosen_section_id, printed_n, passed_n, reprint_n, copy_states, spare_n')
      .eq('job_id', jobId)
      .order('sort'),
    supabase
      .from('part_events')
      .select('id, part_id, kind, from_status, to_status, n, copies, slice_import_id, run_id, note, at, profiles ( full_name )')
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
        `id, part_id, qty, est_minutes, est_grams, material,
         slice_imports!inner ( id, job_id, file_name, printer_model, printer_id, material_id, imported_at,
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

  const quote = latestQuote(r.quotes)
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
    quoteInputs: quote ? { ...quoteInputsFrom(quote), builds: await listQuoteBuilds(quote.id) } : null,
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
        printedN: Number(x.printed_n ?? 0),
        passedN: Number(x.passed_n ?? 0),
        reprintN: Number(x.reprint_n ?? 0),
        copyStates: statesOf({
          qty: Number(x.qty),
          printedN: Number(x.printed_n ?? 0),
          passedN: Number(x.passed_n ?? 0),
          reprintN: Number(x.reprint_n ?? 0),
          copyStates: x.copy_states,
        }),
        spareN: Number(x.spare_n ?? 0),
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
            sectionQty: Math.max(1, Number(v.qty ?? 1)),
            materialId: v.slice_imports?.material_id ?? null,
          }))
          .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1)),
        history: ((partHistory.data ?? []) as any[])
          .filter((e) => e.part_id === x.id)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            fromStatus: e.from_status ?? null,
            toStatus: e.to_status ?? null,
            n: e.n == null ? null : Number(e.n),
            copies: e.copies ? String(e.copies).split(',').map(Number).filter((x: number) => x > 0) : null,
            sliceImportId: e.slice_import_id ?? null,
            runId: e.run_id ?? null,
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

/** See data.local.ts's skipGateItem. */
export async function skipGateItem(
  jobId: string,
  actorId: string,
  phase: JobPhase,
  itemKey: string,
  itemLabel: string,
  reason: string | null,
): Promise<void> {
  const why = reason?.trim() || null
  const { data: existing, error: readErr } = await supabase
    .from('job_gates')
    .select('checked, note')
    .eq('job_id', jobId)
    .eq('phase', phase)
    .eq('item_key', itemKey)
    .maybeSingle()
  if (readErr) throw readErr
  const { error } = await supabase.from('job_gates').upsert(
    {
      job_id: jobId,
      phase,
      item_key: itemKey,
      checked: existing?.checked ?? false,
      note: existing?.note ?? null,
      skipped: why,
      actor_id: actorId,
      at: new Date().toISOString(),
    },
    { onConflict: 'job_id,phase,item_key' },
  )
  if (error) throw error
  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: jobId,
    actor_id: actorId,
    kind: 'edit',
    body: why ? `Skipped “${itemLabel}”. Why: ${why}` : `Took back the skip on “${itemLabel}”.`,
  })
  if (evErr) throw evErr
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
    printerId: 'printer_id',
  }
  const row: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) row[column] = (fields as Record<string, unknown>)[key] ?? null
  }
  if (Object.keys(row).length === 0) return
  row.updated_at = new Date().toISOString()
  const { data: before, error: readErr } = await supabase
    .from('jobs')
    .select('title, brief, poc, needed_by, window_from, window_locked, at_risk, delivery_on, delivery_how, priority, over_ceiling, printer_id')
    .eq('id', jobId)
    .eq('shop_id', shopId)
    .single()
  if (readErr) throw readErr
  const { error } = await supabase.from('jobs').update(row).eq('id', jobId).eq('shop_id', shopId)
  if (error) throw error
  let printerName: string | null = null
  if (fields.printerId) {
    const { data: pr } = await supabase.from('printers').select('name').eq('id', fields.printerId).maybeSingle()
    printerName = (pr as { name?: string } | null)?.name ?? null
  }
  const said = describeProjectEdits(before as ProjectBefore, fields, printerName)
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
       jobs ( id, phase, quotes ( version, status, total ), job_money ( balance_owed ), job_events ( at ) )`,
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
      const q = countedQuote(j.quotes)
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
function quoteInputsFrom(q: any): Omit<QuoteInputsRow, 'builds'> {
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

/** See data.local.ts's correctPrintRun. */
export async function correctPrintRun(
  shopId: string,
  runId: string,
  actorId: string,
  input: RunCorrection,
  failCopies = false,
): Promise<number> {
  const { data: run, error } = await supabase
    .from('print_runs')
    .select('job_id, units_used, hours, outcome, material_id, printer_id, started_at, materials ( unit )')
    .eq('id', runId)
    .eq('shop_id', shopId)
    .maybeSingle()
  if (error) throw error
  if (!run) throw new Error('That print is no longer recorded.')
  // What it said before, read now: the description compares against it.
  const before = {
    unitsUsed: run.units_used == null ? null : Number(run.units_used),
    hours: run.hours == null ? null : Number(run.hours),
    outcome: run.outcome as RunOutcome | null,
  }
  const unit = ((run.materials as { unit?: string } | null)?.unit as string | undefined) ?? 'g'
  const { hours, unitsUsed } = validateRun({
    ...input,
    printerId: (run.printer_id as string | null) ?? '',
    materialId: run.material_id as string | null,
    startedAt: run.started_at as string | null,
  })
  const why = input.failureReason?.trim() || null
  const { error: uErr } = await supabase
    .from('print_runs')
    .update({
      units_used: unitsUsed,
      hours,
      outcome: input.outcome,
      failure_reason: input.outcome === 'success' ? null : why,
      note: input.note?.trim() || null,
    })
    .eq('id', runId)
    .eq('shop_id', shopId)
  if (uErr) throw uErr
  const { error: jErr } = await supabase.from('job_events').insert({
    job_id: run.job_id,
    actor_id: actorId,
    kind: 'run',
    body: describeRunCorrection(before, { ...input, unitsUsed, hours, failureReason: why }, unit),
  })
  if (jErr) throw jErr
  let failed = 0
  if (failCopies && input.outcome !== 'success') {
    const { data: evs, error: eErr } = await supabase
      .from('part_events')
      .select('id, part_id, to_status, copies')
      .eq('run_id', runId)
      .eq('kind', 'status')
      .eq('to_status', 'printed')
      .not('copies', 'is', null)
      .order('id')
    if (eErr) throw eErr
    for (const ev of (evs ?? []) as { id: number; part_id: string; to_status: PartStatus; copies: string | null }[]) {
      const now = await readCopies(shopId, ev.part_id)
      const still = parseCopyList(ev.copies).map((c) => c - 1).filter((i) => now.states[i] === 'printed')
      if (!still.length) continue
      await setCopyStates(shopId, ev.part_id, actorId, still, 'reprint', why || 'The print stopped part way.', runId)
      failed += still.length
    }
  }
  return failed
}

/** See data.local.ts's deletePrintRun. */
export async function deletePrintRun(shopId: string, runId: string, undoCopies = false): Promise<number> {
  // See data.local.ts: what it made and has placed comes back first.
  {
    const { count, error } = await supabase
      .from('made_items')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', runId)
      .in('status', ['shelved', 'assembled', 'kept'])
    if (error) throw error
    if ((count ?? 0) > 0)
      throw new Error('Some of what this print made is already on the shelf, in an assembly or kept — take it back first.')
  }
  let undone = 0
  if (undoCopies) {
    const { data: run, error: rErr } = await supabase
      .from('print_runs')
      .select('job_id, slice_import_id')
      .eq('id', runId)
      .eq('shop_id', shopId)
      .maybeSingle()
    if (rErr) throw rErr
    if (run) {
      const { data: evs, error: eErr } = await supabase
        .from('part_events')
        .select('id, part_id, to_status, copies')
        .eq('run_id', runId)
        .eq('kind', 'status')
        .not('copies', 'is', null)
        .order('id')
      if (eErr) throw eErr
      for (const ev of (evs ?? []) as { id: number; part_id: string; to_status: PartStatus; copies: string | null }[]) {
        const now = await readCopies(shopId, ev.part_id)
        const back = parseCopyList(ev.copies).map((c) => c - 1).filter((i) => now.states[i] === ev.to_status)
        if (!back.length) continue
        const requeue = await queuedBefore(ev, (run.slice_import_id as string | null) ?? null)
        const again = back.filter((c) => requeue.includes(c))
        const plain = back.filter((c) => !requeue.includes(c))
        const why = 'The print that marked this was removed from What it took.'
        if (plain.length) await setCopyStates(shopId, ev.part_id, null, plain, 'pending', why)
        if (again.length) await setCopyStates(shopId, ev.part_id, null, again, 'pending', why, null, run.slice_import_id as string)
        undone += back.length
        // See data.local.ts: a print fully undone is kept as a note.
        if (back.length === parseCopyList(ev.copies).length) {
          const { data: full, error: fErr } = await supabase.from('part_events').select('note, to_status').eq('id', ev.id).maybeSingle()
          if (fErr) throw fErr
          const { error: uErr } = await supabase
            .from('part_events')
            .update({
              kind: 'note',
              note: `Undone (print removed): ${(full?.note as string | null) ?? (full?.to_status as string) ?? ''}`,
              from_status: null,
              to_status: null,
            })
            .eq('id', ev.id)
          if (uErr) throw uErr
        }
      }
    }
  }
  const { error } = await supabase.from('print_runs').delete().eq('id', runId).eq('shop_id', shopId)
  if (error) throw error
  return undone
}

function parseCopyList(v: string | null): number[] {
  return String(v ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0)
}

/** See data.local.ts's queuedBefore. */
async function queuedBefore(ev: { id: number; part_id: string }, file: string | null): Promise<number[]> {
  if (!file) return []
  const { data, error } = await supabase
    .from('part_events')
    .select('id, copies, slice_import_id')
    .eq('part_id', ev.part_id)
    .eq('to_status', 'pending')
    .not('copies', 'is', null)
    .lt('id', ev.id)
    .order('at')
    .order('id')
  if (error) throw error
  const latest = new Map<number, string | null>()
  for (const e of (data ?? []) as { copies: string | null; slice_import_id: string | null }[])
    for (const c of parseCopyList(e.copies)) latest.set(c - 1, e.slice_import_id)
  return [...latest.entries()].filter(([, f]) => f === file).map(([i]) => i)
}

/** See data.local.ts's setSliceProgress. */
/** See data.local.ts's setSliceExtras. */
export async function setSliceExtras(shopId: string, importId: string, thumbnail: string | null, slicedAt: string | null): Promise<void> {
  const { data, error } = await supabase.from('slice_imports').select('thumbnail, sliced_at').eq('id', importId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!data) return
  const patch: Record<string, unknown> = {}
  if (!data.thumbnail && thumbnail) patch.thumbnail = thumbnail
  if (!data.sliced_at && slicedAt) patch.sliced_at = slicedAt
  if (!Object.keys(patch).length) return
  const { error: uErr } = await supabase.from('slice_imports').update(patch).eq('id', importId).eq('shop_id', shopId)
  if (uErr) throw uErr
}

export async function setSliceProgress(shopId: string, importId: string, progress: ProgressPoint[]): Promise<void> {
  const { error } = await supabase
    .from('slice_imports')
    .update({ progress: encodeProgress(progress) })
    .eq('id', importId)
    .eq('shop_id', shopId)
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
  if (status === 'reprint' && !(note ?? '').trim()) throw new Error('Say what went wrong before sending a part back.')
  const part = await readCopies(shopId, partId)
  const n = movable(countsOf(part.states), status)
  if (n === 0) return
  await movePartCopies(shopId, partId, actorId, status, n, note)
}

/** See data.local.ts's readCopies. */
async function readCopies(shopId: string, partId: string) {
  const { data: p, error } = await supabase
    .from('job_parts')
    .select('job_id, qty, status, printed_n, passed_n, reprint_n, copy_states')
    .eq('id', partId)
    .eq('shop_id', shopId)
    .single()
  if (error) throw error
  if (!p) throw new Error('That part no longer exists.')
  return {
    jobId: p.job_id as string,
    status: p.status as PartStatus,
    states: statesOf({
      qty: Number(p.qty),
      printedN: Number(p.printed_n),
      passedN: Number(p.passed_n),
      reprintN: Number(p.reprint_n),
      copyStates: p.copy_states,
    }),
  }
}

/** See data.local.ts's writeCopies. */
async function writeCopies(
  shopId: string,
  partId: string,
  actorId: string | null,
  before: { jobId: string; status: PartStatus },
  states: PartStatus[],
  to: PartStatus,
  moved: number[],
  note: string | null,
  sliceImportId: string | null = null,
  runId: string | null = null,
) {
  const c = countsOf(states)
  const { error } = await supabase
    .from('job_parts')
    .update({
      copy_states: JSON.stringify(states),
      printed_n: c.printed,
      passed_n: c.passed,
      reprint_n: c.reprint,
      status: statusOf(c),
      updated_at: new Date().toISOString(),
    })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error
  const { error: evErr } = await supabase.from('part_events').insert({
    part_id: partId,
    job_id: before.jobId,
    kind: 'status',
    from_status: before.status,
    to_status: to,
    n: moved.length,
    copies: copyList(moved),
    note: note?.trim() || null,
    actor_id: actorId,
    slice_import_id: sliceImportId,
    run_id: runId,
  })
  if (evErr) throw evErr
}

/** See data.local.ts's movePartCopies. */
export async function movePartCopies(
  shopId: string,
  partId: string,
  actorId: string | null,
  to: PartStatus,
  n: number,
  note: string | null,
): Promise<void> {
  if (to === 'reprint' && !(note ?? '').trim()) throw new Error('Say what went wrong before sending a part back.')
  const before = await readCopies(shopId, partId)
  const r = moveStates(before.states, to, n)
  await writeCopies(shopId, partId, actorId, before, r.states, to, r.moved, note)
}

/** See data.local.ts's setCopyStates. */
export async function setCopyStates(
  shopId: string,
  partId: string,
  actorId: string | null,
  copies: number[],
  to: PartStatus,
  note: string | null,
  runId: string | null = null,
  sliceImportId: string | null = null,
): Promise<void> {
  if (to === 'reprint' && !(note ?? '').trim()) throw new Error('Say what went wrong before sending a copy back.')
  const before = await readCopies(shopId, partId)
  const changed = copies.filter((i) => before.states[i] !== to)
  if (changed.length === 0) return
  await writeCopies(shopId, partId, actorId, before, setStates(before.states, changed, to), to, changed, note, sliceImportId, runId)
}

/** See data.local.ts's requeueCopyFromFile. */
export async function requeueCopyFromFile(
  shopId: string,
  partId: string,
  actorId: string | null,
  copy: number,
  sliceImportId: string,
  fileName: string,
): Promise<void> {
  const before = await readCopies(shopId, partId)
  if (before.states[copy] !== 'reprint') throw new Error(`Copy ${copy + 1} has not failed, so there is nothing to replace.`)
  await writeCopies(
    shopId,
    partId,
    actorId,
    before,
    setStates(before.states, [copy], 'pending'),
    'pending',
    [copy],
    `Reprint from ${fileName}`,
    sliceImportId,
  )
}

/** See data.local.ts's markPlatePrinted. */
export async function markPlatePrinted(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null = null,
): Promise<number> {
  return movePlate(shopId, jobId, actorId, sliceImportId, runId, 'printed', null)
}

/** See data.local.ts's markPlateFailed. */
export async function markPlateFailed(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null,
  reason: string | null,
): Promise<number> {
  return movePlate(shopId, jobId, actorId, sliceImportId, runId, 'reprint', reason?.trim() || 'The plate failed.')
}

/** See data.local.ts's markPlateParts. */
export async function markPlateParts(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null,
  ok: Record<string, number>,
  reason: string | null,
): Promise<{ printed: number; failed: number }> {
  // ok: how many of each part's copies on this plate came off fine (CG, 27
  // Oct: four Diagonals on one plate, some good, some not). The rest of that
  // part's copies on the plate failed.
  const why = reason?.trim() || 'The plate failed.'
  const parts = await platePartIds(shopId, jobId, sliceImportId)
  let printed = 0
  let failed = 0
  for (const { id, per } of parts) {
    const good = Math.max(0, Math.min(per, Math.floor(ok[id] ?? 0)))
    if (good > 0) printed += await movePlate(shopId, jobId, actorId, sliceImportId, runId, 'printed', null, id, good)
    if (per - good > 0) failed += await movePlate(shopId, jobId, actorId, sliceImportId, runId, 'reprint', why, id, per - good)
  }
  return { printed, failed }
}

/** See data.local.ts's movePlate. */
async function movePlate(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null,
  to: 'printed' | 'reprint',
  note: string | null,
  onlyPart: string | null = null,
  /** How many of the part's copies on the plate to move, when not all. */
  count: number | null = null,
): Promise<number> {
  const { data, error } = await supabase
    .from('slice_sections')
    // job_parts and slice_sections are linked twice (slice_sections.part_id
    // and job_parts.chosen_section_id), so the embed must name its link or
    // PostgREST refuses it as ambiguous (PGRST201).
    .select(
      'part_id, qty, slice_imports!inner ( job_id ), job_parts!part_id!inner ( qty, printed_n, passed_n, reprint_n, copy_states, shop_id )',
    )
    .eq('import_id', sliceImportId)
    .eq('slice_imports.job_id', jobId)
    .eq('job_parts.shop_id', shopId)
  if (error) throw error
  // One entry per PART: see data.local.ts's markPlatePrinted for why two
  // sections of one plate are summed rather than moved one by one.
  const byPart = new Map<string, { perPlate: number; p: any }>()
  for (const r of (data ?? []) as any[]) {
    const prev = byPart.get(r.part_id)
    const add = Math.max(1, Number(r.qty ?? 1))
    if (prev) prev.perPlate += add
    else byPart.set(r.part_id, { perPlate: add, p: r.job_parts })
  }
  const { data: queued, error: qErr } = await supabase
    .from('part_events')
    .select('part_id, copies, slice_import_id')
    .eq('job_id', jobId)
    .eq('to_status', 'pending')
    .not('copies', 'is', null)
    .order('at')
    .order('id')
  if (qErr) throw qErr
  let moved = 0
  for (const [partId, { perPlate, p }] of byPart) {
    if (onlyPart && partId !== onlyPart) continue
    const states = statesOf({ qty: Number(p.qty), printedN: Number(p.printed_n), passedN: Number(p.passed_n), reprintN: Number(p.reprint_n), copyStates: p.copy_states })
    const pick = plateCopies(
      states,
      queuedCopies((queued ?? []) as any[], partId, sliceImportId, states),
      count ?? perPlate,
      to === 'printed' ? ['reprint', 'pending'] : ['pending'],
    )
    if (!pick.length) continue
    await setCopyStates(shopId, partId, actorId, pick, to, note, runId)
    moved += onlyPart ? pick.length : 1
  }
  return moved
}

/** See data.local.ts's stateBefore. */
async function stateBefore(partId: string, c: number, beforeId: number): Promise<PartStatus> {
  const { data, error } = await supabase
    .from('part_events')
    .select('id, to_status, copies')
    .eq('part_id', partId)
    .eq('kind', 'status')
    .not('to_status', 'is', null)
    .lt('id', beforeId)
    .order('id', { ascending: false })
  if (error) throw error
  for (const e of (data ?? []) as { to_status: PartStatus; copies: string | null }[]) {
    if (e.copies == null || parseCopyList(e.copies).includes(c)) return e.to_status
  }
  return 'pending'
}

async function partNote(partId: string, jobId: string, note: string, actorId: string | null) {
  const { error } = await supabase.from('part_events').insert({ part_id: partId, job_id: jobId, kind: 'note', note, actor_id: actorId })
  if (error) throw error
}

/** See data.local.ts's moveSliceSection. */
export async function moveSliceSection(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sectionId: string,
  to: SectionAssign,
): Promise<SectionMoveResult> {
  const { data: secRow, error: sErr } = await supabase
    .from('slice_sections')
    .select('import_id, part_id, label, qty, slice_imports!inner ( job_id, shop_id, file_name )')
    .eq('id', sectionId)
    .maybeSingle()
  if (sErr) throw sErr
  const imp = (secRow as any)?.slice_imports
  if (!secRow || !imp || imp.job_id !== jobId || imp.shop_id !== shopId) throw new Error('That object is not on a plate of this project.')
  const sec = secRow as { import_id: string; part_id: string | null; label: string; qty: number }
  const fileName = imp.file_name as string
  const { data: partRows, error: pErr } = await supabase
    .from('job_parts')
    .select('id, label, sort, chosen_section_id')
    .eq('job_id', jobId)
    .eq('shop_id', shopId)
  if (pErr) throw pErr
  const parts = (partRows ?? []) as { id: string; label: string; sort: number; chosen_section_id: string | null }[]
  const old = parts.find((x) => x.id === sec.part_id) ?? null
  let partId: string
  let newName: string
  if ('label' in to) {
    const want = to.label.trim().toLowerCase()
    const named = parts.find((x) => x.label.trim().toLowerCase() === want)
    to = named ? { partId: named.id } : { newLabel: to.label }
  }
  if ('partId' in to) {
    const p = parts.find((x) => x.id === to.partId)
    if (!p) throw new Error('That part is not on this project.')
    partId = p.id
    newName = p.label
  } else {
    newName = uniqueLabel(to.newLabel.trim() || sec.label, parts.map((x) => x.label))
    const sort = Math.max(-1, ...parts.map((x) => Number(x.sort ?? -1))) + 1
    const { data: made, error: mErr } = await supabase
      .from('job_parts')
      .insert({ shop_id: shopId, job_id: jobId, label: newName, qty: Math.max(1, Number(sec.qty) || 1), sort })
      .select('id')
      .single()
    if (mErr) throw mErr
    partId = made.id as string
    const { error: evErr } = await supabase.from('part_events').insert({
      part_id: partId,
      job_id: jobId,
      kind: 'status',
      to_status: 'pending',
      note: `Sorted from ${fileName}`,
      actor_id: actorId,
    })
    if (evErr) throw evErr
  }
  const from = sec.part_id
  if (from === partId) return { partId, moved: 0, unplaced: 0 }

  const { data: runRows, error: rErr } = await supabase
    .from('print_runs')
    .select('id, outcome, failure_reason, started_at, consumed_at')
    .eq('slice_import_id', sec.import_id)
    .eq('shop_id', shopId)
    .order('started_at', { ascending: true })
    .order('consumed_at', { ascending: true, nullsFirst: true })
  if (rErr) throw rErr
  const runs = (runRows ?? []) as { id: string; outcome: string; failure_reason: string | null }[]

  let undone = 0
  if (from) {
    for (const run of [...runs].reverse()) {
      const { data: evs, error: eErr } = await supabase
        .from('part_events')
        .select('id, to_status, copies, note')
        .eq('run_id', run.id)
        .eq('part_id', from)
        .eq('kind', 'status')
        .not('copies', 'is', null)
        .order('id', { ascending: false })
      if (eErr) throw eErr
      for (const ev of (evs ?? []) as { id: number; to_status: PartStatus; copies: string | null; note: string | null }[]) {
        const cur = await readCopies(shopId, from)
        const states = [...cur.states]
        const marked = parseCopyList(ev.copies)
        let back = 0
        for (const c of marked) {
          if (states[c - 1] !== ev.to_status) continue
          states[c - 1] = await stateBefore(from, c, ev.id)
          back++
        }
        if (back) {
          const n = countsOf(states)
          const { error: uErr } = await supabase
            .from('job_parts')
            .update({
              copy_states: JSON.stringify(states),
              printed_n: n.printed,
              passed_n: n.passed,
              reprint_n: n.reprint,
              status: statusOf(n),
              updated_at: new Date().toISOString(),
            })
            .eq('id', from)
            .eq('shop_id', shopId)
          if (uErr) throw uErr
          undone += back
        }
        if (back === marked.length) {
          const { error: nErr } = await supabase
            .from('part_events')
            .update({ kind: 'note', note: `Moved with its plate object: ${ev.note ?? ev.to_status}`, from_status: null, to_status: null })
            .eq('id', ev.id)
          if (nErr) throw nErr
        }
      }
    }
    if (old?.chosen_section_id === sectionId) {
      const { error: cErr } = await supabase.from('job_parts').update({ chosen_section_id: null }).eq('id', from).eq('shop_id', shopId)
      if (cErr) throw cErr
    }
    await partNote(
      from,
      jobId,
      `${sec.label} on ${fileName} moved to ${newName}${undone ? ` — ${undone} cop${undone === 1 ? 'y' : 'ies'} it marked put back as before` : ''}.`,
      actorId,
    )
  }
  const { error: mvErr } = await supabase.from('slice_sections').update({ part_id: partId }).eq('id', sectionId)
  if (mvErr) throw mvErr
  let moved = 0
  let unplaced = 0
  for (const run of runs) {
    const ok = run.outcome === 'success'
    const n = await movePlate(shopId, jobId, actorId, sec.import_id, run.id, ok ? 'printed' : 'reprint', ok ? null : run.failure_reason || 'The plate failed.', partId)
    if (n) moved += n
    else unplaced++
  }
  if (from) await partNote(partId, jobId, `${sec.label} on ${fileName} sorted here from ${old?.label ?? 'another part'}.`, actorId)
  return { partId, moved, unplaced }
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
  const before = await readPartForCopies(shopId, partId)
  const { error } = await supabase
    .from('job_parts')
    .update({ label, note, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error
  const said = describePartEdit(before, { label, qty: before.qty, note })
  if (qty !== before.qty) {
    const r = await applyCopyCount(shopId, { ...before, label }, qty)
    said.push(describeCopiesChange(label, before.qty, r, qty))
  }
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

/** See data.local.ts. */
async function readPartForCopies(shopId: string, partId: string) {
  const { data: p, error } = await supabase
    .from('job_parts')
    .select('id, job_id, label, qty, note, printed_n, passed_n, reprint_n, copy_states, spare_n')
    .eq('id', partId)
    .eq('shop_id', shopId)
    .single()
  if (error) throw error
  if (!p) throw new Error('That part is not in this shop.')
  return { ...(p as any), qty: Number(p.qty), spare_n: Number(p.spare_n ?? 0) } as {
    id: string
    job_id: string
    label: string
    qty: number
    note: string | null
    printed_n: number
    passed_n: number
    reprint_n: number
    copy_states: string | null
    spare_n: number
  }
}

/** See data.local.ts's applyCopyCount. */
async function applyCopyCount(shopId: string, p: Awaited<ReturnType<typeof readPartForCopies>>, qty: number) {
  const r = changeCopies(
    statesOf({
      qty: p.qty,
      printedN: Number(p.printed_n),
      passedN: Number(p.passed_n),
      reprintN: Number(p.reprint_n),
      copyStates: p.copy_states,
    }),
    p.spare_n,
    qty,
  )
  const c = countsOf(r.states)
  const { error } = await supabase
    .from('job_parts')
    .update({
      qty,
      copy_states: JSON.stringify(r.states),
      printed_n: c.printed,
      passed_n: c.passed,
      reprint_n: c.reprint,
      status: statusOf(c),
      spare_n: r.spare,
      updated_at: new Date().toISOString(),
    })
    .eq('id', p.id)
    .eq('shop_id', shopId)
  if (error) throw error
  await renumberPartEvents(p.id, r.removed)
  return r
}

/** See data.local.ts's renumberPartEvents. */
async function renumberPartEvents(partId: string, removed: number[]) {
  if (removed.length === 0) return
  const { data, error } = await supabase.from('part_events').select('id, copies').eq('part_id', partId).not('copies', 'is', null)
  if (error) throw error
  for (const e of (data ?? []) as { id: number; copies: string | null }[]) {
    const next = renumberCopies(e.copies, removed)
    if (next === e.copies) continue
    const { error: uErr } = await supabase.from('part_events').update({ copies: next }).eq('id', e.id)
    if (uErr) throw uErr
  }
}

/** See data.local.ts's setPartsCopies. */
export async function setPartsCopies(
  shopId: string,
  jobId: string,
  actorId: string | null,
  changes: PartCopiesChange[],
  reason: string | null,
): Promise<PartCopiesResult[]> {
  const parts = []
  for (const ch of changes) {
    const qty = Math.floor(Number(ch.qty))
    if (!Number.isFinite(qty) || qty < 1) throw new Error('A part needs at least one copy.')
    const p = await readPartForCopies(shopId, ch.partId)
    if (p.job_id !== jobId) throw new Error(`"${p.label}" is not on this project.`)
    if (p.qty !== qty) parts.push({ p, qty })
  }
  if (parts.length === 0) return []
  const why = reason?.trim() || null
  const out: PartCopiesResult[] = []
  for (const { p, qty } of parts) {
    const r = await applyCopyCount(shopId, p, qty)
    const line = describeCopiesChange(p.label, p.qty, r, qty)
    const { error } = await supabase
      .from('part_events')
      .insert({ part_id: p.id, job_id: jobId, kind: 'note', note: why ? `${line} Why: ${why}` : line, actor_id: actorId })
    if (error) throw error
    out.push({ partId: p.id, label: p.label, from: p.qty, to: qty, toSpare: r.toSpare, fromSpare: r.fromSpare, dropped: r.dropped })
  }
  const head =
    out.length === 1
      ? describeCopiesChange(out[0].label, out[0].from, out[0], out[0].to)
      : `Copies changed on ${out.length} parts: ${out.map((x) => `${x.label} ${x.from} → ${x.to}`).join(', ')}.`
  const { error: jErr } = await supabase
    .from('job_events')
    .insert({ job_id: jobId, actor_id: actorId, kind: 'edit', body: why ? `${head} Why: ${why}` : head })
  if (jErr) throw jErr
  return out
}

export async function deletePart(
  shopId: string,
  partId: string,
  actorId: string | null = null,
  reason: string | null = null,
): Promise<void> {
  const { data: part, error: readErr } = await supabase
    .from('job_parts')
    .select('job_id, label, qty')
    .eq('id', partId)
    .eq('shop_id', shopId)
    .maybeSingle()
  if (readErr) throw readErr
  if (!part) return
  const { error } = await supabase.from('job_parts').delete().eq('id', partId).eq('shop_id', shopId)
  if (error) throw error
  const { error: evErr } = await supabase.from('job_events').insert({
    job_id: part.job_id,
    actor_id: actorId,
    kind: 'edit',
    body: `Removed part "${part.label}" ×${part.qty}.${reason?.trim() ? ` Why: ${reason.trim()}` : ''}`,
  })
  if (evErr) throw evErr
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
  // '' is a plate picture taken off on purpose: kept, never shown.
  const pics = await supabase
    .from('product_photos')
    .select('id, product_id, image, import_id')
    .eq('shop_id', shopId)
    .neq('image', '')
    .order('sort')
    .order('created_at')
  if (pics.error) throw pics.error
  const photosOf = (pid: string) =>
    ((pics.data ?? []) as any[])
      .filter((x) => String(x.product_id) === pid)
      .map((x) => ({ id: String(x.id), image: String(x.image), import_id: x.import_id ? String(x.import_id) : null }))

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
      shipping_charged: Number((b as { shipping_charged?: number }).shipping_charged ?? 0),
      shipping_cost: Number((b as { shipping_cost?: number }).shipping_cost ?? 0),
      estimated: (parent?.job_id ?? null) === null,
    }
  })

  return (products.data ?? []).map((p) => {
    const photos = photosOf(String(p.id))
    return {
    id: String(p.id),
    name: String(p.name),
    design_job_id: p.design_job_id ? String(p.design_job_id) : null,
    design_cost: p.design_cost === null ? null : Number(p.design_cost),
    design_hours: p.design_hours === null ? null : Number(p.design_hours),
    archived: p.archived ? 1 : 0,
    photo: photos[0]?.image ?? null,
    photos,
    batches: batches.filter((b) => b.product_id === String(p.id)),
    }
  })
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
    .select('id, batch_id, channel_id, units, unit_price, fee_total, sold_on, note, shipping_charged, shipping_cost, channels ( name )')
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
    shipping_charged: Number((s as { shipping_charged?: number }).shipping_charged ?? 0),
    shipping_cost: Number((s as { shipping_cost?: number }).shipping_cost ?? 0),
  }))
}

export async function recordSale(shopId: string, next: SaleInput): Promise<string> {
  if (!Number.isFinite(next.units) || next.units < 1) throw new Error('A sale is at least one unit.')
  for (const v of [next.shippingCharged, next.shippingCost])
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) throw new Error('Shipping cannot be negative.')
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
      shipping_charged: round2(Math.max(0, Number(next.shippingCharged ?? 0))),
      shipping_cost: round2(Math.max(0, Number(next.shippingCost ?? 0))),
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
    if (input.progress?.length) {
      const { error } = await supabase
        .from('slice_imports')
        .update({ progress: encodeProgress(input.progress) })
        .eq('id', dup.id)
        .is('progress', null)
      if (error) throw error
    }
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
      progress: encodeProgress(input.progress),
      thumbnail: input.thumbnail ?? null,
      sliced_at: input.slicedAt ?? null,
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
    const target = input.forPartId && input.sections.length === 1 ? input.forPartId : null
    // See data.local.ts: sorted by a person, or matched by name.
    const assign = sec.assign ?? null
    if (assign && 'partId' in assign && !(existing ?? []).some((r) => r.id === assign.partId))
      throw new Error('That part is not on this project.')
    let partId: string | null =
      target ??
      (assign
        ? 'partId' in assign
          ? assign.partId
          : 'label' in assign
            ? (byLabel.get(assign.label.trim().toLowerCase()) ?? null)
            : null
        : (byLabel.get(label.toLowerCase()) ?? null))
    const newLabel =
      assign && 'newLabel' in assign
        ? uniqueLabel(assign.newLabel.trim() || label, byLabel.keys())
        : assign && 'label' in assign
          ? assign.label.trim() || label
          : label

    if (partId) partsMatched++
    else {
      const { data: part, error: partErr } = await supabase
        .from('job_parts')
        .insert({ shop_id: shopId, job_id: jobId, label: newLabel, qty, sort: sort++ })
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
      byLabel.set(newLabel.toLowerCase(), partId)
      partsAdded++
    }

    const { data: secRow, error: secErr } = await supabase
      .from('slice_sections')
      .insert({
        import_id: importId,
        part_id: partId,
        label,
        qty,
        est_minutes: sec.estMinutes,
        est_grams: sec.estGrams,
        material: sec.material,
      })
      .select('id')
      .single()
    if (secErr) throw secErr
    // See data.local.ts: the replacement is what the part prints from now.
    if (input.forPartId && partId === input.forPartId) {
      const { error: chErr } = await supabase
        .from('job_parts')
        .update({ chosen_section_id: secRow.id })
        .eq('id', input.forPartId)
        .eq('shop_id', shopId)
      if (chErr) throw chErr
    }
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
       est_minutes, est_grams, notes, imported_at, progress, thumbnail, sliced_at,
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
      progress: decodeProgress(r.progress as string | null),
      thumbnail: (r.thumbnail as string | null) ?? null,
      slicedAt: (r.sliced_at as string | null) ?? null,
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

/** See data.local.ts's listStockHolds. */
export async function listStockHolds(shopId: string): Promise<StockHoldRow[]> {
  const { data, error } = await supabase
    .from('stock_held')
    .select('job_id, ref, title, phase, material_id, held, used, remaining')
    .eq('shop_id', shopId)
    .order('ref')
  if (error) throw error
  return ((data ?? []) as any[]).map((r) => ({
    jobId: r.job_id,
    ref: r.ref,
    title: r.title,
    phase: r.phase,
    materialId: r.material_id,
    held: Number(r.held),
    used: Number(r.used),
    remaining: Number(r.remaining),
  }))
}

/** See data.local.ts's setStockHolds. */
export async function setStockHolds(
  shopId: string,
  jobId: string,
  actorId: string | null,
  holds: StockHoldInput[],
): Promise<void> {
  const clean = holds.filter((h) => Number.isFinite(h.units) && h.units > 0)
  const { data: mats, error: mErr } = await supabase.from('materials').select('id, name, unit').eq('shop_id', shopId)
  if (mErr) throw mErr
  for (const h of clean) {
    if (!(mats ?? []).some((m: any) => m.id === h.materialId)) throw new Error('That material is not in this shop.')
  }
  const { error: dErr } = await supabase.from('stock_holds').delete().eq('job_id', jobId)
  if (dErr) throw dErr
  if (clean.length) {
    const { error } = await supabase.from('stock_holds').insert(
      clean.map((h) => ({ job_id: jobId, material_id: h.materialId, units: Math.ceil(h.units), actor_id: actorId })),
    )
    if (error) throw error
  }
  const body = describeHolds(
    clean.map((h) => {
      const m = (mats as any[]).find((x) => x.id === h.materialId)
      return { name: m.name, unit: m.unit, units: Math.ceil(h.units) }
    }),
  )
  const { error: evErr } = await supabase.from('job_events').insert({ job_id: jobId, actor_id: actorId, kind: 'edit', body })
  if (evErr) throw evErr
}

/** See data.local.ts's skipCopy. */
export async function skipCopy(
  shopId: string,
  partId: string,
  actorId: string | null,
  copy: number,
  note: string | null,
): Promise<void> {
  const before = await readCopies(shopId, partId)
  if (before.states.length <= 1) throw new Error('This is the only copy — remove the part instead of skipping it.')
  if (!Number.isInteger(copy) || copy < 0 || copy >= before.states.length) throw new Error(`There is no copy ${copy + 1}.`)
  const states = before.states.filter((_, i) => i !== copy)
  const c = countsOf(states)
  const { error } = await supabase
    .from('job_parts')
    .update({
      qty: states.length,
      copy_states: JSON.stringify(states),
      printed_n: c.printed,
      passed_n: c.passed,
      reprint_n: c.reprint,
      status: statusOf(c),
      updated_at: new Date().toISOString(),
    })
    .eq('id', partId)
    .eq('shop_id', shopId)
  if (error) throw error
  await renumberPartEvents(partId, [copy])
  const body = `Copy ${copy + 1} skipped — not printed again; ${states.length} cop${states.length === 1 ? 'y' : 'ies'} now.${note?.trim() ? ` Why: ${note.trim()}` : ''}`
  const { error: pErr } = await supabase
    .from('part_events')
    .insert({ part_id: partId, job_id: before.jobId, kind: 'note', copies: String(copy + 1), note: body, actor_id: actorId })
  if (pErr) throw pErr
  const { error: jErr } = await supabase.from('job_events').insert({ job_id: before.jobId, actor_id: actorId, kind: 'edit', body })
  if (jErr) throw jErr
}


/* ---- what each print made (0043) -- see data.local.ts ----------------- */

const madeFromRow = (r: any): MadeItemRow => ({
  id: r.id,
  jobId: r.job_id,
  runId: r.run_id,
  sectionId: r.section_id,
  label: r.label,
  grams: r.grams == null ? null : Number(r.grams),
  unitCost: Number(r.unit_cost),
  status: r.status as MadeStatus,
  assemblyId: r.assembly_id,
  batchId: r.batch_id,
  note: r.note,
  createdAt: r.created_at,
  placedAt: r.placed_at,
  printedOn: r.print_runs?.started_at ? String(r.print_runs.started_at).slice(0, 10) : null,
  fileName: r.slice_sections?.slice_imports?.file_name ?? null,
})

export async function listMadeItems(shopId: string, jobId: string): Promise<MadeItemRow[]> {
  const { data, error } = await supabase
    .from('made_items')
    .select('*, print_runs ( started_at ), slice_sections ( slice_imports ( file_name ) )')
    .eq('shop_id', shopId)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as any[])
    .map(madeFromRow)
    .sort((a, b) => (b.printedOn ?? b.createdAt).localeCompare(a.printedOn ?? a.createdAt))
}

async function placedCount(runId: string): Promise<number> {
  const { count, error } = await supabase
    .from('made_items')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .in('status', ['shelved', 'assembled', 'kept'])
  if (error) throw error
  return count ?? 0
}

export async function recordMadeItems(shopId: string, jobId: string, runId: string, items: MadeItemInput[]): Promise<void> {
  validateMadeItems(items)
  const { data: run, error: rErr } = await supabase.from('print_runs').select('job_id').eq('id', runId).eq('shop_id', shopId).maybeSingle()
  if (rErr) throw rErr
  if (!run || run.job_id !== jobId) throw new Error('That print is not on this project.')
  if ((await placedCount(runId)) > 0) throw new Error('Some of what this print made is already placed — take it back first.')
  const { error: dErr } = await supabase.from('made_items').delete().eq('run_id', runId)
  if (dErr) throw dErr
  if (!items.length) return
  const { error } = await supabase.from('made_items').insert(
    items.map((it) => ({
      shop_id: shopId,
      job_id: jobId,
      run_id: runId,
      section_id: it.sectionId,
      label: it.label.trim(),
      grams: it.grams,
      unit_cost: it.unitCost,
      status: it.failed ? 'failed' : 'made',
      note: it.note ?? null,
    })),
  )
  if (error) throw error
}

export async function placeItems(shopId: string, jobId: string, ids: string[], to: ItemPlace): Promise<{ batchId?: string }> {
  if (!ids.length) return {}
  const { data, error } = await supabase.from('made_items').select('*').eq('shop_id', shopId).in('id', ids)
  if (error) throw error
  const rows = (data ?? []) as any[]
  if (rows.length !== ids.length || rows.some((r) => r.job_id !== jobId)) throw new Error('Those items are not all on this project.')
  const now = new Date().toISOString()
  const set = async (patch: Record<string, unknown>) => {
    const { error: uErr } = await supabase.from('made_items').update(patch).eq('shop_id', shopId).in('id', ids)
    if (uErr) throw uErr
  }
  if (to.kind === 'back') {
    for (const r of rows) {
      if (r.status === 'shelved') throw new Error(`${r.label} is on the shelf and may have sold — it cannot come back from there.`)
      if (r.status === 'failed') throw new Error(`${r.label} failed; it stays a failure.`)
      if (r.assembly_id) {
        const { data: a } = await supabase.from('assemblies').select('status').eq('id', r.assembly_id).maybeSingle()
        if (a?.status === 'done') throw new Error(`${r.label} is in a finished assembly.`)
      }
    }
    await set({ status: 'made', assembly_id: null, placed_at: null })
    return {}
  }
  const bad = rows.find((r) => r.status !== 'made')
  if (bad) throw new Error(`${bad.label} is ${bad.status === 'failed' ? 'a failed print' : 'already placed'}.`)
  if (to.kind === 'kept') {
    await set({ status: 'kept', placed_at: now })
    return {}
  }
  if (to.kind === 'assembly') {
    const { data: a, error: aErr } = await supabase.from('assemblies').select('job_id, status').eq('id', to.assemblyId).eq('shop_id', shopId).maybeSingle()
    if (aErr) throw aErr
    if (!a || a.job_id !== jobId) throw new Error('That assembly is not on this project.')
    if (a.status !== 'open') throw new Error('That assembly is finished.')
    await set({ status: 'assembled', assembly_id: to.assemblyId, placed_at: now })
    return {}
  }
  const productId =
    to.productId ??
    (await saveProduct(shopId, { name: to.name ?? '', designJobId: jobId, designCost: to.designCost ?? null, designHours: to.designHours ?? null }))
  const total = rows.reduce((a, r) => a + Number(r.unit_cost), 0)
  const batchId = await saveBatch(shopId, {
    productId,
    jobId,
    unitsMade: rows.length,
    unitCost: Math.round((total / rows.length) * 1e6) / 1e6,
    madeOn: to.madeOn,
    note: shelfNote(rows.map((r) => r.label)),
  })
  await set({ status: 'shelved', batch_id: batchId, placed_at: now })
  await matchShelfPhotos(shopId).catch(() => undefined)
  return { batchId }
}

const assemblyFromRow = (r: any): AssemblyRow => {
  let needs: { label: string; qty: number }[] = []
  try {
    const v = JSON.parse(r.needs || '[]')
    if (Array.isArray(v)) needs = v.filter((x) => x && typeof x.label === 'string' && Number(x.qty) > 0).map((x) => ({ label: String(x.label), qty: Math.floor(Number(x.qty)) }))
  } catch {
    needs = []
  }
  return { id: r.id, jobId: r.job_id, name: r.name, needs, status: r.status, batchId: r.batch_id, createdAt: r.created_at, doneAt: r.done_at }
}

export async function listAssemblies(shopId: string, jobId: string): Promise<AssemblyRow[]> {
  const { data, error } = await supabase
    .from('assemblies')
    .select('*')
    .eq('shop_id', shopId)
    .eq('job_id', jobId)
    .order('status')
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as any[]).map(assemblyFromRow)
}

export async function saveAssembly(shopId: string, jobId: string, next: AssemblyInput): Promise<string> {
  const name = next.name.trim()
  if (!name) throw new Error('An assembly needs a name.')
  const needs = JSON.stringify(
    next.needs.map((n) => ({ label: n.label.trim(), qty: Math.floor(Number(n.qty)) })).filter((n) => n.label && n.qty > 0),
  )
  if (next.id) {
    const { error } = await supabase.from('assemblies').update({ name, needs }).eq('id', next.id).eq('shop_id', shopId)
    if (error) throw error
    return next.id
  }
  const { data, error } = await supabase.from('assemblies').insert({ shop_id: shopId, job_id: jobId, name, needs }).select('id').single()
  if (error) throw error
  return data.id as string
}

export async function finishAssembly(
  shopId: string,
  assemblyId: string,
  to: { kind: 'shelf'; productId: string | null; name?: string; madeOn: string } | { kind: 'kept' },
): Promise<{ batchId?: string }> {
  const { data: a, error } = await supabase.from('assemblies').select('*').eq('id', assemblyId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!a) throw new Error('That assembly no longer exists.')
  if (a.status === 'done') throw new Error('That assembly is already finished.')
  const { data: items, error: iErr } = await supabase.from('made_items').select('label, unit_cost').eq('assembly_id', assemblyId)
  if (iErr) throw iErr
  if (!items?.length) throw new Error('Nothing is in it yet.')
  // See data.local.ts: its hardware is used now, and is part of the unit cost.
  const { data: hw, error: hErr } = await supabase
    .from('assembly_hardware')
    .select('item_id, per_unit, hardware_items ( unit_cost )')
    .eq('assembly_id', assemblyId)
  if (hErr) throw hErr
  const hwRows = ((hw ?? []) as any[]).map((h) => ({
    item_id: h.item_id,
    per_unit: Number(h.per_unit),
    unit_cost: Number((Array.isArray(h.hardware_items) ? h.hardware_items[0] : h.hardware_items)?.unit_cost ?? 0),
  }))
  if (hwRows.length) {
    const { error: wErr } = await supabase.from('hardware_use').insert(
      hwRows.map((h) => ({ shop_id: shopId, job_id: a.job_id, item_id: h.item_id, qty: h.per_unit, unit_cost: h.unit_cost, source: 'assembly', assembly_id: assemblyId, note: `In ${a.name}` })),
    )
    if (wErr) throw wErr
  }
  const hwCost = hwRows.reduce((t, h) => t + h.per_unit * h.unit_cost, 0)
  let batchId: string | null = null
  if (to.kind === 'shelf') {
    const productId = to.productId ?? (await saveProduct(shopId, { name: to.name || a.name, designJobId: a.job_id }))
    batchId = await saveBatch(shopId, {
      productId,
      jobId: a.job_id,
      unitsMade: 1,
      unitCost: Math.round(((items as any[]).reduce((t, i) => t + Number(i.unit_cost), 0) + hwCost) * 1e6) / 1e6,
      madeOn: to.madeOn,
      note: `${a.name}: ${shelfNote((items as any[]).map((i) => i.label))}`,
    })
  }
  const { error: uErr } = await supabase
    .from('assemblies')
    .update({ status: 'done', batch_id: batchId, done_at: new Date().toISOString() })
    .eq('id', assemblyId)
  if (uErr) throw uErr
  if (batchId) await matchShelfPhotos(shopId).catch(() => undefined)
  return batchId ? { batchId } : {}
}

export async function deleteAssembly(shopId: string, assemblyId: string): Promise<void> {
  const { data: a, error } = await supabase.from('assemblies').select('status').eq('id', assemblyId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!a) return
  if (a.status === 'done') throw new Error('A finished assembly stays — it is on the shelf or kept.')
  const { error: uErr } = await supabase.from('made_items').update({ status: 'made', assembly_id: null, placed_at: null }).eq('assembly_id', assemblyId)
  if (uErr) throw uErr
  const { error: dErr } = await supabase.from('assemblies').delete().eq('id', assemblyId)
  if (dErr) throw dErr
}


/** See data.local.ts's deleteBatch. */
export async function deleteBatch(shopId: string, batchId: string): Promise<void> {
  const { count, error } = await supabase.from('sales').select('id', { count: 'exact', head: true }).eq('batch_id', batchId)
  if (error) throw error
  if ((count ?? 0) > 0) throw new Error('Some of this batch has sold — remove those sales first.')
  const { error: e1 } = await supabase
    .from('made_items')
    .update({ status: 'made', batch_id: null, placed_at: null })
    .eq('batch_id', batchId)
    .eq('shop_id', shopId)
  if (e1) throw e1
  const { error: e2 } = await supabase
    .from('assemblies')
    .update({ status: 'open', batch_id: null, done_at: null })
    .eq('batch_id', batchId)
    .eq('shop_id', shopId)
  if (e2) throw e2
  const { error: e3 } = await supabase.from('batches').delete().eq('id', batchId).eq('shop_id', shopId)
  if (e3) throw e3
}

/** See data.local.ts's deleteProduct. */
export async function deleteProduct(shopId: string, productId: string): Promise<void> {
  const { count, error } = await supabase.from('batches').select('id', { count: 'exact', head: true }).eq('product_id', productId)
  if (error) throw error
  if ((count ?? 0) > 0) throw new Error('Take its batches off the shelf first.')
  const { error: dErr } = await supabase.from('products').delete().eq('id', productId).eq('shop_id', shopId)
  if (dErr) throw dErr
}


/** See data.local.ts's updateProduct. */
export async function updateProduct(shopId: string, productId: string, patch: ProductPatch): Promise<void> {
  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('A product needs a name.')
    row.name = name
  }
  if (!Object.keys(row).length) return
  const { error } = await supabase.from('products').update(row).eq('id', productId).eq('shop_id', shopId)
  if (error) throw error
}

/** See data.local.ts's addProductPhotos. */
export async function addProductPhotos(shopId: string, productId: string, images: string[]): Promise<void> {
  const { data: top, error } = await supabase
    .from('product_photos').select('sort').eq('product_id', productId).eq('shop_id', shopId)
    .order('sort', { ascending: false }).limit(1)
  if (error) throw error
  let sort = Number((top ?? [])[0]?.sort ?? 0)
  const rows = images.filter(Boolean).map((image) => ({ shop_id: shopId, product_id: productId, image, sort: (sort += 1) }))
  if (!rows.length) return
  const { error: iErr } = await supabase.from('product_photos').insert(rows)
  if (iErr) throw iErr
}

/** See data.local.ts's removeProductPhoto. */
export async function removeProductPhoto(shopId: string, photoId: string): Promise<void> {
  const { data: x, error } = await supabase.from('product_photos').select('import_id').eq('id', photoId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!x) return
  const q = x.import_id
    ? supabase.from('product_photos').update({ image: '' }).eq('id', photoId)
    : supabase.from('product_photos').delete().eq('id', photoId)
  const { error: e2 } = await q
  if (e2) throw e2
}

/** See data.local.ts's coverProductPhoto. */
export async function coverProductPhoto(shopId: string, photoId: string): Promise<void> {
  const { data: x, error } = await supabase.from('product_photos').select('product_id').eq('id', photoId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!x) throw new Error('That picture no longer exists.')
  const { data: low } = await supabase.from('product_photos').select('sort').eq('product_id', x.product_id).order('sort').limit(1)
  const { error: e2 } = await supabase.from('product_photos').update({ sort: Number((low ?? [])[0]?.sort ?? 0) - 1 }).eq('id', photoId)
  if (e2) throw e2
}

/** See data.local.ts's matchShelfPhotos. */
export async function matchShelfPhotos(shopId: string): Promise<{ matched: number; need: string[] }> {
  const { data: products, error } = await supabase
    .from('products').select('id, name, design_job_id').eq('shop_id', shopId)
  if (error) throw error
  if (!products?.length) return { matched: 0, need: [] }
  const [h, b, m, a, i, s, f] = await Promise.all([
    supabase.from('product_photos').select('product_id, import_id').eq('shop_id', shopId),
    supabase.from('batches').select('id, product_id, job_id').eq('shop_id', shopId),
    supabase.from('made_items').select('batch_id, assembly_id, slice_sections ( import_id ), print_runs ( slice_import_id )').eq('shop_id', shopId),
    supabase.from('assemblies').select('id, batch_id').eq('shop_id', shopId),
    supabase.from('slice_imports').select('id, job_id, thumbnail').eq('shop_id', shopId),
    supabase.from('slice_sections').select('import_id, label, slice_imports!inner ( shop_id )').eq('slice_imports.shop_id', shopId),
    supabase.from('slice_files').select('import_id, slice_imports!inner ( shop_id )').eq('slice_imports.shop_id', shopId),
  ])
  for (const r of [h, b, m, a, i, s, f]) if (r.error) throw r.error
  const kept = new Set(((f.data ?? []) as any[]).map((x) => String(x.import_id)))
  const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? x[0] ?? null : x ?? null)
  const pick = pickShelfPhotos({
    products: (products as any[]).map((p) => ({ id: String(p.id), name: p.name, design_job_id: p.design_job_id ?? null })),
    have: ((h.data ?? []) as any[]).map((x) => ({ product_id: String(x.product_id), import_id: x.import_id ? String(x.import_id) : null })),
    batches: ((b.data ?? []) as any[]).map((x) => ({ id: String(x.id), product_id: String(x.product_id), job_id: x.job_id ?? null })),
    items: ((m.data ?? []) as any[]).map((x) => ({
      batch_id: x.batch_id ?? null,
      assembly_id: x.assembly_id ?? null,
      import_id: one<any>(x.slice_sections)?.import_id ?? one<any>(x.print_runs)?.slice_import_id ?? null,
    })),
    assemblies: ((a.data ?? []) as any[]).map((x) => ({ id: String(x.id), batch_id: x.batch_id ?? null })),
    imports: ((i.data ?? []) as any[]).map((x) => ({ id: String(x.id), job_id: String(x.job_id), thumbnail: x.thumbnail ?? null, has_file: kept.has(String(x.id)) })),
    sections: ((s.data ?? []) as any[]).map((x) => ({ import_id: String(x.import_id), label: String(x.label) })),
  })
  for (const x of pick.add) {
    const { data: top } = await supabase
      .from('product_photos').select('sort').eq('product_id', x.productId).order('sort', { ascending: false }).limit(1)
    const { error: iErr } = await supabase.from('product_photos').insert({
      shop_id: shopId, product_id: x.productId, image: x.thumbnail, import_id: x.importId,
      sort: Number((top ?? [])[0]?.sort ?? 0) + 1,
    })
    // 23505: the plate is already there (another device got to it first).
    if (iErr && (iErr as { code?: string }).code !== '23505') throw iErr
  }
  return { matched: pick.add.length, need: pick.need }
}

/** See data.local.ts's platePartIds. */
async function platePartIds(shopId: string, jobId: string, sliceImportId: string): Promise<{ id: string; per: number }[]> {
  const { data, error } = await supabase
    .from('slice_sections')
    .select('part_id, qty, slice_imports!inner ( job_id, shop_id )')
    .eq('import_id', sliceImportId)
    .eq('slice_imports.job_id', jobId)
    .eq('slice_imports.shop_id', shopId)
  if (error) throw error
  const per = new Map<string, number>()
  for (const r of (data ?? []) as any[]) if (r.part_id) per.set(String(r.part_id), (per.get(String(r.part_id)) ?? 0) + Math.max(1, Number(r.qty) || 1))
  return [...per].map(([id, n]) => ({ id, per: n }))
}

/** See data.local.ts's mergeParts. */
export async function mergeParts(
  shopId: string,
  jobId: string,
  actorId: string | null,
  partIds: string[],
  label: string,
  need: number | null = null,
): Promise<string> {
  const name = label.trim()
  if (!name) throw new Error('The combined part needs a name.')
  const ids = [...new Set(partIds)]
  if (ids.length < 2) throw new Error('Pick at least two parts to combine.')
  const { data, error } = await supabase
    .from('job_parts')
    .select('id, label, qty, printed_n, passed_n, reprint_n, copy_states, spare_n')
    .eq('shop_id', shopId)
    .eq('job_id', jobId)
    .in('id', ids)
  if (error) throw error
  const rows = ((data ?? []) as any[]).sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)))
  if (rows.length !== ids.length) throw new Error('Those parts are not all on this project.')
  const [keep, ...rest] = rows
  const states0 = rows.map((r) => ({
    id: String(r.id),
    states: statesOf({ qty: Number(r.qty), printedN: Number(r.printed_n), passedN: Number(r.passed_n), reprintN: Number(r.reprint_n), copyStates: r.copy_states }),
  }))
  const plan = planMerge(states0, need ?? Math.max(...rows.map((r) => Number(r.qty))))
  const states = plan.states
  const spare = rows.reduce((t, r) => t + (Number(r.spare_n) || 0), 0) + plan.spare
  for (const r of rows) {
    const qty0 = states0.find((x) => x.id === String(r.id))!.states.length
    const { data: evs, error: eErr } = await supabase.from('part_events').select('id, copies, kind, note, to_status').eq('part_id', r.id)
    if (eErr) throw eErr
    for (const e of (evs ?? []) as any[]) {
      const moved = movedCopies(e, qty0, String(r.id), plan.map)
      const patch =
        moved === undefined
          ? { part_id: keep.id }
          : moved
            ? { part_id: keep.id, copies: moved }
            : { part_id: keep.id, kind: 'note', from_status: null, to_status: null, note: `On ${r.label}, before it was combined: ${e.note ?? e.to_status ?? ''}` }
      const { error: uErr } = await supabase.from('part_events').update(patch).eq('id', e.id)
      if (uErr) throw uErr
    }
    if (r.id !== keep.id) {
      const { error: sErr } = await supabase.from('slice_sections').update({ part_id: keep.id }).eq('part_id', r.id)
      if (sErr) throw sErr
    }
  }
  const n = countsOf(states)
  const { error: pErr } = await supabase
    .from('job_parts')
    .update({ label: name, qty: states.length, copy_states: JSON.stringify(states), printed_n: n.printed, passed_n: n.passed, reprint_n: n.reprint, status: statusOf(n), spare_n: spare })
    .eq('id', keep.id)
    .eq('shop_id', shopId)
  if (pErr) throw pErr
  if (rest.length) {
    const { error: dErr } = await supabase.from('job_parts').delete().eq('shop_id', shopId).in('id', rest.map((r) => r.id))
    if (dErr) throw dErr
  }
  const said = `Combined ${rows.map((r) => `"${r.label}" ×${r.qty}`).join(', ')} into "${name}" ×${states.length}.`
  await supabase.from('part_events').insert({ part_id: keep.id, job_id: jobId, kind: 'note', note: said, actor_id: actorId })
  await supabase.from('job_events').insert({ job_id: jobId, actor_id: actorId, kind: 'edit', body: said })
  return String(keep.id)
}

/* ---- Equipment and hardware (0047; see data.local.ts) ------------------ */

export async function listEquipment(shopId: string): Promise<EquipmentRow[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, name, kind, tracking, watts, price, life_hours, archived, equipment_printers ( printer_id )')
    .eq('shop_id', shopId)
    .order('archived')
    .order('name')
  if (error) throw error
  return ((data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: r.kind,
    tracking: r.tracking,
    watts: r.watts == null ? null : Number(r.watts),
    price: r.price == null ? null : Number(r.price),
    lifeHours: r.life_hours == null ? null : Number(r.life_hours),
    archived: !!r.archived,
    printerIds: ((r.equipment_printers ?? []) as any[]).map((x) => String(x.printer_id)),
  }))
}

export async function saveEquipment(shopId: string, input: EquipmentInput): Promise<string> {
  const next = validateEquipment(input)
  const row = { name: next.name, kind: next.kind, tracking: next.tracking, watts: next.watts, price: next.price, life_hours: next.lifeHours }
  let id = next.id
  if (id) {
    const { error } = await supabase.from('equipment').update(row).eq('id', id).eq('shop_id', shopId)
    if (error) throw error
  } else {
    const { data, error } = await supabase.from('equipment').insert({ ...row, shop_id: shopId }).select('id').single()
    if (error) throw error
    id = String(data.id)
  }
  const { error: dErr } = await supabase.from('equipment_printers').delete().eq('equipment_id', id)
  if (dErr) throw dErr
  if (next.printerIds.length) {
    const { error: iErr } = await supabase.from('equipment_printers').insert(next.printerIds.map((p) => ({ equipment_id: id, printer_id: p })))
    if (iErr) throw iErr
  }
  return id
}

export async function archiveEquipment(shopId: string, id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.from('equipment').update({ archived }).eq('id', id).eq('shop_id', shopId)
  if (error) throw error
}

export async function listHardware(shopId: string): Promise<HardwareRow[]> {
  const [items, stock] = await Promise.all([
    supabase.from('hardware_items').select('id, name, unit_cost, markup_pct, stock_base, reorder_at, archived').eq('shop_id', shopId).order('archived').order('name'),
    supabase.from('hardware_stock').select('item_id, used').eq('shop_id', shopId),
  ])
  if (items.error) throw items.error
  if (stock.error) throw stock.error
  const used = new Map(((stock.data ?? []) as any[]).map((s) => [String(s.item_id), Number(s.used ?? 0)]))
  return ((items.data ?? []) as any[]).map((r) => {
    const u = used.get(String(r.id)) ?? 0
    return {
      id: String(r.id),
      name: String(r.name),
      unitCost: Number(r.unit_cost),
      markupPct: Number(r.markup_pct),
      used: u,
      available: Number(r.stock_base) - u,
      reorderAt: Number(r.reorder_at),
      archived: !!r.archived,
    }
  })
}

export async function saveHardware(shopId: string, input: HardwareInput): Promise<string> {
  const next = validateHardware(input)
  let used = 0
  if (next.id) {
    const { data } = await supabase.from('hardware_stock').select('used').eq('item_id', next.id).maybeSingle()
    used = Number((data as any)?.used ?? 0)
  }
  const row = { name: next.name, unit_cost: next.unitCost, markup_pct: next.markupPct, stock_base: next.onHand + used, reorder_at: next.reorderAt }
  if (next.id) {
    const { error } = await supabase.from('hardware_items').update(row).eq('id', next.id).eq('shop_id', shopId)
    if (error) throw error
    return next.id
  }
  const { data, error } = await supabase.from('hardware_items').insert({ ...row, shop_id: shopId }).select('id').single()
  if (error) throw error
  return String(data.id)
}

export async function archiveHardware(shopId: string, id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.from('hardware_items').update({ archived }).eq('id', id).eq('shop_id', shopId)
  if (error) throw error
}

export async function listJobExtras(shopId: string, jobId: string): Promise<JobExtras> {
  const [eq, hw, ph, ah] = await Promise.all([
    supabase.from('equipment_use').select('id, equipment_id, hours, used_on, note, created_at, equipment ( name )').eq('shop_id', shopId).eq('job_id', jobId),
    supabase.from('hardware_use').select('id, item_id, qty, unit_cost, source, assembly_id, note, created_at, hardware_items ( name )').eq('shop_id', shopId).eq('job_id', jobId),
    supabase.from('part_hardware').select('part_id, item_id, per_copy, job_parts!inner ( job_id )').eq('job_parts.job_id', jobId),
    supabase.from('assembly_hardware').select('assembly_id, item_id, per_unit, assemblies!inner ( job_id )').eq('assemblies.job_id', jobId),
  ])
  for (const r of [eq, hw, ph, ah]) if (r.error) throw r.error
  const one = (x: any) => (Array.isArray(x) ? x[0] : x)
  return {
    equipment: ((eq.data ?? []) as any[])
      .sort((a, b) => String(b.used_on ?? b.created_at).localeCompare(String(a.used_on ?? a.created_at)))
      .map((r) => ({ id: String(r.id), equipmentId: String(r.equipment_id), equipmentName: String(one(r.equipment)?.name ?? ''), hours: Number(r.hours), usedOn: r.used_on ?? null, note: r.note ?? null })),
    hardware: ((hw.data ?? []) as any[])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r) => ({
        id: String(r.id),
        itemId: String(r.item_id),
        itemName: String(one(r.hardware_items)?.name ?? ''),
        qty: Number(r.qty),
        unitCost: Number(r.unit_cost),
        source: r.source as HardwareUseRow['source'],
        assemblyId: r.assembly_id ?? null,
        note: r.note ?? null,
        createdAt: String(r.created_at),
      })),
    partHardware: ((ph.data ?? []) as any[]).map((r) => ({ partId: String(r.part_id), itemId: String(r.item_id), perCopy: Number(r.per_copy) })),
    assemblyHardware: ((ah.data ?? []) as any[]).map((r) => ({ assemblyId: String(r.assembly_id), itemId: String(r.item_id), perUnit: Number(r.per_unit) })),
  }
}

export async function logEquipmentUse(shopId: string, jobId: string, actorId: string | null, input: EquipmentUseInput): Promise<string> {
  const hours = Number(input.hours)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Say how long it ran.')
  const { data: e, error } = await supabase.from('equipment').select('name, tracking').eq('id', input.equipmentId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!e) throw new Error('That equipment no longer exists.')
  if (e.tracking !== 'hours') throw new Error(`${e.name} is not tracked by logged hours — change how it is tracked in Shop settings.`)
  const { data, error: iErr } = await supabase
    .from('equipment_use')
    .insert({ shop_id: shopId, job_id: jobId, equipment_id: input.equipmentId, hours, used_on: input.usedOn || null, note: input.note?.trim() || null, actor_id: actorId })
    .select('id')
    .single()
  if (iErr) throw iErr
  await supabase.from('job_events').insert({ job_id: jobId, actor_id: actorId, kind: 'edit', body: `Logged ${Math.round(hours * 100) / 100} h on ${e.name}.` })
  return String(data.id)
}

export async function deleteEquipmentUse(shopId: string, id: string): Promise<void> {
  const { error } = await supabase.from('equipment_use').delete().eq('id', id).eq('shop_id', shopId)
  if (error) throw error
}

export async function addHardwareUse(shopId: string, jobId: string, actorId: string | null, input: HardwareUseInput): Promise<string> {
  const qty = Number(input.qty)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Say how many were used.')
  const { data: i, error } = await supabase.from('hardware_items').select('name, unit_cost').eq('id', input.itemId).eq('shop_id', shopId).maybeSingle()
  if (error) throw error
  if (!i) throw new Error('That hardware no longer exists.')
  const { data, error: iErr } = await supabase
    .from('hardware_use')
    .insert({ shop_id: shopId, job_id: jobId, item_id: input.itemId, qty, unit_cost: Number(i.unit_cost), source: 'manual', note: input.note?.trim() || null, actor_id: actorId })
    .select('id')
    .single()
  if (iErr) throw iErr
  await supabase.from('job_events').insert({ job_id: jobId, actor_id: actorId, kind: 'edit', body: `Used ${qty} × ${i.name}.` })
  return String(data.id)
}

export async function deleteHardwareUse(shopId: string, id: string): Promise<void> {
  const { error } = await supabase.from('hardware_use').delete().eq('id', id).eq('shop_id', shopId).eq('source', 'manual')
  if (error) throw error
}

export async function setPartHardware(shopId: string, partId: string, itemId: string, perCopy: number): Promise<void> {
  const n = Number(perCopy)
  if (!Number.isFinite(n) || n < 0) throw new Error('How many must be zero or more.')
  const { data: p, error: pErr } = await supabase.from('job_parts').select('id').eq('id', partId).eq('shop_id', shopId).maybeSingle()
  if (pErr) throw pErr
  if (!p) throw new Error('That part no longer exists.')
  const q = n === 0
    ? supabase.from('part_hardware').delete().eq('part_id', partId).eq('item_id', itemId)
    : supabase.from('part_hardware').upsert({ part_id: partId, item_id: itemId, per_copy: n })
  const { error } = await q
  if (error) throw error
}

export async function setAssemblyHardware(shopId: string, assemblyId: string, itemId: string, perUnit: number): Promise<void> {
  const n = Number(perUnit)
  if (!Number.isFinite(n) || n < 0) throw new Error('How many must be zero or more.')
  const { data: a, error: aErr } = await supabase.from('assemblies').select('status').eq('id', assemblyId).eq('shop_id', shopId).maybeSingle()
  if (aErr) throw aErr
  if (!a) throw new Error('That assembly no longer exists.')
  if (a.status === 'done') throw new Error('That assembly is finished — its hardware was already used.')
  const q = n === 0
    ? supabase.from('assembly_hardware').delete().eq('assembly_id', assemblyId).eq('item_id', itemId)
    : supabase.from('assembly_hardware').upsert({ assembly_id: assemblyId, item_id: itemId, per_unit: n })
  const { error } = await q
  if (error) throw error
}
