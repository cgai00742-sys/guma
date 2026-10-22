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
import { describePartEdit, describeProjectEdits, type ProjectBefore } from './edits'
import Database from '@tauri-apps/plugin-sql'
import { round2, type MaterialRef, type PrinterRef } from './pricing'
import { feeFor } from './selling'
import { changeCopies, copyList, countsOf, describeCopiesChange, movable, moveStates, plateCopies, queuedCopies, renumberCopies, setStates, statesOf, statusOf } from './copies'
import { decodeProgress, encodeProgress, type ProgressPoint } from './gcodeWalk'
import {
  NeedsSetup,
  asClientKind,
  validateRun,
  describeRunCorrection,
  validateHours,
  runEventBody,
  validateRevision,
  CHANGE_CAUSE_LABEL,
  sameSliceFile,
  uniqueLabel,
  validateMadeItems,
  shelfNote,
  type MadeItemRow,
  type MadeItemInput,
  type AssemblyRow,
  type AssemblyInput,
  type ItemPlace,
  type MadeStatus,
  type SectionAssign,
  type SectionMoveResult,
  describeHolds,
  quoteBases,
  type StockHoldRow,
  type StockHoldInput,
} from './data.types'
import type { SeriesRow, SeriesInput } from './data.types'
import { osCurrency, osLocale } from './locale'
import { LATEST_RATE_CARD } from './rateCards'
import { activeDbUrl, isDemo } from './workspace'
import type {
  Shop,
  RateCardRow,
  PrinterRow,
  PrinterInput,
  Profile,
  ShopContext,
  SetupPayload,
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
  JobKind,
  SellBranch,
  StockCountInput,
  StockEntry,
  RunOutcome,
  PartInput,
  PartCopiesChange,
  PartCopiesResult,
  RunCorrection,
  QuoteBuildInput,
  QuoteBuildRow,
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
  PartInput,
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

let dbPromise: Promise<Database> | null = null
function db(): Promise<Database> {
  // Which file, from workspace.ts -- the real shop or the demo beside it.
  // Read once and cached, same as the connection: switching workspaces
  // reloads the window rather than swapping the file underneath a running
  // app, which would leave writes going somewhere nobody expects.
  if (!dbPromise) dbPromise = Database.load(activeDbUrl())
  return dbPromise
}

/**
 * Empty the DEMO workspace, so the next launch is a first run: no shop, so
 * loadShopContext throws NeedsSetup, so the setup wizard opens, so the
 * welcome shows. Exactly what someone downloading Guma sees.
 *
 * Refuses point blank unless the demo is active. This deletes a shop's
 * entire history and there is no undo, so the guard is a condition of the
 * function rather than a note in a comment for somebody to read later.
 *
 * Tables are read from the schema rather than listed here. A hardcoded list
 * is a list somebody forgets to add to -- it has already happened twice in
 * this repo with migrations -- and a wipe that misses a table leaves rows
 * pointing at a shop that no longer exists.
 */
export async function resetWorkspace(): Promise<void> {
  if (!isDemo())
    throw new Error(
      'Refusing to empty your shop. Switch to the demo workspace first — this cannot be undone.',
    )
  const d = await db()
  const tables = await d.select<{ name: string }[]>(
    `select name from sqlite_master
      where type = 'table' and name not like 'sqlite_%' and name not like '_sqlx%'`,
  )
  // Foreign keys off for the duration: with them on the deletes have to run
  // in dependency order, and that order is another list to forget.
  await d.execute('pragma foreign_keys = off')
  try {
    for (const t of tables) await d.execute(`delete from "${t.name}"`)
  } finally {
    await d.execute('pragma foreign_keys = on')
  }
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
/** A number from a payload that may not have been filled in yet. */
function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export async function setupShop(p: SetupPayload): Promise<string> {
  const d = await db()
  const shop = p.shop as Record<string, unknown>
  const rates = p.rates as Record<string, unknown>

  const shopId = uuid()
  await d.execute(
    `insert into shops
      (id, name, slug, currency, locale, tax_label, tax_pct, legal_name, address,
       state, email, phone, license_no, quote_valid_days, lead_days, electricity_rate_kwh,
       paper, overhead_monthly, productive_hours_month, failure_pct)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      (shop.name as string) || 'My shop',
      slugify((shop.name as string) || 'shop'),
      (shop.currency as string) || osCurrency(),
      (shop.locale as string) || osLocale(),
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
      // Null means "follow the locale" -- see 0009_paper.sql. The wizard
      // sends the size its region implies so the choice is visible in
      // Settings, but a blank is a legitimate, self-correcting value.
      (shop.paper as string) || null,
      (shop.overhead_monthly as number | null) ?? null,
      (shop.productive_hours_month as number | null) ?? null,
      (shop.failure_pct as number | null) ?? null,
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
      // Every one of these has to survive a shop being created before its
      // rates have been asked about. The wizard now creates the shop on the
      // FIRST answer -- the name -- so that closing the window does not
      // lose everything, which means the rate card is written before a
      // single rate exists. design_hourly and finishing_hourly are the only
      // two columns in this table with no SQL default, so an unanswered
      // rate arrived here as undefined and the insert failed outright.
      //
      // Zero is the right value rather than a guess: it is what setupPlan
      // and the field guidance already read as "not answered yet", and it
      // makes a shop with no rates visibly unfinished instead of quietly
      // pre-priced at somebody else's numbers.
      num(rates.design_hourly, 0),
      num(rates.finishing_hourly, 0),
      num(rates.rush_pct, 0),
      num(rates.minimum_order, 0),
      num(rates.deposit_pct, 0),
      (rates.deposit_when as string) || 'design',
      num(rates.deposit_waive_below, 0),
      // 1x is material sold at cost, which is the honest "unset" here --
      // the default of 2 would be Guma deciding a markup on the shop's
      // behalf and never mentioning it.
      num(rates.material_markup, 1),
      num(rates.revisions_incl, 0),
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
      `select * from rate_cards where shop_id = ? ${LATEST_RATE_CARD} limit 1`,
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
    // Every machine, retired ones included -- the settings list has to be
    // able to show you what you retired in order to let you un-retire it.
    // The pickers get the live ones only, filtered just below.
    d.select<PrinterRow[]>('select * from printers where shop_id = ? order by archived, name', [
      shop.id,
    ]),
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
    // A retired machine must not be offerable on a new quote. It stays in
    // printerRows (below) so Settings can list and restore it, but it is
    // gone from everything that prices work.
    printers: printers
      .filter((p) => !Number(p.archived))
      .map(
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
       license_no = ?, electricity_rate_kwh = ?, currency = ?, locale = ?, paper = ?
     where id = ?`,
    [
      next.name.trim() || 'My shop',
      next.legal_name.trim() || null,
      next.address.trim() || null,
      next.state.trim() || null,
      next.email.trim() || null,
      next.phone.trim() || null,
      next.license_no.trim() || null,
      next.electricity_rate_kwh,
      next.currency.trim() || osCurrency(),
      next.locale.trim() || osLocale(),
      // '' is stored as null: "follow my locale", which stays true if the
      // shop later changes its locale.
      next.paper.trim() || null,
      shopId,
    ],
  )
  const rows = await d.select<Shop[]>('select * from shops where id = ?', [shopId])
  return rows[0]
}

/** How the shop mostly gets paid. See 0023_sell_branch.sql. */
export async function saveSellBranch(shopId: string, branch: SellBranch | null): Promise<void> {
  const d = await db()
  await d.execute('update shops set sell_branch = ? where id = ?', [branch, shopId])
}

/**
 * The four numbers behind "what did this actually cost me".
 *
 * Null is a real value here and is written as null rather than coerced to
 * zero: pricing.ts distinguishes "this shop has no overhead" (impossible)
 * from "nobody has told me the overhead" (common), and only the second one
 * should make the cost panel say a line is missing.
 */
export async function saveShopCosts(shopId: string, next: ShopCostsInput): Promise<Shop> {
  const d = await db()
  await d.execute(
    `update shops set electricity_rate_kwh = ?, overhead_monthly = ?,
       productive_hours_month = ?, failure_pct = ? where id = ?`,
    [
      next.electricity_rate_kwh,
      next.overhead_monthly,
      next.productive_hours_month,
      next.failure_pct,
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

/**
 * Guide chapters this shop has already been shown.
 *
 * A failure here must never stop a screen loading -- guidance is the first
 * thing to give up when something is wrong, not the last. Callers treat a
 * rejection as "show nothing", which is the same shape as having seen
 * everything.
 */
export async function listGuideSeen(shopId: string): Promise<string[]> {
  const d = await db()
  const rows = await d.select<{ chapter: string }[]>(
    'select chapter from guide_seen where shop_id = ?',
    [shopId],
  )
  return rows.map((r) => r.chapter)
}

/** Idempotent by primary key, so a double-click cannot double-insert and
 *  nothing has to check first. */
export async function markGuideSeen(shopId: string, chapter: string): Promise<void> {
  const d = await db()
  await d.execute(
    'insert into guide_seen (shop_id, chapter) values (?, ?) on conflict do nothing',
    [shopId, chapter],
  )
}

export async function savePrinter(
  shopId: string,
  next: PrinterInput,
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

/**
 * Retire a machine, or bring it back.
 *
 * The honest middle ground between keeping a sold printer in every dropdown
 * forever and deleting the history of everything it ever built. A retired
 * machine is gone from the quote form and from pricing; its runs, and the
 * costs those runs put on old projects, are untouched.
 */
export async function setPrinterRetired(
  shopId: string,
  printerId: string,
  retired: boolean,
): Promise<void> {
  const d = await db()
  const res = await d.execute('update printers set archived = ? where id = ? and shop_id = ?', [
    retired ? 1 : 0,
    printerId,
    shopId,
  ])
  if (res.rowsAffected === 0) throw new Error('That machine no longer exists.')
}

/**
 * Delete a machine outright -- only ever for one nothing points at.
 *
 * Same rule as deleteClient, for the same reason. A printer with build runs
 * behind it is load-bearing: its hours are what made those projects cost
 * what they cost, and removing it would rewrite finished money. A printer
 * named on a quote is the machine that quote was priced for. In both cases
 * Guma refuses and says what is in the way, rather than cascading.
 *
 * A machine added five minutes ago with a typo in its name has neither, and
 * deletes cleanly, which is the case this mostly exists for.
 */
export async function deletePrinter(shopId: string, printerId: string): Promise<void> {
  const d = await db()
  const [meta] = await d.select<{ name: string }[]>(
    'select name from printers where id = ? and shop_id = ?',
    [printerId, shopId],
  )
  if (!meta) throw new Error('That machine no longer exists.')
  const [counts] = await d.select<{ runs: number; quotes: number }[]>(
    `select
       (select count(*) from print_runs where printer_id = ?) as runs,
       (select count(*) from quotes     where printer_id = ?) as quotes`,
    [printerId, printerId],
  )
  const runs = Number(counts?.runs ?? 0)
  const quotes = Number(counts?.quotes ?? 0)
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
  const res = await d.execute('delete from printers where id = ? and shop_id = ?', [
    printerId,
    shopId,
  ])
  if (res.rowsAffected === 0) throw new Error('That machine no longer exists.')
}

/** GUMA-2026-0184 — sequential within the year, per shop. Same scheme as
 *  the hosted version; SQLite's text ordering handles the zero-padded
 *  suffix the same way Postgres's does. */
/**
 * The one hidden client row an in-house job hangs off.
 *
 * See 0012_in_house.sql for why this exists rather than a nullable
 * client_id. It is created on demand rather than at setup, so a shop that
 * never logs in-house work never grows a row it did not ask for, and every
 * client-facing query filters `system = 0` so it is invisible either way.
 *
 * The unique index on (shop_id) where system = 1 means two racing calls
 * cannot produce two system clients; the second insert is ignored and both
 * callers read back the same id.
 */
async function systemClientId(shopId: string): Promise<string> {
  const d = await db()
  const found = await d.select<{ id: string }[]>(
    'select id from clients where shop_id = ? and system = 1 limit 1',
    [shopId],
  )
  if (found[0]) return found[0].id

  const id = crypto.randomUUID()
  await d.execute(
    `insert into clients (id, shop_id, name, system) values (?, ?, ?, 1)
     on conflict do nothing`,
    [id, shopId, 'In-house'],
  )
  const after = await d.select<{ id: string }[]>(
    'select id from clients where shop_id = ? and system = 1 limit 1',
    [shopId],
  )
  return after[0]!.id
}

/**
 * Start a job with no client: R&D, a test print, calibration, a sample, or
 * designing something the shop means to sell itself.
 *
 * Lands in 'design' rather than 'intake'. Intake is the stage where a
 * client's brief is turned into a quote, and there is no client and never
 * will be a quote -- parking in-house work there would leave every one of
 * them sitting in a queue waiting for a step that does not apply.
 */
export async function createInHouseJob(
  shopId: string,
  input: { title: string; brief?: string | null; relatedTo?: string | null; seriesId?: string | null; neededBy?: string | null },
): Promise<string> {
  const title = input.title.trim()
  if (!title) throw new Error('An in-house job needs a title — what are you working on?')

  const d = await db()
  const jobId = crypto.randomUUID()
  const clientId = await systemClientId(shopId)
  const ref = await nextJobRef(shopId)

  // taken_in_at is set at birth. A draft is "a price nobody has agreed to
  // yet" (0008_drafts.sql) and the shop's own work has no price and nobody
  // to agree -- so it is live the moment it exists. Leaving this null made
  // every in-house project a draft: off the board, off the dashboard, and
  // offering "Take it into Intake" on a ladder with no Intake. Reported by
  // CG as "the drafts feature isn't working"; fixed for old rows by 0022.
  await d.execute(
    `insert into jobs (id, shop_id, ref, client_id, title, brief, kind, phase, asset_origin,
                       taken_in_at, series_id, needed_by)
     values (?, ?, ?, ?, ?, ?, 'inhouse', 'design', 'model',
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`,
    [jobId, shopId, ref, clientId, title, input.brief?.trim() || null, input.seriesId ?? null, input.neededBy || null],
  )
  if (input.relatedTo) await setRelatedProject(shopId, jobId, input.relatedTo)
  return jobId
}

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

/** The id of the quote version that counts for a job: newest accepted,
 *  else newest sent (job_money's pick), else the newest of any status. */
const COUNTED_QUOTE_SQL = (jobCol: string) =>
  `select cq2.id from quotes cq2 where cq2.job_id = ${jobCol}
    order by (cq2.status = 'accepted') desc, (cq2.status = 'sent') desc, cq2.version desc
    limit 1`

/** Shared by listJobs and loadProjectDetail so the two can never disagree
 *  about what a project's facts are. */
const JOB_LIST_SQL = `
  select j.id as job_id, j.ref, j.title, j.brief, j.created_at, j.updated_at,
         j.archived_at, j.related_to, j.series_id,
         j.taken_in_at,
         j.phase, j.kind, j.priority, j.asset_origin, j.poc,
         j.needed_by, j.window_from, j.window_locked, j.at_risk, j.over_ceiling, j.printer_id,
         j.delivery_on, j.delivery_how,
         c.id as client_id, c.name as client_name, c.kind as client_kind,
         c.contact as client_contact, c.email as client_email, c.phone as client_phone,
         q.id as quote_id, q.status as quote_status, q.total,
         cq.status as counted_status, cq.total as counted_total,
         cq.rates_snapshot as counted_snapshot, cq.discount_pct as counted_discount,
         coalesce(m.deposit_due, 0)  as deposit_due,
         coalesce(m.deposit_owed, 0) as deposit_owed,
         coalesce(m.balance_owed, 0) as balance_owed,
         (select max(at) from job_events e where e.job_id = j.id) as last_activity_at,
         (select skipped from job_gates g where g.job_id = j.id and g.phase = 'approval'
            and g.item_key = 'accepted') as skipped_accepted,
         (select skipped from job_gates g where g.job_id = j.id and g.phase = 'approval'
            and g.item_key = 'deposit') as skipped_deposit,
         coalesce((select minimum_order from rate_cards
                   where shop_id = j.shop_id
                   ${LATEST_RATE_CARD} limit 1), 0) as minimum_order,
         -- What has actually been spent, on the same terms actuals.ts uses:
         -- power when wattage and $/kWh are both on file, the machine rate
         -- as the conservative fallback when they are not. Decided per run
         -- (0033_actuals_per_run_power.sql): on a mixed fleet power_cost
         -- already carries the machine rate for the unmetered runs.
         coalesce(a.material_cost, 0)
           + coalesce(case when a.power_cost > 0 then a.power_cost else a.machine_cost end, 0)
           + coalesce(a.wear_cost, 0)
           + coalesce(a.design_hours, 0) * coalesce(rc.design_hourly, 0)
           + (coalesce(a.finishing_hours, 0) + coalesce(a.admin_hours, 0))
             * coalesce(rc.finishing_hourly, 0) as actual_cost,
         coalesce(ps.parts, 0) as parts,
         coalesce(ps.copies, 0) as copies,
         coalesce(ps.copies_done, 0) as copies_done,
         coalesce(ps.printed, 0) as parts_printed,
         coalesce(ps.passed, 0) as parts_passed,
         coalesce(ps.reprint, 0) as parts_reprint,
         coalesce(ps.reprints_ever, 0) as reprints_ever,
         -- What this project put on the shelf. A correlated count rather
         -- than a stored flag: a batch deleted later has to take its units
         -- with it, and a second copy of the fact would not.
         coalesce((select sum(units_made) from batches b where b.job_id = j.id), 0) as units_made,
         coalesce(a.runs, 0) as actual_runs,
         coalesce(a.machine_hours, 0) as machine_hours,
         coalesce(a.material_units, 0) as material_units,
         coalesce(a.failed_units, 0) as failed_units,
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
                                       ${LATEST_RATE_CARD} limit 1)
  join clients c on c.id = j.client_id
  -- The NEWEST version only. A revision is a second quotes row for the same
  -- job; a plain join returned one row per version, so the project page took
  -- whichever came first -- an old draft with no frozen rates -- and "Save
  -- revision as PDF" opened a blank page for it (CG, 8 Oct).
  left join quotes q on q.id = (select q2.id from quotes q2 where q2.job_id = j.id
                                 order by q2.version desc limit 1)
  -- The version that COUNTS, for the facts (flags, history, client value):
  -- the same pick job_money makes -- newest accepted, else newest sent --
  -- falling back to the newest of any status. An unsent draft revision of
  -- an accepted quote must not make an agreed project read as "not agreed"
  -- while job_money still bills the accepted price.
  left join quotes cq on cq.id = (${COUNTED_QUOTE_SQL('j.id')})
  left join job_money m on m.job_id = j.id
  where j.shop_id = ?`

interface JobListSqlRow {
  job_id: string
  kind: string
  machine_hours: number | null
  material_units: number | null
  failed_units: number | null
  ref: string
  title: string
  brief: string | null
  created_at: string
  updated_at: string
  taken_in_at: string | null
  phase: JobPhase
  priority: JobPriority
  asset_origin: 'model' | 'fix' | 'ready'
  poc: string | null
  needed_by: string | null
  window_from: string | null
  window_locked: number
  at_risk: number
  over_ceiling: string | null
  printer_id: string | null
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
  /** The version that counts (see COUNTED_QUOTE_SQL), for the facts. */
  counted_status: QuoteStatus | null
  counted_total: number | null
  counted_snapshot: string | null
  counted_discount: number | null
  deposit_due: number
  deposit_owed: number
  balance_owed: number
  last_activity_at: string | null
  skipped_accepted: string | null
  skipped_deposit: string | null
  minimum_order: number
  actual_cost: number
  has_actuals: number
  actual_runs: number
  actual_hours: number
  parts: number
  copies: number
  copies_done: number
  parts_printed: number
  parts_passed: number
  parts_reprint: number
  reprints_ever: number
  units_made: number
  archived_at: string | null
  related_to: string | null
  series_id: string | null
}

function factsFrom(r: JobListSqlRow): ProjectFacts {
  return {
    phase: r.phase,
    kind: r.kind === 'inhouse' ? 'inhouse' : 'client',
    priority: r.priority,
    createdAt: r.created_at,
    takenInAt: r.taken_in_at,
    neededBy: r.needed_by,
    windowFrom: r.window_from,
    // SQLite has no boolean type; 0/1 becomes a real boolean here so that
    // nothing downstream has to remember which backend it came from.
    windowLocked: Number(r.window_locked) === 1,
    atRisk: Number(r.at_risk) === 1,
    overCeiling: r.over_ceiling ?? null,
    printerId: r.printer_id ?? null,
    wentAheadWithout: { accepted: r.skipped_accepted ?? null, deposit: r.skipped_deposit ?? null },
    deliveryOn: r.delivery_on,
    deliveryHow: r.delivery_how,
    brief: r.brief,
    // A project's own point of contact overrides the client's, but until
    // someone sets one the client's named contact IS the person to chase —
    // asking for it twice would be busywork dressed as diligence.
    poc: r.poc ?? r.client_contact,
    quoteStatus: r.counted_status,
    quoteTotal: r.counted_total == null ? null : Number(r.counted_total),
    quotePreTax: quoteBases(r.counted_total, r.counted_snapshot, r.counted_discount).preTax,
    quoteListPrice: quoteBases(r.counted_total, r.counted_snapshot, r.counted_discount).listPrice,
    depositDue: Number(r.deposit_due ?? 0),
    depositOwed: Number(r.deposit_owed ?? 0),
    balanceOwed: Number(r.balance_owed ?? 0),
    lastActivityAt: r.last_activity_at,
    minimumOrder: Number(r.minimum_order ?? 0),
    actualCost: Number(r.actual_cost ?? 0),
    hasActuals: Number(r.has_actuals) === 1,
    actualRuns: Number(r.actual_runs ?? 0),
    actualHours: Number(r.actual_hours ?? 0),
    machineHours: Number(r.machine_hours ?? 0),
    materialUnits: Number(r.material_units ?? 0),
    failedUnits: Number(r.failed_units ?? 0),
    parts: Number(r.parts ?? 0),
    copies: Number(r.copies ?? 0),
    copiesDone: Number(r.copies_done ?? 0),
    partsPrinted: Number(r.parts_printed ?? 0),
    partsPassed: Number(r.parts_passed ?? 0),
    partsReprint: Number(r.parts_reprint ?? 0),
    reprintsEver: Number(r.reprints_ever ?? 0),
    unitsMade: Number(r.units_made ?? 0),
    archivedAt: r.archived_at ?? null,
    relatedTo: r.related_to ?? null,
    seriesId: r.series_id ?? null,
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
    { job_id: string; phase: string; item_key: string; checked: number; note: string | null; skipped: string | null }[]
  >(
    `select job_id, phase, item_key, checked, note, skipped from job_gates where job_id in (${marks})`,
    jobIds,
  )
  for (const r of rows) {
    const byPhase = (out[r.job_id] ??= {})
    const byKey = (byPhase[r.phase] ??= {})
    byKey[r.item_key] = { checked: Number(r.checked) === 1, note: r.note, skipped: r.skipped ?? null }
  }
  return out
}

export async function updateJobPhase(
  shopId: string,
  jobId: string,
  actorId: string,
  toPhase: JobPhase,
  /** Why. Required by the screen when moving BACK a stage; logged either way. */
  note: string | null = null,
): Promise<void> {
  const d = await db()
  const rows = await d.select<{ phase: JobPhase }[]>(
    'select phase from jobs where id = ? and shop_id = ?',
    [jobId, shopId],
  )
  const fromPhase = rows[0]?.phase
  if (!fromPhase || fromPhase === toPhase) return
  // Only delivered work can be archived; moving it back off Delivered
  // brings it back onto the board.
  await d.execute(
    `update jobs set phase = ?,
            archived_at = case when ? = 'delivered' then archived_at else null end,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     where id = ? and shop_id = ?`,
    [toPhase, toPhase, jobId, shopId],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, from_phase, to_phase, body)
     values (?, ?, 'phase_change', ?, ?, ?)`,
    [jobId, actorId, fromPhase, toPhase, note?.trim() || null],
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

  // A revision: same project, same client, next version. The accepted
  // version is never touched -- it is what the client agreed to.
  if (args.reviseJobId) return reviseQuote(d, args, args.reviseJobId)

  const existing = await d.select<{ id: string }[]>(
    'select id from clients where shop_id = ? and system = 0 and name like ? limit 1',
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

  // The build lines, when the quote has them. Written after the quote row
  // because they hang off it; the single-machine columns above keep
  // whatever they were given and are simply not read for such a quote.
  await writeQuoteBuilds(d, quoteId, args.builds)

  if (args.send) {
    await d.execute(
      `insert into job_events (job_id, kind, body) values (?, 'quote_sent', ?)`,
      [jobId, `Quote ${args.ref} sent · ${args.send.total.toFixed(2)}`],
    )
  }

  return { jobId, clientId, quoteId, ref: args.ref }
}

/**
 * A new version of an existing project's quote.
 *
 * Everything the client already holds stays where it is: the accepted row
 * keeps its status, its frozen rate snapshot and its total, and this
 * writes the next version alongside it. The only new rule is the ceiling
 * -- above accepted + 10% the revision has to say what the client changed,
 * and it is allowed once it has.
 */
async function reviseQuote(
  d: Awaited<ReturnType<typeof db>>,
  args: SaveQuoteArgs,
  jobId: string,
): Promise<SavedQuote> {
  const job = (
    await d.select<{ id: string; ref: string; client_id: string }[]>(
      'select id, ref, client_id from jobs where id = ? and shop_id = ?',
      [jobId, args.shopId],
    )
  )[0]
  if (!job) throw new Error('That project no longer exists.')

  const accepted = (
    await d.select<{ total: number | null }[]>(
      `select total from quotes
        where job_id = ? and status = 'accepted'
        order by version desc limit 1`,
      [jobId],
    )
  )[0]
  const change = validateRevision(
    accepted?.total == null ? null : Number(accepted.total),
    args.send?.total ?? null,
    args.change,
  )

  const top = (
    await d.select<{ v: number }[]>(
      'select coalesce(max(version), 0) as v from quotes where job_id = ?',
      [jobId],
    )
  )[0]
  const version = (top?.v ?? 0) + 1

  const quoteId = uuid()
  await d.execute(
    `insert into quotes
      (id, shop_id, job_id, version, status, design_billing, design_qty, revisions_incl,
       quantity, material_id, printer_id, units_per_part, print_hrs_part, finishing_hrs,
       rush, flat_each, discount_pct, rates_snapshot, total, deposit_due, valid_until, sent_at,
       change_cause, change_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      quoteId,
      args.shopId,
      jobId,
      version,
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
      change?.cause ?? null,
      change?.reason ?? null,
    ],
  )
  await writeQuoteBuilds(d, quoteId, args.builds)

  // The project's own facts move with the revision: a client who added
  // parts usually moved the date too.
  await d.execute(
    `update jobs set title = ?, brief = ?, needed_by = ?, asset_origin = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [args.job.title, args.job.brief || null, args.job.neededBy, args.job.assetOrigin, jobId, args.shopId],
  )
  // A change order above the accepted price flags the project until
  // someone clears it by hand (0025_over_ceiling.sql).
  if (change) {
    await d.execute('update jobs set over_ceiling = ? where id = ? and shop_id = ?', [
      `Quote v${version} is ${(args.send?.total ?? 0).toFixed(2)}, above the price the client accepted — ${CHANGE_CAUSE_LABEL[change.cause]}: ${change.reason}`,
      jobId,
      args.shopId,
    ])
  }

  await d.execute(
    `insert into job_events (job_id, kind, body) values (?, 'quote_sent', ?)`,
    [
      jobId,
      change
        ? `Quote revised to v${version} · ${(args.send?.total ?? 0).toFixed(2)} — above the accepted price: ${CHANGE_CAUSE_LABEL[change.cause]} (${change.reason})`
        : `Quote revised to v${version}${args.send ? ` · ${args.send.total.toFixed(2)}` : ' (draft)'}`,
    ],
  )

  return { jobId, clientId: job.client_id, quoteId, ref: job.ref }
}

/** Replace a quote's build lines wholesale. Called on save; a quote is
 *  versioned by insert, so there is no partial-edit case to handle. */
async function writeQuoteBuilds(
  d: Awaited<ReturnType<typeof db>>,
  quoteId: string,
  builds: QuoteBuildInput[] | undefined,
) {
  if (!builds?.length) return
  let sort = 0
  for (const b of builds) {
    const label = b.label.trim()
    if (!label) continue
    await d.execute(
      `insert into quote_builds
         (id, quote_id, kind, label, printer_id, material_id, qty,
          units_per_part, print_hrs_part, slice_import_id, sort)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        quoteId,
        b.kind ?? 'print',
        label,
        b.printerId,
        b.materialId,
        Math.max(1, Math.floor(Number(b.qty) || 1)),
        Number(b.unitsPerPart) || 0,
        Number(b.printHrsPerPart) || 0,
        b.sliceImportId ?? null,
        sort++,
      ],
    )
  }
}

/** A quote's build lines, in order. Empty for a single-machine quote,
 *  which is every quote written before 0016. */
export async function listQuoteBuilds(quoteId: string): Promise<QuoteBuildRow[]> {
  const d = await db()
  const rows = await d.select<
    {
      id: string
      kind: 'print'
      label: string
      printer_id: string | null
      material_id: string | null
      qty: number
      units_per_part: number
      print_hrs_part: number
      slice_import_id: string | null
      sort: number
    }[]
  >(
    `select id, kind, label, printer_id, material_id, qty, units_per_part,
            print_hrs_part, slice_import_id, sort
       from quote_builds where quote_id = ? order by sort, created_at, rowid`,
    [quoteId],
  )
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    printerId: r.printer_id,
    materialId: r.material_id,
    qty: Number(r.qty),
    unitsPerPart: Number(r.units_per_part),
    printHrsPerPart: Number(r.print_hrs_part),
    sliceImportId: r.slice_import_id,
    sort: Number(r.sort),
  }))
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
  const slices = await listSliceImports(shopId, jobId)
  // The family: the project this one continues from, and the ones that
  // continue from it. Design hours come along per project rather than
  // summed, because the point is that they were spent once.
  const FAMILY_SQL = `select j.id as job_id, j.ref, j.title, j.phase, j.kind, j.archived_at,
            coalesce(a.design_hours, 0) as design_hours
       from jobs j
       left join job_actuals a on a.job_id = j.id
      where j.shop_id = ?`
  const parentRows = r.related_to
    ? await d.select<FamilySqlRow[]>(`${FAMILY_SQL} and j.id = ?`, [shopId, r.related_to])
    : []
  const childRows = await d.select<FamilySqlRow[]>(
    `${FAMILY_SQL} and j.related_to = ? order by j.created_at`,
    [shopId, jobId],
  )

  const actualsRow = await d.select<Record<string, number>[]>(
    'select * from job_actuals where job_id = ?',
    [jobId],
  )
  const actuals = toActuals(actualsRow[0])

  const quoteRow = await d.select<Record<string, unknown>[]>(
    `select id, design_billing, design_qty, revisions_incl, quantity, material_id, printer_id,
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
      slice_import_id: string | null
    }[]
  >(
    `select r.id, r.printer_id, p.name as printer_name, r.material_id, m.name as material_name,
            m.unit, r.units_used, r.hours, r.outcome, r.failure_reason, r.note,
            r.started_at, r.ended_at, r.slice_import_id, pr.full_name as operator
       from print_runs r
       left join printers p on p.id = r.printer_id
       left join materials m on m.id = r.material_id
       left join profiles pr on pr.id = r.operator_id
      where r.job_id = ?
      -- Newest first; two prints on one day in the order they were recorded.
      order by coalesce(r.started_at, '') desc, r.rowid desc`,
    [jobId],
  )

  const partRows = await d.select<
    {
      id: string
      label: string
      qty: number
      status: PartStatus
      note: string | null
      sort: number
      chosen_section_id: string | null
      printed_n: number
      passed_n: number
      reprint_n: number
      copy_states: string | null
      spare_n: number | null
    }[]
  >(
    `select id, label, qty, status, note, sort, chosen_section_id, printed_n, passed_n, reprint_n, copy_states, spare_n
       from job_parts where job_id = ? order by sort, created_at`,
    [jobId],
  )
  // Every variant of every part on this job, in one pass. plate_parts
  // counts the objects on the file's plate, because a plate of three is
  // one indivisible print and the row has to say so.
  const variantRows = await d.select<
    {
      section_id: string
      part_id: string
      import_id: string
      file_name: string
      printer_model: string | null
      printer_id: string | null
      printer_name: string | null
      est_minutes: number | null
      est_grams: number | null
      material: string | null
      imported_at: string
      plate_parts: number
      section_qty: number
      material_id: string | null
    }[]
  >(
    `select s.qty as section_qty, i.material_id, s.id as section_id, s.part_id, i.id as import_id, i.file_name,
            i.printer_model, i.printer_id, p.name as printer_name,
            s.est_minutes, s.est_grams, s.material, i.imported_at,
            (select count(*) from slice_sections x where x.import_id = i.id) as plate_parts
       from slice_sections s
       join slice_imports i on i.id = s.import_id
       left join printers p on p.id = i.printer_id
      where i.job_id = ? and s.part_id is not null
      order by i.imported_at desc, s.rowid desc`,
    [jobId],
  )
  const partHistory = await d.select<
    {
      id: number
      part_id: string
      kind: 'status' | 'note'
      from_status: PartStatus | null
      to_status: PartStatus | null
      n: number | null
      copies: string | null
      slice_import_id: string | null
      run_id: string | null
      note: string | null
      actor: string | null
      at: string
    }[]
  >(
    `select e.id, e.part_id, e.kind, e.from_status, e.to_status, e.n, e.copies, e.slice_import_id, e.run_id, e.note, e.at,
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
    quoteInputs: quoteRow[0]
      ? { ...toQuoteInputs(quoteRow[0]), builds: await listQuoteBuilds(String(quoteRow[0].id)) }
      : null,
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
        sliceImportId: x.slice_import_id,
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
        note: x.note,
        sort: Number(x.sort),
        chosenSectionId: x.chosen_section_id,
        variants: variantRows
          .filter((v) => v.part_id === x.id)
          .map((v): PartVariant => ({
            sectionId: v.section_id,
            importId: v.import_id,
            fileName: v.file_name,
            printerModel: v.printer_model,
            printerId: v.printer_id,
            printerName: v.printer_name,
            estMinutes: v.est_minutes == null ? null : Number(v.est_minutes),
            estGrams: v.est_grams == null ? null : Number(v.est_grams),
            material: v.material,
            importedAt: v.imported_at,
            plateParts: Number(v.plate_parts),
            sectionQty: Math.max(1, Number(v.section_qty ?? 1)),
            materialId: v.material_id ?? null,
          })),
        history: partHistory
          .filter((e) => e.part_id === x.id)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            fromStatus: e.from_status,
            toStatus: e.to_status,
            n: e.n == null ? null : Number(e.n),
            copies: parseCopies(e.copies),
            sliceImportId: e.slice_import_id ?? null,
            runId: e.run_id ?? null,
            note: e.note,
            actor: e.actor,
            at: e.at,
          })),
      }),
    ),
    slices,
    relatedTo: parentRows[0] ? toRelated(parentRows[0]) : null,
    related: childRows.map(toRelated),
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

