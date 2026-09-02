/**
 * The local-first counterpart to data.ts. Same exported types, same function
 * signatures, same return shapes — every screen that imports from data.ts
 * should be able to import from here instead with no other changes once
 * Phase 4 (see the project board) wires up the switch.
 *
 * Backed by @tauri-apps/plugin-sql against the SQLite schema in
 * src-tauri/migrations/0001_initial.sql, instead of the Supabase client.
 * The big differences from data.ts, all deliberate:
 *
 *   - No auth. loadShopContext() doesn't look up a signed-in user — a local
 *     install has exactly one shop, so it just reads the one row. There is
 *     no RLS to satisfy and no setup_shop() RPC to call around it.
 *   - Ids are generated here (crypto.randomUUID()) rather than by the
 *     database, since SQLite has no server-side uuid default.
 *   - rates_snapshot is stored and read back as a JSON string, not jsonb.
 *
 * Not yet exercised end to end — running the actual Tauri app needs a
 * display, which the build sandbox that wrote this file doesn't have. The
 * schema itself (including the job_money view) was verified against a real
 * sqlite3 binary; this module has not yet been run against a live app.
 * Treat it as a strong draft, not a proven one, until Phase 4's parity task
 * is checked off.
 */
import Database from '@tauri-apps/plugin-sql'
import type { MaterialRef, PrinterRef } from './pricing'
import { NeedsSetup, asClientKind, validateRun, validateHours, runEventBody } from './data.types'
import type {
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

let dbPromise: Promise<Database> | null = null
function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load('sqlite:guma.db')
  return dbPromise
}

function uuid(): string {
  return crypto.randomUUID()
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  const suffix = uuid().slice(0, 6)
  return (base || 'shop') + '-' + suffix
}

/** First run. No RPC needed — a fresh local database is its own permission
 *  boundary, so this just inserts directly: shop, rate card, first printer
 *  (if given), materials, and an owner profile for `fullName`. */
export async function setupShop(p: SetupPayload): Promise<string> {
  const d = await db()
  const shop = p.shop as Record<string, unknown>
  const rates = p.rates as Record<string, unknown>

  const shopId = uuid()
  await d.execute(
    `insert into shops
      (id, name, slug, currency, locale, tax_label, tax_pct, legal_name, address,
       state, email, phone, license_no, quote_valid_days, lead_days, electricity_rate_kwh)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      (shop.name as string) || 'My shop',
      slugify((shop.name as string) || 'shop'),
      (shop.currency as string) || 'USD',
      (shop.locale as string) || 'en-US',
      (shop.tax_label as string) || 'Tax',
      (shop.tax_pct as number) ?? 0,
      (shop.legal_name as string) || null,
      (shop.address as string) || null,
      (shop.state as string) || null,
      (shop.email as string) || null,
      (shop.phone as string) || null,
      (shop.license_no as string) || null,
      (shop.quote_valid_days as number) ?? 30,
      (shop.lead_days as number) ?? 10,
      (shop.electricity_rate_kwh as number | null) ?? null,
    ],
  )

  await d.execute(
    `insert into rate_cards
      (id, shop_id, design_hourly, finishing_hourly, rush_pct, minimum_order,
       deposit_pct, deposit_when, deposit_waive_below, material_markup,
       revisions_incl, revision_hourly)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      shopId,
      rates.design_hourly,
      rates.finishing_hourly,
      rates.rush_pct,
      rates.minimum_order,
      rates.deposit_pct,
      rates.deposit_when,
      rates.deposit_waive_below,
      rates.material_markup,
      rates.revisions_incl,
      rates.revision_hourly ?? null,
    ],
  )

  if (p.printer) {
    const printer = p.printer as Record<string, unknown>
    await d.execute(
      `insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly, watts)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        shopId,
        printer.name,
        printer.model || '—',
        printer.tech,
        printer.rate_hourly,
        printer.wear_hourly,
        (printer.watts as number | null) ?? null,
      ],
    )
  }

  for (const m of p.materials) {
    const mat = m as Record<string, unknown>
    await d.execute(
      `insert into materials (id, shop_id, name, kind, swatch, unit, cost_per_unit)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), shopId, mat.name, mat.kind, mat.swatch, mat.unit || 'g', mat.cost_per_unit],
    )
  }

  await d.execute(
    `insert into profiles (id, shop_id, full_name, role) values (?, ?, ?, 'owner')`,
    [uuid(), shopId, p.fullName || 'Owner'],
  )

  return shopId
}

export async function loadShopContext(): Promise<ShopContext> {
  const d = await db()
  const shops = await d.select<(Omit<Shop, 'show_welcome'> & { show_welcome: number })[]>(
    'select * from shops limit 1',
  )
  const shopRow = shops[0]
  if (!shopRow) throw new NeedsSetup()
  // SQLite has no boolean type -- see 0002_show_welcome.sql -- so this is
  // the one place that 0/1 becomes a real boolean before anything else in
  // the app has to think about it.
  const shop: Shop = { ...shopRow, show_welcome: Boolean(shopRow.show_welcome) }

  const profiles = await d.select<Profile[]>(
    'select * from profiles where shop_id = ? limit 1',
    [shop.id],
  )
  const profile = profiles[0]
  if (!profile) throw new Error('shop exists with no profile — database may be corrupted')

  const [rateCards, materials, printers] = await Promise.all([
    d.select<RateCardRow[]>(
      'select * from rate_cards where shop_id = ? order by effective_from desc limit 1',
      [shop.id],
    ),
    // Joined to material_costs so a quote is priced against what the shop
    // actually paid, not the figure it typed at setup. The view falls back
    // to that figure until a purchase is logged, so a fresh install prices
    // exactly as it did before this existed.
    d.select<PrinterRow[] & { archived: number }[]>(
      `select m.*, c.avg_cost_per_unit, c.basis
         from materials m
         join material_costs c on c.material_id = m.id
        where m.shop_id = ? and m.archived = 0
        order by m.name`,
      [shop.id],
    ),
    d.select<PrinterRow[]>('select * from printers where shop_id = ? order by name', [shop.id]),
  ])

  const rateCard = rateCards[0]
  if (!rateCard) throw new Error('shop exists with no rate card — database may be corrupted')

  return {
    profile,
    shop,
    rateCard,
    materials: (materials as unknown as Record<string, unknown>[]).map(
      (m): MaterialRef => ({
        id: m.id as string,
        name: m.name as string,
        unit: m.unit as 'g' | 'ml',
        costPerUnit: Number(m.avg_cost_per_unit ?? m.cost_per_unit),
        costBasis: (m.basis as 'purchases' | 'estimate') ?? 'estimate',
        sellOverride: m.sell_override == null ? null : Number(m.sell_override),
        swatch: m.swatch as string,
      }),
    ),
    printers: printers.map(
      (p): PrinterRef => ({
        id: p.id,
        name: p.name,
        model: p.model,
        ratePerHour: Number(p.rate_hourly),
        wearPerHour: Number(p.wear_hourly),
        watts: p.watts == null ? null : Number(p.watts),
      }),
    ),
    printerRows: printers,
  }
}

