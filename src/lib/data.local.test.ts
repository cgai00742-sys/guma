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
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { priceQuote, round2, type RateSet } from './pricing'
import type { SaveQuoteArgs, SetupPayload } from './data.types'
import { flagsFor, gateStatus } from './gates'
import type { GateAnswer } from './data.types'

/** Stored gate answers, for asserting that an automatic item ignores them. */
const ticked = (...keys: string[]): Record<string, GateAnswer> =>
  Object.fromEntries(keys.map((k) => [k, { checked: true, note: 'done' } as GateAnswer]))

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
// Every migration file the app itself applies, in the same order Tauri's
// migration runner would -- read from the directory rather than listed
// here, because a hardcoded list is a list somebody forgets to add to. It
// was forgotten twice before this comment existed, and both times the
// failure was a wall of "no such column" rather than anything that named
// the real problem.
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
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


  /* ---------------------------------------------------------------- */
  /* Materials: what the shop actually paid                            */
  /* ---------------------------------------------------------------- */

  it('costs a material at the typed figure until a purchase is logged', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)

    const [m] = await local.listMaterials(shopId)
    expect(m.name).toBe('PA-CF black')
    expect(m.costPerUnit).toBe(0.095)
    expect(m.avgCostPerUnit).toBe(0.095)
    expect(m.costBasis).toBe('estimate')
    expect(m.purchases).toBe(0)

    // ...and that is what a quote prices against.
    const ctx = await local.loadShopContext()
    expect(ctx.materials[0].costPerUnit).toBe(0.095)
    expect(ctx.materials[0].costBasis).toBe('estimate')
  })

  it('weights the cost across every purchase, and says so', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx0 = await local.loadShopContext()
    const materialId = ctx0.materials[0].id

    // A 1 kg spool at 24, then 3 kg at 60. Weighted: 84 / 4000 = 0.021,
    // which is neither of the two prices and neither is their plain mean.
    await local.recordMaterialPurchase(shopId, materialId, ctx0.profile.id, {
      purchasedOn: '2026-01-10',
      qty: 1000,
      totalCost: 24,
      supplier: 'Filament Co',
      note: null,
    })
    await local.recordMaterialPurchase(shopId, materialId, ctx0.profile.id, {
      purchasedOn: '2026-06-01',
      qty: 3000,
      totalCost: 60,
      supplier: 'Filament Co',
      note: 'box of three',
    })

    const [m] = await local.listMaterials(shopId)
    expect(m.avgCostPerUnit).toBeCloseTo(0.021, 10)
    expect(m.avgCostPerUnit).not.toBe((0.024 + 0.02) / 2)
    expect(m.costBasis).toBe('purchases')
    expect(m.purchases).toBe(2)
    expect(m.purchasedQty).toBe(4000)
    expect(m.purchasedSpend).toBe(84)
    expect(m.lastCostPerUnit).toBeCloseTo(0.02, 10)
    expect(m.lastPurchasedOn).toBe('2026-06-01')
    // The typed figure survives as the comparison, not overwritten.
    expect(m.costPerUnit).toBe(0.095)

    // Purchases put material on the shelf.
    expect(m.onHand).toBe(4000)

    // And the quote now prices against the measurement, not the guess.
    const ctx = await local.loadShopContext()
    expect(ctx.materials[0].costPerUnit).toBeCloseTo(0.021, 10)
    expect(ctx.materials[0].costBasis).toBe('purchases')
  })

  it('a purchase changes the material cost on a quote, and the shop is cheaper than it thought', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const before = await local.loadShopContext()
    const guessed = priceQuote(
      MAST_BRACKETS,
      local.toRateSet(before.rateCard, before.shop),
      before.materials[0],
      before.printers[0],
    )
    expect(round2(guessed.materialSell)).toBe(140.6)

    await local.recordMaterialPurchase(shopId, before.materials[0].id, before.profile.id, {
      purchasedOn: '2026-01-10',
      qty: 1000,
      totalCost: 24,
      supplier: null,
      note: null,
    })

    const after = await local.loadShopContext()
    const real = priceQuote(
      MAST_BRACKETS,
      local.toRateSet(after.rateCard, after.shop),
      after.materials[0],
      after.printers[0],
    )
    // 740 g at 0.024 x 2 markup = 35.52, against 140.60 on the setup guess
    // of 0.095/g. The shop had been quoting nearly four times its real
    // filament cost -- which is exactly the kind of thing a purchase log
    // exists to find.
    expect(round2(real.materialSell)).toBe(35.52)
    expect(real.total).toBeLessThan(guessed.total)
  })

  it('refuses a purchase with no quantity, and one with a negative cost', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const id = ctx.materials[0].id
    const base = { purchasedOn: '2026-01-10', supplier: null, note: null }

    await expect(
      local.recordMaterialPurchase(shopId, id, ctx.profile.id, { ...base, qty: 0, totalCost: 24 }),
    ).rejects.toThrow(/greater than zero/)
    await expect(
      local.recordMaterialPurchase(shopId, id, ctx.profile.id, { ...base, qty: 1000, totalCost: -5 }),
    ).rejects.toThrow(/zero or more/)
    expect(await local.listMaterialPurchases(shopId, id)).toEqual([])
    // A zero-quantity purchase would have divided the weighted average by
    // nothing, so this guard is load-bearing, not decorative.
    expect((await local.listMaterials(shopId))[0].costBasis).toBe('estimate')
  })

  it('deleting a purchase reverses both the average and the stock', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const id = ctx.materials[0].id

    const first = await local.recordMaterialPurchase(shopId, id, ctx.profile.id, {
      purchasedOn: '2026-01-10',
      qty: 1000,
      totalCost: 24,
      supplier: null,
      note: null,
    })
    await local.recordMaterialPurchase(shopId, id, ctx.profile.id, {
      purchasedOn: '2026-06-01',
      qty: 3000,
      totalCost: 60,
      supplier: null,
      note: null,
    })
    expect((await local.listMaterialPurchases(shopId, id))).toHaveLength(2)

    await local.deleteMaterialPurchase(shopId, first)
    const [m] = await local.listMaterials(shopId)
    expect(m.purchases).toBe(1)
    expect(m.avgCostPerUnit).toBeCloseTo(0.02, 10)
    expect(m.onHand).toBe(3000)

    // Delete the last one and the typed figure takes over again.
    const [remaining] = await local.listMaterialPurchases(shopId, id)
    await local.deleteMaterialPurchase(shopId, remaining.id)
    const [back] = await local.listMaterials(shopId)
    expect(back.costBasis).toBe('estimate')
    expect(back.avgCostPerUnit).toBe(0.095)
    expect(back.onHand).toBe(0)
  })

  it('creates and edits materials, and keeps archived ones visible on the materials screen', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)

    const created = await local.saveMaterial(shopId, {
      name: 'PETG clear',
      kind: 'filament',
      swatch: '#88CCEE',
      unit: 'g',
      costPerUnit: 0.028,
      sellOverride: null,
      onHand: 0,
      reorderAt: 500,
    })
    expect(created.id).toBeTruthy()
    expect(created.costBasis).toBe('estimate')

    await local.saveMaterial(shopId, { ...created, name: 'PETG clear (v2)', archived: true })
    const all = await local.listMaterials(shopId)
    // Archived rows still listed here -- this is where you go to un-archive.
    expect(all.map((m) => m.name)).toContain('PETG clear (v2)')
    expect(all.find((m) => m.name === 'PETG clear (v2)')!.archived).toBe(true)
    // ...but the pricing context leaves them out.
    const ctx = await local.loadShopContext()
    expect(ctx.materials.map((m) => m.name)).not.toContain('PETG clear (v2)')

    await expect(
      local.saveMaterial(shopId, { ...created, name: '   ' }),
    ).rejects.toThrow(/needs a name/)
  })

  /* ---------------------------------------------------------------- */
  /* What a project actually took                                      */
  /* ---------------------------------------------------------------- */

  it('a recorded run draws material off the shelf, failures included', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)

    await local.recordMaterialPurchase(shopId, ctx.materials[0].id, ctx.profile.id, {
      purchasedOn: '2026-01-10',
      qty: 2000,
      totalCost: 48,
      supplier: null,
      note: null,
    })
    expect((await local.listMaterials(shopId))[0].onHand).toBe(2000)

    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 740,
      hours: 21,
      outcome: 'success',
      failureReason: null,
      note: null,
      startedAt: '2026-02-01T09:00:00Z',
    })
    // A failed plate burned the same grams as a good one. Counting it is
    // the entire point.
    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 185,
      hours: 5.25,
      outcome: 'failed',
      failureReason: 'warped off the plate',
      note: null,
      startedAt: '2026-02-03T09:00:00Z',
    })

    expect((await local.listMaterials(shopId))[0].onHand).toBe(2000 - 925)

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.actuals.materialUnits).toBe(925)
    expect(d.actuals.failedUnits).toBe(185)
    expect(d.actuals.runs).toBe(2)
    expect(d.actuals.failedRuns).toBe(1)
    expect(d.actuals.machineHours).toBeCloseTo(26.25, 10)
    // 925 g at the purchased 0.024/g.
    expect(d.actuals.materialCost).toBeCloseTo(22.2, 6)
    // 26.25 h x $9 machine, x $3 wear.
    expect(d.actuals.machineCost).toBeCloseTo(236.25, 6)
    expect(d.actuals.wearCost).toBeCloseTo(78.75, 6)
    // No wattage on the seeded printer, so there is no honest power figure.
    expect(d.actuals.powerCost).toBe(0)
    expect(d.runs).toHaveLength(2)
    expect(d.runs[0].printerName).toBe('Tasa 1')
    // Runs show up in the project's story, not just its ledger.
    expect(d.events.some((e) => e.kind === 'run')).toBe(true)

    // Deleting a run puts its material back.
    await local.deletePrintRun(shopId, d.runs[0].id)
    expect((await local.listMaterials(shopId))[0].onHand).toBeGreaterThan(2000 - 925)
  })

  it('refuses a run that used nothing, and negative figures', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)
    const base = {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      outcome: 'success' as const,
      failureReason: null,
      note: null,
      startedAt: null,
    }
    await expect(
      local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, { ...base, unitsUsed: 0, hours: 0 }),
    ).rejects.toThrow(/is not a run/)
    await expect(
      local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, { ...base, unitsUsed: -5, hours: 2 }),
    ).rejects.toThrow(/cannot be negative/)
    // A run that died on layer one used material and no time. Still a run.
    await expect(
      local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, { ...base, unitsUsed: 12, hours: 0 }),
    ).resolves.toBeTruthy()
  })

  it('logs hours by kind, and refuses a day that will not fit in a day', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)

    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'design',
      hours: 6.5,
      workedOn: '2026-01-20',
      note: 'CAD and a test print',
    })
    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'design',
      hours: 4.5,
      workedOn: '2026-01-21',
      note: 'client changed the mount',
    })
    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'finishing',
      hours: 3,
      workedOn: '2026-02-05',
      note: null,
    })

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.actuals.designHours).toBe(11)
    expect(d.actuals.finishingHours).toBe(3)
    expect(d.actuals.adminHours).toBe(0)
    expect(d.work).toHaveLength(3)
    expect(d.work[0].actor).toBe('Owner')

    await expect(
      local.logWork(shopId, saved.jobId, ctx.profile.id, {
        kind: 'design',
        hours: 0,
        workedOn: '2026-01-20',
        note: null,
      }),
    ).rejects.toThrow(/more than zero/)
    await expect(
      local.logWork(shopId, saved.jobId, ctx.profile.id, {
        kind: 'design',
        hours: 30,
        workedOn: '2026-01-20',
        note: null,
      }),
    ).rejects.toThrow(/24 hours/)

    await local.deleteWorkEntry(shopId, d.work[0].id)
    expect((await local.loadProjectDetail(shopId, saved.jobId)).work).toHaveLength(2)
  })

  it('compares the frozen quote against what the job really cost', async () => {
    const local = await import('./data.local')
    const { compareToQuote } = await import('./actuals')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const q = priceQuote(MAST_BRACKETS, rates, ctx.materials[0], ctx.printers[0])
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
      send: {
        rates_snapshot: { rates },
        total: q.total,
        deposit_due: q.deposit,
        valid_until: '2026-10-01',
      },
    } satisfies SaveQuoteArgs)

    // Nothing recorded yet: every line reads "not recorded", not zero.
    let d = await local.loadProjectDetail(shopId, saved.jobId)
    let cmp = compareToQuote(q, d.actuals, rates)
    expect(cmp.hasActuals).toBe(false)
    expect(cmp.actualCost).toBeNull()
    expect(cmp.actualMargin).toBeNull()
    expect(cmp.lines.every((l) => l.actual === null)).toBe(true)
    // The quote's own inputs came back so the page can reprice it.
    expect(d.quoteInputs?.quantity).toBe(4)
    expect(d.quoteInputs?.designQty).toBe(6)
    expect(d.quoteInputs?.ratesSnapshot).not.toBeNull()

    // The job ran long: 11 design hours against 6 quoted, one failed plate.
    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 740,
      hours: 21,
      outcome: 'success',
      failureReason: null,
      note: null,
      startedAt: null,
    })
    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 185,
      hours: 5.25,
      outcome: 'failed',
      failureReason: 'warped',
      note: null,
      startedAt: null,
    })
    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'design',
      hours: 11,
      workedOn: '2026-01-20',
      note: null,
    })
    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'finishing',
      hours: 3,
      workedOn: '2026-02-05',
      note: null,
    })

    d = await local.loadProjectDetail(shopId, saved.jobId)
    cmp = compareToQuote(q, d.actuals, rates)
    expect(cmp.hasActuals).toBe(true)
    expect(cmp.partial).toBe(false)

    const labour = cmp.lines.find((l) => l.key === 'labour')!
    // Quoted 6h design at 85 + 2h finishing at 55 = 620.
    expect(labour.quoted).toBe(620)
    // Actually 11h at 85 + 3h at 55 = 1100.
    expect(labour.actual).toBe(1100)
    expect(labour.delta).toBe(480)
    expect(labour.pct).toBeCloseTo(480 / 620, 6)

    const material = cmp.lines.find((l) => l.key === 'material')!
    expect(material.detail).toContain('925g')
    expect(material.detail).toContain('failed')

    // The headline: quoted margin was positive, the real one is worse.
    expect(cmp.quotedMargin).toBe(round2(q.margin))
    expect(cmp.actualMargin!).toBeLessThan(cmp.quotedMargin)
    expect(cmp.netRevenue).toBeCloseTo(q.total - q.tax, 6)
    expect(cmp.actualCost!).toBeGreaterThan(cmp.quotedCost)
  })

  it('flags a project that has cost more than it earns', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const q = priceQuote(MAST_BRACKETS, rates, ctx.materials[0], ctx.printers[0])
    const ref = await local.nextJobRef(shopId)
    const saved = await local.saveQuote({
      shopId,
      ref,
      client: { name: 'Acme Co', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly', design_qty: 6, revisions_incl: 2, quantity: 4,
        material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id,
        units_per_part: 185, print_hrs_part: 5.25, finishing_hrs: 2,
        rush: false, flat_each: 0, discount_pct: 0,
      },
      send: {
        rates_snapshot: { rates }, total: q.total, deposit_due: q.deposit,
        valid_until: '2026-10-01',
      },
    } satisfies SaveQuoteArgs)

    const now = new Date('2026-09-02T00:00:00Z')
    let [row] = await local.listJobs(shopId)
    expect(row.facts.hasActuals).toBe(false)
    expect(flagsFor(row.facts, now).map((f) => f.key)).not.toContain('over-budget')

    // 20 design hours at $85 alone is $1,700 against a $1,063 quote.
    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'design', hours: 20, workedOn: '2026-01-20', note: null,
    })
    ;[row] = await local.listJobs(shopId)
    expect(row.facts.hasActuals).toBe(true)
    expect(row.facts.actualCost).toBeCloseTo(1700, 6)
    const flag = flagsFor(row.facts, now).find((f) => f.key === 'over-budget')!
    expect(flag.tone).toBe('crit')
    expect(flag.label).toBe('Underwater')
    expect(flag.cause).toContain('160%')
  })

  it('the in-build gate item about material spend now clears from real runs', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'building')

    let d = await local.loadProjectDetail(shopId, saved.jobId)
    let spend = gateStatus('building', d.gates.building ?? {}, d.facts).items.find(
      (i) => i.key === 'spend',
    )!
    // It is automatic, so it cannot be ticked by hand while nothing is
    // recorded — which is the whole improvement. Before this it was a
    // checkbox a tired person ticked at 7pm.
    expect(spend.automatic).toBe(true)
    expect(spend.checked).toBe(false)

    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 740,
      hours: 21,
      outcome: 'success',
      failureReason: null,
      note: null,
      startedAt: null,
    })

    d = await local.loadProjectDetail(shopId, saved.jobId)
    spend = gateStatus('building', d.gates.building ?? {}, d.facts).items.find(
      (i) => i.key === 'spend',
    )!
    expect(spend.checked).toBe(true)
    expect(d.facts.actualRuns).toBe(1)
  })

  it('rebuilds the comparison from a real saved quote, snapshot and all', async () => {
    const local = await import('./data.local')
    const { buildComparison } = await import('./actuals')
    const { buildRatesSnapshot } = await import('./pricing')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const rates = local.toRateSet(ctx.rateCard, ctx.shop)
    const q = priceQuote(MAST_BRACKETS, rates, ctx.materials[0], ctx.printers[0])
    const ref = await local.nextJobRef(shopId)

    const saved = await local.saveQuote({
      shopId,
      ref,
      client: { name: 'Acme Co', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly', design_qty: 6, revisions_incl: 2, quantity: 4,
        material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id,
        units_per_part: 185, print_hrs_part: 5.25, finishing_hrs: 2,
        rush: false, flat_each: 0, discount_pct: 0,
      },
      send: {
        // The real snapshot the app writes, not a hand-made stand-in — this
        // test exists to catch a bad JSON round trip, so it has to make one.
        rates_snapshot: buildRatesSnapshot(rates, ctx.materials[0], ctx.printers[0]),
        total: q.total, deposit_due: q.deposit, valid_until: '2026-10-01',
      },
    } satisfies SaveQuoteArgs)

    const detail = await local.loadProjectDetail(shopId, saved.jobId)
    const pricing = {
      rateCard: ctx.rateCard,
      shop: ctx.shop,
      materials: ctx.materials,
      printers: ctx.printers,
    }

    const cmp = buildComparison(detail, pricing)
    expect(cmp).not.toBeNull()
    // Repriced from the snapshot, it lands on exactly the quoted figures —
    // if the snapshot came back as a raw string, or a key had drifted, the
    // catch would have swallowed it and returned null instead.
    expect(cmp!.quotedMargin).toBe(round2(q.margin))
    expect(cmp!.netRevenue).toBeCloseTo(q.total - q.tax, 6)
    expect(cmp!.lines.find((l) => l.key === 'material')!.quoted).toBe(round2(q.materialCost))
    expect(cmp!.lines.find((l) => l.key === 'labour')!.quoted).toBe(round2(q.yourHours))

    // A project with no quote has nothing to compare, and says so rather
    // than throwing.
    const { saved: draftless } = await seedProject(local, shopId, { title: 'Unquoted' })
    const bare = await local.loadProjectDetail(shopId, draftless.jobId)
    expect(buildComparison({ ...bare, quoteInputs: null }, pricing)).toBeNull()

    // A snapshot this build can no longer read must not blank the page.
    const corrupted = { ...detail, quoteInputs: { ...detail.quoteInputs!, ratesSnapshot: { nope: true } } }
    expect(buildComparison(corrupted, pricing)).toBeNull()
  })

  it('prices a draft against today\'s rates, since nobody was promised anything', async () => {
    const local = await import('./data.local')
    const { buildComparison } = await import('./actuals')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)

    const detail = await local.loadProjectDetail(shopId, saved.jobId)
    expect(detail.quoteInputs?.ratesSnapshot).toBeNull()

    const cmp = buildComparison(detail, {
      rateCard: ctx.rateCard,
      shop: ctx.shop,
      materials: ctx.materials,
      printers: ctx.printers,
    })
    expect(cmp).not.toBeNull()
    expect(cmp!.quotedCost).toBeGreaterThan(0)
    expect(cmp!.hasActuals).toBe(false)
  })

  /* ---------------------------------------------------------------- */
  /* The build sheet                                                   */
  /* ---------------------------------------------------------------- */

  it('adds parts, moves them through QC, and keeps every move', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)
    const add = (label: string, qty: number) =>
      local.addPart(shopId, saved.jobId, ctx.profile.id, { label, qty })

    const bracket = await add('Mast bracket, left', 2)
    await add('Mast bracket, right', 2)
    await add('Spacer', 8)

    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.parts.map((p) => p.label)).toEqual([
      'Mast bracket, left',
      'Mast bracket, right',
      'Spacer',
    ])
    expect(d.parts.every((p) => p.status === 'pending')).toBe(true)
    expect(d.facts.parts).toBe(3)
    expect(d.facts.partsPassed).toBe(0)
    // Adding a part is itself an event, so nothing is ever undated.
    expect(d.parts[0].history).toHaveLength(1)

    await local.setPartStatus(shopId, bracket, ctx.profile.id, 'printed', null)
    await local.setPartStatus(shopId, bracket, ctx.profile.id, 'passed', null)

    d = await local.loadProjectDetail(shopId, saved.jobId)
    const b = d.parts.find((p) => p.id === bracket)!
    expect(b.status).toBe('passed')
    expect(b.history).toHaveLength(3)
    expect(b.history[0].fromStatus).toBe('printed')
    expect(b.history[0].toStatus).toBe('passed')
    expect(b.history[0].actor).toBe('Owner')
    expect(d.facts.partsPrinted).toBe(1)
    expect(d.facts.partsPassed).toBe(1)

    // Moving to the status it already has is a no-op, not a duplicate event.
    await local.setPartStatus(shopId, bracket, ctx.profile.id, 'passed', null)
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.parts.find((p) => p.id === bracket)!.history).toHaveLength(3)
  })

  it('will not send a part back without a reason', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)
    const part = await local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'Cowl', qty: 1 })

    await expect(
      local.setPartStatus(shopId, part, ctx.profile.id, 'reprint', null),
    ).rejects.toThrow(/what went wrong/)
    await expect(
      local.setPartStatus(shopId, part, ctx.profile.id, 'reprint', '   '),
    ).rejects.toThrow(/what went wrong/)
    // Passing needs no explanation. Only going back does.
    await expect(
      local.setPartStatus(shopId, part, ctx.profile.id, 'passed', null),
    ).resolves.toBeUndefined()

    await local.setPartStatus(shopId, part, ctx.profile.id, 'reprint', 'Layer shift at 40mm')
    const d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.parts[0].status).toBe('reprint')
    expect(d.parts[0].history[0].note).toBe('Layer shift at 40mm')
  })

  it('counts every trip back, not just the parts sitting in reprint', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)
    const part = await local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'Rib', qty: 1 })

    await local.setPartStatus(shopId, part, ctx.profile.id, 'reprint', 'warped')
    await local.setPartStatus(shopId, part, ctx.profile.id, 'printed', null)
    await local.setPartStatus(shopId, part, ctx.profile.id, 'reprint', 'warped again')
    await local.setPartStatus(shopId, part, ctx.profile.id, 'printed', null)
    await local.setPartStatus(shopId, part, ctx.profile.id, 'passed', null)

    const [row] = await local.listJobs(shopId)
    // Nothing is in reprint now, and the sheet reads 1 of 1 passed...
    expect(row.facts.partsReprint).toBe(0)
    expect(row.facts.partsPassed).toBe(1)
    // ...but it cost the shop two extra prints, and that is the number a
    // margin conversation actually needs.
    expect(row.facts.reprintsEver).toBe(2)
  })

  it('the QC and started gate items read the sheet, and step aside without one', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()

    // A project with no build sheet: both items stay manual, exactly as
    // they were before the sheet existed. A feature nobody opted into must
    // never become a blocker.
    const { saved: plain } = await seedProject(local, shopId, { title: 'No sheet' })
    const bare = await local.loadProjectDetail(shopId, plain.jobId)
    const bareQc = gateStatus('review', {}, bare.facts).items.find((i) => i.key === 'qc')!
    expect(bareQc.automatic).toBe(false)
    expect(gateStatus('review', ticked('qc'), bare.facts).items.find((i) => i.key === 'qc')!.checked).toBe(
      true,
    )

    // A project that uses one: the item is read, not asked.
    const { saved } = await seedProject(local, shopId, { title: 'With a sheet' })
    const a = await local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'A', qty: 1 })
    const b = await local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'B', qty: 1 })

    let d = await local.loadProjectDetail(shopId, saved.jobId)
    let qc = gateStatus('review', d.gates.review ?? {}, d.facts).items.find((i) => i.key === 'qc')!
    expect(qc.automatic).toBe(true)
    expect(qc.checked).toBe(false)
    // ...and a stored tick from before cannot override the sheet.
    expect(
      gateStatus('review', ticked('qc'), d.facts).items.find((i) => i.key === 'qc')!.checked,
    ).toBe(false)

    await local.setPartStatus(shopId, a, ctx.profile.id, 'passed', null)
    d = await local.loadProjectDetail(shopId, saved.jobId)
    qc = gateStatus('review', {}, d.facts).items.find((i) => i.key === 'qc')!
    expect(qc.checked).toBe(false)

    await local.setPartStatus(shopId, b, ctx.profile.id, 'passed', null)
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(gateStatus('review', {}, d.facts).items.find((i) => i.key === 'qc')!.checked).toBe(true)
    // The in-build item cleared as soon as anything came off a machine.
    expect(
      gateStatus('building', {}, d.facts).items.find((i) => i.key === 'started')!.checked,
    ).toBe(true)
  })

  it('refuses a part with no name or no copies, and edits one in place', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)

    await expect(
      local.addPart(shopId, saved.jobId, ctx.profile.id, { label: '  ', qty: 1 }),
    ).rejects.toThrow(/needs a name/)
    await expect(
      local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'Cowl', qty: 0 }),
    ).rejects.toThrow(/at least one copy/)

    const part = await local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'Cowl', qty: 1 })
    await local.updatePart(shopId, part, { label: 'Cowl, revised', qty: 3, note: 'thicker wall' })
    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.parts[0].label).toBe('Cowl, revised')
    expect(d.parts[0].qty).toBe(3)
    expect(d.parts[0].note).toBe('thicker wall')

    await local.deletePart(shopId, part)
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.parts).toEqual([])
    expect(d.facts.parts).toBe(0)
  })

  /* ---------------------------------------------------------------- */
  /* The whole lifecycle, the way a person actually walks it           */
  /* ---------------------------------------------------------------- */

  /**
   * The test that should have existed before any gate shipped.
   *
   * Every suite above checks a piece in isolation, and every one of them
   * passed while the app was unusable: a project saved with the bare
   * minimum could never leave Intake, because the gate read a brief that
   * no screen could edit and could not be ticked by hand either. One stage
   * later it would have hit the same wall on quote status, which nothing
   * could change. Unit tests cannot see that. A walk can.
   */
  it('walks a bare-minimum project from intake to delivered, clearing every gate', async () => {
    const local = await import('./data.local')
    const { GATES, PHASE_LABEL, gateStatus, nextPhase } = await import('./gates')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const ref = await local.nextJobRef(shopId)

    // Exactly what Intake writes when only its two required fields are
    // filled in -- no brief, no contact, no date. This is the project that
    // got stuck.
    const saved = await local.saveQuote({
      shopId,
      ref,
      client: { name: 'Acme Co', contact: '', email: '', phone: '', source: '' },
      job: { title: 'A test project', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly', design_qty: 6, revisions_incl: 2, quantity: 4,
        material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id,
        units_per_part: 185, print_hrs_part: 5.25, finishing_hrs: 2,
        rush: false, flat_each: 0, discount_pct: 0,
      },
    } satisfies SaveQuoteArgs)

    const detail = () => local.loadProjectDetail(shopId, saved.jobId)
    const gateNow = async () => {
      const d = await detail()
      return { d, g: gateStatus(d.phase, d.gates[d.phase] ?? {}, d.facts) }
    }
    // --- INTAKE: blocked, and every blocker is actionable -------------
    let { g } = await gateNow()
    expect(g.blocked).toBe(true)
    const stuck = g.items.filter((i) => !i.checked)
    expect(stuck.length).toBeGreaterThan(0)
    // The invariant this whole failure came down to: an item a person
    // cannot tick MUST tell them where to go and change what it reads.
    for (const i of stuck.filter((x) => x.automatic)) {
      expect(i.fix, `auto item "${i.key}" has no fix hint`).toBeTruthy()
    }

    // Follow the fixes. Each of these is a real control on the project page.
    await local.updateProjectFields(shopId, saved.jobId, {
      brief: 'Four aluminium-look mast brackets for a rig, printed in PA-CF.',
      poc: 'Dana Reyes',
      neededBy: '2026-11-30',
    })
    await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'intake', 'origin', true, null)

    ;({ g } = await gateNow())
    expect(g.done).toBe(g.total)
    expect(g.blocked).toBe(false)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'design')

    // --- DESIGN -------------------------------------------------------
    for (const item of GATES.design) {
      await local.setGateItem(
        shopId, saved.jobId, ctx.profile.id, 'design', item.key, true,
        item.needsNote ? 'Logged against the quote.' : null,
      )
    }
    ;({ g } = await gateNow())
    expect(g.blocked).toBe(false)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'approval')

    // --- APPROVAL: the second wall. Quote status had no control at all.
    ;({ g } = await gateNow())
    expect(g.blocked).toBe(true)
    const sent = g.items.find((i) => i.key === 'sent')!
    expect(sent.automatic).toBe(true)
    expect(sent.checked).toBe(false)
    expect(sent.fix).toBeTruthy()

    await local.setQuoteStatus(shopId, saved.quoteId, ctx.profile.id, 'sent')
    ;({ g } = await gateNow())
    expect(g.items.find((i) => i.key === 'sent')!.checked).toBe(true)
    expect(g.items.find((i) => i.key === 'accepted')!.checked).toBe(false)

    await local.setQuoteStatus(shopId, saved.quoteId, ctx.profile.id, 'accepted')
    ;({ g } = await gateNow())
    expect(g.done).toBe(g.total)
    expect(g.blocked).toBe(false)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'scheduled')

    // --- SCHEDULED ----------------------------------------------------
    for (const item of GATES.scheduled.filter((i) => !i.auto)) {
      await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'scheduled', item.key, true, null)
    }
    ;({ g } = await gateNow())
    expect(g.blocked).toBe(false)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'building')

    // --- IN BUILD: 'spend' only clears from a real run ----------------
    ;({ g } = await gateNow())
    expect(g.items.find((i) => i.key === 'spend')!.checked).toBe(false)
    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id, materialId: ctx.materials[0].id,
      unitsUsed: 740, hours: 21, outcome: 'success', failureReason: null,
      note: null, startedAt: null,
    })
    for (const item of GATES.building) {
      const resolved = gateStatus('building', {}, (await detail()).facts).items.find(
        (i) => i.key === item.key,
      )!
      if (resolved.automatic) continue
      await local.setGateItem(
        shopId, saved.jobId, ctx.profile.id, 'building', item.key, true,
        item.needsNote ? 'One plate warped, reprinted.' : null,
      )
    }
    ;({ g } = await gateNow())
    expect(g.items.find((i) => i.key === 'spend')!.checked).toBe(true)
    expect(g.blocked).toBe(false)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'review')

    // --- REVIEW -------------------------------------------------------
    for (const item of GATES.review) {
      const resolved = gateStatus('review', {}, (await detail()).facts).items.find(
        (i) => i.key === item.key,
      )!
      if (resolved.automatic) continue
      await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'review', item.key, true, null)
    }
    ;({ g } = await gateNow())
    expect(g.blocked, `stuck in Review: ${g.reason}`).toBe(false)
    await local.updateJobPhase(shopId, saved.jobId, ctx.profile.id, 'delivered')

    // --- DELIVERED: the end of the line -------------------------------
    const { d, g: last } = await gateNow()
    expect(d.phase).toBe('delivered')
    expect(last.total).toBe(0)
    expect(nextPhase('delivered')).toBeNull()
    expect(PHASE_LABEL[d.phase]).toBe('Delivered')

    // Six stage changes, plus the run and the quote, all in one story.
    expect(d.events.filter((e) => e.kind === 'phase_change')).toHaveLength(6)
    expect(d.events.some((e) => e.kind === 'quote')).toBe(true)
    expect(d.events.some((e) => e.kind === 'run')).toBe(true)
  })

  it('every automatic gate item says how to satisfy it', async () => {
    const { GATES } = await import('./gates')
    // Cheap structural guard against the bug that started this: an item a
    // person cannot tick, with nowhere to go and change what it reads.
    for (const [phase, items] of Object.entries(GATES)) {
      for (const item of items) {
        if (!item.auto) continue
        expect(item.fix, `${phase}/${item.key} is automatic but has no fix hint`).toBeTruthy()
        expect(item.fix!.length).toBeGreaterThan(15)
      }
    }
  })

  it('a quote status change is recorded and stamps its dates', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)

    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.quote?.status).toBe('draft')

    await local.setQuoteStatus(shopId, saved.quoteId, ctx.profile.id, 'sent')
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.quote?.status).toBe('sent')
    expect(d.events.some((e) => e.kind === 'quote' && e.body?.includes('sent'))).toBe(true)

    // Setting the status it already has is a no-op, not a second event.
    const before = d.events.length
    await local.setQuoteStatus(shopId, saved.quoteId, ctx.profile.id, 'sent')
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.events).toHaveLength(before)
  })

  /* ---------------------------------------------------------------- */
  /* Drafts, taking in, and deleting                                   */
  /* ---------------------------------------------------------------- */

  it('a saved project starts as a draft and is not on the board', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const { saved } = await seedProject(local, shopId)

    const d = await local.loadProjectDetail(shopId, saved.jobId)
    // Saving prices something; it does not commit to doing it.
    expect(d.facts.takenInAt).toBeNull()
    const [row] = await local.listJobs(shopId)
    expect(row.facts.takenInAt).toBeNull()
    // ...and the board filters on exactly this.
    expect((await local.listJobs(shopId)).filter((j) => j.facts.takenInAt)).toHaveLength(0)
  })

  it('taking a draft in stamps it once and records why', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)

    await local.takeProjectIn(shopId, saved.jobId, ctx.profile.id)
    let d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.facts.takenInAt).toBeTruthy()
    expect(d.phase).toBe('intake')
    expect(d.events.some((e) => e.kind === 'taken_in')).toBe(true)
    const stamp = d.facts.takenInAt

    // Idempotent: the first answer to "when did this become real" is the
    // true one, so taking it in again must not move the date.
    await local.takeProjectIn(shopId, saved.jobId, ctx.profile.id)
    d = await local.loadProjectDetail(shopId, saved.jobId)
    expect(d.facts.takenInAt).toBe(stamp)
    expect(d.events.filter((e) => e.kind === 'taken_in')).toHaveLength(1)

    await expect(
      local.takeProjectIn(shopId, 'no-such-job', ctx.profile.id),
    ).rejects.toThrow(/no longer exists/)
  })

  it('deleting a project takes everything recorded against it', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const { saved } = await seedProject(local, shopId)
    const other = await seedProject(local, shopId, { title: 'Survivor', name: 'Other Co' })

    // Give it one of everything, so the cascade has something to prove.
    await local.recordPayment(shopId, saved.jobId, ctx.profile.id, {
      kind: 'deposit', amount: 100, method: 'cash', receivedOn: '2026-01-10',
      note: null, quoteId: saved.quoteId,
    })
    await local.recordPrintRun(shopId, saved.jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id, materialId: ctx.materials[0].id,
      unitsUsed: 100, hours: 2, outcome: 'success', failureReason: null,
      note: null, startedAt: null,
    })
    await local.logWork(shopId, saved.jobId, ctx.profile.id, {
      kind: 'design', hours: 2, workedOn: '2026-01-10', note: null,
    })
    const part = await local.addPart(shopId, saved.jobId, ctx.profile.id, { label: 'A', qty: 1 })
    await local.setPartStatus(shopId, part, ctx.profile.id, 'printed', null)
    await local.setGateItem(shopId, saved.jobId, ctx.profile.id, 'intake', 'origin', true, null)

    expect(await local.listJobs(shopId)).toHaveLength(2)

    await local.deleteProject(shopId, saved.jobId)

    const left = await local.listJobs(shopId)
    expect(left).toHaveLength(1)
    expect(left[0].jobId).toBe(other.saved.jobId)
    await expect(local.loadProjectDetail(shopId, saved.jobId)).rejects.toThrow(/no longer exists/)

    // Nothing orphaned. A half-delete in a tool about money is worse than
    // no delete at all, and SQLite only cascades with the pragma on.
    const d = await import('./data.local')
    const survivors = await d.loadProjectDetail(shopId, other.saved.jobId)
    expect(survivors.payments).toEqual([])
    expect((await d.listClients(shopId)).find((c) => c.name === 'Acme Co')?.projects).toBe(0)

    await expect(local.deleteProject(shopId, saved.jobId)).rejects.toThrow(/no longer exists/)
  })

  it('deleting one project leaves another shop-mate untouched', async () => {
    const local = await import('./data.local')
    const shopId = await local.setupShop(SETUP_PAYLOAD)
    const ctx = await local.loadShopContext()
    const a = await seedProject(local, shopId, { title: 'Going' })
    const b = await seedProject(local, shopId, { title: 'Staying' })
    await local.recordPayment(shopId, b.saved.jobId, ctx.profile.id, {
      kind: 'deposit', amount: 250, method: 'cash', receivedOn: '2026-01-10',
      note: null, quoteId: b.saved.quoteId,
    })

    await local.deleteProject(shopId, a.saved.jobId)

    const kept = await local.loadProjectDetail(shopId, b.saved.jobId)
    expect(kept.title).toBe('Staying')
    expect(kept.payments).toHaveLength(1)
    expect(kept.payments[0].amount).toBe(250)
  })
})