/**
 * Skip a gate item on purpose, with the reason -- or take the skip back
 * (reason null). Logged to Activity. See 0027_gate_skips.sql.
 */
export async function skipGateItem(
  jobId: string,
  actorId: string,
  phase: JobPhase,
  itemKey: string,
  itemLabel: string,
  reason: string | null,
): Promise<void> {
  const why = reason?.trim() || null
  const d = await db()
  await d.execute(
    `insert into job_gates (job_id, phase, item_key, checked, skipped, actor_id, at)
     values (?, ?, ?, 0, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     on conflict (job_id, phase, item_key) do update set
       skipped = excluded.skipped, actor_id = excluded.actor_id, at = excluded.at`,
    [jobId, phase, itemKey, why, actorId],
  )
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [
    jobId,
    actorId,
    why ? `Skipped “${itemLabel}”. Why: ${why}` : `Took back the skip on “${itemLabel}”.`,
  ])
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
  const [before] = await d.select<ProjectBefore[]>(
    `select title, brief, poc, needed_by, window_from, window_locked, at_risk,
            delivery_on, delivery_how, priority, over_ceiling, printer_id
       from jobs where id = ? and shop_id = ?`,
    [jobId, shopId],
  )
  if (!before) throw new Error('That project is not in this shop.')
  await d.execute(`update jobs set ${sets.join(', ')} where id = ? and shop_id = ?`, [
    ...args,
    jobId,
    shopId,
  ])
  // Every edit after creation is on the record: who changed what, from what.
  const printerName = fields.printerId
    ? ((await d.select<{ name: string }[]>('select name from printers where id = ?', [fields.printerId]))[0]?.name ?? null)
    : null
  const said = describeProjectEdits(before, fields, printerName)
  if (said.length > 0) {
    await d.execute(
      `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`,
      [jobId, actorId, said.join(' ')],
    )
  }
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
     -- The version that counts, as job_money and the project facts pick it:
     -- a draft revision does not wipe out the price the client accepted.
     left join quotes q on q.id = (${COUNTED_QUOTE_SQL('j.id')})
     left join job_money m on m.job_id = j.id
     -- The in-house row is a storage detail, not a client. It never appears
     -- in the list, the counts or the money. See 0012_in_house.sql.
     where c.shop_id = ? and c.system = 0
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