/** Rates stay versioned locally too: a new row, never an in-place edit, for
 *  exactly the same reason as the hosted version — a quote's own snapshot
 *  must never be able to drift because a later rate change moved a number
 *  underneath it. */
export async function saveRateCard(
  shopId: string,
  next: Omit<RateCardRow, 'id' | 'shop_id' | 'effective_from'>,
): Promise<RateCardRow> {
  const d = await db()
  const id = uuid()
  await d.execute(
    `insert into rate_cards
      (id, shop_id, design_hourly, finishing_hourly, rush_pct, minimum_order,
       deposit_pct, deposit_when, deposit_waive_below, material_markup,
       revisions_incl, revision_hourly)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopId,
      next.design_hourly,
      next.finishing_hourly,
      next.rush_pct,
      next.minimum_order,
      next.deposit_pct,
      next.deposit_when,
      next.deposit_waive_below,
      next.material_markup,
      next.revisions_incl,
      next.revision_hourly,
    ],
  )
  const rows = await d.select<RateCardRow[]>('select * from rate_cards where id = ?', [id])
  return rows[0]
}

export async function saveShopIdentity(shopId: string, next: ShopIdentityInput): Promise<Shop> {
  const d = await db()
  await d.execute(
    `update shops set name = ?, legal_name = ?, address = ?, state = ?, email = ?, phone = ?,
       license_no = ?, electricity_rate_kwh = ? where id = ?`,
    [
      next.name.trim() || 'My shop',
      next.legal_name.trim() || null,
      next.address.trim() || null,
      next.state.trim() || null,
      next.email.trim() || null,
      next.phone.trim() || null,
      next.license_no.trim() || null,
      next.electricity_rate_kwh,
      shopId,
    ],
  )
  const rows = await d.select<Shop[]>('select * from shops where id = ?', [shopId])
  return rows[0]
}

export async function saveShopQuoteTerms(shopId: string, next: ShopQuoteTermsInput): Promise<Shop> {
  const d = await db()
  await d.execute(
    `update shops set tax_label = ?, tax_pct = ?, quote_valid_days = ?, lead_days = ?,
       terms_text = ?, revision_policy = ?, payment_info = ? where id = ?`,
    [
      next.tax_label.trim() || 'Tax',
      next.tax_pct,
      next.quote_valid_days,
      next.lead_days,
      next.terms_text.trim() || null,
      next.revision_policy.trim() || null,
      next.payment_info.trim() || null,
      shopId,
    ],
  )
  const rows = await d.select<Shop[]>('select * from shops where id = ?', [shopId])
  return rows[0]
}

/** The desktop welcome dialog's own "don't show this again". Nothing
 *  fancier than a flag on the one shop row this install has. */
export async function dismissWelcome(shopId: string): Promise<void> {
  const d = await db()
  await d.execute('update shops set show_welcome = 0 where id = ?', [shopId])
}

export async function savePrinter(
  shopId: string,
  next: Omit<PrinterRow, 'id'> & { id?: string },
): Promise<PrinterRow> {
  const d = await db()
  const row = {
    name: next.name.trim(),
    model: next.model.trim() || '—',
    tech: next.tech,
    rate_hourly: next.rate_hourly,
    wear_hourly: next.wear_hourly,
    watts: next.watts,
  }
  const id = next.id ?? uuid()
  if (next.id) {
    await d.execute(
      `update printers set name = ?, model = ?, tech = ?, rate_hourly = ?, wear_hourly = ?, watts = ?
       where id = ?`,
      [row.name, row.model, row.tech, row.rate_hourly, row.wear_hourly, row.watts, id],
    )
  } else {
    await d.execute(
      `insert into printers (id, shop_id, name, model, tech, rate_hourly, wear_hourly, watts)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, shopId, row.name, row.model, row.tech, row.rate_hourly, row.wear_hourly, row.watts],
    )
  }
  const rows = await d.select<PrinterRow[]>('select * from printers where id = ?', [id])
  return rows[0]
}

/** GUMA-2026-0184 — sequential within the year, per shop. Same scheme as
 *  the hosted version; SQLite's text ordering handles the zero-padded
 *  suffix the same way Postgres's does. */
export async function nextJobRef(shopId: string): Promise<string> {
  const d = await db()
  const year = new Date().getFullYear()
  const prefix = `GUMA-${year}-`
  const rows = await d.select<{ ref: string }[]>(
    'select ref from jobs where shop_id = ? and ref like ? order by ref desc limit 1',
    [shopId, `${prefix}%`],
  )
  const last = rows[0]?.ref
  const n = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1
  return prefix + String(n).padStart(4, '0')
}

/** Every job saved so far, newest first — the thing that was missing
 *  entirely: once a quote was saved there was no page to see it again.
 *  A job today always has exactly one quote (no revise-and-resave flow
 *  yet), so a plain left join is enough; `quotes.job_id` isn't declared
 *  unique though, so if that changes this would need to pick the latest
 *  version explicitly rather than assume one row back. */
/**
 * Every project, newest first, with enough attached to compute its flags
 * and its current gate on the client without a second query per card.
 *
 * The money columns come from the job_money view rather than being summed
 * here: payments are append-only facts and the view is the one place that
 * knows how to fold them, so a second implementation of that arithmetic in
 * TypeScript is a second thing to get wrong.
 */
export async function listJobs(shopId: string): Promise<JobListRow[]> {
  const d = await db()
  // created_at alone is not a total order: two projects saved in the same
  // millisecond tie, and SQLite is then free to return them in any order
  // (which it does — the order changed the moment this query grew a join).
  // ref is sequential per shop per year, so it breaks the tie the same way
  // a human would.
  const rows = await d.select<JobListSqlRow[]>(
    `${JOB_LIST_SQL} order by j.created_at desc, j.ref desc`,
    [shopId],
  )
  const jobIds = rows.map((r) => r.job_id)
  const gates = await loadGateAnswers(d, jobIds)
  return rows.map((r) => ({
    ...toJobListRow(r),
    gateAnswers: gates[r.job_id]?.[r.phase] ?? {},
  }))
}

/** Shared by listJobs and loadProjectDetail so the two can never disagree
 *  about what a project's facts are. */
