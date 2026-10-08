// @vitest-environment jsdom
/**
 * Slicer import, walked the whole way through the screen, against a real
 * database. Nothing below the screen is mocked: @tauri-apps/plugin-sql is
 * node:sqlite, every migration is applied, and the file goes in through the
 * real <input type="file">.
 *
 * It is a render test rather than another unit test because of the two
 * NOT NULL crashes this project has already shipped. Both were payload
 * bugs -- a value the screen sent that the database refused -- and neither
 * was catchable by reading code or by any test that did not walk the screen
 * and look at what came out the other side. importSlice sends a payload
 * built from a parsed file, which is exactly that shape of risk.
 *
 * The other reason: "an estimate is not an actual" is a claim about what
 * the PROJECT shows after an import, not about a function's return value.
 * So it is asserted here, on the rendered screen.
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
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
      all(...p: unknown[]): unknown[]
      // node:sqlite has get() too; the other render tests do not declare it
      // because they do not use it. The assertions here read single rows.
      get(...p: unknown[]): unknown
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
    sqlite,
    path: 'sqlite:guma.db',
    async execute(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...params)
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params)
    },
  }
}

// jsdom does not implement the compression streams. Safari has had both
// since 16.4 and the 3MF parser already depends on DecompressionStream in
// the real app, so borrowing Node's implementation here tests the same
// path rather than a stub.
{
  const web = (await import(/* @vite-ignore */ ['node', 'stream/web'].join(':'))) as {
    CompressionStream?: unknown
    DecompressionStream?: unknown
  }
  const g = globalThis as Record<string, unknown>
  if (!g.CompressionStream && web.CompressionStream) g.CompressionStream = web.CompressionStream
  if (!g.DecompressionStream && web.DecompressionStream) {
    g.DecompressionStream = web.DecompressionStream
  }
}

let currentDb: ReturnType<typeof freshDb>
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

/**
 * CG: "have a way to upload the gcode files so it can automatically
 * implement for the project costs." Driven through the real New project
 * form on a real database, with his own PrusaSlicer export.
 */