/**
 * Add a client without going through a quote.
 *
 * Until now the ONLY way a client could come into existence was as a side
 * effect of saving a quote, which meant a shop could not enter the people
 * it already works with before it had work to enter, could not fix a name
 * typed wrong on the first job, and had no way to keep a contact it had
 * spoken to but not yet quoted. That is a CRM that only records history,
 * and a shop's client list is the one thing it brings with it.
 *
 * A name is the only requirement, because it is the only thing that has to
 * be true. Matching is case-insensitive so "Hafen GmbH" and "hafen gmbh"
 * do not become two clients who each owe you half.
 */
export async function createClient(shopId: string, input: ClientEditInput): Promise<string> {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('A client needs a name.')
  const d = await db()
  const dupes = await d.select<{ id: string }[]>(
    'select id from clients where shop_id = ? and system = 0 and name = ? collate nocase',
    [shopId, name],
  )
  if (dupes[0]) {
    throw new Error(
      `You already have a client called "${name}". Open that one rather than making a second — ` +
        'two clients with one name is how a balance owed goes missing.',
    )
  }
  const id = uuid()
  await d.execute(
    `insert into clients (id, shop_id, name, kind, contact, email, phone)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopId,
      name,
      input.kind ?? 'individual',
      input.contact?.trim() || null,
      input.email?.trim() || null,
      input.phone?.trim() || null,
    ],
  )
  return id
}

/**
 * Delete a client, but only one with nothing recorded against them.
 *
 * `jobs.client_id` has no `on delete cascade` and that is deliberate: a
 * cascade here would take the projects, their quotes, their payments and
 * their build history with it, so a mistyped name cleaned up in the client
 * list would silently delete money the shop had actually received. So this
 * refuses and says how many projects are in the way, and the shop deletes
 * those from their own pages — where the warning names what goes with them
 * — or renames the client instead.
 */
export async function deleteClient(shopId: string, clientId: string): Promise<void> {
  const d = await db()
  const rows = await d.select<{ n: number; name: string }[]>(
    `select count(j.id) as n, max(c.name) as name
       from clients c left join jobs j on j.client_id = c.id
      where c.id = ? and c.shop_id = ?`,
    [clientId, shopId],
  )
  const n = Number(rows[0]?.n ?? 0)
  if (n > 0) {
    throw new Error(
      `${rows[0]?.name ?? 'That client'} has ${n} project${n === 1 ? '' : 's'}. ` +
        'Deleting them would take those projects, their payments and their build history with them. ' +
        'Delete the projects first if you mean to, or rename the client instead.',
    )
  }
  const res = await d.execute('delete from clients where id = ? and shop_id = ?', [clientId, shopId])
  if (res.rowsAffected === 0) throw new Error('That client no longer exists.')
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
              sell_override = ?, on_hand = coalesce(?, on_hand),
              reorder_at = coalesce(?, reorder_at), archived = ?
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
        next.onHand ?? 0,
        next.reorderAt ?? 0,
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

/**
 * Record a weighing. Stores the count AND the difference from what Guma
 * believed was on hand -- the difference is the number worth reading
 * later: a print nobody logged, or a slicer that is optimistic about its
 * filament. The trigger applies the difference, so on-hand becomes the
 * count. See 0024_stock_counts.sql.
 */
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
  const d = await db()
  const rows = await d.select<{ on_hand: number }[]>(
    'select on_hand from materials where id = ? and shop_id = ?',
    [materialId, shopId],
  )
  if (!rows[0]) throw new Error('That material no longer exists.')
  const delta = Math.round((counted - Number(rows[0].on_hand ?? 0)) * 1000) / 1000
  const id = crypto.randomUUID()
  await d.execute(
    `insert into material_counts
       (id, shop_id, material_id, counted_on, counted_qty, delta, note, recorded_by)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, shopId, materialId, input.countedOn, counted, delta, input.note, actorId],
  )
  return { id, delta }
}

/** Every movement of one material, newest first. */
export async function listMaterialLedger(
  shopId: string,
  materialId: string,
): Promise<StockEntry[]> {
  const d = await db()
  const purchases = await d.select<
    { id: string; on: string; qty: number; cost: number; note: string | null; supplier: string | null }[]
  >(
    `select id, purchased_on as "on", qty, total_cost as cost, note, supplier
       from material_purchases where shop_id = ? and material_id = ?`,
    [shopId, materialId],
  )
  const runs = await d.select<
    {
      id: string
      on: string | null
      created: string | null
      qty: number
      outcome: RunOutcome | null
      job_id: string
      ref: string
      title: string
      note: string | null
    }[]
  >(
    `select r.id, r.started_at as "on", r.consumed_at as created, r.units_used as qty, r.outcome,
            j.id as job_id, j.ref, j.title, r.failure_reason as note
       from print_runs r
       join jobs j on j.id = r.job_id
      where r.shop_id = ? and r.material_id = ? and coalesce(r.units_used, 0) > 0`,
    [shopId, materialId],
  )
  const counts = await d.select<
    { id: string; on: string; counted: number; delta: number; note: string | null }[]
  >(
    `select id, counted_on as "on", counted_qty as counted, delta, note
       from material_counts where shop_id = ? and material_id = ?`,
    [shopId, materialId],
  )
  const out: StockEntry[] = [
    ...purchases.map(
      (p): StockEntry => ({
        id: p.id,
        kind: 'purchase',
        on: p.on,
        qty: Number(p.qty),
        cost: Number(p.cost),
        jobId: null,
        jobRef: null,
        jobTitle: null,
        outcome: null,
        counted: null,
        note: [p.supplier, p.note].filter(Boolean).join(' · ') || null,
      }),
    ),
    ...runs.map(
      (r): StockEntry => ({
        id: r.id,
        kind: 'print',
        on: (r.on ?? r.created ?? '').slice(0, 10),
        qty: -Number(r.qty),
        cost: null,
        jobId: r.job_id,
        jobRef: r.ref,
        jobTitle: r.title,
        outcome: r.outcome,
        counted: null,
        note: r.note,
      }),
    ),
    ...counts.map(
      (c): StockEntry => ({
        id: c.id,
        kind: 'count',
        on: c.on,
        qty: Number(c.delta),
        cost: null,
        jobId: null,
        jobRef: null,
        jobTitle: null,
        outcome: null,
        counted: Number(c.counted),
        note: c.note,
      }),
    ),
  ]
  return out.sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0))
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