const JOB_LIST_SQL = `
  select j.id as job_id, j.ref, j.title, j.brief, j.created_at, j.updated_at,
         j.phase, j.priority, j.asset_origin, j.poc,
         j.needed_by, j.window_from, j.window_locked, j.at_risk,
         j.delivery_on, j.delivery_how,
         c.id as client_id, c.name as client_name, c.kind as client_kind,
         c.contact as client_contact, c.email as client_email, c.phone as client_phone,
         q.id as quote_id, q.status as quote_status, q.total,
         coalesce(m.deposit_due, 0)  as deposit_due,
         coalesce(m.deposit_owed, 0) as deposit_owed,
         coalesce(m.balance_owed, 0) as balance_owed,
         (select max(at) from job_events e where e.job_id = j.id) as last_activity_at,
         coalesce((select minimum_order from rate_cards
                   where shop_id = j.shop_id
                   order by effective_from desc limit 1), 0) as minimum_order,
         -- What has actually been spent, on the same terms actuals.ts uses:
         -- power when wattage and $/kWh are both on file, the machine rate
         -- as the conservative fallback when they are not.
         coalesce(a.material_cost, 0)
           + coalesce(case when a.power_cost > 0 then a.power_cost else a.machine_cost end, 0)
           + coalesce(a.wear_cost, 0)
           + coalesce(a.design_hours, 0) * coalesce(rc.design_hourly, 0)
           + (coalesce(a.finishing_hours, 0) + coalesce(a.admin_hours, 0))
             * coalesce(rc.finishing_hourly, 0) as actual_cost,
         coalesce(ps.parts, 0) as parts,
         coalesce(ps.printed, 0) as parts_printed,
         coalesce(ps.passed, 0) as parts_passed,
         coalesce(ps.reprint, 0) as parts_reprint,
         coalesce(ps.reprints_ever, 0) as reprints_ever,
         coalesce(a.runs, 0) as actual_runs,
         coalesce(a.design_hours, 0) + coalesce(a.finishing_hours, 0)
           + coalesce(a.admin_hours, 0) as actual_hours,
         (coalesce(a.runs, 0) > 0
          or coalesce(a.design_hours, 0) + coalesce(a.finishing_hours, 0)
             + coalesce(a.admin_hours, 0) > 0) as has_actuals
  from jobs j
  left join job_actuals a on a.job_id = j.id
  left join job_parts_summary ps on ps.job_id = j.id
  left join rate_cards rc on rc.id = (select id from rate_cards
                                       where shop_id = j.shop_id
                                       order by effective_from desc limit 1)
  join clients c on c.id = j.client_id
  left join quotes q on q.job_id = j.id
  left join job_money m on m.job_id = j.id
  where j.shop_id = ?`

interface JobListSqlRow {
  job_id: string
  ref: string
  title: string
  brief: string | null
  created_at: string
  updated_at: string
  phase: JobPhase
  priority: JobPriority
  asset_origin: 'model' | 'fix' | 'ready'
  poc: string | null
  needed_by: string | null
  window_from: string | null
  window_locked: number
  at_risk: number
  delivery_on: string | null
  delivery_how: string | null
  client_id: string
  client_name: string
  client_kind: string | null
  client_contact: string | null
  client_email: string | null
  client_phone: string | null
  quote_id: string | null
  quote_status: QuoteStatus | null
  total: number | null
  deposit_due: number
  deposit_owed: number
  balance_owed: number
  last_activity_at: string | null
  minimum_order: number
  actual_cost: number
  has_actuals: number
  actual_runs: number
  actual_hours: number
  parts: number
  parts_printed: number
  parts_passed: number
  parts_reprint: number
  reprints_ever: number
}

function factsFrom(r: JobListSqlRow): ProjectFacts {
  return {
    phase: r.phase,
    priority: r.priority,
    createdAt: r.created_at,
    neededBy: r.needed_by,
    windowFrom: r.window_from,
    // SQLite has no boolean type; 0/1 becomes a real boolean here so that
    // nothing downstream has to remember which backend it came from.
    windowLocked: Number(r.window_locked) === 1,
    atRisk: Number(r.at_risk) === 1,
    deliveryOn: r.delivery_on,
    deliveryHow: r.delivery_how,
    brief: r.brief,
    // A project's own point of contact overrides the client's, but until
    // someone sets one the client's named contact IS the person to chase —
    // asking for it twice would be busywork dressed as diligence.
    poc: r.poc ?? r.client_contact,
    quoteStatus: r.quote_status,
    quoteTotal: r.total == null ? null : Number(r.total),
    depositDue: Number(r.deposit_due ?? 0),
    depositOwed: Number(r.deposit_owed ?? 0),
    balanceOwed: Number(r.balance_owed ?? 0),
    lastActivityAt: r.last_activity_at,
    minimumOrder: Number(r.minimum_order ?? 0),
    actualCost: Number(r.actual_cost ?? 0),
    hasActuals: Number(r.has_actuals) === 1,
    actualRuns: Number(r.actual_runs ?? 0),
    actualHours: Number(r.actual_hours ?? 0),
    parts: Number(r.parts ?? 0),
    partsPrinted: Number(r.parts_printed ?? 0),
    partsPassed: Number(r.parts_passed ?? 0),
    partsReprint: Number(r.parts_reprint ?? 0),
    reprintsEver: Number(r.reprints_ever ?? 0),
  }
}

function toJobListRow(r: JobListSqlRow): Omit<JobListRow, 'gateAnswers'> {
  return {
    jobId: r.job_id,
    ref: r.ref,
    title: r.title,
    clientId: r.client_id,
    clientName: r.client_name,
    clientKind: asClientKind(r.client_kind),
    createdAt: r.created_at,
    phase: r.phase,
    priority: r.priority,
    quoteId: r.quote_id,
    quoteStatus: r.quote_status,
    total: r.total == null ? null : Number(r.total),
    facts: factsFrom(r),
  }
}

/** job_id -> phase -> item key -> answer. One query for any number of jobs. */
async function loadGateAnswers(
  d: Awaited<ReturnType<typeof db>>,
  jobIds: string[],
): Promise<Record<string, Record<string, Record<string, GateAnswer>>>> {
  const out: Record<string, Record<string, Record<string, GateAnswer>>> = {}
  if (jobIds.length === 0) return out
  const marks = jobIds.map(() => '?').join(',')
  const rows = await d.select<
    { job_id: string; phase: string; item_key: string; checked: number; note: string | null }[]
  >(
    `select job_id, phase, item_key, checked, note from job_gates where job_id in (${marks})`,
    jobIds,
  )
  for (const r of rows) {
    const byPhase = (out[r.job_id] ??= {})
    const byKey = (byPhase[r.phase] ??= {})
    byKey[r.item_key] = { checked: Number(r.checked) === 1, note: r.note }
  }
  return out
}

