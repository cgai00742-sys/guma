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
import { flagsFor, gateStatus } from './gates'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
// Every migration file the app itself applies, in the same order Tauri's
// migration runner would -- not just 0001. A test that only ran the first
// file would silently drift from the real schema the moment a second one
// (like 0002_show_welcome.sql) shipped.
const MIGRATION_SQL = [
  '0001_initial.sql',
  '0002_show_welcome.sql',
  '0003_shop_state.sql',
  '0004_partners_gates.sql',
]
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

    // Both start in the phase every job is created in, at the priority
    // every job is created at — nothing sets either anywhere else yet.
    expect(rows[0].phase).toBe('intake')
    expect(rows[0].priority).toBe('medium')
  })

  it('moves a job through phases and logs each move, and updates priority', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const ref = await local.nextJobRef(shopId)
    const saved = await local.saveQuote({
      shopId,
      ref,
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

    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'design')
    let rows = await local.listJobs(shopId)
    expect(rows.find((r) => r.jobId === saved.jobId)?.phase).toBe('design')

    // A no-op move (same phase) must not throw and must not add a spurious
    // job_events row — see updateJobPhase's early return.
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'design')

    await local.updateJobPriority(shopId, saved.jobId, 'urgent')
    rows = await local.listJobs(shopId)
    expect(rows.find((r) => r.jobId === saved.jobId)?.priority).toBe('urgent')
  })

  /* ---------------------------------------------------------------- */
  /* Partners, gates and the project detail                            */
  /* ---------------------------------------------------------------- */

  /** Save one project and hand back the ids the detail tests need. */
  async function seedProject(
    local: typeof import('./data.local'),
    shopId: string,
    over: Partial<{ name: string; contact: string; title: string; neededBy: string | null }> = {},
  ) {
    const ctx = await local.loadShopContext()
    const ref = await local.nextJobRef(shopId)
    const saved = await local.saveQuote({
      shopId,
      ref,
      client: {
        name: over.name ?? 'Acme Co',
        contact: over.contact ?? 'Dana Reyes',
        email: '',
        phone: '',
        source: '',
      },
      job: {
        title: over.title ?? 'Mast brackets',
        brief: 'Four aluminium-look brackets for a rig, printed in PA-CF.',
        neededBy: over.neededBy === undefined ? '2026-09-30' : over.neededBy,
        assetOrigin: 'model',
      },
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
    return { ctx, saved }
  }

  it('loads a project detail with its client, quote, derived money and empty gates', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { saved } = await seedProject(local, shopId)

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.ref).toBe(saved.ref)
    expect(d.title).toBe('Mast brackets')
    expect(d.client.name).toBe('Acme Co')
    // clients.kind defaults to 'other' for every row that predates the column.
    expect(d.client.kind).toBe('other')
    expect(d.quote?.status).toBe('draft')
    expect(d.facts.neededBy).toBe('2026-09-30')
    // The point of contact falls back to the client's named contact.
    expect(d.facts.poc).toBe('Dana Reyes')
    // job_money exists but nothing is owed on a draft: no sent quote to owe against.
    expect(d.facts.depositOwed).toBe(0)
    expect(d.facts.balanceOwed).toBe(0)
    expect(d.gates).toEqual({})
    expect(d.events).toEqual([])
    // minimum_order comes off the live rate card, not a hard-coded zero.
    expect(d.facts.minimumOrder).toBe(85)
  })

  it('a project that has not been touched raises no flags but is missing gate items', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { saved } = await seedProject(local, shopId)
    const d = await local.loadProjectDetail(shopId, saved.jobId)

    // Fixed clock: a flag test that reads the real clock rots.
    const now = new Date('2026-09-02T00:00:00Z')
    expect(flagsFor(d.facts, now)).toEqual([])

    const g = gateStatus('intake', d.gates.intake ?? {}, d.facts)
    // brief, poc, needed_by and quote all clear from real data already;
    // "who owns the model" is the one a person still has to answer.
    expect(g.done).toBe(4)
    expect(g.total).toBe(5)
    expect(g.blocked).toBe(true)
    expect(g.items.find((i) => i.key === 'origin')!.checked).toBe(false)
  })

  it('records a gate tick, its note, and who ticked it — and upserts on a second write', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { ctx, saved } = await seedProject(local, shopId)

    await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'intake', 'origin', true, null)
    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.gates.intake.origin).toEqual({ checked: true, note: null })
    expect(gateStatus('intake', d.gates.intake, d.facts).blocked).toBe(false)

    // Same key again: an update, never a second row.
    await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'intake', 'origin', true, 'Client sent a STEP file')
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.gates.intake.origin.note).toBe('Client sent a STEP file')
    expect(Object.keys(d.gates.intake)).toHaveLength(1)

    // Unticking is a real write too, not a delete.
    await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'intake', 'origin', false, null)
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.gates.intake.origin.checked).toBe(false)
  })

  it('notes and phase changes land in one ordered activity log', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { ctx, saved } = await seedProject(local, shopId)

    await local.addProjectNote(saved.jobId, ctx.profile.id, '  Waiting on the client to confirm colour.  ')
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'design')

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.events).toHaveLength(2)
    const kinds = d.events.map((e) => e.kind)
    expect(kinds).toContain('note')
    expect(kinds).toContain('phase_change')
    const note = d.events.find((e) => e.kind === 'note')!
    expect(note.body).toBe('Waiting on the client to confirm colour.')
    expect(note.actorName).toBe('Owner')

    // An empty note is not an event.
    await local.addProjectNote(saved.jobId, ctx.profile.id, '   ')
    expect((await local.loadProjectDetail(shopId, saved.jobId)).events).toHaveLength(2)
  })

  it('updates only the project fields it is given, and coerces booleans for SQLite', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { saved } = await seedProject(local, shopId)

    await local.updateProjectFields(shopId, saved.jobId, { windowLocked: true, poc: 'Sam Iona' })
    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.facts.windowLocked).toBe(true)
    expect(d.facts.poc).toBe('Sam Iona')
    // Untouched keys stay untouched — this is not a whole-row replace.
    expect(d.facts.neededBy).toBe('2026-09-30')
    expect(d.facts.atRisk).toBe(false)

    await local.updateProjectFields(shopId, saved.jobId, {
      atRisk: true,
      deliveryOn: '2026-09-28',
      deliveryHow: 'Collected in person',
    })
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.facts.atRisk).toBe(true)
    expect(d.facts.windowLocked).toBe(true)
    expect(d.facts.deliveryOn).toBe('2026-09-28')

    // An empty patch is a no-op, not a crash and not an UPDATE with no SET.
    await expect(local.updateProjectFields(shopId, saved.jobId, {})).resolves.toBeUndefined()
  })

  it('flags a project that is overdue and past intake with nothing paid', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { ctx, saved } = await seedProject(local, shopId, { neededBy: '2026-08-01' })
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'building')

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    const keys = flagsFor(d.facts, new Date('2026-09-02T00:00:00Z')).map((f) => f.key)
    expect(keys).toContain('overdue')
    // The quote exists but was only ever saved as a draft — priced, never
    // agreed, and already on a machine. That is 'unagreed', not 'unquoted'.
    expect(keys).toContain('unagreed')
    expect(keys).not.toContain('unquoted')
  })

  it('rolls clients up from real projects, counting only sent and accepted quotes', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const q = priceQuote(MAST_BRACKETS, rates, ctx.materials[0], ctx.printers[0])

    // Acme: one draft (worth nothing yet) and one sent.
    await seedProject(local, shopId, { name: 'Acme Co', title: 'Draft one' })
    const sentRef = await local.nextJobRef(shopId)
    await local.saveQuote({
      shopId,
      ref: sentRef,
      client: { name: 'Acme Co', contact: 'Dana Reyes', email: '', phone: '', source: '' },
      job: { title: 'Sent one', brief: '', neededBy: null, assetOrigin: 'model' },
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
      send: {
        rates_snapshot: { rates },
        total: q.total,
        deposit_due: q.deposit,
        valid_until: '2026-10-01',
      },
    } satisfies SaveQuoteArgs)

    // A second, quieter client.
    await seedProject(local, shopId, { name: 'Bishop Trust', title: 'Museum mount' })

    const clients = await local.listClients(shopId)
    expect(clients.map((c) => c.name)).toEqual(['Acme Co', 'Bishop Trust'])

    const acme = clients.find((c) => c.name === 'Acme Co')!
    expect(acme.projects).toBe(2)
    expect(acme.active).toBe(2)
    // Only the sent quote counts toward what they are worth.
    expect(acme.value).toBe(q.total)
    // Sent but unpaid, so the whole total is still owed.
    expect(acme.owed).toBe(q.total)

    const bishop = clients.find((c) => c.name === 'Bishop Trust')!
    expect(bishop.projects).toBe(1)
    expect(bishop.value).toBe(0)
  })

  it('edits a client without touching the fields it was not given', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    await seedProject(local, shopId, { name: 'Bishop Trust' })

    const [before] = await local.listClients(shopId)
    await local.updateClientRecord(shopId, before.id, { kind: 'nonprofit' })

    const [after] = await local.listClients(shopId)
    expect(after.kind).toBe('nonprofit')
    expect(after.contact).toBe(before.contact)
    expect(after.name).toBe('Bishop Trust')

    // An unknown value in the column reads back as 'other' rather than
    // leaking a string no screen has a label for.
    await local.updateClientRecord(shopId, before.id, { kind: 'wholesaler' as never })
    expect((await local.listClients(shopId))[0].kind).toBe('other')
  })

  it('listJobs carries the same facts and gate answers the detail screen sees', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { ctx, saved } = await seedProject(local, shopId)
    await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'intake', 'origin', true, null)

    const [row] = await local.listJobs(shopId)
    const detail = await local.loadProjectDetail(shopId, saved.jobId)

    expect(row.facts).toEqual(detail.facts)
    expect(row.gateAnswers).toEqual(detail.gates.intake)
    expect(row.clientKind).toBe('other')
    expect(row.clientId).toBe(detail.client.id)

    // The board and the list therefore cannot disagree about a project.
    expect(gateStatus(row.phase, row.gateAnswers, row.facts).done).toBe(
      gateStatus(detail.phase, detail.gates.intake, detail.facts).done,
    )
  })

  it('a recorded payment moves every derived figure at once, and clears the flag', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const q = priceQuote(MAST_BRACKETS, rates, ctx.materials[0], ctx.printers[0])
    const ref = await local.nextJobRef(shopId)

    const saved = await local.saveQuote({
      shopId,
      ref,
      client: { name: 'Acme Co', contact: 'Dana Reyes', email: '', phone: '', source: '' },
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
      send: {
        rates_snapshot: { rates },
        total: q.total,
        deposit_due: q.deposit,
        valid_until: '2026-10-01',
      },
    } satisfies SaveQuoteArgs)

    // Sent and unpaid, already on a machine: the deposit flag must fire.
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'building')
    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.facts.depositDue).toBe(q.deposit)
    expect(d.facts.depositOwed).toBe(q.deposit)
    expect(d.payments).toEqual([])
    expect(flagsFor(d.facts, new Date('2026-09-02T00:00:00Z')).map((f) => f.key)).toContain('deposit')

    await local.recordPayment(shopId, saved.jobId, ctx.profile.id, {
      kind: 'deposit',
      amount: q.deposit,
      method: 'transfer',
      receivedOn: '2026-09-01',
      note: 'REF 8841',
      quoteId: saved.quoteId,
    })

    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.payments).toHaveLength(1)
    expect(d.payments[0].amount).toBe(q.deposit)
    expect(d.payments[0].recordedBy).toBe('Owner')
    // The whole point: nothing was "marked paid" — the view refolded.
    expect(d.facts.depositOwed).toBe(0)
    expect(d.facts.balanceOwed).toBe(Number((q.total - q.deposit).toFixed(2)))
    expect(flagsFor(d.facts, new Date('2026-09-02T00:00:00Z')).map((f) => f.key)).not.toContain(
      'deposit',
    )
    // ...and it shows up in the story of the project, not just the ledger.
    expect(d.events.some((e) => e.kind === 'payment')).toBe(true)

    // Paying the rest settles it, and the client ledger agrees.
    await local.recordPayment(shopId, saved.jobId, ctx.profile.id, {
      kind: 'balance',
      amount: q.total - q.deposit,
      method: 'cash',
      receivedOn: '2026-09-02',
      note: null,
      quoteId: saved.quoteId,
    })
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.facts.balanceOwed).toBe(0)
    expect((await local.listClients(shopId))[0].owed).toBe(0)
  })

  it('refuses a payment that is zero, negative or not a number', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { ctx, saved } = await seedProject(local, shopId)
    for (const amount of [0, -50, Number.NaN]) {
      await expect(
        local.recordPayment(shopId, saved.jobId, ctx.profile.id, {
          kind: 'deposit',
          amount,
          method: 'cash',
          receivedOn: '2026-09-01',
          note: null,
          quoteId: null,
        }),
      ).rejects.toThrow(/greater than zero/)
    }
    expect((await local.loadProjectDetail(shopId, saved.jobId)).payments).toEqual([])
  })

  it('a refund reverses a payment without editing history', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { ctx, saved } = await seedProject(local, shopId)

    await local.recordPayment(shopId, saved.jobId, ctx.profile.id, {
      kind: 'deposit',
      amount: 200,
      method: 'card',
      receivedOn: '2026-09-01',
      note: 'entered twice by mistake',
      quoteId: null,
    })
    await local.recordPayment(shopId, saved.jobId, ctx.profile.id, {
      kind: 'refund',
      amount: 200,
      method: 'card',
      receivedOn: '2026-09-02',
      note: 'correcting the duplicate above',
      quoteId: null,
    })

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    // Both rows survive. The ledger is a record, not a running total.
    expect(d.payments).toHaveLength(2)
    expect(d.payments.map((p) => p.kind).sort()).toEqual(['deposit', 'refund'])
  })

})
