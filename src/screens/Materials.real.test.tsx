// @vitest-environment jsdom
/**
 * The project page, rendered against a real database.
 *
 * Nothing is mocked below the screen: @tauri-apps/plugin-sql is swapped for
 * node:sqlite, every migration is applied, and the project is created by the
 * same setupShop / saveQuote / takeProjectIn the app calls. So this exercises
 * the migrations, data.local.ts, the dispatcher, gates.ts, pricing.ts and the
 * screen in one pass.
 *
 * It exists because of one report: "I tried to move a new project forward but
 * no success." Three separate dead ends were behind it, and all three were
 * invisible to a test that never rendered a page:
 *   - the intake gate read a brief no screen could edit
 *   - the approval gate read a quote status nothing could change
 *   - saving stranded the user on the form
 * The assertions here are those three, made permanent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Loaded through a specifier Vite cannot see: under the jsdom environment
// it treats a literal 'node:sqlite' import as browser code and refuses to
// bundle it. The engine underneath is the same one the desktop app uses.
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
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
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
    sqlite: sqlite as any,
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
// The dispatcher picks its backend from this. Saying yes routes every call
// through data.local.ts, which is the code the desktop app runs.
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))


async function shop() {
  currentDb = freshDb()
  vi.resetModules()
  const data = await import('../lib/data')
  await data.setupShop({
    shop: { name: 'Guma Creations', currency: 'USD', locale: 'en-US', paper: 'letter', tax_label: 'GET', tax_pct: 4.5, state: 'HI', quote_valid_days: 30, lead_days: 10, electricity_rate_kwh: 0.43 },
    rates: { design_hourly: 45, finishing_hourly: 20, rush_pct: 0, minimum_order: 0, deposit_pct: 0, deposit_when: 'design', deposit_waive_below: 0, material_markup: 2, revisions_incl: 0, revision_hourly: null },
    printer: { name: 'Hatsa', model: 'Prusa XL', tech: 'fdm', rate_hourly: 6, wear_hourly: 0.5, watts: 200 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#fff', unit: 'g', cost_per_unit: 0.022 }],
    fullName: 'CG',
  } as never)
  const ctx = await data.loadShopContext()
  return { data, ctx }
}

async function renderMaterials(ctx: unknown) {
  const { default: Settings } = await import('./Settings')
  render(
    <MemoryRouter initialEntries={['/settings?tab=materials']}>
      <Routes>
        <Route path="/settings" element={<Settings ctx={ctx as never} onSaved={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText(/What your material actually costs/i)
}

beforeEach(cleanup)

describe('putting material on the shelf (CG, 8 Oct: "I can\'t add material")', () => {
  it('a new material can start with what is already on the shelf', async () => {
    const { ctx } = await shop()
    await renderMaterials(ctx)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^add a material$/i }))
    await user.type(screen.getByLabelText(/^name$/i), 'PETG black')
    await user.type(screen.getByLabelText(/on the shelf now/i), '2.5')
    await user.click(screen.getByRole('button', { name: /^add it$/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare("select on_hand from materials where name = 'PETG black'").get()).toEqual({ on_hand: 2500 }),
    )
  })

  it('"+ add stock" on the row: bought 1 kg for $25 adds 1000 g and is a purchase', async () => {
    const { ctx } = await shop()
    await renderMaterials(ctx)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add stock of pla/i }))
    await user.type(screen.getByLabelText(/how much came in/i), '1')
    await user.type(screen.getByLabelText(/what you paid, all in/i), '25')
    await user.click(screen.getByRole('button', { name: /add to the shelf/i }))
    await screen.findByText(/Added 1,000g of PLA/)
    expect(currentDb.sqlite.prepare('select on_hand from materials').get()).toEqual({ on_hand: 1000 })
    expect(currentDb.sqlite.prepare('select count(*) as n from material_purchases').get()).toEqual({ n: 1 })
  })

  it('a purchase with no price is not saved at $0', async () => {
    const { ctx } = await shop()
    await renderMaterials(ctx)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add stock of pla/i }))
    await user.type(screen.getByLabelText(/how much came in/i), '1')
    expect((screen.getByRole('button', { name: /add to the shelf/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('counted: on hand becomes what is there, and the count is kept', async () => {
    const { ctx } = await shop()
    await renderMaterials(ctx)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add stock of pla/i }))
    await user.selectOptions(screen.getByLabelText(/^pla$/i), 'counted')
    await user.type(screen.getByLabelText(/on the shelf now/i), '3')
    await user.click(screen.getByRole('button', { name: /record the count/i }))
    await screen.findByText(/PLA counted at 3,000g/)
    expect(currentDb.sqlite.prepare('select on_hand from materials').get()).toEqual({ on_hand: 3000 })
  })
})