export async function updateJobPhase(
  shopId: string,
  jobId: string,
  actorId: string,
  toPhase: JobPhase,
): Promise<void> {
  const d = await db()
  const rows = await d.select<{ phase: JobPhase }[]>(
    'select phase from jobs where id = ? and shop_id = ?',
    [jobId, shopId],
  )
  const fromPhase = rows[0]?.phase
  if (!fromPhase || fromPhase === toPhase) return
  await d.execute(
    `update jobs set phase = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     where id = ? and shop_id = ?`,
    [toPhase, jobId, shopId],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, from_phase, to_phase)
     values (?, ?, 'phase_change', ?, ?)`,
    [jobId, actorId, fromPhase, toPhase],
  )
}

/** Priority has no history worth keeping (unlike phase, it's a triage
 *  label a shop might flip back and forth on the same afternoon), so this
 *  is a plain column update — no job_events row. */
export async function updateJobPriority(
  shopId: string,
  jobId: string,
  priority: JobPriority,
): Promise<void> {
  const d = await db()
  await d.execute('update jobs set priority = ? where id = ? and shop_id = ?', [
    priority,
    jobId,
    shopId,
  ])
}

export async function saveQuote(args: SaveQuoteArgs): Promise<SavedQuote> {
  const d = await db()

  const existing = await d.select<{ id: string }[]>(
    'select id from clients where shop_id = ? and name like ? limit 1',
    [args.shopId, args.client.name],
  )

  let clientId = existing[0]?.id
  if (!clientId) {
    clientId = uuid()
    await d.execute(
      `insert into clients (id, shop_id, name, contact, email, phone, source)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId,
        args.shopId,
        args.client.name,
        args.client.contact || null,
        args.client.email || null,
        args.client.phone || null,
        args.client.source || null,
      ],
    )
  } else {
    await d.execute(
      'update clients set contact = ?, email = ?, phone = ? where id = ?',
      [args.client.contact || null, args.client.email || null, args.client.phone || null, clientId],
    )
  }

  const jobId = uuid()
  await d.execute(
    `insert into jobs (id, shop_id, ref, client_id, title, brief, asset_origin, needed_by, phase)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'intake')`,
    [
      jobId,
      args.shopId,
      args.ref,
      clientId,
      args.job.title,
      args.job.brief || null,
      args.job.assetOrigin,
      args.job.neededBy,
    ],
  )

  const quoteId = uuid()
  await d.execute(
    `insert into quotes
      (id, shop_id, job_id, version, status, design_billing, design_qty, revisions_incl,
       quantity, material_id, printer_id, units_per_part, print_hrs_part, finishing_hrs,
       rush, flat_each, discount_pct, rates_snapshot, total, deposit_due, valid_until, sent_at)
     values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      quoteId,
      args.shopId,
      jobId,
      args.send ? 'sent' : 'draft',
      args.quote.design_billing,
      args.quote.design_qty,
      args.quote.revisions_incl,
      args.quote.quantity,
      args.quote.material_id,
      args.quote.printer_id,
      args.quote.units_per_part,
      args.quote.print_hrs_part,
      args.quote.finishing_hrs,
      args.quote.rush ? 1 : 0,
      args.quote.flat_each,
      args.quote.discount_pct,
      args.send ? JSON.stringify(args.send.rates_snapshot) : null,
      args.send?.total ?? null,
      args.send?.deposit_due ?? null,
      args.send?.valid_until ?? null,
      args.send ? new Date().toISOString() : null,
    ],
  )

  if (args.send) {
    await d.execute(
      `insert into job_events (job_id, kind, body) values (?, 'quote_sent', ?)`,
      [jobId, `Quote ${args.ref} sent · ${args.send.total.toFixed(2)}`],
    )
  }

  return { jobId, clientId, quoteId, ref: args.ref }
}

/** A sent quote, re-read for printing. Priced from its OWN snapshot — same
 *  contract as the hosted version, assembled from three plain selects
 *  instead of one PostgREST embed since SQLite has no equivalent syntax. */
export async function loadQuoteForPrint(quoteId: string) {
  const d = await db()
  const quotes = await d.select<Record<string, unknown>[]>('select * from quotes where id = ?', [
    quoteId,
  ])
  const quote = quotes[0]
  if (!quote) throw new Error('quote not found')

  const jobs = await d.select<Record<string, unknown>[]>('select * from jobs where id = ?', [
    quote.job_id,
  ])
  const job = jobs[0]

  const clients = await d.select<Record<string, unknown>[]>(
    'select * from clients where id = ?',
    [job?.client_id],
  )
  const client = clients[0]

  const shops = await d.select<Record<string, unknown>[]>('select * from shops where id = ?', [
    quote.shop_id,
  ])
  const shop = shops[0]

  // SQLite has no jsonb — rates_snapshot is stored as a TEXT column holding
  // a JSON string (see 0001_initial.sql's header note). The hosted/Supabase
  // backend's jsonb column comes back through PostgREST already parsed into
  // an object, and QuoteDoc.tsx relies on that shape (`snap.rates`,
  // `snap.material`, ...) without ever parsing it itself. Forgetting to
  // parse it back out here was exactly why the print/PDF view rendered
  // blank on desktop: `ratesFromSnapshot()` received a raw string, every
  // field on it read back `undefined`, and the resulting arithmetic threw
  // during render — with no error boundary anywhere in the app to catch it
  // and show a message instead of a blank screen.
  const rates_snapshot = quote.rates_snapshot
    ? JSON.parse(quote.rates_snapshot as string)
    : null

  return {
    ...quote,
    rates_snapshot,
    jobs: job ? { ...job, clients: client } : null,
    shops: shop,
  }
}

/* ------------------------------------------------------------------ */
/* Project detail, stage gates, clients                                */
/* ------------------------------------------------------------------ */

/**
 * One project, everything the detail screen draws: the project itself, its
 * client, its quote, its derived money, every gate answer on every phase,
 * and the full activity log.
 *
 * Four queries rather than one join: the events and the gates are both
 * one-to-many, and folding them into the main row would multiply it out
 * and then need un-multiplying in TypeScript. Against a local SQLite file
 * on the same machine, four round trips is not a cost worth designing
 * around.
 */
export async function loadProjectDetail(shopId: string, jobId: string): Promise<ProjectDetail> {
  const d = await db()
  const rows = await d.select<JobListSqlRow[]>(`${JOB_LIST_SQL} and j.id = ?`, [shopId, jobId])
  const r = rows[0]
  if (!r) throw new Error('That project no longer exists.')

  const gatesByPhase = (await loadGateAnswers(d, [jobId]))[jobId] ?? {}

  const actualsRow = await d.select<Record<string, number>[]>(
    'select * from job_actuals where job_id = ?',
    [jobId],
  )
  const actuals = toActuals(actualsRow[0])

  const quoteRow = await d.select<Record<string, unknown>[]>(
    `select design_billing, design_qty, revisions_incl, quantity, material_id, printer_id,
            units_per_part, print_hrs_part, finishing_hrs, rush, flat_each, discount_pct,
            rates_snapshot
       from quotes where job_id = ? order by version desc limit 1`,
    [jobId],
  )

  const runs = await d.select<
    {
      id: string
      printer_id: string | null
      printer_name: string | null
      material_id: string | null
      material_name: string | null
      unit: 'g' | 'ml' | null
      units_used: number | null
      hours: number | null
      outcome: PrintRunRow['outcome']
      failure_reason: string | null
      note: string | null
      started_at: string | null
      ended_at: string | null
      operator: string | null
    }[]
  >(
    `select r.id, r.printer_id, p.name as printer_name, r.material_id, m.name as material_name,
            m.unit, r.units_used, r.hours, r.outcome, r.failure_reason, r.note,
            r.started_at, r.ended_at, pr.full_name as operator
       from print_runs r
       left join printers p on p.id = r.printer_id
       left join materials m on m.id = r.material_id
       left join profiles pr on pr.id = r.operator_id
      where r.job_id = ?
      order by coalesce(r.started_at, r.id) desc`,
    [jobId],
  )

  const partRows = await d.select<
    { id: string; label: string; qty: number; status: PartStatus; note: string | null; sort: number }[]
  >(
    'select id, label, qty, status, note, sort from job_parts where job_id = ? order by sort, created_at',
    [jobId],
  )
  const partHistory = await d.select<
    {
      id: number
      part_id: string
      kind: 'status' | 'note'
      from_status: PartStatus | null
      to_status: PartStatus | null
      note: string | null
      actor: string | null
      at: string
    }[]
  >(
    `select e.id, e.part_id, e.kind, e.from_status, e.to_status, e.note, e.at,
            p.full_name as actor
       from part_events e
       left join profiles p on p.id = e.actor_id
      where e.job_id = ?
      order by e.at desc, e.id desc`,
    [jobId],
  )

  const work = await d.select<
    { id: string; kind: WorkEntryRow['kind']; hours: number; worked_on: string; note: string | null; actor: string | null }[]
  >(
    `select w.id, w.kind, w.hours, w.worked_on, w.note, p.full_name as actor
       from work_log w
       left join profiles p on p.id = w.actor_id
      where w.job_id = ?
      order by w.worked_on desc, w.created_at desc`,
    [jobId],
  )

  const payments = await d.select<
    {
      id: string
      kind: PaymentRow['kind']
      amount: number
      method: PaymentRow['method']
      received_on: string
      note: string | null
      recorded_by_name: string | null
    }[]
  >(
    `select p.id, p.kind, p.amount, p.method, p.received_on, p.note,
            pr.full_name as recorded_by_name
     from payments p
     left join profiles pr on pr.id = p.recorded_by
     where p.job_id = ?
     order by p.received_on desc, p.created_at desc`,
    [jobId],
  )

  const events = await d.select<
    {
      id: number
      kind: string
      body: string | null
      from_phase: JobPhase | null
      to_phase: JobPhase | null
      at: string
      actor_name: string | null
    }[]
  >(
    `select e.id, e.kind, e.body, e.from_phase, e.to_phase, e.at, p.full_name as actor_name
     from job_events e
     left join profiles p on p.id = e.actor_id
     where e.job_id = ?
     order by e.at desc, e.id desc`,
    [jobId],
  )

  return {
    jobId: r.job_id,
    ref: r.ref,
    title: r.title,
    brief: r.brief,
    phase: r.phase,
    priority: r.priority,
    assetOrigin: r.asset_origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    client: {
      id: r.client_id,
      name: r.client_name,
      kind: asClientKind(r.client_kind),
      contact: r.client_contact,
      email: r.client_email,
      phone: r.client_phone,
    },
    quote:
      r.quote_id && r.quote_status
        ? { id: r.quote_id, status: r.quote_status, total: r.total == null ? null : Number(r.total) }
        : null,
    facts: factsFrom(r),
    actuals,
    quoteInputs: quoteRow[0] ? toQuoteInputs(quoteRow[0]) : null,
    runs: runs.map(
      (x): PrintRunRow => ({
        id: x.id,
        printerId: x.printer_id,
        printerName: x.printer_name,
        materialId: x.material_id,
        materialName: x.material_name,
        unit: x.unit,
        unitsUsed: x.units_used == null ? null : Number(x.units_used),
        hours: x.hours == null ? null : Number(x.hours),
        outcome: x.outcome,
        failureReason: x.failure_reason,
        note: x.note,
        startedAt: x.started_at,
        endedAt: x.ended_at,
        operator: x.operator,
      }),
    ),
    work: work.map(
      (x): WorkEntryRow => ({
        id: x.id,
        kind: x.kind,
        hours: Number(x.hours),
        workedOn: x.worked_on,
        note: x.note,
        actor: x.actor,
      }),
    ),
    parts: partRows.map(
      (x): PartRow => ({
        id: x.id,
        label: x.label,
        qty: Number(x.qty),
        status: x.status,
        note: x.note,
        sort: Number(x.sort),
        history: partHistory
          .filter((e) => e.part_id === x.id)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            fromStatus: e.from_status,
            toStatus: e.to_status,
            note: e.note,
            actor: e.actor,
            at: e.at,
          })),
      }),
    ),
    gates: gatesByPhase,
    payments: payments.map(
      (p): PaymentRow => ({
        id: p.id,
        kind: p.kind,
        amount: Number(p.amount),
        method: p.method,
        receivedOn: p.received_on,
        note: p.note,
        recordedBy: p.recorded_by_name,
      }),
    ),
    events: events.map(
      (e): ProjectEvent => ({
        id: e.id,
        kind: e.kind,
        body: e.body,
        fromPhase: e.from_phase,
        toPhase: e.to_phase,
        at: e.at,
        actorName: e.actor_name,
      }),
    ),
  }
}

/**
 * Tick, untick, or annotate one gate item.
 *
 * Upsert rather than insert-or-update-in-two-steps: (job_id, phase,
 * item_key) is the primary key, so ON CONFLICT is the whole story. `at`
 * and `actor_id` are refreshed on every write — a note edited three weeks
 * later should say so.
 *
 * Nothing here validates the item key against gates.ts. That is deliberate:
 * the checklist is allowed to change, and an answer to a question that has
 * since been reworded is still a fact about what someone did.
 */
export async function setGateItem(
  _shopId: string,
  jobId: string,
  actorId: string,
  phase: JobPhase,
  itemKey: string,
  checked: boolean,
  note: string | null,
): Promise<void> {
  const d = await db()
  await d.execute(
    `insert into job_gates (job_id, phase, item_key, checked, note, actor_id, at)
     values (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     on conflict (job_id, phase, item_key) do update set
       checked = excluded.checked,
       note = excluded.note,
       actor_id = excluded.actor_id,
       at = excluded.at`,
    [jobId, phase, itemKey, checked ? 1 : 0, note, actorId],
  )
}

/** A human update on the project. Same table as phase changes, so the
 *  activity log is one ordered story rather than two interleaved ones. */
export async function addProjectNote(jobId: string, actorId: string, body: string): Promise<void> {
  const text = body.trim()
  if (!text) return
  const d = await db()
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'note', ?)`,
    [jobId, actorId, text],
  )
  await d.execute(
    `update jobs set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ?`,
    [jobId],
  )
}

