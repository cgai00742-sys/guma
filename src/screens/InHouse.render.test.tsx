// @vitest-environment jsdom
/**
 * The shop's own work, walked the whole way, against a real database.
 *
 * Nothing is mocked below the screen: @tauri-apps/plugin-sql is swapped for
 * node:sqlite, every migration is applied, and the project is created by the
 * same createInHouseJob the app calls. So this exercises the migrations,
 * data.local.ts, the dispatcher, gates.ts, selling.ts and three screens in
 * one pass.
 *
 * It exists because of one report, made three times: "when you try to enter
 * a new project, it doesn't give you an in-house option." It did, in a
 * dropdown that only rendered once the shop ALREADY HAD CLIENTS -- so on a
 * new shop, which is exactly the shop most likely to be printing its own
 * things, the option did not exist at all.
 *
 * The loop these tests walk is the whole point of the feature:
 *
 *   start something of your own -> log what it takes -> record what it made
 *   -> it is on the shelf -> sell it
 *
 * Every step of that was reachable in code and unreachable in the program.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { DatabaseSync } = (await import(/* @vite-ignore */ ['node', 'sqlite'].join(':'))) as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): {
      run(...p: never[]): { changes: number | bigint; lastInsertRowid: number | bigint }
      all(...p: never[]): unknown[]
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION_SQL = readdirSync(join(here, '../../src-tauri/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '../../src-tauri/migrations', f), 'utf8'))
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
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

/** A shop with a machine, a material and a rate — and NO clients, which is
 *  the state this whole feature was broken in. */
async function seedShop() {
  currentDb = freshDb()
  vi.resetModules()
  const data = await import('../lib/data')
  await data.setupShop({
    shop: {
      name: 'Bay Street Fabrication',
      currency: 'USD',
      locale: 'en-US',
      paper: 'letter',
      tax_label: 'GET',
      tax_pct: 4.712,
      state: 'HI',
      quote_valid_days: 30,
      lead_days: 10,
      electricity_rate_kwh: 0.4299,
    },
    rates: {
      design_hourly: 25,
      finishing_hourly: 18,
      rush_pct: 0,
      minimum_order: 0,
      deposit_pct: 0,
      deposit_when: 'design',
      deposit_waive_below: 0,
      material_markup: 1,
      revisions_incl: 0,
      revision_hourly: null,
    },
    printer: { name: 'Bay 1', model: '', tech: 'fdm', rate_hourly: 0, wear_hourly: 0.2, watts: 350 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g', cost_per_unit: 0.022 }],
    fullName: 'Owner',
  })
  const ctx = await data.loadShopContext()
  return { ctx, data }
}

async function renderIntake(ctx: any) {
  const { default: Intake } = await import('./Intake')
  render(
    <MemoryRouter>
      <Intake ctx={ctx} />
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { name: /new project/i })
}

async function renderProject(jobId: string, ctx: any) {
  const { default: Project } = await import('./Project')
  render(
    <MemoryRouter initialEntries={[`/project/${jobId}`]}>
      <Routes>
        <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(cleanup)

describe('starting work of your own', () => {
  it('is offered on a shop with no clients, which is where it used to vanish', async () => {
    const { ctx } = await seedShop()
    expect(ctx.shop.name).toBe('Bay Street Fabrication')
    await renderIntake(ctx)

    // The old version put this in a client dropdown that was itself hidden
    // until the shop had clients. Here there are none, on purpose.
    expect(screen.getByRole('button', { name: /it is mine/i })).toBeDefined()
  })

  it('needs a title and nothing else, and lands on a real project', async () => {
    const { ctx, data } = await seedShop()
    const user = userEvent.setup()
    await renderIntake(ctx)

    await user.click(screen.getByRole('button', { name: /it is mine/i }))
    await user.type(screen.getByLabelText(/project title/i), 'Calibrating the new PETG')
    await user.click(screen.getByRole('button', { name: /start it/i }))

    await waitFor(async () => {
      const jobs = await data.listJobs(ctx.shop.id)
      expect(jobs).toHaveLength(1)
    })
    const [job] = await data.listJobs(ctx.shop.id)
    expect(job.title).toBe('Calibrating the new PETG')
    expect(job.facts.kind).toBe('inhouse')
    // It starts at Working, not at Intake: there is nobody to take it in
    // from, and a stage nobody can clear is a stage that blocks forever.
    expect(job.phase).toBe('design')
    // And no client was invented to hold it.
    expect(await data.listClients(ctx.shop.id)).toHaveLength(0)
  })
})

describe('the project page for work nobody is paying for', () => {
  async function started() {
    const { ctx, data } = await seedShop()
    const jobId = await data.createInHouseJob(ctx.shop.id, {
      title: 'Calibrating the new PETG',
      brief: null,
    })
    return { ctx, data, jobId }
  }

  it('walks Working, Made, Done — not seven client stages', async () => {
    const { ctx, jobId } = await started()
    await renderProject(jobId, ctx)
    await screen.findByText('Calibrating the new PETG')

    expect(screen.getByRole('button', { name: /^Working$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^Made$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^Done$/ })).toBeDefined()
    // Walking a trial print past "Client approval" is theatre, and a
    // checklist that is theatre teaches people to tick without reading.
    expect(screen.queryByRole('button', { name: /client approval/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Scheduled$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Intake$/ })).toBeNull()
  })

  it('shows no money, no promised window and no handover', async () => {
    // Not "empty" — they do not apply. Showing them unfilled turns the page
    // into a list of things you have failed to do, which is the complaint
    // that started this whole piece of work.
    const { ctx, jobId } = await started()
    await renderProject(jobId, ctx)
    await screen.findByText('Calibrating the new PETG')

    expect(screen.queryByRole('heading', { name: /^Money$/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /who and when/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Handover$/ })).toBeNull()
  })

  it('is never flagged for having no quote', async () => {
    // It fired on every in-house job, permanently: they start past intake,
    // and the rule was "past intake with no quote".
    const { ctx, jobId } = await started()
    await renderProject(jobId, ctx)
    await screen.findByText('Calibrating the new PETG')
    expect(screen.queryByText(/No quote/)).toBeNull()
  })

  it('measures what it cost against what it made, not against a quote', async () => {
    const { ctx, jobId } = await started()
    await renderProject(jobId, ctx)
    await screen.findByText('Calibrating the new PETG')
    expect(screen.getByText(/measured against what it made/i)).toBeDefined()
    expect(screen.queryByText(/until this project has a quote/i)).toBeNull()
  })
})

describe('the whole loop', () => {
  it('turns an evening of printing into units on the shelf', async () => {
    const { ctx, data } = await seedShop()
    const jobId = await data.createInHouseJob(ctx.shop.id, {
      title: 'Hex keychain run',
      brief: null,
    })

    // An evening: one print run, and two hours of design before it.
    const fresh = await data.loadShopContext()
    await data.recordPrintRun(ctx.shop.id, jobId, ctx.profile.id, {
      printerId: fresh.printers[0].id,
      materialId: fresh.materials[0].id,
      hours: 6,
      unitsUsed: 500,
      outcome: 'success',
      failureReason: null,
      note: null,
      startedAt: null,
    })
    await data.logWork(ctx.shop.id, jobId, ctx.profile.id, {
      kind: 'design',
      hours: 2,
      workedOn: '2026-09-01',
      note: null,
    })

    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await screen.findByText('Hex keychain run')

    // The section only an in-house job has.
    await screen.findByRole('heading', { name: /what this made/i })
    await user.type(screen.getByLabelText(/call it/i), 'Hex keychain')
    await user.type(screen.getByLabelText(/how many usable units/i), '40')
    await user.click(screen.getByRole('button', { name: /put them on the shelf/i }))

    await waitFor(async () => {
      const shelf = await data.listShelf(ctx.shop.id)
      expect(shelf).toHaveLength(1)
    })

    const [product] = await data.listShelf(ctx.shop.id)
    expect(product.name).toBe('Hex keychain')
    // Design is carried on the PRODUCT as an investment to pay back -- two
    // hours at $25 -- and deliberately kept OUT of the unit cost. In both
    // places it would say the thing costs more than it does AND that it has
    // recovered less than it has.
    expect(Number(product.design_cost)).toBeCloseTo(50, 2)

    const [batch] = product.batches
    expect(batch.units_made).toBe(40)
    expect(batch.units_left).toBe(40)
    /**
     * The number a shop will actually act on, worked out by hand:
     *
     *   material   500 g x $0.022        = $11.00
     *   power      6 h x 0.35 kW x $0.4299 = $0.90
     *   wear       6 h x $0.20           = $1.20
     *                                     --------
     *   production                        = $13.10   -> $0.33 a keychain
     *
     *   design     2 h x $25             = $50.00   -> on the product
     *
     * Had design been folded in, a keychain would read $1.58 -- nearly five
     * times its real production cost, and climbing every time the design
     * was reused. That is the whole argument for the split, in one number.
     */
    expect(Number(batch.unit_cost)).toBeCloseTo(0.33, 2)
    expect(Number(batch.unit_cost)).not.toBeCloseTo(1.58, 2)
    // Traceable back to the evening that produced it, which is what makes
    // it a measurement rather than a number somebody typed.
    expect(batch.job_id).toBe(jobId)
    expect(batch.estimated).toBe(false)
  })

  it('sells what the evening produced, and keeps what is left of it', async () => {
    const { ctx, data } = await seedShop()
    const jobId = await data.createInHouseJob(ctx.shop.id, { title: 'Hex keychain run', brief: null })
    const productId = await data.saveProduct(ctx.shop.id, { name: 'Hex keychain', designCost: 50 })
    const batchId = await data.saveBatch(ctx.shop.id, {
      productId,
      jobId,
      unitsMade: 40,
      unitCost: 1.15,
      madeOn: '2026-09-01',
    })
    const etsy = await data.saveChannel(ctx.shop.id, { name: 'Etsy', feePct: 9.5, feeFlat: 0.45 })

    await data.recordSale(ctx.shop.id, {
      batchId,
      channelId: etsy.id,
      units: 12,
      unitPrice: 9,
      soldOn: '2026-09-14',
    })

    const [product] = await data.listShelf(ctx.shop.id)
    const [batch] = product.batches
    expect(batch.units_left).toBe(28)
    expect(Number(batch.revenue)).toBeCloseTo(108, 2)
    expect(Number(batch.fees)).toBeCloseTo(10.71, 2)
    // Cost of what SOLD, not of what was made. The other 28 are stock.
    expect(Number(batch.cost_of_sold)).toBeCloseTo(13.8, 2)

    // $108 in, $10.71 to Etsy, $13.80 of keychains: $83.49 kept against a
    // $50 evening of design. That evening is paid back.
    const kept = Number(batch.revenue) - Number(batch.fees) - Number(batch.cost_of_sold)
    expect(kept).toBeCloseTo(83.49, 2)
    expect(kept).toBeGreaterThan(Number(product.design_cost))
  })
})

describe('a master program — BathyTopo', () => {
  /**
   * CG's real structure: BathyTopo holds the Hawaiian Islands, Fiji and
   * French Polynesia, and the Hawaiian Islands hold the islands already
   * printed. Walked through the screen, because the last two bugs in this
   * area were both "it works in the data and cannot be seen".
   */
  it('shows up on the board as live work, not a draft', async () => {
    const { ctx, data } = await seedShop()
    const bathy = await data.createInHouseJob(ctx.shop.id, { title: 'BathyTopo' })
    await renderProject(bathy, ctx)
    await screen.findByText('BathyTopo')
    expect(screen.queryByText(/Saved as a draft/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /take it into intake/i })).toBeNull()
  })

  it('builds BathyTopo › Hawaiian Islands › Maui from the Series screen', async () => {
    const { ctx } = await seedShop()
    const user = userEvent.setup()
    const { default: Series } = await import('./Series')
    const { default: Project } = await import('./Project')
    render(
      <MemoryRouter initialEntries={['/series']}>
        <Routes>
          <Route path="/series" element={<Series ctx={ctx} />} />
          <Route path="/series/:seriesId" element={<Series ctx={ctx} />} />
          <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
        </Routes>
      </MemoryRouter>,
    )
    await user.type(await screen.findByLabelText(/start a series/i), 'BathyTopo')
    await user.click(screen.getByRole('button', { name: /^start it$/i }))
    await user.type(await screen.findByLabelText(/start a series inside BathyTopo/i), 'Hawaiian Islands')
    await user.click(screen.getAllByRole('button', { name: /^start it$/i })[0])
    await user.click(await screen.findByRole('link', { name: /Hawaiian Islands/ }))
    await user.type(await screen.findByLabelText(/add a piece to Hawaiian Islands/i), 'Maui')
    await user.click(screen.getByRole('button', { name: /start the piece/i }))

    // Lands on Maui: an ordinary project at its first stage, with the way
    // back up one click per level.
    expect(await screen.findByRole('link', { name: 'BathyTopo' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Hawaiian Islands' })).toBeDefined()
    const rows = (await currentDb.select(
      "select j.phase, s.name from jobs j join series s on s.id = j.series_id where j.title = 'Maui'",
    )) as { phase: string; name: string }[]
    expect(rows).toEqual([{ phase: 'design', name: 'Hawaiian Islands' }])
  })

  it('adds up the whole series, islands included, and shows each piece at its stage', async () => {
    const { ctx, data } = await seedShop()
    const bathy = await data.createSeries(ctx.shop.id, { name: 'BathyTopo' })
    const hi = await data.createSeries(ctx.shop.id, { name: 'Hawaiian Islands', parentId: bathy })
    const oahu = await data.createInHouseJob(ctx.shop.id, { title: 'Oʻahu', seriesId: hi })
    await data.recordPrintRun(ctx.shop.id, oahu, ctx.profile.id, {
      printerId: ctx.printers[0].id,
      materialId: ctx.materials[0].id,
      unitsUsed: 410,
      hours: 18,
      outcome: 'success',
      failureReason: null,
      note: null,
      startedAt: '2026-08-14',
    })
    await data.updateJobPhase(ctx.shop.id, oahu, ctx.profile.id, 'review')
    const { default: Series } = await import('./Series')
    render(
      <MemoryRouter initialEntries={[`/series/${bathy}`]}>
        <Routes>
          <Route path="/series/:seriesId" element={<Series ctx={ctx} />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('410 g')
    expect(screen.getByRole('link', { name: /Hawaiian Islands/ })).toBeDefined()

    cleanup()
    render(
      <MemoryRouter initialEntries={[`/series/${hi}`]}>
        <Routes>
          <Route path="/series/:seriesId" element={<Series ctx={ctx} />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: 'Oʻahu' })).toBeDefined()
    expect(screen.getAllByText('Made').length).toBeGreaterThan(0)
  })
})