async function freshShop() {
  currentDb = freshDb()
  vi.resetModules()
  const data = await import('../lib/data')
  await data.setupShop({
    shop: {
      name: 'Kahului Fab', currency: 'USD', locale: 'en-US', paper: 'letter', tax_label: 'GET',
      tax_pct: 4.5, state: 'HI', quote_valid_days: 30, lead_days: 10, electricity_rate_kwh: 0.43,
    },
    rates: {
      design_hourly: 45, finishing_hourly: 20, rush_pct: 0, minimum_order: 0, deposit_pct: 0,
      deposit_when: 'design', deposit_waive_below: 0, material_markup: 2, revisions_incl: 0,
      revision_hourly: null,
    },
    printer: { name: 'Hatsa', model: 'Prusa XL', tech: 'fdm', rate_hourly: 6, wear_hourly: 0.5, watts: 200 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#fff', unit: 'g', cost_per_unit: 0.022 }],
    fullName: 'CG',
  } as never)
  const ctx = await data.loadShopContext()
  return { data, ctx }
}

async function renderIntake(ctx: unknown) {
  const { default: Intake } = await import('./Intake')
  const { default: Project } = await import('./Project')
  render(
    <MemoryRouter initialEntries={['/intake']}>
      <Routes>
        <Route path="/intake" element={<Intake ctx={ctx as never} />} />
        <Route path="/project/:jobId" element={<Project ctx={ctx as never} />} />
      </Routes>
    </MemoryRouter>,
  )
}

const MAUI = () =>
  new File([readFileSync(join(here, '../../samples/maui-top_prusa-xl.bgcode'))], 'Maui_Top_2mm Base.bgcode')

beforeEach(cleanup)

describe('saving a revision as a PDF (CG, 8 Oct: blank white screen)', () => {
  async function revise(ctx: unknown, jobId: string) {
    const { default: Intake } = await import('./Intake')
    const { default: Project } = await import('./Project')
    const { default: QuoteDoc } = await import('./QuoteDoc')
    render(
      <MemoryRouter initialEntries={[`/intake?revise=${jobId}`]}>
        <Routes>
          <Route path="/intake" element={<Intake ctx={ctx as never} />} />
          <Route path="/project/:jobId" element={<Project ctx={ctx as never} />} />
          <Route path="/quote/:quoteId/print" element={<QuoteDoc />} />
        </Routes>
      </MemoryRouter>,
    )
    // No "who is it for?" question in front of a revision.
    await waitFor(() =>
      expect((screen.getByLabelText(/project title/i) as HTMLInputElement).value).toBe('Five 16in Anson models'),
    )
  }

  it('opens the printable of the NEW version when the first one was only a draft', async () => {
    const { ctx } = await freshShop()
    const user = userEvent.setup()
    await renderIntake(ctx)
    await user.click(await screen.findByRole('button', { name: /someone is paying/i }))
    await user.type(screen.getByLabelText(/^client/i), 'Anson Canoe Club')
    await user.type(screen.getByLabelText(/project title/i), 'Five 16in Anson models')
    await user.upload(screen.getByLabelText(/price from a sliced file/i), MAUI())
    await screen.findByText(/Priced on Hatsa/)
    // CG's case: the first version was saved as a draft -- no frozen rates.
    await user.click(screen.getByRole('button', { name: /^save draft$/i }))
    await waitFor(() => expect(currentDb.sqlite.prepare('select count(*) as n from quotes').get()).toEqual({ n: 1 }))
    const jobId = (currentDb.sqlite.prepare('select id from jobs').get() as { id: string }).id
    cleanup()

    await revise(ctx, jobId)
    await user.click(screen.getByRole('button', { name: /^save revision as pdf$/i }))
    await waitFor(() => expect(currentDb.sqlite.prepare('select count(*) as n from quotes').get()).toEqual({ n: 2 }))
    // The printable, with the version that has frozen rates.
    await waitFor(() => expect(document.body.textContent).toMatch(/Prepared for\s*Anson Canoe Club/), { timeout: 3000 })
    expect(document.body.textContent).toMatch(/Machine time/)

    // And the project is one project, showing the newest version.
    const data = await import('../lib/data')
    const rows = await data.listJobs((ctx as { shop: { id: string } }).shop.id)
    expect(rows.filter((r) => r.jobId === jobId)).toHaveLength(1)
    const d = await data.loadProjectDetail((ctx as { shop: { id: string } }).shop.id, jobId)
    const v2 = currentDb.sqlite.prepare('select id from quotes where version = 2').get() as { id: string }
    expect(d.quote?.id).toBe(v2.id)
    // Money rolls up once per project, not once per version.
    currentDb.sqlite.prepare("update quotes set status = 'sent'").run()
    expect(currentDb.sqlite.prepare('select count(*) as n from job_money where job_id = ?').get(jobId)).toEqual({ n: 1 })
  })

  it('a draft version opened directly says so, instead of a blank page', async () => {
    const { ctx } = await freshShop()
    const data = await import('../lib/data')
    const c = ctx as { shop: { id: string }; materials: { id: string }[]; printers: { id: string }[] }
    const ref = await data.nextJobRef(c.shop.id)
    const saved = await data.saveQuote({
      shopId: c.shop.id, ref,
      client: { name: 'X', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Draft only', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'none', design_qty: 0, revisions_incl: 0, quantity: 1,
        material_id: c.materials[0].id, printer_id: c.printers[0].id, units_per_part: 10,
        print_hrs_part: 1, finishing_hrs: 0, rush: false, flat_each: 0, discount_pct: 0,
      },
    } as never)
    const { default: QuoteDoc } = await import('./QuoteDoc')
    render(
      <MemoryRouter initialEntries={[`/quote/${saved.quoteId}/print`]}>
        <Routes>
          <Route path="/quote/:quoteId/print" element={<QuoteDoc />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText(/has not been priced for sending/i)
  })
})