/**
 * Edit the handful of fields the detail screen owns. Only the keys actually
 * present in `fields` are written, so a screen that draws one section can
 * save one section without silently clearing the rest.
 */
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
  const sets: string[] = []
  const args: unknown[] = []
  for (const [key, column] of Object.entries(map)) {
    if (!(key in fields)) continue
    const v = (fields as Record<string, unknown>)[key]
    sets.push(`${column} = ?`)
    args.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null))
  }
  if (sets.length === 0) return
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
  const d = await db()
  await d.execute(`update jobs set ${sets.join(', ')} where id = ? and shop_id = ?`, [
    ...args,
    jobId,
    shopId,
  ])
}

/**
 * Every client, with what they are actually worth to the shop.
 *
 * `value` counts sent and accepted quotes only. A draft is a number the
 * shop typed to itself; putting it in a client's lifetime value is how a
 * pipeline starts lying to the person running it.
 */
export async function listClients(shopId: string): Promise<ClientRow[]> {
  const d = await db()
  const rows = await d.select<
    {
      id: string
      name: string
      kind: string | null
      contact: string | null
      email: string | null
      phone: string | null
      projects: number
      active: number
      value: number | null
      owed: number | null
      last_activity: string | null
    }[]
  >(
    `select c.id, c.name, c.kind, c.contact, c.email, c.phone,
            count(distinct j.id) as projects,
            count(distinct case when j.phase <> 'delivered' then j.id end) as active,
            coalesce(sum(case when q.status in ('sent','accepted') then q.total end), 0) as value,
            coalesce(sum(m.balance_owed), 0) as owed,
            (select max(e.at) from job_events e
             join jobs j2 on j2.id = e.job_id
             where j2.client_id = c.id) as last_activity
     from clients c
     left join jobs j on j.client_id = c.id
     left join quotes q on q.job_id = j.id
     left join job_money m on m.job_id = j.id
     where c.shop_id = ?
     group by c.id, c.name, c.kind, c.contact, c.email, c.phone
     order by c.name collate nocase`,
    [shopId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: asClientKind(r.kind),
    contact: r.contact,
    email: r.email,
    phone: r.phone,
    projects: Number(r.projects ?? 0),
    active: Number(r.active ?? 0),
    value: Number(r.value ?? 0),
    owed: Number(r.owed ?? 0),
    lastActivity: r.last_activity,
  }))
}