function toQuoteInputs(q: Record<string, unknown>): Omit<QuoteInputsRow, 'builds'> {
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
                             outcome, failure_reason, note, started_at, operator_id,
                             slice_import_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.sliceImportId ?? null,
    ],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'run', ?)`,
    [jobId, actorId, runEventBody(input)],
  )
  return id
}

/**
 * Correct a recorded print in place (CG, 14 Oct: a plate recorded as clean
 * had stopped at 15 of 16h 26m). The machine and spool stay; grams, hours,
 * outcome and reason change, and the shelf moves by the difference (0038's
 * trigger). Turning a clean print into a failed or stopped one can also
 * fail the copies it marked printed -- the ones still printed -- with the
 * reason, so the reprint workflow starts. Returns how many copies failed.
 */
export async function correctPrintRun(
  shopId: string,
  runId: string,
  actorId: string,
  input: RunCorrection,
  failCopies = false,
): Promise<number> {
  const d = await db()
  const [run] = await d.select<
    { job_id: string; units_used: number | null; hours: number | null; outcome: RunOutcome | null; material_id: string | null; printer_id: string | null; started_at: string | null }[]
  >('select job_id, units_used, hours, outcome, material_id, printer_id, started_at from print_runs where id = ? and shop_id = ?', [runId, shopId])
  if (!run) throw new Error('That print is no longer recorded.')
  const { hours, unitsUsed } = validateRun({ ...input, printerId: run.printer_id ?? '', materialId: run.material_id, startedAt: run.started_at })
  const why = input.failureReason?.trim() || null
  await d.execute(
    `update print_runs set units_used = ?, hours = ?, outcome = ?, failure_reason = ?, note = ? where id = ? and shop_id = ?`,
    [unitsUsed, hours, input.outcome, input.outcome === 'success' ? null : why, input.note?.trim() || null, runId, shopId],
  )
  const [mat] = run.material_id
    ? await d.select<{ unit: string }[]>('select unit from materials where id = ?', [run.material_id])
    : []
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'run', ?)`, [
    run.job_id,
    actorId,
    describeRunCorrection(
      { unitsUsed: run.units_used == null ? null : Number(run.units_used), hours: run.hours == null ? null : Number(run.hours), outcome: run.outcome },
      { ...input, unitsUsed, hours, failureReason: why },
      mat?.unit ?? 'g',
    ),
  ])
  let failed = 0
  if (failCopies && input.outcome !== 'success') {
    const evs = await d.select<{ id: number; part_id: string; to_status: PartStatus; copies: string | null }[]>(
      `select id, part_id, to_status, copies from part_events
        where run_id = ? and kind = 'status' and to_status = 'printed' and copies is not null order by id`,
      [runId],
    )
    for (const ev of evs) {
      const still = await copiesStillFrom(ev)
      if (!still.length) continue
      await setCopyStates(shopId, ev.part_id, actorId, still, 'reprint', why || 'The print stopped part way.', runId)
      failed += still.length
    }
  }
  return failed
}

/** Delete a run. The trigger puts its material back on the shelf. Same
 *  reasoning as deleting a material purchase: this is the shop's own cost
 *  book, and a mistyped run skews every figure downstream of it. */
export async function deletePrintRun(shopId: string, runId: string, undoCopies = false): Promise<number> {
  const d = await db()
  // What it made and has been placed -- on the shelf, in an assembly, kept --
  // has to come back first, or the shelf would hold units no print made.
  const placed = await d.select<{ n: number }[]>(
    "select count(*) as n from made_items where run_id = ? and status in ('shelved', 'assembled', 'kept')",
    [runId],
  )
  if (Number(placed[0]?.n ?? 0) > 0)
    throw new Error('Some of what this print made is already on the shelf, in an assembly or kept — take it back first.')
  let undone = 0
  if (undoCopies) {
    const [run] = await d.select<{ job_id: string; slice_import_id: string | null }[]>(
      'select job_id, slice_import_id from print_runs where id = ? and shop_id = ?',
      [runId, shopId],
    )
    if (run) {
      const evs = await d.select<{ id: number; part_id: string; to_status: PartStatus; copies: string | null }[]>(
        `select id, part_id, to_status, copies from part_events
          where run_id = ? and kind = 'status' and copies is not null order by id`,
        [runId],
      )
      for (const ev of evs) {
        const back = await copiesStillFrom(ev)
        if (!back.length) continue
        // A copy this print came off as a reprint from a fixed file goes
        // back to waiting for that file, not to plain "not printed".
        const requeue = await queuedBefore(ev, run.slice_import_id)
        const again = back.filter((c) => requeue.includes(c))
        const plain = back.filter((c) => !requeue.includes(c))
        const why = 'The print that marked this was removed from What it took.'
        if (plain.length) await setCopyStates(shopId, ev.part_id, null, plain, 'pending', why)
        if (again.length) await setCopyStates(shopId, ev.part_id, null, again, 'pending', why, null, run.slice_import_id)
        undone += back.length
        // Every copy it moved went back: what it recorded did not happen as
        // recorded. Kept in the history as a note, so it no longer counts as
        // a failure on the copy, in the tally, or in the reprint queue.
        if (back.length === (parseCopies(ev.copies) ?? []).length)
          await d.execute(
            `update part_events set kind = 'note', note = 'Undone (print removed): ' || coalesce(note, to_status),
                    from_status = null, to_status = null where id = ?`,
            [ev.id],
          )
      }
    }
  }
  await d.execute('delete from print_runs where id = ? and shop_id = ?', [runId, shopId])
  return undone
}

/** What copy `c` (1-based) was just before event `beforeId`: the last status
 *  event that named it, or not printed. */
async function stateBefore(partId: string, c: number, beforeId: number): Promise<PartStatus> {
  const d = await db()
  const evs = await d.select<{ to_status: PartStatus; copies: string | null }[]>(
    `select to_status, copies from part_events
      where part_id = ? and kind = 'status' and to_status is not null and id < ? order by id desc`,
    [partId, beforeId],
  )
  for (const e of evs) {
    const cs = parseCopies(e.copies)
    if (cs == null || cs.includes(c)) return e.to_status
  }
  return 'pending'
}

/** The copies an event moved that are still where it put them, 0-based. */
async function copiesStillFrom(ev: { part_id: string; to_status: PartStatus; copies: string | null }): Promise<number[]> {
  const d = await db()
  const [p] = await d.select<{ qty: number; printed_n: number; passed_n: number; reprint_n: number; copy_states: string | null }[]>(
    'select qty, printed_n, passed_n, reprint_n, copy_states from job_parts where id = ?',
    [ev.part_id],
  )
  if (!p) return []
  const states = statesOf({ qty: Number(p.qty), printedN: Number(p.printed_n), passedN: Number(p.passed_n), reprintN: Number(p.reprint_n), copyStates: p.copy_states })
  return (parseCopies(ev.copies) ?? []).map((c) => c - 1).filter((i) => states[i] === ev.to_status)
}

/** Copies that were waiting to print from `file` just before this event. */
async function queuedBefore(ev: { id: number; part_id: string }, file: string | null): Promise<number[]> {
  if (!file) return []
  const d = await db()
  const before = await d.select<{ part_id: string; copies: string | null; slice_import_id: string | null }[]>(
    `select part_id, copies, slice_import_id from part_events
      where part_id = ? and to_status = 'pending' and copies is not null and id < ? order by at, id`,
    [ev.part_id, ev.id],
  )
  // Every copy counts as not printed here: the question is only which file
  // it was last queued for.
  const latest = new Map<number, string | null>()
  for (const e of before) for (const c of parseCopies(e.copies) ?? []) latest.set(c - 1, e.slice_import_id)
  return [...latest.entries()].filter(([, f]) => f === file).map(([i]) => i)
}

/**
 * Save the progress read from a kept file that was imported before Guma
 * read the moves -- so a stopped print can be costed from it, once.
 */
/** A plate's picture and sliced date, read from its kept file once (0040). */
export async function setSliceExtras(shopId: string, importId: string, thumbnail: string | null, slicedAt: string | null): Promise<void> {
  const d = await db()
  await d.execute('update slice_imports set thumbnail = coalesce(thumbnail, ?), sliced_at = coalesce(sliced_at, ?) where id = ? and shop_id = ?', [
    thumbnail,
    slicedAt,
    importId,
    shopId,
  ])
}

export async function setSliceProgress(shopId: string, importId: string, progress: ProgressPoint[]): Promise<void> {
  const d = await db()
  await d.execute('update slice_imports set progress = ? where id = ? and shop_id = ?', [encodeProgress(progress), importId, shopId])
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
    [id, jobId, input.reason?.trim() ? `Added after checking: ${input.reason.trim()}` : 'Added to the build sheet', actorId],
  )
  if (input.reason?.trim()) {
    await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [
      jobId,
      actorId,
      `Added a part, "${label}" ×${qty}. Why: ${input.reason.trim()}`,
    ])
  }
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
  // Every copy that can go there, goes. Kept for the callers that mean the
  // whole part ("pass them all"); counting callers use movePartCopies.
  if (status === 'reprint' && !(note ?? '').trim()) {
    throw new Error('Say what went wrong before sending a part back.')
  }
  const part = await readCopies(shopId, partId)
  const n = movable(countsOf(part.states), status)
  if (n === 0) return
  await movePartCopies(shopId, partId, actorId, status, n, note)
}

/** A part's copies as stored, for the writers below. */
async function readCopies(shopId: string, partId: string) {
  const d = await db()
  const [p] = await d.select<
    { job_id: string; qty: number; status: PartStatus; printed_n: number; passed_n: number; reprint_n: number; copy_states: string | null }[]
  >(
    'select job_id, qty, status, printed_n, passed_n, reprint_n, copy_states from job_parts where id = ? and shop_id = ?',
    [partId, shopId],
  )
  if (!p) throw new Error('That part no longer exists.')
  return {
    jobId: p.job_id,
    status: p.status,
    states: statesOf({
      qty: Number(p.qty),
      printedN: Number(p.printed_n),
      passedN: Number(p.passed_n),
      reprintN: Number(p.reprint_n),
      copyStates: p.copy_states,
    }),
  }
}

/** Write the copies, the counts and the summary status together, and
 *  say what happened in the part's history. */
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
  const d = await db()
  const c = countsOf(states)
  await d.execute(
    `update job_parts set copy_states = ?, printed_n = ?, passed_n = ?, reprint_n = ?, status = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [JSON.stringify(states), c.printed, c.passed, c.reprint, statusOf(c), partId, shopId],
  )
  await d.execute(
    `insert into part_events (part_id, job_id, kind, from_status, to_status, n, copies, note, actor_id, slice_import_id, run_id)
     values (?, ?, 'status', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [partId, before.jobId, before.status, to, moved.length, copyList(moved), note?.trim() || null, actorId, sliceImportId, runId],
  )
}

/**
 * Move some of a part's copies (CG, 8 Oct: one test copy of five). The
 * rules -- which copies can move where -- are lib/copies.ts, shared with
 * the hosted backend and the screen. Sending copies back needs a reason.
 */
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

/**
 * Set named copies (0-based) to a state -- including back to not printed,
 * for a copy marked by mistake. Failing one still needs a reason.
 */
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
  const after = setStates(before.states, changed, to)
  await writeCopies(shopId, partId, actorId, before, after, to, changed, note, sliceImportId, runId)
}

/**
 * A failed copy gets a replacement file: back in the queue, to print from
 * THAT file (CG, 9 Oct). The failure stays in the part's history -- the
 * copy shows it failed and what it is being reprinted from -- and the event
 * names the file, so recording that file's plate marks this copy printed
 * rather than whichever copy is next. Voltage kept a failed part as a
 * "replaced" record pointing at its replacement; this is the same, per copy.
 */
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
  const after = setStates(before.states, [copy], 'pending')
  await writeCopies(
    shopId,
    partId,
    actorId,
    before,
    after,
    'pending',
    [copy],
    `Reprint from ${fileName}`,
    sliceImportId,
  )
}

/**
 * One plate came off the machine: every part on it gains the copies that
 * plate holds -- not all of its copies. A part needing five, on a plate
 * that carries one, is one of five printed (CG, 8 Oct). Returns how many
 * parts moved.
 */
export async function markPlatePrinted(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null = null,
): Promise<number> {
  return movePlate(shopId, jobId, actorId, sliceImportId, runId, 'printed', null)
}

/**
 * A plate that failed: the copies it was printing are marked failed, with
 * the reason, so the reprint workflow starts on the build sheet (CG, 13 Oct)
 * -- New file, Skip, or back to Not printed. Which copies: the same ones a
 * successful plate would have marked printed.
 */
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

