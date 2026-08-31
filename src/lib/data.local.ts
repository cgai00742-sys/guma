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
} from './data'

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
}
export { toRateSet } from './data'

/** Thrown when the local database has no shop yet — the setup wizard's cue. */
export class NeedsSetup extends Error {
  constructor() {
    super('no shop yet')
    this.name = 'NeedsSetup'
  }
}

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
       email, phone, license_no, quote_valid_days, lead_days, electricity_rate_kwh)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const shops = await d.select<Shop[]>('select * from shops limit 1')
  const shop = shops[0]
  if (!shop) throw new NeedsSetup()

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
    d.select<PrinterRow[] & { archived: number }[]>(
      'select * from materials where shop_id = ? and archived = 0 order by name',
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
        costPerUnit: Number(m.cost_per_unit),
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
    `update shops set name = ?, legal_name = ?, address = ?, email = ?, phone = ?,
       license_no = ?, electricity_rate_kwh = ? where id = ?`,
    [
      next.name.trim() || 'My shop',
      next.legal_name.trim() || null,
      next.address.trim() || null,
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

  return {
    ...quote,
    jobs: job ? { ...job, clients: client } : null,
    shops: shop,
  }
}