/** Edit a client from the Clients screen. Same present-keys-only rule as
 *  updateProjectFields. */
export async function updateClientRecord(
  shopId: string,
  clientId: string,
  input: ClientEditInput,
): Promise<void> {
  const allowed = ['name', 'kind', 'contact', 'email', 'phone'] as const
  const sets: string[] = []
  const args: unknown[] = []
  for (const key of allowed) {
    if (!(key in input)) continue
    sets.push(`${key} = ?`)
    args.push((input as Record<string, unknown>)[key] ?? null)
  }
  if (sets.length === 0) return
  const d = await db()
  await d.execute(`update clients set ${sets.join(', ')} where id = ? and shop_id = ?`, [
    ...args,
    clientId,
    shopId,
  ])
}

/**
 * Record a payment against a project.
 *
 * Append-only, on purpose. There is no "mark this quote paid" column
 * anywhere in the schema — every owed figure in the app is the job_money
 * view folding these rows at read time, so a payment recorded here moves
 * the deposit-owed number, the balance-owed number, the project's flags
 * and the client's ledger in the same instant, with nothing to keep in
 * sync. A mistake is corrected by recording a refund, not by rewriting
 * history.
 *
 * A matching note goes on the activity log so the money and the story of
 * the project stay in one place.
 */
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
  const id = crypto.randomUUID()
  const d = await db()
  await d.execute(
    `insert into payments (id, shop_id, job_id, quote_id, kind, amount, method, received_on, note, recorded_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopId,
      jobId,
      input.quoteId,
      input.kind,
      amount,
      input.method,
      input.receivedOn,
      input.note,
      actorId,
    ],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'payment', ?)`,
    [jobId, actorId, `${input.kind} of ${amount.toFixed(2)} by ${input.method}${input.note ? ` — ${input.note}` : ''}`],
  )
  return id
}

/* ------------------------------------------------------------------ */
/* Materials and what they actually cost                               */
/* ------------------------------------------------------------------ */

const MATERIAL_SELECT = `
  select m.id, m.name, m.kind, m.swatch, m.unit, m.cost_per_unit, m.sell_override,
         m.on_hand, m.reorder_at, m.archived,
         c.avg_cost_per_unit, c.basis, c.purchases, c.purchased_qty,
         c.purchased_spend, c.last_cost_per_unit, c.last_purchased_on
  from materials m
  join material_costs c on c.material_id = m.id
  where m.shop_id = ?`

interface MaterialSqlRow {
  id: string
  name: string
  kind: string
  swatch: string
  unit: 'g' | 'ml'
  cost_per_unit: number
  sell_override: number | null
  on_hand: number
  reorder_at: number
  archived: number
  avg_cost_per_unit: number
  basis: 'purchases' | 'estimate'
  purchases: number
  purchased_qty: number
  purchased_spend: number
  last_cost_per_unit: number | null
  last_purchased_on: string | null
}

function toMaterialRow(m: MaterialSqlRow): MaterialRow {
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
    archived: Number(m.archived) === 1,
    avgCostPerUnit: Number(m.avg_cost_per_unit),
    costBasis: m.basis,
    purchases: Number(m.purchases ?? 0),
    purchasedQty: Number(m.purchased_qty ?? 0),
    purchasedSpend: Number(m.purchased_spend ?? 0),
    lastCostPerUnit: m.last_cost_per_unit == null ? null : Number(m.last_cost_per_unit),
    lastPurchasedOn: m.last_purchased_on,
  }
}

/** Every material, archived ones included — the Materials screen is where
 *  you go to un-archive one, so hiding them there would be a trap. */
export async function listMaterials(shopId: string): Promise<MaterialRow[]> {
  const d = await db()
  const rows = await d.select<MaterialSqlRow[]>(
    `${MATERIAL_SELECT} order by m.archived, m.name collate nocase`,
    [shopId],
  )
  return rows.map(toMaterialRow)
}