/** The copies one plate moves, part by part, each event stamped with the print. */
async function movePlate(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sliceImportId: string,
  runId: string | null,
  to: 'printed' | 'reprint',
  note: string | null,
  onlyPart: string | null = null,
): Promise<number> {
  const d = await db()
  const rows = await d.select<
    { part_id: string; per_plate: number; qty: number; printed_n: number; passed_n: number; reprint_n: number; copy_states: string | null }[]
  >(
    // One row per PART, not per section: two sections of one plate can
    // point at the same part (importSlice matches labels ignoring case), and
    // moving them one by one from a single read moved the first and then
    // threw on the second, half-applied.
    `select s.part_id, sum(max(1, coalesce(s.qty, 1))) as per_plate,
            p.qty, p.printed_n, p.passed_n, p.reprint_n, p.copy_states
       from slice_sections s
       join slice_imports i on i.id = s.import_id
       join job_parts p on p.id = s.part_id
      where s.import_id = ? and i.job_id = ? and p.shop_id = ?
      group by s.part_id, p.qty, p.printed_n, p.passed_n, p.reprint_n, p.copy_states`,
    [sliceImportId, jobId, shopId],
  )
  // Copies queued to print from THIS file (a failed copy's replacement) are
  // the ones this plate was for.
  const queued = await d.select<{ part_id: string; copies: string | null; slice_import_id: string | null }[]>(
    `select part_id, copies, slice_import_id from part_events
      where job_id = ? and to_status = 'pending' and copies is not null
      order by at, id`,
    [jobId],
  )
  let moved = 0
  for (const r of rows) {
    if (onlyPart && r.part_id !== onlyPart) continue
    const states = statesOf({ qty: Number(r.qty), printedN: Number(r.printed_n), passedN: Number(r.passed_n), reprintN: Number(r.reprint_n), copyStates: r.copy_states })
    const pick = plateCopies(
      states,
      queuedCopies(queued, r.part_id, sliceImportId, states),
      Math.max(1, Number(r.per_plate)),
      to === 'printed' ? ['reprint', 'pending'] : ['pending'],
    )
    if (!pick.length) continue
    await setCopyStates(shopId, r.part_id, actorId, pick, to, note, runId)
    moved += onlyPart ? pick.length : 1
  }
  return moved
}

/**
 * Move one object of a plate to another part -- or to a new one (CG, 16 Oct:
 * "a plate can have the same name ... but have completely different parts";
 * Guma had matched objects to parts by name alone). What the plate's prints
 * marked moves with it: the copies go back to not printed on the part it
 * leaves, and the same prints mark copies on the part it joins. Both parts'
 * histories say so.
 */
export async function moveSliceSection(
  shopId: string,
  jobId: string,
  actorId: string | null,
  sectionId: string,
  to: SectionAssign,
): Promise<SectionMoveResult> {
  const d = await db()
  const [sec] = await d.select<
    { import_id: string; part_id: string | null; label: string; qty: number; file_name: string; old_label: string | null; chosen: string | null }[]
  >(
    `select s.import_id, s.part_id, s.label, s.qty, i.file_name, p.label as old_label, p.chosen_section_id as chosen
       from slice_sections s
       join slice_imports i on i.id = s.import_id
       left join job_parts p on p.id = s.part_id
      where s.id = ? and i.job_id = ? and i.shop_id = ?`,
    [sectionId, jobId, shopId],
  )
  if (!sec) throw new Error('That object is not on a plate of this project.')
  const parts = await d.select<{ id: string; label: string; sort: number }[]>(
    'select id, label, sort from job_parts where job_id = ? and shop_id = ?',
    [jobId, shopId],
  )
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
    partId = crypto.randomUUID()
    const sort = Math.max(-1, ...parts.map((x) => Number(x.sort))) + 1
    await d.execute(
      'insert into job_parts (id, shop_id, job_id, label, qty, sort) values (?, ?, ?, ?, ?, ?)',
      [partId, shopId, jobId, newName, Math.max(1, Number(sec.qty) || 1), sort],
    )
    await d.execute(
      `insert into part_events (part_id, job_id, kind, to_status, note, actor_id) values (?, ?, 'status', 'pending', ?, ?)`,
      [partId, jobId, `Sorted from ${sec.file_name}`, actorId],
    )
  }
  const from = sec.part_id
  if (from === partId) return { partId, moved: 0, unplaced: 0 }

  // The prints recorded from this plate, oldest first.
  const runs = await d.select<{ id: string; outcome: string; failure_reason: string | null }[]>(
    `select id, outcome, failure_reason from print_runs
      where slice_import_id = ? and shop_id = ? order by coalesce(started_at, ''), rowid`,
    [sec.import_id, shopId],
  )
  // 1. What those prints marked on the part it leaves is taken back: each
  // copy returns to the state it had before (a reprint the plate printed is
  // a failed copy again, waiting -- not a fresh failure), and the marks
  // become notes, so they no longer count there.
  let undone = 0
  if (from) {
    for (const run of [...runs].reverse()) {
      const evs = await d.select<{ id: number; to_status: PartStatus; copies: string | null }[]>(
        `select id, to_status, copies from part_events
          where run_id = ? and part_id = ? and kind = 'status' and copies is not null order by id desc`,
        [run.id, from],
      )
      for (const ev of evs) {
        const cur = await readCopies(shopId, from)
        const states = [...cur.states]
        const marked = parseCopies(ev.copies) ?? []
        let back = 0
        for (const c of marked) {
          if (states[c - 1] !== ev.to_status) continue
          states[c - 1] = await stateBefore(from, c, ev.id)
          back++
        }
        if (back) {
          const n = countsOf(states)
          await d.execute(
            `update job_parts set copy_states = ?, printed_n = ?, passed_n = ?, reprint_n = ?, status = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ? and shop_id = ?`,
            [JSON.stringify(states), n.printed, n.passed, n.reprint, statusOf(n), from, shopId],
          )
          undone += back
        }
        if (back === marked.length)
          await d.execute(
            `update part_events set kind = 'note', note = 'Moved with its plate object: ' || coalesce(note, to_status),
                    from_status = null, to_status = null where id = ?`,
            [ev.id],
          )
      }
    }
    if (sec.chosen === sectionId)
      await d.execute('update job_parts set chosen_section_id = null where id = ? and shop_id = ?', [from, shopId])
    await d.execute(`insert into part_events (part_id, job_id, kind, note, actor_id) values (?, ?, 'note', ?, ?)`, [
      from,
      jobId,
      `${sec.label} on ${sec.file_name} moved to ${newName}${undone ? ` — ${undone} cop${undone === 1 ? 'y' : 'ies'} it marked put back as before` : ''}.`,
      actorId,
    ])
  }
  // 2. The object joins its part.
  await d.execute('update slice_sections set part_id = ? where id = ?', [partId, sectionId])
  // 3. The same prints mark copies there, in the order they happened.
  let moved = 0
  let unplaced = 0
  for (const run of runs) {
    const ok = run.outcome === 'success'
    const n = await movePlate(
      shopId,
      jobId,
      actorId,
      sec.import_id,
      run.id,
      ok ? 'printed' : 'reprint',
      ok ? null : run.failure_reason || 'The plate failed.',
      partId,
    )
    if (n) moved += n
    else unplaced++
  }
  if (from)
    await d.execute(`insert into part_events (part_id, job_id, kind, note, actor_id) values (?, ?, 'note', ?, ?)`, [
      partId,
      jobId,
      `${sec.label} on ${sec.file_name} sorted here from ${sec.old_label ?? 'another part'}.`,
      actorId,
    ])
  return { partId, moved, unplaced }
}

/**
 * Choose which sliced file this part is being printed from.
 *
 * Null clears the choice and the screen falls back to the fastest variant,
 * saying so. The section must belong to this part: pointing a part at
 * another part's slice would put the wrong time into every schedule built
 * from it, silently, which is the failure mode this whole feature exists
 * to prevent.
 */
export async function choosePartVariant(
  shopId: string,
  partId: string,
  sectionId: string | null,
): Promise<void> {
  const d = await db()
  if (sectionId) {
    const ok = await d.select<{ n: number }[]>(
      'select count(*) as n from slice_sections where id = ? and part_id = ?',
      [sectionId, partId],
    )
    if (!(ok[0]?.n ?? 0)) throw new Error('That sliced file is not a version of this part.')
  }
  await d.execute(
    `update job_parts set chosen_section_id = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [sectionId, partId, shopId],
  )
}

/** Rename a part or change how many copies of it there are. */
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
  const d = await db()
  const before = await readPartForCopies(shopId, partId)
  await d.execute(
    `update job_parts set label = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ? and shop_id = ?`,
    [label, note, partId, shopId],
  )
  const said = describePartEdit(before, { label, qty: before.qty, note })
  if (qty !== before.qty) {
    const r = await applyCopyCount(shopId, { ...before, label }, qty)
    said.push(describeCopiesChange(label, before.qty, r, qty))
  }
  if (said.length > 0) {
    const body = said.join(' ')
    await d.execute(
      `insert into part_events (part_id, job_id, kind, note, actor_id) values (?, ?, 'note', ?, ?)`,
      [partId, before.job_id, body, actorId],
    )
    await d.execute(
      `insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`,
      [before.job_id, actorId, body],
    )
  }
}

async function readPartForCopies(shopId: string, partId: string) {
  const d = await db()
  const [p] = await d.select<
    {
      id: string
      job_id: string
      label: string
      qty: number
      note: string | null
      printed_n: number
      passed_n: number
      reprint_n: number
      copy_states: string | null
      spare_n: number | null
    }[]
  >(
    `select id, job_id, label, qty, note, printed_n, passed_n, reprint_n, copy_states, spare_n
       from job_parts where id = ? and shop_id = ?`,
    [partId, shopId],
  )
  if (!p) throw new Error('That part is not in this shop.')
  return { ...p, qty: Number(p.qty), spare_n: Number(p.spare_n ?? 0) }
}

/**
 * Set one part's copy count (lib/copies.ts changeCopies): the copies, the
 * counts, the spares, and the history's copy numbers, together. The caller
 * says what happened -- one line per part, or one line for a batch.
 */
async function applyCopyCount(
  shopId: string,
  p: Awaited<ReturnType<typeof readPartForCopies>>,
  qty: number,
) {
  const d = await db()
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
  await d.execute(
    `update job_parts set qty = ?, copy_states = ?, printed_n = ?, passed_n = ?, reprint_n = ?, status = ?, spare_n = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [qty, JSON.stringify(r.states), c.printed, c.passed, c.reprint, statusOf(c), r.spare, p.id, shopId],
  )
  await renumberPartEvents(p.id, r.removed)
  return r
}

/** Keep the history's copy numbers pointing at the same copies after some
 *  left the part (lib/copies.ts renumberCopies). */
async function renumberPartEvents(partId: string, removed: number[]) {
  if (removed.length === 0) return
  const d = await db()
  const evs = await d.select<{ id: number; copies: string | null }[]>(
    'select id, copies from part_events where part_id = ? and copies is not null',
    [partId],
  )
  for (const e of evs) {
    const next = renumberCopies(e.copies, removed)
    if (next !== e.copies) await d.execute('update part_events set copies = ? where id = ?', [next, e.id])
  }
}

/**
 * Several parts to new copy counts at once (CG, 12 Oct: "reduce the number
 * of parts needed down to 4 for some of the parts"). Every part is read and
 * checked before any is written, so a bad entry changes nothing. One line
 * per part in its history, one line for the batch in the project's.
 */
export async function setPartsCopies(
  shopId: string,
  jobId: string,
  actorId: string | null,
  changes: PartCopiesChange[],
  reason: string | null,
): Promise<PartCopiesResult[]> {
  const d = await db()
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
    await d.execute(`insert into part_events (part_id, job_id, kind, note, actor_id) values (?, ?, 'note', ?, ?)`, [
      p.id,
      jobId,
      why ? `${line} Why: ${why}` : line,
      actorId,
    ])
    out.push({ partId: p.id, label: p.label, from: p.qty, to: qty, toSpare: r.toSpare, fromSpare: r.fromSpare, dropped: r.dropped })
  }
  const head =
    out.length === 1
      ? describeCopiesChange(out[0].label, out[0].from, out[0], out[0].to)
      : `Copies changed on ${out.length} parts: ${out.map((x) => `${x.label} ${x.from} → ${x.to}`).join(', ')}.`
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [
    jobId,
    actorId,
    why ? `${head} Why: ${why}` : head,
  ])
  return out
}

/** Remove a part. Its history goes with it — there is nothing left to be
 *  the history of. */
export async function deletePart(
  shopId: string,
  partId: string,
  actorId: string | null = null,
  reason: string | null = null,
): Promise<void> {
  const d = await db()
  const [part] = await d.select<{ job_id: string; label: string; qty: number }[]>(
    'select job_id, label, qty from job_parts where id = ? and shop_id = ?',
    [partId, shopId],
  )
  if (!part) return
  await d.execute('delete from job_parts where id = ? and shop_id = ?', [partId, shopId])
  // The part's own history goes with it, so the removal is recorded on the
  // project: what it was, who removed it, and why when a reason was given.
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [
    part.job_id,
    actorId,
    `Removed part "${part.label}" ×${part.qty}.${reason?.trim() ? ` Why: ${reason.trim()}` : ''}`,
  ])
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

/**
 * Take a saved draft in as a real project.
 *
 * Stamped rather than flagged, because "when did this become work we
 * agreed to do" is a question worth being able to answer later, and a
 * boolean cannot. Idempotent: taking in a project that is already in does
 * nothing rather than moving its date, since the first answer is the true
 * one.
 */
export async function takeProjectIn(
  shopId: string,
  jobId: string,
  actorId: string,
): Promise<void> {
  const d = await db()
  const rows = await d.select<{ taken_in_at: string | null }[]>(
    'select taken_in_at from jobs where id = ? and shop_id = ?',
    [jobId, shopId],
  )
  if (!rows[0]) throw new Error('That project no longer exists.')
  if (rows[0].taken_in_at) return

  await d.execute(
    `update jobs set taken_in_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     where id = ? and shop_id = ?`,
    [jobId, shopId],
  )
  await d.execute(
    `insert into job_events (job_id, actor_id, kind, body)
     values (?, ?, 'taken_in', 'Taken in from a draft — now on the board at Intake.')`,
    [jobId, actorId],
  )
}

/**
 * Delete a project and everything recorded against it.
 *
 * Every child table declares `on delete cascade`, but SQLite only honours
 * that when the foreign_keys pragma is on, and a pragma is a property of a
 * connection rather than of the schema. Turning it on here costs one
 * statement and removes the possibility of a silent half-delete leaving
 * orphaned payments behind — which, in a tool whose whole subject is money,
 * would be worse than the delete failing outright.
 *
 * There is no soft-delete and no archive. A shop that wants to keep a
 * finished project keeps it; this is for the ones that should not have
 * existed. The screen asking for confirmation is where the warning lives,
 * because that is where the person is.
 */
