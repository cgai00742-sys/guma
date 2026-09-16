/// <reference types="node" />
/**
 * The MCP tool surface, against a real database.
 *
 * Two things are being tested here, and the second matters more than the
 * first.
 *
 * One: the tools work — a model can read the shop, price a job with the
 * shop's own engine, and turn an enquiry into a correctly priced draft.
 *
 * Two: the boundary holds. Guma's rule is that a model may read the mess but
 * may never produce a number that lands on a document someone signs. That is
 * enforced structurally — there is no tool that accepts a price, records a
 * payment, or moves a quote to accepted — and structure erodes unless
 * something fails when it does. `writeRefusals` is the list; every entry gets
 * a test.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShopContext } from '../data.types'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../../src-tauri/migrations')
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n')

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
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))

/** A shop in Berlin: euros, 19% MwSt., one printer, one material. */
const SHOP = {
  name: 'Werkstatt Drei',
  currency: 'EUR',
  locale: 'de-DE',
  paper: 'a4',
  tax_label: 'MwSt.',
  tax_pct: 19,
  state: '',
  quote_valid_days: 30,
  lead_days: 10,
  electricity_rate_kwh: 0.32,
}
const RATES = {
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

interface Kit {
  ctx: ShopContext
  call: (name: string, args?: Record<string, unknown>) => Promise<any>
  tool: (name: string) => any
  local: typeof import('../data.local')
  materialId: string
  printerId: string
  reload: () => Promise<void>
}

async function setup(): Promise<Kit> {
  currentDb = freshDb()
  vi.resetModules()
  const local = await import('../data.local')
  const { toolsFor } = await import('./tools')

  await local.setupShop({
    shop: SHOP,
    rates: RATES,
    printer: { name: 'Prusa XL', model: 'XL 5T', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 350 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g', cost_per_unit: 0.095 }],
    fullName: 'Anke Roth',
  })

  const kit: Kit = {
    ctx: await local.loadShopContext(),
    local,
    materialId: '',
    printerId: '',
    tool: (name) => toolsFor('write').find((t) => t.name === name),
    call: async (name, args = {}) => {
      const t = toolsFor('write').find((x) => x.name === name)
      if (!t) throw new Error(`no tool ${name}`)
      return t.handler(args, kit.ctx)
    },
    reload: async () => {
      kit.ctx = await local.loadShopContext()
    },
  }
  kit.materialId = kit.ctx.materials[0]!.id
  kit.printerId = kit.ctx.printers[0]!.id
  return kit
}

/** The worked example from pricing.test.ts, in euros. */
const JOB = (k: Kit) => ({
  asset_origin: 'model',
  design_hours: 6,
  quantity: 12,
  material_id: k.materialId,
  printer_id: k.printerId,
  material_per_part: 62,
  print_hours_per_part: 1.75,
  finishing_hours: 2,
})

beforeEach(() => vi.clearAllMocks())

describe('the boundary', () => {
  it('publishes no tool that can touch money, commit the shop, or delete', async () => {
    const { toolsFor } = await import('./tools')
    const names = toolsFor('write').map((t) => t.name).join(' ')
    // Not a spelling check — these are the verbs a model would reach for.
    for (const forbidden of [
      'payment',
      'pay',
      'quote_status',
      'accept',
      'rate',
      'markup',
      'deposit',
      'take_in',
      'delete',
      'remove',
    ]) {
      expect(names, `a tool named for "${forbidden}" appeared`).not.toContain(forbidden)
    }
  })

  it('has a stated reason for every refusal, so the list cannot be padded silently', async () => {
    const { writeRefusals } = await import('./tools')
    expect(writeRefusals.length).toBeGreaterThanOrEqual(5)
    for (const r of writeRefusals) {
      expect(r.what.length).toBeGreaterThan(10)
      expect(['money', 'agreeing to do work', 'irreversible']).toContain(r.why)
    }
  })

  it('accepts no price, total or amount as an input to anything', async () => {
    const { toolsFor } = await import('./tools')
    for (const t of toolsFor('write')) {
      const props = Object.keys((t.inputSchema as any).properties ?? {})
      for (const p of props) {
        // flat_each and discount_pct are the two deliberate exceptions: they
        // are quote INPUTS the shop agreed with the client, and they still go
        // through priceQuote rather than around it.
        if (p === 'flat_each' || p === 'discount_pct') continue
        expect(p, `${t.name}.${p} looks like a price`).not.toMatch(/price|total|amount|owed/)
      }
    }
  })

  it('drops every writing tool in read-only mode rather than listing one that fails', async () => {
    const { toolsFor } = await import('./tools')
    const read = toolsFor('read')
    expect(read.every((t) => !t.writes)).toBe(true)
    expect(read.map((t) => t.name)).not.toContain('guma_create_draft')
    expect(toolsFor('write').length).toBeGreaterThan(read.length)
  })

  it('describes every tool well enough for a model to choose it', async () => {
    const { toolsFor } = await import('./tools')
    for (const t of toolsFor('write')) {
      expect(t.name).toMatch(/^guma_[a-z_]+$/)
      expect(t.description.length, `${t.name} is under-described`).toBeGreaterThan(80)
      expect((t.inputSchema as any).type).toBe('object')
    }
  })
})

describe('guma_shop', () => {
  it('hands over the ids and rates every other tool depends on', async () => {
    const k = await setup()
    const out = await k.call('guma_shop')
    expect(out.shop.currency).toBe('EUR')
    expect(out.rates.designHourly).toBe(85)
    expect(out.materials[0].id).toBe(k.materialId)
    expect(out.printers[0].ratePerHour).toBe(9)
    expect(out.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('guma_price_quote', () => {
  it('returns the same figures the app computes, in the shop’s currency', async () => {
    const k = await setup()
    const q = await k.call('guma_price_quote', JOB(k))
    // 6 h × 85 design + 744 g × 0.19 material + 21 h × 9 machine
    // + 21 h × 3 wear + 2 h × 55 finishing = 1013.36, then 19% MwSt.
    expect(q.subtotal).toBeCloseTo(1013.36, 2)
    expect(q.total).toBeCloseTo(1205.9, 2)
    expect(q.total_shown).toContain('€')
    // German grouping and decimal comma, not 1,205.90.
    expect(q.total_shown).toContain('1.205,90')
  })

  it('shows the arithmetic behind each line, so nothing has to be taken on trust', async () => {
    const k = await setup()
    const q = await k.call('guma_price_quote', JOB(k))
    const material = q.lines.find((l: any) => l.label.startsWith('Material'))
    expect(material.basis).toContain('744 g')
    expect(material.basis).toContain('€')
    expect(material.basis).not.toContain('$')
  })

  it('applies the shop’s minimum without being asked, and says that it did', async () => {
    const k = await setup()
    const tiny = await k.call('guma_price_quote', {
      ...JOB(k),
      design_hours: 0,
      asset_origin: 'ready',
      quantity: 1,
      material_per_part: 5,
      print_hours_per_part: 0.2,
      finishing_hours: 0,
    })
    expect(tiny.minimum_applied).toBe(true)
    expect(tiny.subtotal).toBe(85)
  })

  it('writes nothing', async () => {
    const k = await setup()
    await k.call('guma_price_quote', JOB(k))
    expect(await k.local.listJobs(k.ctx.shop.id)).toHaveLength(0)
    expect(k.tool('guma_price_quote').writes).toBeFalsy()
  })

  it('refuses to report a margin as fact while a cost line is missing', async () => {
    const k = await setup()
    // No printer means no wattage; and this shop has entered no overhead and
    // no failure allowance, so three of six cost lines are unmeasured.
    const q = await k.call('guma_price_quote', { ...JOB(k), printer_id: undefined })
    expect(q.costs_incomplete).toBe(true)
    expect(q.note).toMatch(/understated|overstated/)
    const keys = q.missing_costs.map((m: any) => m.key)
    expect(keys).toContain('electricity')
    expect(keys).toContain('overhead')
    expect(keys).toContain('failure')
    // Every one names the control that fixes it, not just the gap.
    for (const m of q.missing_costs) expect(m.fix.length).toBeGreaterThan(20)
  })

  it('hands back the whole owner-only cost block, adding up', async () => {
    const k = await setup()
    const q = await k.call('guma_price_quote', JOB(k))
    const c = q.cost
    expect(c.total).toBeCloseTo(
      c.material + c.electricity + c.machine_wear + c.overhead + c.failure_allowance + c.own_hours,
      2,
    )
    expect(c.break_even).toBeCloseTo(c.total, 2)
    expect(c.per_piece).toBeCloseTo(c.total / 12, 2)
    expect(q.margin).toBeCloseTo(q.total - q.tax - c.total, 2)
  })
})

describe('guma_create_draft', () => {
  it('creates a draft that is priced but not on the board', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', {
      ...JOB(k),
      client_name: 'Hafen GmbH',
      title: 'Mast brackets',
      brief: 'Twelve stainless-look mast brackets, 6 mm bolt holes, matte finish.',
    })
    expect(made.state).toBe('draft')
    expect(made.ref).toMatch(/^GUMA-\d{4}-\d{4}$/)
    expect(made.next).toContain('person')

    const detail = await k.local.loadProjectDetail(k.ctx.shop.id, made.job_id)
    expect(detail.facts.takenInAt).toBeNull()
    expect(detail.brief).toContain('mast brackets')
    expect(detail.client.name).toBe('Hafen GmbH')
  })

  it('keeps drafts off guma_list_projects unless they are asked for', async () => {
    const k = await setup()
    await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'Mast brackets' })

    expect(await k.call('guma_list_projects')).toHaveLength(0)
    const withDrafts = await k.call('guma_list_projects', { include_drafts: true })
    expect(withDrafts).toHaveLength(1)
    expect(withDrafts[0].is_draft).toBe(true)
    // Not a number anyone has been given yet.
    expect(withDrafts[0].quoted_total).toBeNull()
  })

  it('reuses an existing client rather than making a second one', async () => {
    const k = await setup()
    await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'One' })
    await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'Two' })
    expect(await k.local.listClients(k.ctx.shop.id)).toHaveLength(1)
  })
})