/**
 * Create or update one material.
 *
 * on_hand is writable by hand on purpose. Guma does not watch machines, so
 * it can never draw stock down the way a tool wired into the printers
 * could — purchases push the figure up and nothing pushes it back down.
 * A running total that only ever rises is a lie, so the shop has to be able
 * to correct it after weighing a spool. The screen says as much.
 */
export async function saveMaterial(shopId: string, next: MaterialInput): Promise<MaterialRow> {
  const d = await db()
  const id = next.id ?? crypto.randomUUID()
  const name = next.name.trim()
  if (!name) throw new Error('A material needs a name.')
  if (next.id) {
    await d.execute(
      `update materials set name = ?, kind = ?, swatch = ?, unit = ?, cost_per_unit = ?,
              sell_override = ?, on_hand = ?, reorder_at = ?, archived = ?
       where id = ? and shop_id = ?`,
      [
        name,
        next.kind,
        next.swatch,
        next.unit,
        next.costPerUnit,
        next.sellOverride,
        next.onHand,
        next.reorderAt,
        next.archived ? 1 : 0,
        id,
        shopId,
      ],
    )
  } else {
    await d.execute(
      `insert into materials (id, shop_id, name, kind, swatch, unit, cost_per_unit,
                              sell_override, on_hand, reorder_at, archived)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        shopId,
        name,
        next.kind,
        next.swatch,
        next.unit,
        next.costPerUnit,
        next.sellOverride,
        next.onHand,
        next.reorderAt,
        next.archived ? 1 : 0,
      ],
    )
  }
  const rows = await d.select<MaterialSqlRow[]>(`${MATERIAL_SELECT} and m.id = ?`, [shopId, id])
  return toMaterialRow(rows[0])
}

/**
 * Log what a spool actually cost.
 *
 * Quantity is in the material's own unit — grams for filament, mL for
 * resin — because that is the unit cost_per_unit is in and the unit the
 * slicer reports. The form does the kilogram arithmetic; the database
 * stores one unit, not two.
 */
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
  const id = crypto.randomUUID()
  const d = await db()
  await d.execute(
    `insert into material_purchases
       (id, shop_id, material_id, purchased_on, qty, total_cost, supplier, note, recorded_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, shopId, materialId, input.purchasedOn, qty, cost, input.supplier, input.note, actorId],
  )
  return id
}

export async function listMaterialPurchases(
  shopId: string,
  materialId: string,
): Promise<MaterialPurchaseRow[]> {
  const d = await db()
  const rows = await d.select<
    {
      id: string
      material_id: string
      purchased_on: string
      qty: number
      total_cost: number
      supplier: string | null
      note: string | null
      recorded_by_name: string | null
    }[]
  >(
    `select p.id, p.material_id, p.purchased_on, p.qty, p.total_cost, p.supplier, p.note,
            pr.full_name as recorded_by_name
     from material_purchases p
     left join profiles pr on pr.id = p.recorded_by
     where p.shop_id = ? and p.material_id = ?
     order by p.purchased_on desc, p.created_at desc`,
    [shopId, materialId],
  )
  return rows.map((r) => ({
    id: r.id,
    materialId: r.material_id,
    purchasedOn: r.purchased_on,
    qty: Number(r.qty),
    totalCost: Number(r.total_cost),
    costPerUnit: Number(r.qty) > 0 ? Number(r.total_cost) / Number(r.qty) : 0,
    supplier: r.supplier,
    note: r.note,
    recordedBy: r.recorded_by_name,
  }))
}

/**
 * Delete a purchase. The stock trigger reverses its quantity.
 *
 * Deliberately unlike payments, which are append-only and corrected with a
 * refund. A payment is a client-facing financial record where the audit
 * trail is the point. A purchase log is the shop's own cost book, and a
 * mistyped spool price silently skews the weighted average behind every
 * future quote — leaving that in place to preserve a trail nobody will ever
 * read is the worse trade.
 */
export async function deleteMaterialPurchase(shopId: string, purchaseId: string): Promise<void> {
  const d = await db()
  await d.execute('delete from material_purchases where id = ? and shop_id = ?', [
    purchaseId,
    shopId,
  ])
}

/* ------------------------------------------------------------------ */
/* Build runs and work hours                                           */
/* ------------------------------------------------------------------ */

function toActuals(a: Record<string, number> | undefined): ProjectActuals {
  const n = (k: string) => Number(a?.[k] ?? 0)
  return {
    materialUnits: n('material_units'),
    failedUnits: n('failed_units'),
    materialCost: n('material_cost'),
    machineHours: n('machine_hours'),
    machineCost: n('machine_cost'),
    wearCost: n('wear_cost'),
    powerCost: n('power_cost'),
    runs: n('runs'),
    failedRuns: n('failed_runs'),
    designHours: n('design_hours'),
    finishingHours: n('finishing_hours'),
    adminHours: n('admin_hours'),
  }
}

function toQuoteInputs(q: Record<string, unknown>): QuoteInputsRow {
  return {
    designBilling: q.design_billing as 'hourly' | 'flat' | 'none',
    designQty: Number(q.design_qty ?? 0),
    revisionsIncl: Number(q.revisions_incl ?? 0),
    quantity: Number(q.quantity ?? 1),
    materialId: (q.material_id as string | null) ?? null,
    printerId: (q.printer_id as string | null) ?? null,
    unitsPerPart: Number(q.units_per_part ?? 0),
    printHrsPart: Number(q.print_hrs_part ?? 0),
    finishingHrs: Number(q.finishing_hrs ?? 0),
    rush: Number(q.rush) === 1,
    flatEach: Number(q.flat_each ?? 0),
    discountPct: Number(q.discount_pct ?? 0),
    // Stored as a JSON string here, unlike Postgres's jsonb. Parsing it at
    // the boundary is the same fix as loadQuoteForPrint's -- a raw string
    // reaching a consumer that expects an object is how the blank PDF
    // view happened.
    ratesSnapshot:
      typeof q.rates_snapshot === 'string' && q.rates_snapshot
        ? (JSON.parse(q.rates_snapshot) as unknown)
        : null,
  }
}

/**
 * Record a build run.
 *
 * The insert trigger takes its material off the shelf, whatever the
 * outcome. A failed plate consumed the same grams as a successful one, and
 * a shop that does not count its failures believes its margin is better
 * than it is -- which is the whole reason this is worth typing in.
 *
 * A matching activity-log entry goes on the project, so the story of the
 * build and its cost stay in one place rather than two.
 */
export async function recordPrintRun(
  shopId: string,
  jobId: string,
  actorId: string,
  input: PrintRunInput,
): Promise<string> {
  const { hours, unitsUsed } = validateRun(input)
  const id = crypto.randomUUID()
  const d = await db()
  await d.execute(
    `insert into print_runs (id, shop_id, job_id, printer_id, material_id, units_used, hours,
                             outcome, failure_reason, note, started_at, operator_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopId,
      jobId,
      input.printerId,
      input.materialId,
      unitsUsed,
      hours,
      input.outcome,
      input.failureReason,
      input.note,
      input.startedAt,
      actorId,
    ],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'run', ?)`,
    [jobId, actorId, runEventBody(input)],
  )
  return id
}

/** Delete a run. The trigger puts its material back on the shelf. Same
 *  reasoning as deleting a material purchase: this is the shop's own cost
 *  book, and a mistyped run skews every figure downstream of it. */
export async function deletePrintRun(shopId: string, runId: string): Promise<void> {
  const d = await db()
  await d.execute('delete from print_runs where id = ? and shop_id = ?', [runId, shopId])
}

/**
 * Log hours against a project.
 *
 * Not a timer and not a timesheet. A shop owner will write "3 hours,
 * modelling the bracket" at the end of a day and will never run a
 * stopwatch, so this asks for exactly that. Anything more elaborate does
 * not get filled in, and a log nobody fills in is worse than no log at all
 * because it looks like evidence.
 */
export async function logWork(
  shopId: string,
  jobId: string,
  actorId: string,
  input: WorkEntryInput,
): Promise<string> {
  const hours = validateHours(input.hours)
  const id = crypto.randomUUID()
  const d = await db()
  await d.execute(
    `insert into work_log (id, shop_id, job_id, kind, hours, worked_on, note, actor_id)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, shopId, jobId, input.kind, hours, input.workedOn, input.note, actorId],
  )
  return id
}

export async function deleteWorkEntry(shopId: string, entryId: string): Promise<void> {
  const d = await db()
  await d.execute('delete from work_log where id = ? and shop_id = ?', [entryId, shopId])
}

/* ------------------------------------------------------------------ */
/* The build sheet                                                     */
/* ------------------------------------------------------------------ */

/**
 * Add a part to the sheet.
 *
 * Parts can only be added, renamed or removed while the project is still
 * being built. From Review onwards the sheet is locked to QC — Voltage's
 * rule, and a good one: once you are checking work against a list, a list
 * that can still change is not a check. That rule is enforced in the
 * screen rather than here, because the data layer has no business deciding
 * that a shop cannot correct a typo it just noticed.
 */
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
  const id = crypto.randomUUID()
  const d = await db()
  const next = await d.select<{ n: number }[]>(
    'select coalesce(max(sort), -1) + 1 as n from job_parts where job_id = ?',
    [jobId],
  )
  await d.execute(
    `insert into job_parts (id, shop_id, job_id, label, qty, note, sort)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, shopId, jobId, label, qty, input.note ?? null, input.sort ?? next[0]?.n ?? 0],
  )
  await d.execute(
    `insert into part_events (part_id, job_id, kind, to_status, note, actor_id)
     values (?, ?, 'status', 'pending', ?, ?)`,
    [id, jobId, 'Added to the build sheet', actorId],
  )
  return id
}