export async function deleteProject(shopId: string, jobId: string): Promise<void> {
  const d = await db()
  await d.execute('pragma foreign_keys = ON')
  const res = await d.execute('delete from jobs where id = ? and shop_id = ?', [jobId, shopId])
  if (res.rowsAffected === 0) throw new Error('That project no longer exists.')
}

/* ---- the selling side ------------------------------------------------- */
/**
 * What the shop makes for itself and sells.
 *
 * Everything here reads the batch_stock view rather than summing sales in
 * JavaScript, for the same reason job_money and job_actuals are views: a
 * figure folded at read time cannot be stale, and there is no recalculate
 * button for somebody to forget to press.
 */

/** Where the shop sells. Archived channels stay, so old sales keep a name. */
export async function listChannels(shopId: string): Promise<ChannelRow[]> {
  const d = await db()
  return d.select<ChannelRow[]>(
    'select id, name, fee_pct, fee_flat, archived from channels where shop_id = ? order by archived, name',
    [shopId],
  )
}

export async function saveChannel(shopId: string, next: ChannelInput): Promise<ChannelRow> {
  const name = next.name.trim()
  if (!name) throw new Error('A place you sell needs a name.')
  if (next.feePct < 0 || next.feePct > 100) throw new Error('A fee is a percentage between 0 and 100.')
  if (next.feeFlat < 0) throw new Error('A flat fee cannot be negative.')

  const d = await db()
  const id = next.id ?? uuid()
  if (next.id) {
    await d.execute(
      'update channels set name = ?, fee_pct = ?, fee_flat = ?, archived = ? where id = ? and shop_id = ?',
      [name, next.feePct, next.feeFlat, next.archived ? 1 : 0, id, shopId],
    )
  } else {
    await d.execute(
      'insert into channels (id, shop_id, name, fee_pct, fee_flat, archived) values (?, ?, ?, ?, ?, ?)',
      [id, shopId, name, next.feePct, next.feeFlat, next.archived ? 1 : 0],
    )
  }
  const rows = await d.select<ChannelRow[]>(
    'select id, name, fee_pct, fee_flat, archived from channels where id = ?',
    [id],
  )
  return rows[0]
}

/**
 * Every product, with its batches and what each one has done.
 *
 * One query per table rather than a join, because a product has many
 * batches and a batch has many sales: joined, the rows multiply and the
 * money has to be de-duplicated in JavaScript, which is where money bugs
 * come from.
 */
export async function listShelf(shopId: string): Promise<ProductRow[]> {
  const d = await db()
  const [products, batches] = await Promise.all([
    d.select<
      {
        id: string
        name: string
        design_job_id: string | null
        design_cost: number | null
        design_hours: number | null
        archived: number
      }[]
    >(
      `select id, name, design_job_id, design_cost, design_hours, archived
       from products where shop_id = ? order by archived, name`,
      [shopId],
    ),
    d.select<
      (Omit<BatchRow, 'estimated'> & { product_id: string })[]
    >(
      `select s.batch_id as id, s.product_id, b.job_id, s.units_made, s.unit_cost,
              s.made_on, b.note, s.units_sold, s.units_left, s.revenue, s.fees,
              s.cost_of_sold
       from batch_stock s
       join batches b on b.id = s.batch_id
       where s.shop_id = ?
       order by s.made_on desc, b.created_at desc`,
      [shopId],
    ),
  ])

  return products.map((p) => ({
    ...p,
    batches: batches
      .filter((b) => b.product_id === p.id)
      .map((b) => ({ ...b, estimated: b.job_id === null })),
  }))
}

export async function saveProduct(shopId: string, next: ProductInput): Promise<string> {
  const name = next.name.trim()
  if (!name) throw new Error('A product needs a name.')

  const d = await db()
  const id = next.id ?? uuid()
  if (next.id) {
    await d.execute(
      `update products set name = ?, design_job_id = ?, design_cost = ?, design_hours = ?,
         archived = ? where id = ? and shop_id = ?`,
      [
        name,
        next.designJobId ?? null,
        next.designCost ?? null,
        next.designHours ?? null,
        next.archived ? 1 : 0,
        id,
        shopId,
      ],
    )
  } else {
    await d.execute(
      `insert into products (id, shop_id, name, design_job_id, design_cost, design_hours, archived)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        shopId,
        name,
        next.designJobId ?? null,
        next.designCost ?? null,
        next.designHours ?? null,
        next.archived ? 1 : 0,
      ],
    )
  }
  return id
}

/**
 * A run of units at a cost that never moves again.
 *
 * The cost is frozen here on purpose. A keychain made when filament was
 * $22/kg cost that, whatever a spool costs today, and recomputing it later
 * would rewrite what last month actually cost -- which this program refuses
 * everywhere else too.
 */
export async function saveBatch(shopId: string, next: BatchInput): Promise<string> {
  if (!Number.isFinite(next.unitsMade) || next.unitsMade < 1) {
    throw new Error('A batch is at least one unit.')
  }
  if (!Number.isFinite(next.unitCost) || next.unitCost < 0) {
    throw new Error('A unit cost cannot be negative.')
  }
  const d = await db()
  const id = next.id ?? uuid()
  if (next.id) {
    // Units made and the note can be corrected; the frozen cost and the job
    // behind it cannot, because those are what the figure means.
    const sold = await d.select<{ units_sold: number }[]>(
      'select units_sold from batch_stock where batch_id = ?',
      [id],
    )
    if (sold[0] && next.unitsMade < Number(sold[0].units_sold)) {
      throw new Error(
        `${sold[0].units_sold} of these have already sold, so the batch cannot be fewer than that.`,
      )
    }
    await d.execute('update batches set units_made = ?, note = ? where id = ? and shop_id = ?', [
      next.unitsMade,
      next.note ?? null,
      id,
      shopId,
    ])
  } else {
    await d.execute(
      `insert into batches (id, shop_id, product_id, job_id, units_made, unit_cost, made_on, note)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        shopId,
        next.productId,
        next.jobId ?? null,
        next.unitsMade,
        next.unitCost,
        next.madeOn,
        next.note ?? null,
      ],
    )
  }
  return id
}

export async function listSales(shopId: string, batchId?: string): Promise<SaleRow[]> {
  const d = await db()
  const where = batchId ? 'and s.batch_id = ?' : ''
  const params: unknown[] = batchId ? [shopId, batchId] : [shopId]
  return d.select<SaleRow[]>(
    `select s.id, s.batch_id, s.channel_id, c.name as channel_name, s.units,
            s.unit_price, s.fee_total, s.sold_on, s.note
     from sales s
     left join channels c on c.id = s.channel_id
     where s.shop_id = ? ${where}
     order by s.sold_on desc, s.created_at desc`,
    params,
  )
}

/**
 * Units leaving, at a price, through a place that takes a cut.
 *
 * The fee is worked out here and STORED, so changing a channel's fee next
 * year cannot rewrite what a sale actually netted -- the same rule that
 * keeps a quote's rates with the quote.
 */
export async function recordSale(shopId: string, next: SaleInput): Promise<string> {
  if (!Number.isFinite(next.units) || next.units < 1) throw new Error('A sale is at least one unit.')
  if (!Number.isFinite(next.unitPrice) || next.unitPrice < 0) {
    throw new Error('A price cannot be negative.')
  }

  const d = await db()
  const left = await d.select<{ units_left: number }[]>(
    'select units_left from batch_stock where batch_id = ? and shop_id = ?',
    [next.batchId, shopId],
  )
  if (!left[0]) throw new Error('That batch does not exist.')
  if (next.units > Number(left[0].units_left)) {
    throw new Error(
      `Only ${left[0].units_left} of those are left. Record another batch if you made more.`,
    )
  }

  const channels = next.channelId
    ? await d.select<ChannelRow[]>(
        'select id, name, fee_pct, fee_flat, archived from channels where id = ? and shop_id = ?',
        [next.channelId, shopId],
      )
    : []
  const channel = channels[0]
  const fee = channel
    ? feeFor(
        {
          id: channel.id,
          name: channel.name,
          feePct: Number(channel.fee_pct),
          feeFlat: Number(channel.fee_flat),
        },
        next.units,
        next.unitPrice,
      )
    : 0

  const id = next.id ?? uuid()
  await d.execute(
    `insert into sales (id, shop_id, batch_id, channel_id, units, unit_price, fee_total, sold_on, note)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopId,
      next.batchId,
      next.channelId,
      next.units,
      next.unitPrice,
      round2(fee),
      next.soldOn,
      next.note ?? null,
    ],
  )
  return id
}

/** A sale recorded wrongly is a typo, not history -- nothing was sent to
 *  anyone. Deleting puts the units back on the shelf. */
export async function deleteSale(shopId: string, saleId: string): Promise<void> {
  const d = await db()
  await d.execute('delete from sales where id = ? and shop_id = ?', [saleId, shopId])
}

/* ---- slicer imports ---------------------------------------------------- */

/**
 * Record what a sliced file said, and fill in the build sheet from it.
 *
 * Two things happen, and only the first is a fact:
 *
 *   - job_parts rows appear, one per object on the plate. Those are real.
 *   - slice_imports / slice_sections record the prediction. Those stay
 *     predictions until somebody logs an actual print_run by hand.
 *
 * Nothing here writes a print_run, which is the whole point -- job_actuals
 * sums print_runs with no filter on outcome, so a row there would put an
 * estimate into a project's real cost. See 0015_slice_imports.sql.
 *
 * A section whose label already exists on this job is MATCHED, not
 * duplicated: that is the fixed-file-for-reprint case, and the shop wants
 * the new estimate attached to the part it already has rather than a second
 * row with the same name. Matching is on the trimmed label, case-insensitive,
 * because "Hull A" and "hull a" out of two slicer sessions are one part.
 * The existing part's qty is deliberately NOT overwritten -- a re-slice of
 * one copy of a part the shop needs four of should not silently reduce the
 * build sheet.
 */
export async function importSlice(
  shopId: string,
  jobId: string,
  actorId: string,
  input: SliceImportInput,
): Promise<SliceImportResult> {
  if (!input.sections.length) throw new Error('That file had nothing on the plate.')
  const d = await db()

  // The same file again is not a second print, and not a second import.
  // Reported by CG: one file uploaded several times onto Maui. If the
  // earlier copy was imported before files were kept, keep this one's bytes.
  const prior = await d.select<
    { id: string; file_name: string; est_minutes: number | null; est_grams: number | null; imported_at: string; kept: number }[]
  >(
    `select i.id, i.file_name, i.est_minutes, i.est_grams, i.imported_at,
            (select count(*) from slice_files f where f.import_id = i.id) as kept
       from slice_imports i where i.job_id = ? and i.shop_id = ? order by i.imported_at`,
    [jobId, shopId],
  )
  const dup = prior.find((r) =>
    sameSliceFile(
      { fileName: r.file_name, estMinutes: r.est_minutes, estGrams: r.est_grams },
      input,
    ),
  )
  if (dup) {
    // Read again with a newer reader: keep what it now knows.
    if (input.progress?.length)
      await d.execute('update slice_imports set progress = coalesce(progress, ?) where id = ?', [encodeProgress(input.progress), dup.id])
    if (input.thumbnail || input.slicedAt)
      await d.execute('update slice_imports set thumbnail = coalesce(thumbnail, ?), sliced_at = coalesce(sliced_at, ?) where id = ?', [
        input.thumbnail ?? null,
        input.slicedAt ?? null,
        dup.id,
      ])
    if (input.file && Number(dup.kept) === 0) {
      await d.execute(
        `insert into slice_files (import_id, byte_size, stored_size, encoding, content)
         values (?, ?, ?, ?, ?)`,
        [dup.id, input.file.byteSize, input.file.storedSize, input.file.encoding, input.file.content],
      )
    }
    return { importId: dup.id, partsAdded: 0, partsMatched: 0, duplicateOf: dup.imported_at }
  }
  const importId = crypto.randomUUID()

  await d.execute(
    `insert into slice_imports
       (id, shop_id, job_id, file_name, kind, printer_model, printer_id,
        material_text, material_id, est_minutes, est_grams, notes, progress, thumbnail, sliced_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      importId,
      shopId,
      jobId,
      input.fileName,
      input.kind,
      input.printerModel,
      input.printerId,
      input.materialText,
      input.materialId,
      input.estMinutes,
      input.estGrams,
      JSON.stringify(input.notes ?? []),
      encodeProgress(input.progress),
      input.thumbnail ?? null,
      input.slicedAt ?? null,
    ],
  )

  // The bytes, when the caller kept them. A separate row so that every
  // ordinary read of slice_imports stays cheap. See 0020_slice_files.sql.
  if (input.file) {
    await d.execute(
      `insert into slice_files (import_id, byte_size, stored_size, encoding, content)
       values (?, ?, ?, ?, ?)`,
      [importId, input.file.byteSize, input.file.storedSize, input.file.encoding, input.file.content],
    )
  }

  const existing = await d.select<{ id: string; label: string }[]>(
    'select id, label from job_parts where job_id = ?',
    [jobId],
  )
  const byLabel = new Map(existing.map((r) => [r.label.trim().toLowerCase(), r.id]))
  const sortStart = await d.select<{ n: number }[]>(
    'select coalesce(max(sort), -1) + 1 as n from job_parts where job_id = ?',
    [jobId],
  )
  let sort = sortStart[0]?.n ?? 0

  let partsAdded = 0
  let partsMatched = 0

  for (const sec of input.sections) {
    const label = sec.label.trim()
    if (!label) continue
    const qty = Math.max(1, Math.floor(Number(sec.qty) || 1))
    const target = input.forPartId && input.sections.length === 1 ? input.forPartId : null
    const assign = sec.assign ?? null
    // Sorted by a person: an existing part of THIS project, or a new one.
    // Otherwise the old rule, matched by name.
    if (assign && 'partId' in assign && !existing.some((r) => r.id === assign.partId))
      throw new Error('That part is not on this project.')
    let partId =
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
      partId = crypto.randomUUID()
      await d.execute(
        `insert into job_parts (id, shop_id, job_id, label, qty, sort)
         values (?, ?, ?, ?, ?, ?)`,
        [partId, shopId, jobId, newLabel, qty, sort++],
      )
      await d.execute(
        `insert into part_events (part_id, job_id, kind, to_status, note, actor_id)
         values (?, ?, 'status', 'pending', ?, ?)`,
        [partId, jobId, `Imported from ${input.fileName}`, actorId],
      )
      byLabel.set(newLabel.toLowerCase(), partId)
      partsAdded++
    }

    const sectionId = crypto.randomUUID()
    await d.execute(
      `insert into slice_sections
         (id, import_id, part_id, label, qty, est_minutes, est_grams, material)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sectionId, importId, partId, label, qty, sec.estMinutes, sec.estGrams, sec.material],
    )
    // The replacement file is what the part is printed from now -- whether
    // it holds that part alone or the part among others on a re-sliced plate.
    if (input.forPartId && partId === input.forPartId) {
      await d.execute('update job_parts set chosen_section_id = ? where id = ? and shop_id = ?', [
        sectionId,
        input.forPartId,
        shopId,
      ])
    }
  }

  return { importId, partsAdded, partsMatched }
}

interface FamilySqlRow {
  job_id: string
  ref: string
  title: string
  phase: JobPhase
  kind: JobKind
  archived_at: string | null
  design_hours: number | null
}

function toRelated(r: FamilySqlRow): RelatedProject {
  return {
    jobId: r.job_id,
    ref: r.ref,
    title: r.title,
    phase: r.phase,
    kind: r.kind,
    designHours: Number(r.design_hours ?? 0),
    archivedAt: r.archived_at,
  }
}

/**
 * File a finished project off the working board, or put it back.
 *
 * Only a delivered project can go. The board is a list of what needs
 * attention and archiving is the act of saying this one no longer does --
 * doing that to a project still being built would hide live work, which is
 * the one thing a board must never do.
 *
 * Nothing is deleted and nothing stops counting. Voltage's rule, and the
 * reason it holds: a completed project is the system of record for what
 * the shop earned and what it cost, so it stays in the dashboard, in the
 * shop's own history, and in what a material has cost on average.
 */
export async function archiveProject(
  shopId: string,
  jobId: string,
  actorId: string,
  archived: boolean,
): Promise<void> {
  const d = await db()
  const rows = await d.select<{ phase: JobPhase; archived_at: string | null }[]>(
    'select phase, archived_at from jobs where id = ? and shop_id = ?',
    [jobId, shopId],
  )
  const job = rows[0]
  if (!job) throw new Error('That project no longer exists.')
  if (archived && job.phase !== 'delivered') {
    throw new Error('Only a finished project can be archived — this one is still live.')
  }
  if (!!job.archived_at === archived) return

  await d.execute(
    `update jobs set archived_at = ${archived ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'null'},
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [jobId, shopId],
  )
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'note', ?)`, [
    jobId,
    actorId,
    archived
      ? 'Archived — filed off the board. Every figure it contributes still counts.'
      : 'Unarchived — back on the board.',
  ])
}

/**
 * Put this project under another one -- or take it out, with null.
 *
 * PROGRAMS NEST. The first version flattened everything to one level: a
 * project linked under a follow-on was quietly re-pointed at the original.
 * That was the wrong call, and CG's first real use broke it: BathyTopo is a
 * master program, the Hawaiian Islands, Fiji and French Polynesia are
 * programs under it, and each of those holds its own prints. Flattening
 * would have dropped Fiji's prints straight into BathyTopo and lost the
 * middle layer that is the whole point.
 *
 * So the tree is kept as built, and the one thing that must never happen
 * is refused: a loop. Putting BathyTopo under Fiji while Fiji is under
 * BathyTopo would make "what is in this program" a question with no
 * answer, and every rollup would count forever. The walk up from the new
 * parent is bounded, so a loop that somehow already exists cannot hang it.
 *
 * Nothing is copied between members. Each project keeps its own runs,
 * material and hours; the program view ADDS them up for reading.
 */
export async function setRelatedProject(
  shopId: string,
  jobId: string,
  relatedTo: string | null,
): Promise<void> {
  const d = await db()
  if (relatedTo === jobId) throw new Error('A project cannot sit under itself.')

  if (relatedTo) {
    let cursor: string | null = relatedTo
    for (let hops = 0; cursor && hops < 64; hops++) {
      const rows: { id: string; related_to: string | null }[] = await d.select(
        'select id, related_to from jobs where id = ? and shop_id = ?',
        [cursor, shopId],
      )
      if (!rows[0]) throw new Error('That project no longer exists.')
      if (rows[0].related_to === jobId) {
        throw new Error(
          'That project is already inside this one — putting this under it would make a loop.',
        )
      }
      cursor = rows[0].related_to
    }
  }

  await d.execute(
    `update jobs set related_to = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [relatedTo, jobId, shopId],
  )
}

