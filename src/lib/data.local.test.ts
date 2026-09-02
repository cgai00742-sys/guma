/// <reference types="node" />
/**
 * Parity check for the local (SQLite) backend, per the project board's
 * p4-parity task: "Same 28 pricing tests, now run against local data. A
 * worked quote priced identically in both versions."
 *
 * Everything about data.local.ts had been verified up to this point except
 * the one thing that actually matters: does its SQL run? The schema was
 * checked with a real sqlite3 binary (src-tauri/migrations/0001_initial.sql
 * applies cleanly), and the dispatcher's routing was checked with mocked
 * backends (data.test.ts) — but no query in data.local.ts had ever been
 * executed against a real database. Column-name typos, wrong bind-parameter
 * order, or a JSON round-trip bug would all have sailed through both of
 * those checks.
 *
 * This test closes that gap using node:sqlite (built into Node 22+) as a
 * stand-in for the real @tauri-apps/plugin-sql connection — same SQLite
 * engine, same `?` bind-parameter placeholders, so every statement in
 * data.local.ts runs for real, against the real schema, with real values.
 * It reruns the exact worked example from pricing.test.ts (the Quote PDF
 * design file's numbers) end to end: setupShop -> loadShopContext ->
 * priceQuote -> saveQuote -> loadQuoteForPrint, and checks the total still
 * comes out to $1,063.23 after a full round trip through SQLite and back.
 *
 * What this does NOT cover: the real @tauri-apps/plugin-sql <-> Rust IPC
 * bridge, or anything about the actual app window. That still needs a real
 * Tauri run on a real machine — see the project board.
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { priceQuote, round2, type RateSet } from './pricing'
import type { SaveQuoteArgs, SetupPayload } from './data.types'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
// Every migration file the app itself applies, in the same order Tauri's
// migration runner would -- not just 0001. A test that only ran the first
// file would silently drift from the real schema the moment a second one
// (like 0002_show_welcome.sql) shipped.
const MIGRATION_SQL = ['0001_initial.sql', '0002_show_welcome.sql', '0003_shop_state.sql']
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n')

// A fresh in-memory SQLite database per test, wrapped in the same
// execute()/select() shape @tauri-apps/plugin-sql's Database exposes (see
// its .d.ts: execute(sql, params) => Promise<QueryResult>, select(sql,
// params) => Promise<T>). data.local.ts only reads rowsAffected/lastInsertId
// off execute()'s result when it doesn't already re-select the row, which
// it always does here, so a minimal result is enough.
function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION_SQL)
  return {
    path: 'sqlite:guma.db',
    async execute(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...(params as never[]))
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...(params as never[]))
    },
  }
}

let currentDb: ReturnType<typeof freshDb>

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => currentDb },
}))

beforeEach(() => {
  currentDb = freshDb()
  vi.resetModules()
})

// The exact rates, material, printer and job from the Quote PDF worked
// example in pricing.test.ts — reproduced here (not imported) because that
// file doesn't export its fixtures, and duplicating them keeps this test
// readable as its own worked example rather than a hidden coupling to
// another file's internals.
const SHOP_INPUT = {
  name: 'Test Shop',
  currency: 'USD',
  locale: 'en-US',
  tax_label: 'Sales tax',
  tax_pct: 5,
  electricity_rate_kwh: null,
}
const RATES_INPUT = {
  design_hourly: 85,
  finishing_hourly: 55,
  rush_pct: 35,
  minimum_order: 85,
  deposit_pct: 50,
  deposit_when: 'design',
  deposit_waive_below: 150,
  material_markup: 2,
  revisions_incl: 2,
  revision_hourly: 85,
}
const PRINTER_INPUT = {
  name: 'Tasa 1',
  model: 'Prusa XL 2T',
  tech: 'fdm',
  rate_hourly: 9,
  wear_hourly: 3,
  watts: null,
}
const MATERIAL_INPUT = {
  name: 'PA-CF black',
  kind: 'filament',
  swatch: '#2A3442',
  unit: 'g',
  cost_per_unit: 0.095, // $95/kg
}
const MAST_BRACKETS = {
  assetOrigin: 'model' as const,
  designBilling: 'hourly' as const,
  designQty: 6,
  revisions: 2,
  quantity: 4,
  unitsPerPart: 185,
  printHrsPerPart: 5.25,
  finishingHrs: 2,
  rush: false,
  flatEach: 0,
  discountPct: 0,
}

const SETUP_PAYLOAD: SetupPayload = {
  shop: SHOP_INPUT,
  rates: RATES_INPUT,
  printer: PRINTER_INPUT,
  materials: [MATERIAL_INPUT],
  fullName: 'Owner',
}

describe('data.local.ts against a real SQLite database', () => {
  it('prices the Quote PDF worked example identically after a full setup + load round trip', async () => {
    const local = await import('./data.local')

    const shopId = await local.setupShop(SETUP_PAYLOAD)
    expect(shopId).toBeTruthy()

    const ctx = await local.loadShopContext()
    expect(ctx.shop.name).toBe('Test Shop')
    expect(ctx.materials).toHaveLength(1)
    expect(ctx.printers).toHaveLength(1)

    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const material = ctx.materials[0]
    const printer = ctx.printers[0]
    const q = priceQuote(MAST_BRACKETS, rates, material, printer)

    // Same figures as "the Quote PDF worked example" in pricing.test.ts —
    // now computed from rows that made a full trip through SQLite.
    expect(round2(q.designAmt)).toBe(510.0)
    expect(round2(q.materialSell)).toBe(140.6)
    expect(round2(q.machineAmt)).toBe(189.0)
    expect(round2(q.wearAmt)).toBe(63.0)
    expect(round2(q.finishingAmt)).toBe(110.0)
    expect(round2(q.subtotal)).toBe(1012.6)
    expect(round2(q.tax)).toBe(50.63)
    expect(round2(q.total)).toBe(1063.23)
    expect(q.deposit).toBe(531.62)
    expect(q.balance).toBe(531.61)
  })

  it('assigns sequential job refs per year', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)

    const first = await local.nextJobRef(shopId)
    expect(first).toMatch(/^GUMA-\d{4}-0001$/)

    // nextJobRef only reads existing rows — it doesn't reserve one, so
    // simulate a job actually having been written before asking again.
    const ctx = await local.loadShopContext()
    await local.saveQuote({
      shopId,
      ref: first,
      client: { name: 'Acme Co', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly',
        design_qty: 6,
        revisions_incl: 2,
        quantity: 4,
        material_id: ctx.materials[0].id,
        printer_id: ctx.printers[0].id,
        units_per_part: 185,
        print_hrs_part: 5.25,
        finishing_hrs: 2,
        rush: false,
        flat_each: 0,
        discount_pct: 0,
      },
    } satisfies SaveQuoteArgs)

    const second = await local.nextJobRef(shopId)
    expect(second).toMatch(/^GUMA-\d{4}-0002$/)
  })

  it('freezes the rate snapshot on send, and loadQuoteForPrint reprices identically from it', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const material = ctx.materials[0]
    const printer = ctx.printers[0]
    const q = priceQuote(MAST_BRACKETS, rates, material, printer)
    const ref = await local.nextJobRef(shopId)

    const saved = await local.saveQuote({
      shopId,
      ref,
      client: { name: 'Acme Co', contact: 'Jules', email: 'jules@acme.test', phone: '', source: 'referral' },
      job: { title: 'Mast brackets', brief: 'Four brackets', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly',
        design_qty: MAST_BRACKETS.designQty,
        revisions_incl: MAST_BRACKETS.revisions,
        quantity: MAST_BRACKETS.quantity,
        material_id: material.id,
        printer_id: printer.id,
        units_per_part: MAST_BRACKETS.unitsPerPart,
        print_hrs_part: MAST_BRACKETS.printHrsPerPart,
        finishing_hrs: MAST_BRACKETS.finishingHrs,
        rush: MAST_BRACKETS.rush,
        flat_each: MAST_BRACKETS.flatEach,
        discount_pct: MAST_BRACKETS.discountPct,
      },
      send: {
        rates_snapshot: rates,
        total: q.total,
        deposit_due: q.deposit,
        valid_until: '2026-12-31',
      },
    })

    expect(saved.ref).toBe(ref)

    // loadQuoteForPrint's return type only names the two joined relations
    // (jobs, shops) — the columns spread in from the quotes row itself (via
    // `...quote`, itself a Record<string, unknown> from the raw select)
    // aren't individually named in the inferred type, same as they wouldn't
    // be for the real Tauri-backed row. Cast once here rather than widen
    // the function's real return type just for this test's sake.
    const printed = (await local.loadQuoteForPrint(saved.quoteId)) as unknown as {
      total: number
      deposit_due: number
      rates_snapshot: RateSet
      jobs: { clients: { name: string } }
      shops: { name: string }
    }
    expect(printed.total).toBe(q.total)
    expect(printed.deposit_due).toBe(q.deposit)
    // SQLite has no jsonb, so rates_snapshot is stored as a TEXT column
    // holding a JSON string — but loadQuoteForPrint parses it back to an
    // object before returning, the same shape QuoteDoc.tsx's
    // `snap.rates`/`snap.material` reads expect and the same shape
    // PostgREST hands back for the hosted backend's jsonb column. An
    // earlier version of this test asserted the opposite — that
    // rates_snapshot came back as a raw string the caller had to
    // JSON.parse itself — which is exactly the bug that made the desktop
    // quote/PDF view render blank: this test passed while the real
    // consumer crashed, because the test was parsing what the app forgot
    // to.
    const reprised = priceQuote(MAST_BRACKETS, printed.rates_snapshot, material, printer)
    expect(round2(reprised.total)).toBe(round2(q.total))
    expect(printed.jobs.clients.name).toBe('Acme Co')
    expect(printed.shops.name).toBe('Test Shop')
  })

  it('lists saved jobs newest first, with draft and sent quotes both showing', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const material = ctx.materials[0]
    const printer = ctx.printers[0]
    const q = priceQuote(MAST_BRACKETS, rates, material, printer)

    const quoteArgs = (ref: string) =>
      ({
        shopId,
        ref,
        client: { name: 'Acme Co', contact: '', email: '', phone: '', source: '' },
        job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' as const },
        quote: {
          design_billing: 'hourly' as const,
          design_qty: MAST_BRACKETS.designQty,
          revisions_incl: MAST_BRACKETS.revisions,
          quantity: MAST_BRACKETS.quantity,
          material_id: material.id,
          printer_id: printer.id,
          units_per_part: MAST_BRACKETS.unitsPerPart,
          print_hrs_part: MAST_BRACKETS.printHrsPerPart,
          finishing_hrs: MAST_BRACKETS.finishingHrs,
          rush: MAST_BRACKETS.rush,
          flat_each: MAST_BRACKETS.flatEach,
          discount_pct: MAST_BRACKETS.discountPct,
        },
      }) satisfies SaveQuoteArgs

    const draftRef = await local.nextJobRef(shopId)
    const draft = await local.saveQuote(quoteArgs(draftRef))

    const sentRef = await local.nextJobRef(shopId)
    const sent = await local.saveQuote({
      ...quoteArgs(sentRef),
      send: {
        rates_snapshot: rates,
        total: q.total,
        deposit_due: q.deposit,
        valid_until: '2026-12-31',
      },
    })

    const rows = await local.listJobs(shopId)
    expect(rows).toHaveLength(2)

    // newest first — the sent job was saved second
    expect(rows[0].jobId).toBe(sent.jobId)
    expect(rows[0].quoteStatus).toBe('sent')
    expect(rows[0].total).toBe(q.total)
    expect(rows[0].quoteId).toBe(sent.quoteId)

    expect(rows[1].jobId).toBe(draft.jobId)
    expect(rows[1].quoteStatus).toBe('draft')
    expect(rows[1].total).toBeNull()
    expect(rows[1].clientName).toBe('Acme Co')
  })
})