/**
 * Move a part between states, and say why.
 *
 * A note is required to send something back, and only then. Everywhere
 * else it is optional, because "passed" explains itself and "reprint" never
 * does — a part that failed twice for the same reason is a design problem
 * rather than bad luck, and the only way anyone notices is if the reasons
 * were written down at the time.
 */
export async function setPartStatus(
  shopId: string,
  partId: string,
  actorId: string,
  status: PartStatus,
  note: string | null,
): Promise<void> {
  const d = await db()
  const rows = await d.select<{ job_id: string; status: PartStatus }[]>(
    'select job_id, status from job_parts where id = ? and shop_id = ?',
    [partId, shopId],
  )
  const part = rows[0]
  if (!part) throw new Error('That part no longer exists.')
  if (status === 'reprint' && !(note ?? '').trim()) {
    throw new Error('Say what went wrong before sending a part back.')
  }
  if (part.status === status) return

  await d.execute(
    `update job_parts set status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     where id = ? and shop_id = ?`,
    [status, partId, shopId],
  )
  await d.execute(
    `insert into part_events (part_id, job_id, kind, from_status, to_status, note, actor_id)
     values (?, ?, 'status', ?, ?, ?, ?)`,
    [partId, part.job_id, part.status, status, note?.trim() || null, actorId],
  )
}

/** Rename a part or change how many copies of it there are. */
export async function updatePart(
  shopId: string,
  partId: string,
  input: PartInput,
): Promise<void> {
  const label = input.label.trim()
  if (!label) throw new Error('A part needs a name.')
  const qty = Math.floor(Number(input.qty))
  if (!Number.isFinite(qty) || qty < 1) throw new Error('A part needs at least one copy.')
  const d = await db()
  await d.execute(
    `update job_parts set label = ?, qty = ?, note = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     where id = ? and shop_id = ?`,
    [label, qty, input.note ?? null, partId, shopId],
  )
}

/** Remove a part. Its history goes with it — there is nothing left to be
 *  the history of. */
export async function deletePart(shopId: string, partId: string): Promise<void> {
  const d = await db()
  await d.execute('delete from job_parts where id = ? and shop_id = ?', [partId, shopId])
}

/**
 * Move a quote between draft, sent, accepted, declined and expired.
 *
 * This existed nowhere until a real run through the app hit the wall it
 * created: the client-approval gate reads quote status, a quote could only
 * ever be created as a draft or as sent from intake, and nothing anywhere
 * could mark one accepted. So a project that reached Client approval could
 * never leave it. The rule this cost us is worth writing down: every fact a
 * gate reads must have somewhere a person can change it, or the gate is not
 * a gate, it is a wall.
 *
 * sent_at and decided_at are stamped here rather than left to the caller,
 * because "when did we send this" is exactly the sort of thing nobody
 * remembers and the expiry check needs.
 */
export async function setQuoteStatus(
  shopId: string,
  quoteId: string,
  actorId: string,
  status: QuoteStatus,
): Promise<void> {
  const d = await db()
  const rows = await d.select<{ job_id: string; status: QuoteStatus }[]>(
    'select job_id, status from quotes where id = ? and shop_id = ?',
    [quoteId, shopId],
  )
  const quote = rows[0]
  if (!quote) throw new Error('That quote no longer exists.')
  if (quote.status === status) return

  const stamps: string[] = []
  if (status === 'sent') stamps.push("sent_at = coalesce(sent_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
  if (status === 'accepted' || status === 'declined') {
    stamps.push("decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  }
  await d.execute(
    `update quotes set status = ?${stamps.length ? ', ' + stamps.join(', ') : ''}
     where id = ? and shop_id = ?`,
    [status, quoteId, shopId],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'quote', ?)`,
    [quote.job_id, actorId, `Quote marked ${status}.`],
  )
}