/** Every file imported against a project, newest first. */
export async function listSliceImports(
  shopId: string,
  jobId: string,
): Promise<SliceImportRow[]> {
  const d = await db()
  const heads = await d.select<
    {
      id: string
      file_name: string
      kind: SliceImportRow['kind']
      printer_model: string | null
      printer_id: string | null
      printer_name: string | null
      material_text: string | null
      material_id: string | null
      material_name: string | null
      est_minutes: number | null
      est_grams: number | null
      notes: string | null
      imported_at: string
      kept_bytes: number | null
      progress: string | null
      thumbnail: string | null
      sliced_at: string | null
    }[]
  >(
    `select i.id, i.file_name, i.kind, i.printer_model, i.printer_id, p.name as printer_name,
            i.material_text, i.material_id, m.name as material_name,
            i.est_minutes, i.est_grams, i.notes, i.imported_at, i.progress, i.thumbnail, i.sliced_at,
            (select byte_size from slice_files f where f.import_id = i.id) as kept_bytes
       from slice_imports i
       left join printers p on p.id = i.printer_id
       left join materials m on m.id = i.material_id
      where i.shop_id = ? and i.job_id = ?
      -- rowid breaks the tie, per the rule lib/rateCards.ts learned the hard
      -- way: imported_at is a text timestamp, dropping four sliced files at
      -- once writes them inside the same millisecond, and SQLite then returns
      -- the FIRST -- so the newest import would list as the oldest.
      order by i.imported_at desc, i.rowid desc`,
    [shopId, jobId],
  )
  if (!heads.length) return []

  const sections = await d.select<
    {
      id: string
      import_id: string
      part_id: string | null
      label: string
      qty: number
      est_minutes: number | null
      est_grams: number | null
      material: string | null
    }[]
  >(
    `select s.id, s.import_id, s.part_id, s.label, s.qty, s.est_minutes, s.est_grams, s.material
       from slice_sections s
       join slice_imports i on i.id = s.import_id
      where i.shop_id = ? and i.job_id = ?`,
    [shopId, jobId],
  )

  const byImport = new Map<string, SliceSectionRow[]>()
  for (const r of sections) {
    const list = byImport.get(r.import_id) ?? []
    list.push({
      id: r.id,
      partId: r.part_id,
      label: r.label,
      qty: Number(r.qty),
      estMinutes: r.est_minutes == null ? null : Number(r.est_minutes),
      estGrams: r.est_grams == null ? null : Number(r.est_grams),
      material: r.material,
    })
    byImport.set(r.import_id, list)
  }

  return heads.map((h) => ({
    id: h.id,
    fileName: h.file_name,
    kind: h.kind,
    printerModel: h.printer_model,
    printerId: h.printer_id,
    printerName: h.printer_name,
    materialText: h.material_text,
    materialId: h.material_id,
    materialName: h.material_name,
    estMinutes: h.est_minutes == null ? null : Number(h.est_minutes),
    estGrams: h.est_grams == null ? null : Number(h.est_grams),
    // Stored as JSON text, same as rates_snapshot. A bad parse must not take
    // the screen down over a advisory note.
    notes: parseNotes(h.notes),
    importedAt: h.imported_at,
    keptBytes: h.kept_bytes == null ? null : Number(h.kept_bytes),
    progress: decodeProgress(h.progress),
    thumbnail: h.thumbnail,
    slicedAt: h.sliced_at,
    sections: byImport.get(h.id) ?? [],
  }))
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

/** Forget an import. The build-sheet parts it created are left alone --
 *  they are the shop's now, not the file's. */
/**
 * The stored file, base64 of gzip, or null when Guma did not keep one.
 *
 * Its own call on purpose: this is the only read that moves the bytes, and
 * it happens when somebody asks for the file, not every time a screen
 * lists what was imported.
 */
export async function sliceFileContent(
  shopId: string,
  importId: string,
): Promise<{ content: string; byteSize: number } | null> {
  const d = await db()
  const rows = await d.select<{ content: string; byte_size: number }[]>(
    `select f.content, f.byte_size
       from slice_files f
       join slice_imports i on i.id = f.import_id
      where f.import_id = ? and i.shop_id = ?`,
    [importId, shopId],
  )
  const r = rows[0]
  return r ? { content: r.content, byteSize: Number(r.byte_size) } : null
}

export async function deleteSliceImport(shopId: string, importId: string): Promise<void> {
  const d = await db()
  await d.execute('delete from slice_imports where id = ? and shop_id = ?', [importId, shopId])
}

// ---------------------------------------------------------------------------
// Series (0026_series.sql)
// ---------------------------------------------------------------------------

export async function listSeries(shopId: string): Promise<SeriesRow[]> {
  const d = await db()
  const rows = await d.select<
    { id: string; name: string; brief: string | null; parent_id: string | null; created_at: string; archived_at: string | null }[]
  >('select id, name, brief, parent_id, created_at, archived_at from series where shop_id = ? order by name', [shopId])
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    brief: r.brief,
    parentId: r.parent_id,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  }))
}

/** Refuse a parent that is this series or sits inside it. */
async function checkSeriesParent(shopId: string, id: string | null, parentId: string | null) {
  if (!parentId) return
  if (parentId === id) throw new Error('A series cannot sit inside itself.')
  const d = await db()
  let cursor: string | null = parentId
  for (let hops = 0; cursor && hops < 64; hops++) {
    const rows: { parent_id: string | null }[] = await d.select(
      'select parent_id from series where id = ? and shop_id = ?',
      [cursor, shopId],
    )
    if (!rows.length) throw new Error('That series no longer exists.')
    if (id && rows[0].parent_id === id) {
      throw new Error('That series is already inside this one — that would make a loop.')
    }
    cursor = rows[0].parent_id
  }
}

export async function createSeries(
  shopId: string,
  input: { name: string; brief?: string | null; parentId?: string | null },
): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error('A series needs a name.')
  await checkSeriesParent(shopId, null, input.parentId ?? null)
  const id = crypto.randomUUID()
  const d = await db()
  await d.execute('insert into series (id, shop_id, name, brief, parent_id) values (?, ?, ?, ?, ?)', [
    id,
    shopId,
    name,
    input.brief?.trim() || null,
    input.parentId ?? null,
  ])
  return id
}

export async function updateSeries(shopId: string, id: string, input: SeriesInput): Promise<void> {
  const sets: string[] = []
  const args: unknown[] = []
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('A series needs a name.')
    sets.push('name = ?')
    args.push(name)
  }
  if (input.brief !== undefined) {
    sets.push('brief = ?')
    args.push(input.brief?.trim() || null)
  }
  if (input.parentId !== undefined) {
    await checkSeriesParent(shopId, id, input.parentId)
    sets.push('parent_id = ?')
    args.push(input.parentId)
  }
  if (input.archived !== undefined) {
    sets.push(input.archived ? "archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'archived_at = null')
  }
  if (!sets.length) return
  const d = await db()
  await d.execute(`update series set ${sets.join(', ')} where id = ? and shop_id = ?`, [...args, id, shopId])
}

/** File a project into a series, or take it out. Logged to Activity. */
export async function setJobSeries(
  shopId: string,
  jobId: string,
  seriesId: string | null,
  actorId: string | null = null,
): Promise<void> {
  const d = await db()
  const [job] = await d.select<{ series_id: string | null }[]>(
    'select series_id from jobs where id = ? and shop_id = ?',
    [jobId, shopId],
  )
  if (!job) throw new Error('That project is not in this shop.')
  if ((job.series_id ?? null) === seriesId) return
  const name = async (id: string | null) =>
    id
      ? ((await d.select<{ name: string }[]>('select name from series where id = ? and shop_id = ?', [id, shopId]))[0]
          ?.name ?? null)
      : null
  const to = await name(seriesId)
  if (seriesId && !to) throw new Error('That series no longer exists.')
  const from = await name(job.series_id)
  await d.execute(
    `update jobs set series_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ? and shop_id = ?`,
    [seriesId, jobId, shopId],
  )
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [
    jobId,
    actorId,
    to ? (from ? `Moved from the ${from} series to ${to}.` : `Filed in the ${to} series.`) : `Taken out of the ${from} series.`,
  ])
}