describe('guma_project and the gate', () => {
  it('says which items are automatic and what clears each one', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', {
      ...JOB(k),
      client_name: 'Hafen GmbH',
      title: 'Mast brackets',
      brief: 'Twelve stainless-look mast brackets, 6 mm bolt holes, matte finish.',
    })
    const p = await k.call('guma_project', { job_id: made.job_id })
    expect(p.gate.total).toBeGreaterThan(0)
    const autos = p.gate.items.filter((i: any) => i.automatic)
    expect(autos.length).toBeGreaterThan(0)
    for (const a of autos.filter((i: any) => !i.satisfied)) {
      expect(a.clears_by, `${a.key} has no fix`).toBeTruthy()
    }
  })

  it('refuses to tick an automatic item, and says how it is really cleared', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'X' })
    const p = await k.call('guma_project', { job_id: made.job_id })
    const auto = p.gate.items.find((i: any) => i.automatic && !i.satisfied)

    await expect(
      k.call('guma_tick_gate', { job_id: made.job_id, phase: 'intake', item_key: auto.key, note: 'trust me' }),
    ).rejects.toThrow(/automatic/)
  })

  it('refuses a starred item ticked without saying what was done', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'X' })
    const { GATES } = await import('../gates')
    const starred = GATES.intake.find((i) => i.needsNote && !i.auto)
    if (!starred) return
    await expect(
      k.call('guma_tick_gate', { job_id: made.job_id, phase: 'intake', item_key: starred.key }),
    ).rejects.toThrow(/note/)
  })
})

