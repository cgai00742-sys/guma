// @vitest-environment jsdom
/**
(CG, 5 Nov) A folder of sliced files onto a new quote, and the form kept
 * while you step away.
 *
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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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

const BUOY = (name = 'reef-buoy_prusa.gcode') =>
  new File([readFileSync(join(here, '../../samples/reef-buoy_prusa.gcode'))], name)

beforeEach(cleanup)

describe('a folder of sliced files (CG, 5 Nov)', () => {
  it('lists what it found, leaves the copy and the STL out, and prices the rest', async () => {
    const { ctx } = await freshShop()
    const user = userEvent.setup({ applyAccept: false }) // a dropped folder ignores accept=
    await renderIntake(ctx)
    await user.click(await screen.findByRole('button', { name: /someone is paying/i }))
    await user.upload(screen.getByLabelText(/price from a sliced file/i), [
      MAUI(),
      BUOY(),
      BUOY('reef-buoy_prusa copy.gcode'),
      new File(['solid x'], 'bracket.stl'),
      new File([''], '.DS_Store'),
    ])
    const list = await screen.findByRole('group', { name: /files found/i })
    expect(list.textContent).toMatch(/3 sliced files found/)
    expect(list.textContent).toMatch(/Same file as reef-buoy_prusa\.gcode/)
    expect(list.textContent).toMatch(/Skipped 1 file that is not sliced \(\.stl\)/)
    expect((screen.getByLabelText(/include reef-buoy_prusa copy\.gcode/i) as HTMLInputElement).checked).toBe(false)
    // Nothing is priced until the checklist says so.
    expect(screen.queryByLabelText(/copies of maui/i)).toBeNull()
    // The quote says so, and can add them itself (CG, 5 Nov: the folder was
    // read but the quote still showed 0 g -- the Add button was off-screen).
    const note = await screen.findByTestId('folder-pending')
    expect(note.textContent).toMatch(/Not priced yet\. 2 sliced files are ticked/)
    await user.click(within(note).getByRole('button', { name: /add 2 to the quote/i }))
    expect(await screen.findByLabelText(/copies of maui/i)).toBeDefined()
    expect(screen.queryByRole('group', { name: /files found/i })).toBeNull()
    expect(screen.getByText(/2 files added/)).toBeDefined()
    expect(screen.queryByTestId('folder-pending')).toBeNull()
    // The filament is on the quote now, not 0 g.
    const basis = screen.getAllByText(/ g at /).map((e) => e.textContent ?? '')
    expect(basis.some((t) => /^[1-9][\d.,]* g at/.test(t))).toBe(true)
  })
})

describe('the form is kept while you step away (CG, 5 Nov)', () => {
  it('comes back as you left it, file and all, and Start fresh clears it', async () => {
    const { ctx } = await freshShop()
    const user = userEvent.setup()
    await renderIntake(ctx)
    await user.click(await screen.findByRole('button', { name: /someone is paying/i }))
    await user.type(screen.getByLabelText(/project title/i), 'Four sensor mast brackets')
    await user.upload(screen.getByLabelText(/price from a sliced file/i), MAUI())
    await screen.findByText(/Priced on Hatsa/)
    cleanup() // off to Shop settings → Materials

    await renderIntake(ctx)
    expect(await screen.findByTestId('draft-note')).toBeDefined()
    expect((screen.getByLabelText(/project title/i) as HTMLInputElement).value).toBe('Four sensor mast brackets')
    expect(screen.getByLabelText(/copies of maui/i)).toBeDefined()

    await user.click(screen.getByRole('button', { name: /start fresh/i }))
    expect(screen.queryByTestId('draft-note')).toBeNull()
    cleanup()
    await renderIntake(ctx)
    expect(await screen.findByRole('button', { name: /someone is paying/i })).toBeDefined()
  })

  it('is let go once the project is saved', async () => {
    const { ctx } = await freshShop()
    const user = userEvent.setup()
    await renderIntake(ctx)
    await user.click(await screen.findByRole('button', { name: /someone is paying/i }))
    await user.type(screen.getByLabelText(/^client/i), 'Sakman Mario')
    await user.type(screen.getByLabelText(/project title/i), 'Brackets')
    await user.click(screen.getByRole('button', { name: /^intake/i }))
    await waitFor(() => expect(currentDb.sqlite.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 }))
    cleanup()
    await renderIntake(ctx)
    expect(await screen.findByRole('button', { name: /someone is paying/i })).toBeDefined()
    expect(screen.queryByTestId('draft-note')).toBeNull()
  })
})