/** Every live hold in the shop, from the stock_held view. */
export async function listStockHolds(shopId: string): Promise<StockHoldRow[]> {
  const d = await db()
  const rows = await d.select<
    { job_id: string; ref: string; title: string; phase: JobPhase; material_id: string; held: number; used: number; remaining: number }[]
  >(
    `select job_id, ref, title, phase, material_id, held, used, remaining
       from stock_held where shop_id = ? order by ref`,
    [shopId],
  )
  return rows.map((r) => ({
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

/**
 * Replace what this project has set aside. An empty list releases it.
 * Replacing rather than adding is deliberate: the build sheet changes, and
 * a hold that only ever grew would hoard stock nobody is going to print.
 */
export async function setStockHolds(
  shopId: string,
  jobId: string,
  actorId: string | null,
  holds: StockHoldInput[],
): Promise<void> {
  const d = await db()
  const [job] = await d.select<{ id: string }[]>('select id from jobs where id = ? and shop_id = ?', [jobId, shopId])
  if (!job) throw new Error('That project is not in this shop.')
  const clean = holds.filter((h) => Number.isFinite(h.units) && h.units > 0)
  const mats = await d.select<{ id: string; name: string; unit: string }[]>(
    'select id, name, unit from materials where shop_id = ?',
    [shopId],
  )
  for (const h of clean) {
    if (!mats.some((m) => m.id === h.materialId)) throw new Error('That material is not in this shop.')
  }
  await d.execute('delete from stock_holds where job_id = ?', [jobId])
  for (const h of clean) {
    await d.execute(
      'insert into stock_holds (job_id, material_id, units, actor_id) values (?, ?, ?, ?)',
      [jobId, h.materialId, Math.ceil(h.units), actorId],
    )
  }
  const body = describeHolds(
    clean.map((h) => {
      const m = mats.find((x) => x.id === h.materialId)!
      return { name: m.name, unit: m.unit, units: Math.ceil(h.units) }
    }),
  )
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [
    jobId,
    actorId,
    body,
  ])
}

/** "2,4" -> [2, 4]. Null when the event named no copies. */
function parseCopies(v: string | null | undefined): number[] | null {
  if (!v) return null
  const out = v.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0)
  return out.length ? out : null
}

/**
 * Skip a failed copy: it will not be printed again, and the part needs one
 * fewer (CG, 8 Oct: "failed prints can have an immediate way to ...
 * skip"). The copy leaves the part; what it cost stays in the runs. A part
 * of one copy cannot skip its last -- remove the part instead.
 */
export async function skipCopy(
  shopId: string,
  partId: string,
  actorId: string | null,
  copy: number,
  note: string | null,
): Promise<void> {
  const d = await db()
  const before = await readCopies(shopId, partId)
  if (before.states.length <= 1) throw new Error('This is the only copy — remove the part instead of skipping it.')
  if (!Number.isInteger(copy) || copy < 0 || copy >= before.states.length) throw new Error(`There is no copy ${copy + 1}.`)
  const states = before.states.filter((_, i) => i !== copy)
  const c = countsOf(states)
  await d.execute(
    `update job_parts set qty = ?, copy_states = ?, printed_n = ?, passed_n = ?, reprint_n = ?, status = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id = ? and shop_id = ?`,
    [states.length, JSON.stringify(states), c.printed, c.passed, c.reprint, statusOf(c), partId, shopId],
  )
  await renumberPartEvents(partId, [copy])
  const body = `Copy ${copy + 1} skipped — not printed again; ${states.length} cop${states.length === 1 ? 'y' : 'ies'} now.${note?.trim() ? ` Why: ${note.trim()}` : ''}`
  await d.execute(
    `insert into part_events (part_id, job_id, kind, copies, note, actor_id) values (?, ?, 'note', ?, ?, ?)`,
    [partId, before.jobId, String(copy + 1), body, actorId],
  )
  await d.execute(`insert into job_events (job_id, actor_id, kind, body) values (?, ?, 'edit', ?)`, [before.jobId, actorId, body])
}


/* ---- what each print made (0039) --------------------------------------
 * One row per object off a print, carrying its share of the print's cost,
 * and where it went -- shelf, assembly, kept (CG, 21 Oct). lib/madeItems.ts
 * does the arithmetic; this keeps the rows.
 */

interface MadeSql {
  id: string
  job_id: string
  run_id: string | null
  section_id: string | null
  label: string
  grams: number | null
  unit_cost: number
  status: MadeStatus
  assembly_id: string | null
  batch_id: string | null
  note: string | null
  created_at: string
  placed_at: string | null
  printed_on: string | null
  file_name: string | null
}

const madeRow = (r: MadeSql): MadeItemRow => ({
  id: r.id,
  jobId: r.job_id,
  runId: r.run_id,
  sectionId: r.section_id,
  label: r.label,
  grams: r.grams == null ? null : Number(r.grams),
  unitCost: Number(r.unit_cost),
  status: r.status,
  assemblyId: r.assembly_id,
  batchId: r.batch_id,
  note: r.note,
  createdAt: r.created_at,
  placedAt: r.placed_at,
  printedOn: r.printed_on ? String(r.printed_on).slice(0, 10) : null,
  fileName: r.file_name,
})

export async function listMadeItems(shopId: string, jobId: string): Promise<MadeItemRow[]> {
  const d = await db()
  const rows = await d.select<MadeSql[]>(
    `select m.*, r.started_at as printed_on, i.file_name
       from made_items m
       left join print_runs r on r.id = m.run_id
       left join slice_sections s on s.id = m.section_id
       left join slice_imports i on i.id = s.import_id
      where m.shop_id = ? and m.job_id = ?
      order by coalesce(r.started_at, m.created_at) desc, r.rowid desc, m.rowid`,
    [shopId, jobId],
  )
  return rows.map(madeRow)
}

/**
 * Write what one print made. Recording again replaces what it made before,
 * unless any of that has been placed -- then it refuses, rather than leave
 * the shelf holding something the print no longer says it made.
 */
export async function recordMadeItems(shopId: string, jobId: string, runId: string, items: MadeItemInput[]): Promise<void> {
  validateMadeItems(items)
  const d = await db()
  const [run] = await d.select<{ job_id: string }[]>('select job_id from print_runs where id = ? and shop_id = ?', [runId, shopId])
  if (!run || run.job_id !== jobId) throw new Error('That print is not on this project.')
  const placed = await d.select<{ n: number }[]>(
    "select count(*) as n from made_items where run_id = ? and status in ('shelved', 'assembled', 'kept')",
    [runId],
  )
  if (Number(placed[0]?.n ?? 0) > 0) throw new Error('Some of what this print made is already placed — take it back first.')
  await d.execute('delete from made_items where run_id = ?', [runId])
  for (const it of items) {
    await d.execute(
      `insert into made_items (id, shop_id, job_id, run_id, section_id, label, grams, unit_cost, status, note)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), shopId, jobId, runId, it.sectionId, it.label.trim(), it.grams, it.unitCost, it.failed ? 'failed' : 'made', it.note ?? null],
    )
  }
}

async function itemsFor(shopId: string, ids: string[]): Promise<MadeSql[]> {
  if (!ids.length) return []
  const d = await db()
  return d.select<MadeSql[]>(
    `select m.*, null as printed_on, null as file_name from made_items m
      where m.shop_id = ? and m.id in (${ids.map(() => '?').join(',')})`,
    [shopId, ...ids],
  )
}

/**
 * Put items somewhere. The shelf takes them as one batch of a product at
 * their average cost (the batch's cost is frozen, like every batch); an
 * assembly takes them while it is open; kept means not for sale; back
 * returns them to "made" -- from an open assembly or from kept, never from
 * the shelf, where they may already have sold.
 */
export async function placeItems(shopId: string, jobId: string, ids: string[], to: ItemPlace): Promise<{ batchId?: string }> {
  const d = await db()
  const rows = await itemsFor(shopId, ids)
  if (rows.length !== ids.length || rows.some((r) => r.job_id !== jobId)) throw new Error('Those items are not all on this project.')
  if (!rows.length) return {}
  if (to.kind === 'back') {
    for (const r of rows) {
      if (r.status === 'shelved') throw new Error(`${r.label} is on the shelf and may have sold — it cannot come back from there.`)
      if (r.status === 'failed') throw new Error(`${r.label} failed; it stays a failure.`)
      if (r.assembly_id) {
        const [a] = await d.select<{ status: string }[]>('select status from assemblies where id = ?', [r.assembly_id])
        if (a?.status === 'done') throw new Error(`${r.label} is in a finished assembly.`)
      }
    }
    await d.execute(
      `update made_items set status = 'made', assembly_id = null, placed_at = null
        where shop_id = ? and id in (${ids.map(() => '?').join(',')})`,
      [shopId, ...ids],
    )
    return {}
  }
  const bad = rows.find((r) => r.status !== 'made')
  if (bad) throw new Error(`${bad.label} is ${bad.status === 'failed' ? 'a failed print' : 'already placed'}.`)
  const now = new Date().toISOString()
  if (to.kind === 'kept') {
    await d.execute(
      `update made_items set status = 'kept', placed_at = ? where shop_id = ? and id in (${ids.map(() => '?').join(',')})`,
      [now, shopId, ...ids],
    )
    return {}
  }
  if (to.kind === 'assembly') {
    const [a] = await d.select<{ job_id: string; status: string }[]>('select job_id, status from assemblies where id = ? and shop_id = ?', [to.assemblyId, shopId])
    if (!a || a.job_id !== jobId) throw new Error('That assembly is not on this project.')
    if (a.status !== 'open') throw new Error('That assembly is finished.')
    await d.execute(
      `update made_items set status = 'assembled', assembly_id = ?, placed_at = ?
        where shop_id = ? and id in (${ids.map(() => '?').join(',')})`,
      [to.assemblyId, now, shopId, ...ids],
    )
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
  await d.execute(
    `update made_items set status = 'shelved', batch_id = ?, placed_at = ?
      where shop_id = ? and id in (${ids.map(() => '?').join(',')})`,
    [batchId, now, shopId, ...ids],
  )
  return { batchId }
}

interface AssemblySql {
  id: string
  job_id: string
  name: string
  needs: string
  status: 'open' | 'done'
  batch_id: string | null
  created_at: string
  done_at: string | null
}
const assemblyRow = (r: AssemblySql): AssemblyRow => ({
  id: r.id,
  jobId: r.job_id,
  name: r.name,
  needs: parseNeedsText(r.needs),
  status: r.status,
  batchId: r.batch_id,
  createdAt: r.created_at,
  doneAt: r.done_at,
})

function parseNeedsText(t: string | null): { label: string; qty: number }[] {
  try {
    const v = JSON.parse(t || '[]')
    return Array.isArray(v) ? v.filter((x) => x && typeof x.label === 'string' && Number(x.qty) > 0).map((x) => ({ label: String(x.label), qty: Math.floor(Number(x.qty)) })) : []
  } catch {
    return []
  }
}

function cleanNeeds(needs: { label: string; qty: number }[]) {
  return needs
    .map((n) => ({ label: n.label.trim(), qty: Math.floor(Number(n.qty)) }))
    .filter((n) => n.label && n.qty > 0)
}

export async function listAssemblies(shopId: string, jobId: string): Promise<AssemblyRow[]> {
  const d = await db()
  const rows = await d.select<AssemblySql[]>(
    'select * from assemblies where shop_id = ? and job_id = ? order by status, created_at desc',
    [shopId, jobId],
  )
  return rows.map(assemblyRow)
}

export async function saveAssembly(shopId: string, jobId: string, next: AssemblyInput): Promise<string> {
  const name = next.name.trim()
  if (!name) throw new Error('An assembly needs a name.')
  const d = await db()
  const needs = JSON.stringify(cleanNeeds(next.needs))
  if (next.id) {
    const [a] = await d.select<{ status: string }[]>('select status from assemblies where id = ? and shop_id = ?', [next.id, shopId])
    if (!a) throw new Error('That assembly no longer exists.')
    await d.execute('update assemblies set name = ?, needs = ? where id = ? and shop_id = ?', [name, needs, next.id, shopId])
    return next.id
  }
  const id = uuid()
  await d.execute('insert into assemblies (id, shop_id, job_id, name, needs) values (?, ?, ?, ?, ?)', [id, shopId, jobId, name, needs])
  return id
}

/**
 * Finish an assembly: onto the shelf as ONE unit at the sum of what is in
 * it, or kept. Its items stay "assembled" -- they are in it.
 */
export async function finishAssembly(
  shopId: string,
  assemblyId: string,
  to: { kind: 'shelf'; productId: string | null; name?: string; madeOn: string } | { kind: 'kept' },
): Promise<{ batchId?: string }> {
  const d = await db()
  const [a] = await d.select<AssemblySql[]>('select * from assemblies where id = ? and shop_id = ?', [assemblyId, shopId])
  if (!a) throw new Error('That assembly no longer exists.')
  if (a.status === 'done') throw new Error('That assembly is already finished.')
  const items = await d.select<{ label: string; unit_cost: number }[]>(
    'select label, unit_cost from made_items where assembly_id = ?',
    [assemblyId],
  )
  if (!items.length) throw new Error('Nothing is in it yet.')
  let batchId: string | null = null
  if (to.kind === 'shelf') {
    const productId = to.productId ?? (await saveProduct(shopId, { name: to.name || a.name, designJobId: a.job_id }))
    batchId = await saveBatch(shopId, {
      productId,
      jobId: a.job_id,
      unitsMade: 1,
      unitCost: Math.round(items.reduce((t, i) => t + Number(i.unit_cost), 0) * 1e6) / 1e6,
      madeOn: to.madeOn,
      note: `${a.name}: ${shelfNote(items.map((i) => i.label))}`,
    })
  }
  await d.execute("update assemblies set status = 'done', batch_id = ?, done_at = ? where id = ?", [batchId, new Date().toISOString(), assemblyId])
  return batchId ? { batchId } : {}
}

/** An open assembly can go; what was in it goes back to "made". */
export async function deleteAssembly(shopId: string, assemblyId: string): Promise<void> {
  const d = await db()
  const [a] = await d.select<{ status: string }[]>('select status from assemblies where id = ? and shop_id = ?', [assemblyId, shopId])
  if (!a) return
  if (a.status === 'done') throw new Error('A finished assembly stays — it is on the shelf or kept.')
  await d.execute("update made_items set status = 'made', assembly_id = null, placed_at = null where assembly_id = ?", [assemblyId])
  await d.execute('delete from assemblies where id = ?', [assemblyId])
}


/**
 * Take a batch off the shelf -- one put there by mistake, or to start again
 * (CG, 22 Oct). Not once any of it has sold: remove those sales first, so
 * revenue never points at a batch that is gone. Pieces it came from go back
 * to "made" in their project, ready to place again; an assembly it came from
 * reopens with its pieces still in it.
 */
export async function deleteBatch(shopId: string, batchId: string): Promise<void> {
  const d = await db()
  const sold = await d.select<{ n: number }[]>('select count(*) as n from sales where batch_id = ?', [batchId])
  if (Number(sold[0]?.n ?? 0) > 0) throw new Error('Some of this batch has sold — remove those sales first.')
  await d.execute(
    "update made_items set status = 'made', batch_id = null, placed_at = null where batch_id = ? and shop_id = ?",
    [batchId, shopId],
  )
  await d.execute("update assemblies set status = 'open', batch_id = null, done_at = null where batch_id = ? and shop_id = ?", [
    batchId,
    shopId,
  ])
  await d.execute('delete from batches where id = ? and shop_id = ?', [batchId, shopId])
}

/** A product with nothing on the shelf can go entirely. */
export async function deleteProduct(shopId: string, productId: string): Promise<void> {
  const d = await db()
  const n = await d.select<{ n: number }[]>('select count(*) as n from batches where product_id = ?', [productId])
  if (Number(n[0]?.n ?? 0) > 0) throw new Error('Take its batches off the shelf first.')
  await d.execute('delete from products where id = ? and shop_id = ?', [productId, shopId])
}