describe('guma_advance_stage', () => {
  it('will not move a draft, because taking it in is a person’s decision', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'X' })
    await expect(k.call('guma_advance_stage', { job_id: made.job_id })).rejects.toThrow(/draft/)
  })

  it('will not move past an unmet gate, and quotes the gate’s own reason', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'X' })
    await k.local.takeProjectIn(k.ctx.shop.id, made.job_id, k.ctx.profile.id)
    await expect(k.call('guma_advance_stage', { job_id: made.job_id })).rejects.toThrow(/Cannot advance/)
  })

  it('moves it once the gate is genuinely clear', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', {
      ...JOB(k),
      client_name: 'Hafen GmbH',
      title: 'Mast brackets',
      brief: 'Twelve stainless-look mast brackets, 6 mm bolt holes, matte finish.',
      needed_by: '2026-12-01',
      contact: 'Ilse Braun',
    })
    await k.local.takeProjectIn(k.ctx.shop.id, made.job_id, k.ctx.profile.id)

    // Clear whatever manual items remain, honestly.
    const p = await k.call('guma_project', { job_id: made.job_id })
    for (const item of p.gate.items.filter((i: any) => !i.automatic && !i.satisfied)) {
      await k.call('guma_tick_gate', {
        job_id: made.job_id,
        phase: 'intake',
        item_key: item.key,
        note: 'Confirmed on the call.',
      })
    }
    const moved = await k.call('guma_advance_stage', { job_id: made.job_id })
    expect(moved.phase).toBe('design')
    expect(moved.stage).toBe('Design')
  })
})

describe('logging what actually happened', () => {
  it('records a run and a note, and the project reflects both', async () => {
    const k = await setup()
    const made = await k.call('guma_create_draft', { ...JOB(k), client_name: 'Hafen GmbH', title: 'X' })
    await k.local.takeProjectIn(k.ctx.shop.id, made.job_id, k.ctx.profile.id)

    await k.call('guma_log_run', {
      job_id: made.job_id,
      printer_id: k.printerId,
      material_id: k.materialId,
      units: 744,
      hours: 21,
      outcome: 'success',
    })
    await k.call('guma_log_work', { job_id: made.job_id, kind: 'design', hours: 6 })
    await k.call('guma_add_note', { job_id: made.job_id, note: 'Client asked for a matte finish.' })

    const p = await k.call('guma_project', { job_id: made.job_id })
    expect(p.runs).toHaveLength(1)
    expect(p.work).toHaveLength(1)
    expect(p.events.some((e: any) => (e.body ?? '').includes('matte finish'))).toBe(true)
    expect(p.actuals.materialUnits).toBeCloseTo(744, 1)
  })
})
