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

describe('pricing a new project from its sliced file', () => {
  it('fills the print from the file, prices it, and puts the file on the project', async () => {
    const { ctx } = await freshShop()
    const user = userEvent.setup()
    await renderIntake(ctx)
    await user.click(await screen.findByRole('button', { name: /someone is paying/i }))
    await user.type(screen.getByLabelText(/^client/i), 'Maui Ocean Center')
    await user.type(screen.getByLabelText(/project title/i), 'Maui relief')

    await user.upload(screen.getByLabelText(/price from a sliced file/i), MAUI())
    await screen.findByText(/Maui_Top_2mm Base\.bgcode: 1 object, ~73 g, ~7h 34m\. Priced on Hatsa\./)

    // One line, on the XL, in PLA, per-copy figures from the file.
    expect((screen.getByLabelText(/copies of maui land standalone 3x/i) as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText(/^g per copy/i) as HTMLInputElement).value).toBe('73.1')
    // 7h 34m, as hours and minutes.
    expect((screen.getByLabelText(/time per copy of .* \(hours\)/i) as HTMLInputElement).value).toBe('7')
    expect((screen.getByLabelText(/time per copy of .* \(minutes\)/i) as HTMLInputElement).value).toBe('34')
    // The hand-typed fields are gone while the lines are the print.
    expect(screen.queryByLabelText(/^print time per part/i)).toBeNull()

    await user.click(screen.getByRole('button', { name: /^intake/i }))

    await waitFor(() => {
      const b = currentDb.sqlite
        .prepare('select label, qty, units_per_part, print_hrs_part from quote_builds')
        .all()
      expect(b).toEqual([
        { label: 'Maui LAND STANDALONE 3x', qty: 1, units_per_part: 73.1, print_hrs_part: 7.5667 },
      ])
    })
    // The file is on the project as an estimate: kept, nothing recorded.
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select file_name, est_grams from slice_imports').all()).toEqual([
        { file_name: 'Maui_Top_2mm Base.bgcode', est_grams: 73.13 },
      ]),
    )
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_files').get()).toEqual({ n: 1 })
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 0 })

    // The project reads the lines back, so its quoted-vs-actual is priced
    // from them -- not from the empty single-machine fields.
    const data = await import('../lib/data')
    const { buildComparison } = await import('../lib/actuals')
    const jobId = (currentDb.sqlite.prepare('select id from jobs').get() as { id: string }).id
    const detail = await data.loadProjectDetail((ctx as { shop: { id: string } }).shop.id, jobId)
    expect(detail.quoteInputs?.builds).toHaveLength(1)
    const c = buildComparison(detail, ctx as never)
    // Material and machine come from the line; without it both are zero.
    expect(c?.lines.find((l) => l.key === 'material')?.quoted ?? 0).toBeGreaterThan(1)
    expect(c?.lines.find((l) => l.key === 'machine')?.quoted ?? 0).toBeGreaterThan(0)
  })

  it('prices each line at its own machine, and more copies cost more', async () => {
    const { ctx } = await freshShop()
    const user = userEvent.setup()
    await renderIntake(ctx)
    await user.click(await screen.findByRole('button', { name: /someone is paying/i }))
    const totalDue = () => {
      const el = screen.getByText(/^total due$/i).parentElement!
      return Number((el.textContent ?? '').replace(/[^0-9.]/g, ''))
    }
    const before = totalDue()
    await user.upload(screen.getByLabelText(/price from a sliced file/i), MAUI())
    await screen.findByText(/Priced on Hatsa/)
    const one = totalDue()
    expect(one).toBeGreaterThan(before)
    const copies = screen.getByLabelText(/copies of maui/i)
    await user.clear(copies)
    await user.type(copies, '3')
    await waitFor(() => expect(totalDue()).toBeGreaterThan(one))
  })
})
